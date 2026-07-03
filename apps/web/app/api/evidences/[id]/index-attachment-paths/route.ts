import path from "node:path";
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent } from "@core/cases";
import { prisma } from "@core/db";
import { scanUfdrArchive } from "@core/parsers";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function basenameLower(filePath: string) {
  return path.basename(filePath).toLowerCase();
}

function pickBestMatch(fileName: string, candidates: string[]) {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const lower = fileName.toLowerCase();
  const preferred =
    candidates.find((entry) => /(^|[\\/])files[\\/]/i.test(entry)) ??
    candidates.find((entry) => entry.toLowerCase().includes("/files/")) ??
    candidates.find((entry) => entry.toLowerCase().includes("\\files\\")) ??
    candidates.find((entry) => entry.toLowerCase().endsWith(lower));
  return preferred ?? candidates[0];
}

type MediaKind = "pdf" | "image" | "video" | "audio" | "other";

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|bmp|heic|heif|gif)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|3gp|webm|avi|wmv|flv)$/i;
const AUDIO_EXT_RE = /\.(aac|amr|flac|m4a|mp3|ogg|opus|wav|wma)$/i;
const PDF_EXT_RE = /\.pdf$/i;
const GIF_EXT_RE = /\.gif$/i;
const STICKER_NAME_RE = /(^|[\\/])STK-[0-9]{8}-WA\d+\.webp$/i;
const MIN_IMAGE_BYTES_DEFAULT = 12 * 1024;
const MIN_STICKER_BYTES_DEFAULT = 24 * 1024;

function isMessagingSourceApp(value?: string | null) {
  const source = normalize(value ?? "");
  if (!source) return false;
  return /(whatsapp|telegram|signal|messenger|facebook|instagram|imessage|sms|mms|wechat|viber)/i.test(source);
}

function isMessagingPath(value?: string | null) {
  const row = normalize(value ?? "");
  if (!row) return false;
  return /(whatsapp|telegram|messenger|instagram|facebook|messages?|chats?|conversation|inbox|media)/i.test(row);
}

function isLikelyCameraPath(value?: string | null) {
  const row = normalize(value ?? "");
  if (!row) return false;
  return /(dcim|camera|cameraroll|camera roll|100andro|\bimg[_-]?\d+|\bdsc[_-]?\d+)/i.test(row);
}

function isLikelyGamePath(value?: string | null) {
  const row = normalize(value ?? "");
  if (!row) return false;
  return /(games?|jogos?|unity|unreal|minecraft|roblox|free ?fire|pubg|fortnite|callofduty|codm)/i.test(row);
}

function isLikelyScreenshotPath(value?: string | null) {
  const row = normalize(value ?? "");
  if (!row) return false;
  return /(screenshot|screen[_ -]?shot|screenrecord|screen[_ -]?record|captura de tela|print[_ -]?screen)/i.test(row);
}

function hasBankTransferSignal(value?: string | null) {
  const row = normalize(value ?? "");
  if (!row) return false;
  return /(pix|ted|doc|transfer|transferencia|comprovante|pagamento|deposito|bank|banco|nubank|itau|bradesco|santander|caixa|bb\b)/i.test(
    row
  );
}

function detectMediaKind(input: { mimeType?: string | null; fileName?: string | null; archivePath?: string | null }) {
  const mime = normalize(input.mimeType ?? "");
  const ref = `${input.fileName ?? ""} ${input.archivePath ?? ""}`.trim();
  if (mime === "application/pdf" || PDF_EXT_RE.test(ref)) return "pdf" satisfies MediaKind;
  if (mime === "image" || mime.startsWith("image/") || IMAGE_EXT_RE.test(ref)) return "image" satisfies MediaKind;
  if (mime === "video" || mime.startsWith("video/") || VIDEO_EXT_RE.test(ref)) return "video" satisfies MediaKind;
  if (mime === "voice message" || mime.startsWith("audio/") || AUDIO_EXT_RE.test(ref)) return "audio" satisfies MediaKind;
  return "other" satisfies MediaKind;
}

function isGifMedia(input: { mimeType?: string | null; fileName?: string | null; archivePath?: string | null }) {
  const mime = normalize(input.mimeType ?? "");
  const ref = `${input.fileName ?? ""} ${input.archivePath ?? ""}`.trim();
  return mime === "image/gif" || GIF_EXT_RE.test(ref);
}

function parsePositiveInt(raw: string | undefined, fallback: number) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function shouldDiscardTinyImage(input: {
  fileName?: string | null;
  archivePath?: string | null;
  sizeBytes?: bigint | null;
}) {
  const rawSize = Number(input.sizeBytes ?? 0n);
  if (!Number.isFinite(rawSize) || rawSize <= 0) return false;

  const minImageBytes = parsePositiveInt(process.env.ATTACHMENT_IMAGE_MIN_BYTES, MIN_IMAGE_BYTES_DEFAULT);
  const minStickerBytes = parsePositiveInt(process.env.ATTACHMENT_STICKER_MIN_BYTES, MIN_STICKER_BYTES_DEFAULT);

  const ref = `${input.fileName ?? ""} ${input.archivePath ?? ""}`.trim();
  const isStickerLike = STICKER_NAME_RE.test(ref) || /(^|[\\/])stickers?([\\/]|$)/i.test(ref);
  const threshold = isStickerLike ? minStickerBytes : minImageBytes;
  return rawSize < threshold;
}

function shouldIndexByPolicy(input: {
  mimeType?: string | null;
  fileName?: string | null;
  archivePath?: string | null;
  sizeBytes?: bigint | null;
  sourceApp?: string | null;
  messageBody?: string | null;
}) {
  const kind = detectMediaKind(input);
  const joinedSignals = `${input.fileName ?? ""} ${input.archivePath ?? ""} ${input.messageBody ?? ""}`;
  const messaging = isMessagingSourceApp(input.sourceApp) || isMessagingPath(input.archivePath);
  const camera = isLikelyCameraPath(input.archivePath) || isLikelyCameraPath(input.fileName);
  const screenshot = isLikelyScreenshotPath(input.archivePath) || isLikelyScreenshotPath(input.fileName);
  const game = isLikelyGamePath(input.archivePath) || isLikelyGamePath(input.fileName);
  const bankLike = hasBankTransferSignal(joinedSignals);

  if (kind === "pdf" || kind === "audio") {
    return { allowed: true as const, kind };
  }
  if (kind === "image") {
    if (isGifMedia(input)) {
      return { allowed: false as const, kind, reason: "IMAGE_GIF_DISCARDED" };
    }
    if (shouldDiscardTinyImage(input)) {
      return { allowed: false as const, kind, reason: "IMAGE_TOO_SMALL_DISCARDED" };
    }
    if (camera || screenshot || bankLike) {
      return { allowed: true as const, kind };
    }
    return { allowed: false as const, kind, reason: "IMAGE_NOT_RELEVANT_POLICY" };
  }
  if (kind === "video") {
    if (game) return { allowed: false as const, kind, reason: "VIDEO_GAME_PATH_DISCARDED" };
    if (camera || screenshot || messaging) return { allowed: true as const, kind };
    if (!messaging) return { allowed: false as const, kind, reason: "VIDEO_NON_RELEVANT_PATH_DISCARDED" };
    return { allowed: true as const, kind };
  }
  return { allowed: true as const, kind };
}

function markAsExcludedNotRecovered(current: unknown, source: string) {
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  return {
    ...base,
    recovery: {
      ...(base.recovery && typeof base.recovery === "object" && !Array.isArray(base.recovery)
        ? (base.recovery as Record<string, unknown>)
        : {}),
      status: "NOT_RECOVERED",
      excluded: true,
      reason: "MISSING_IN_EXTRACTION",
      markedAt: new Date().toISOString(),
      markedBy: source
    }
  };
}

function markAsExcludedByPolicy(current: unknown, source: string, reason: string) {
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  return {
    ...base,
    recovery: {
      ...(base.recovery && typeof base.recovery === "object" && !Array.isArray(base.recovery)
        ? (base.recovery as Record<string, unknown>)
        : {}),
      status: "EXCLUDED_BY_POLICY",
      excluded: true,
      reason,
      markedAt: new Date().toISOString(),
      markedBy: source
    }
  };
}

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const sessionUser = auth.session;

    const params = paramsSchema.parse(await context.params);
    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      include: { extraction: true }
    });
    if (!evidence) {
      return NextResponse.json({ error: "Evidencia nao encontrada." }, { status: 404 });
    }
    if (evidence.extraction?.status === "PROCESSING" || evidence.extraction?.status === "INDEXING") {
      return NextResponse.json({ error: "Extracao em andamento. Aguarde para indexar caminhos." }, { status: 409 });
    }

    const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? "./storage");
    const ufdrAbsolutePath = path.resolve(storageRoot, evidence.originalPath);
    const ufdrInfo = await stat(ufdrAbsolutePath).catch(() => null);
    if (!ufdrInfo) {
      return NextResponse.json({ error: "Fonte original da evidencia nao encontrada no storage." }, { status: 404 });
    }

    const [attachmentsTotal, attachments] = await Promise.all([
      prisma.attachment.count({ where: { evidenceId: evidence.id } }),
      prisma.attachment.findMany({
        where: {
          evidenceId: evidence.id,
          OR: [{ archivePath: null }, { archivePath: "" }]
        },
        select: {
          id: true,
          fileName: true,
          archivePath: true,
          mimeType: true,
          sizeBytes: true,
          metadata: true,
          message: {
            select: {
              body: true,
              chat: {
                select: {
                  sourceApp: true
                }
              }
            }
          }
        }
      })
    ]);

    if (attachments.length === 0) {
      return NextResponse.json({
        ok: true,
        indexed: 0,
        unresolved: 0,
        processed: 0,
        totalPending: 0,
        totalAttachments: attachmentsTotal,
        scannedEntries: 0,
        message: "Nenhum anexo pendente de indexacao de caminho."
      });
    }

    const scan = await scanUfdrArchive(ufdrAbsolutePath);
    const byBasename = new Map<string, string[]>();
    for (const entry of scan.files) {
      const key = basenameLower(entry);
      const list = byBasename.get(key) ?? [];
      list.push(entry);
      byBasename.set(key, list);
    }

    let indexed = 0;
    let unresolved = 0;
    let ambiguous = 0;
    let excludedByPolicy = 0;
    const transcriptionRows = await prisma.audioTranscription.findMany({
      where: {
        evidenceId: evidence.id,
        status: "COMPLETED"
      },
      select: {
        attachmentId: true,
        sourceFilePath: true
      },
      orderBy: { finishedAt: "desc" }
    });
    const fallbackByAttachmentId = new Map<string, string>();
    for (const row of transcriptionRows) {
      if (!row.sourceFilePath || fallbackByAttachmentId.has(row.attachmentId)) continue;
      fallbackByAttachmentId.set(row.attachmentId, row.sourceFilePath);
    }

    for (const attachment of attachments) {
      const fallbackSourcePath = fallbackByAttachmentId.get(attachment.id);
      const fallbackFromTranscription = fallbackSourcePath ? path.basename(fallbackSourcePath) : undefined;
      const filenameForMatch =
        attachment.fileName && attachment.fileName.trim().length > 0 ? attachment.fileName : fallbackFromTranscription;
      if (!filenameForMatch || filenameForMatch.trim().length === 0) {
        await prisma.attachment.update({
          where: { id: attachment.id },
          data: {
            metadata: markAsExcludedNotRecovered(attachment.metadata, "api/evidences/index-attachment-paths")
          }
        });
        unresolved += 1;
        continue;
      }

      const candidates = byBasename.get(normalize(filenameForMatch)) ?? [];
      if (candidates.length > 1) ambiguous += 1;
      const chosen = pickBestMatch(filenameForMatch, candidates);
      if (!chosen) {
        await prisma.attachment.update({
          where: { id: attachment.id },
          data: {
            metadata: markAsExcludedNotRecovered(attachment.metadata, "api/evidences/index-attachment-paths")
          }
        });
        unresolved += 1;
        continue;
      }

      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          archivePath: chosen,
          fileName: attachment.fileName ?? filenameForMatch,
          metadata: {
            ...((attachment.metadata as Record<string, unknown> | null) ?? {}),
            indexedArchivePathAt: new Date().toISOString(),
            indexedArchivePathBy: "api/evidences/index-attachment-paths"
          }
        }
      });

      const policy = shouldIndexByPolicy({
        mimeType: attachment.mimeType,
        fileName: attachment.fileName ?? filenameForMatch,
        archivePath: chosen,
        sizeBytes: attachment.sizeBytes,
        sourceApp: attachment.message?.chat?.sourceApp,
        messageBody: attachment.message?.body
      });

      if (!policy.allowed) {
        await prisma.attachment.update({
          where: { id: attachment.id },
          data: {
            archivePath: null,
            metadata: markAsExcludedByPolicy(
              {
                ...((attachment.metadata as Record<string, unknown> | null) ?? {}),
                indexedArchivePathCandidate: chosen,
                indexedArchivePathAt: new Date().toISOString(),
                indexedArchivePathBy: "api/evidences/index-attachment-paths"
              },
              "api/evidences/index-attachment-paths",
              policy.reason
            )
          }
        });
        excludedByPolicy += 1;
        continue;
      }

      indexed += 1;
    }

    await addCustodyEvent({
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      actorId: sessionUser.id,
      action: "ATTACHMENT_PATHS_INDEXED",
      source: "api/evidences/index-attachment-paths",
      currentHash: evidence.sha256,
      details: {
        indexed,
        unresolved,
        excludedByPolicy,
        ambiguous,
        scannedEntries: scan.files.length
      }
    });

    return NextResponse.json({
      ok: true,
      indexed,
      unresolved,
      excludedByPolicy,
      processed: indexed + unresolved + excludedByPolicy,
      totalPending: attachments.length,
      totalAttachments: attachmentsTotal,
      ambiguous,
      scannedEntries: scan.files.length
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao indexar caminhos de anexos."
      },
      { status: 500 }
    );
  }
}
