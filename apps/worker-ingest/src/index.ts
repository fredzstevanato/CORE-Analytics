import "./load-env.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { Queue, Worker } from "bullmq";
import {
  addCustodyEvent,
  buildEvidenceMessageLinkageContext,
  clearDerivedDataByEvidence,
  enrichCaseContextFromUfdrMetadata,
  findExistingUfdrAnalysisBySha,
  persistAudioArtifactsIndex,
  persistAudioAttachments,
  persistNormalizedExtraction,
  saveExtractionDevice,
  syncCaseTimeline,
  updateExtractionStatus
} from "@core/cases";
import {
  extractArchiveEntriesToFiles,
  extractArchiveEntryToFile,
  extractAudioEntriesFromUfdr,
  parseUfdrReportXml,
  parseUfdrReportXmlStream,
  scanUfdrArchive
} from "@core/parsers";
import {
  audioRecoveryBatchQueue,
  enqueueAudioRecoveryBatch,
  enqueueAudioRecoveryFinalize,
  enqueueAudioTranscription,
  enqueueOcrDocument,
  enqueueUfdrIngestion,
  redisConnection,
  QUEUE_NAMES
} from "@core/queue";
import { ensureSearchIndices, indexExtractionSummary } from "@core/search";
import { Prisma, prisma } from "@core/db";
import { computeSha256FromFile } from "@core/forensics";
import type { AudioRecoveryBatchJob, AudioRecoveryFinalizeJob, IngestJob, LocalUfdrImportJob } from "@core/shared";
import {
  audioRecoveryBatchJobSchema,
  audioRecoveryFinalizeJobSchema,
  ingestJobSchema,
  localUfdrImportJobSchema
} from "@core/shared";
import { log } from "./logger.js";

function parseOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function resolveStorageRoot() {
  const fallback = path.resolve("./storage");
  const raw = (process.env.STORAGE_ROOT ?? "").trim();
  if (!raw) return fallback;
  const resolved = path.resolve(raw);

  // Defensive guard for malformed Windows device prefix values such as "\\?".
  if (resolved === "\\\\?" || resolved === "\\\\?\\") {
    log("warn", "Invalid STORAGE_ROOT detected, falling back to ./storage", {
      storageRootRaw: raw
    });
    return fallback;
  }
  return resolved;
}

const UFDR_AUDIO_MAX_FILES = parseOptionalPositiveIntEnv("UFDR_AUDIO_MAX_FILES");
const UFDR_AUDIO_EXTRACTION_TIMEOUT_MS =
  parseOptionalPositiveIntEnv("UFDR_AUDIO_EXTRACTION_TIMEOUT_MS") ?? 5 * 60 * 1000;
const UFDR_AUDIO_ENTRY_TIMEOUT_MS = parseOptionalPositiveIntEnv("UFDR_AUDIO_ENTRY_TIMEOUT_MS") ?? 45 * 1000;
const UFDR_AUDIO_RECOVERY_BATCH_SIZE = parseOptionalPositiveIntEnv("UFDR_AUDIO_RECOVERY_BATCH_SIZE") ?? 200;
const UFDR_AUDIO_RECOVERY_BATCH_TIMEOUT_MS =
  parseOptionalPositiveIntEnv("UFDR_AUDIO_RECOVERY_BATCH_TIMEOUT_MS") ?? 25 * 60 * 1000;
const UFDR_AUDIO_RECOVERY_FINALIZE_DELAY_MS = parseOptionalPositiveIntEnv("UFDR_AUDIO_RECOVERY_FINALIZE_DELAY_MS") ?? 15 * 1000;
const UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY = parseOptionalPositiveIntEnv("UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY") ?? 1;
const UFDR_AUDIO_RECOVERY_QUEUE_SCAN_PAGE_SIZE =
  parseOptionalPositiveIntEnv("UFDR_AUDIO_RECOVERY_QUEUE_SCAN_PAGE_SIZE") ?? 1000;
const UFDR_AUDIO_RECOVERY_QUEUE_SCAN_MAX_JOBS =
  parseOptionalPositiveIntEnv("UFDR_AUDIO_RECOVERY_QUEUE_SCAN_MAX_JOBS") ?? 50000;
const UFDR_AUDIO_RECOVERY_ASYNC_ENABLED = !["0", "false", "no", "off"].includes(
  (process.env.UFDR_AUDIO_RECOVERY_ASYNC_ENABLED ?? "true").trim().toLowerCase()
);
const UFDR_STALE_PROCESSING_TIMEOUT_MS = parseOptionalPositiveIntEnv("UFDR_STALE_PROCESSING_TIMEOUT_MS") ?? 45 * 60 * 1000;
const UFDR_STALE_PENDING_TIMEOUT_MS = parseOptionalPositiveIntEnv("UFDR_STALE_PENDING_TIMEOUT_MS") ?? 10 * 60 * 1000;
const UFDR_STALE_WATCHDOG_INTERVAL_MS = parseOptionalPositiveIntEnv("UFDR_STALE_WATCHDOG_INTERVAL_MS") ?? 2 * 60 * 1000;
const UFDR_SOURCE_AVAILABILITY_TIMEOUT_MS =
  parseOptionalPositiveIntEnv("UFDR_SOURCE_AVAILABILITY_TIMEOUT_MS") ?? 3 * 60 * 1000;
const WORKER_LOG_HEARTBEAT_MS = (parseOptionalPositiveIntEnv("WORKER_LOG_HEARTBEAT_SECONDS") ?? 30) * 1000;
const UFDR_XML_STREAM_MIN_FILES = parseOptionalPositiveIntEnv("UFDR_XML_STREAM_MIN_FILES") ?? 20000;
const UFDR_XML_IN_MEMORY_MAX_CHARS = parseOptionalPositiveIntEnv("UFDR_XML_IN_MEMORY_MAX_CHARS") ?? 8_000_000;
const UFDR_FORCE_XML_STREAM = !["0", "false", "no", "off"].includes(
  (process.env.UFDR_FORCE_XML_STREAM ?? "true").trim().toLowerCase()
);
const WORKER_INGEST_DEBUG_PHASES = ["1", "true", "yes", "on"].includes(
  (process.env.WORKER_INGEST_DEBUG_PHASES ?? "").trim().toLowerCase()
);
type OperationalAlertSeverity = "INFO" | "WARN" | "CRITICAL";
type OperationalAlert = {
  code: string;
  severity: OperationalAlertSeverity;
  message: string;
};

type ExtractedAudioArtifact = {
  archivePath: string;
  fileName: string;
  absolutePath: string;
  sizeBytes: number;
  chatExternalId?: string;
  messageExternalId?: string;
};

type AudioExtractionHintRow = {
  archivePath?: string;
  fileName?: string;
  timestamp?: string;
  senderExternalId?: string;
  chatExternalId?: string;
  messageExternalId?: string;
};

const OPUS_EXT_RE = /\.opus$/i;
type AttachmentMediaKind = "pdf" | "image" | "video" | "audio" | "other";

const ATTACHMENT_IMAGE_EXT_RE = /\.(jpe?g|png|webp|bmp|heic|heif|gif)$/i;
const ATTACHMENT_VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|3gp|webm|avi|wmv|flv)$/i;
const ATTACHMENT_AUDIO_EXT_RE = /\.(aac|amr|flac|m4a|mp3|ogg|opus|wav|wma)$/i;
const ATTACHMENT_PDF_EXT_RE = /\.pdf$/i;
const ATTACHMENT_GIF_EXT_RE = /\.gif$/i;
const ATTACHMENT_STICKER_NAME_RE = /(^|[\\/])STK-[0-9]{8}-WA\d+\.webp$/i;
const ATTACHMENT_MIN_IMAGE_BYTES_DEFAULT = 12 * 1024;
const ATTACHMENT_MIN_STICKER_BYTES_DEFAULT = 24 * 1024;
const ATTACHMENT_MIN_PDF_BYTES_DEFAULT = 5 * 1024;
const ATTACHMENT_MIN_IMAGE_WIDTH_DEFAULT = 300;
const ATTACHMENT_MIN_IMAGE_HEIGHT_DEFAULT = 300;
const ATTACHMENT_MIN_VIDEO_SECONDS_DEFAULT = 2;

type AttachmentQualityStatus = "AUDITABLE" | "REVIEWABLE" | "DISCARDED";
type AttachmentQualityDecision = {
  status: AttachmentQualityStatus;
  score: number;
  reason: string;
  kind: AttachmentMediaKind;
  width?: number;
  height?: number;
  durationSeconds?: number;
  pages?: number;
  textLength?: number;
  bytes?: number;
  auditCachePath?: string;
  ocrCandidate?: boolean;
};

function hasOpusExtension(value?: string | null) {
  if (!value) return false;
  return OPUS_EXT_RE.test(value.trim());
}

function normalizeAttachmentIndexValue(value?: string | null) {
  return (value ?? "").trim().toLowerCase();
}

function attachmentBasenameLower(filePath: string) {
  return path.basename(filePath).trim().toLowerCase();
}

function pickBestAttachmentArchiveMatch(fileName: string, candidates: string[]) {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const lower = fileName.trim().toLowerCase();
  return (
    candidates.find((entry) => /(^|[\\/])files[\\/]/i.test(entry)) ??
    candidates.find((entry) => entry.toLowerCase().includes("/files/")) ??
    candidates.find((entry) => entry.toLowerCase().includes("\\files\\")) ??
    candidates.find((entry) => entry.toLowerCase().endsWith(lower)) ??
    candidates[0]
  );
}

function detectAttachmentMediaKind(input: { mimeType?: string | null; fileName?: string | null; archivePath?: string | null }) {
  const mime = normalizeAttachmentIndexValue(input.mimeType);
  const ref = `${input.fileName ?? ""} ${input.archivePath ?? ""}`.trim();
  if (mime === "application/pdf" || ATTACHMENT_PDF_EXT_RE.test(ref)) return "pdf" satisfies AttachmentMediaKind;
  if (mime === "image" || mime.startsWith("image/") || ATTACHMENT_IMAGE_EXT_RE.test(ref)) {
    return "image" satisfies AttachmentMediaKind;
  }
  if (mime === "video" || mime.startsWith("video/") || ATTACHMENT_VIDEO_EXT_RE.test(ref)) {
    return "video" satisfies AttachmentMediaKind;
  }
  if (mime === "voice message" || mime.startsWith("audio/") || ATTACHMENT_AUDIO_EXT_RE.test(ref)) {
    return "audio" satisfies AttachmentMediaKind;
  }
  return "other" satisfies AttachmentMediaKind;
}

function isAttachmentGifMedia(input: { mimeType?: string | null; fileName?: string | null; archivePath?: string | null }) {
  const mime = normalizeAttachmentIndexValue(input.mimeType);
  const ref = `${input.fileName ?? ""} ${input.archivePath ?? ""}`.trim();
  return mime === "image/gif" || ATTACHMENT_GIF_EXT_RE.test(ref);
}

function parsePositiveAttachmentIntEnv(name: string, fallback: number) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function shouldDiscardTinyAttachmentImage(input: {
  fileName?: string | null;
  archivePath?: string | null;
  sizeBytes?: bigint | null;
}) {
  const rawSize = Number(input.sizeBytes ?? 0n);
  if (!Number.isFinite(rawSize) || rawSize <= 0) return false;

  const minImageBytes = parsePositiveAttachmentIntEnv("ATTACHMENT_IMAGE_MIN_BYTES", ATTACHMENT_MIN_IMAGE_BYTES_DEFAULT);
  const minStickerBytes = parsePositiveAttachmentIntEnv(
    "ATTACHMENT_STICKER_MIN_BYTES",
    ATTACHMENT_MIN_STICKER_BYTES_DEFAULT
  );
  const ref = `${input.fileName ?? ""} ${input.archivePath ?? ""}`.trim();
  const isStickerLike = ATTACHMENT_STICKER_NAME_RE.test(ref) || /(^|[\\/])stickers?([\\/]|$)/i.test(ref);
  return rawSize < (isStickerLike ? minStickerBytes : minImageBytes);
}

function isMessagingAttachmentSourceApp(value?: string | null) {
  const source = normalizeAttachmentIndexValue(value);
  return Boolean(source && /(whatsapp|telegram|signal|messenger|facebook|instagram|imessage|sms|mms|wechat|viber)/i.test(source));
}

function isMessagingAttachmentPath(value?: string | null) {
  const row = normalizeAttachmentIndexValue(value);
  return Boolean(row && /(whatsapp|telegram|messenger|instagram|facebook|messages?|chats?|conversation|inbox|media)/i.test(row));
}

function isLikelyAttachmentCameraPath(value?: string | null) {
  const row = normalizeAttachmentIndexValue(value);
  return Boolean(row && /(dcim|camera|cameraroll|camera roll|100andro|\bimg[_-]?\d+|\bdsc[_-]?\d+)/i.test(row));
}

function isLikelyAttachmentGamePath(value?: string | null) {
  const row = normalizeAttachmentIndexValue(value);
  return Boolean(row && /(games?|jogos?|unity|unreal|minecraft|roblox|free ?fire|pubg|fortnite|callofduty|codm)/i.test(row));
}

function isLikelyAttachmentScreenshotPath(value?: string | null) {
  const row = normalizeAttachmentIndexValue(value);
  return Boolean(row && /(screenshot|screen[_ -]?shot|screenrecord|screen[_ -]?record|captura de tela|print[_ -]?screen)/i.test(row));
}

function hasAttachmentBankTransferSignal(value?: string | null) {
  const row = normalizeAttachmentIndexValue(value);
  return Boolean(
    row &&
      /(pix|ted|doc|transfer|transferencia|comprovante|pagamento|deposito|bank|banco|nubank|itau|bradesco|santander|caixa|bb\b)/i.test(
        row
      )
  );
}

function shouldIndexAttachmentByPolicy(input: {
  mimeType?: string | null;
  fileName?: string | null;
  archivePath?: string | null;
  sizeBytes?: bigint | null;
  sourceApp?: string | null;
  messageBody?: string | null;
}) {
  const kind = detectAttachmentMediaKind(input);
  const joinedSignals = `${input.fileName ?? ""} ${input.archivePath ?? ""} ${input.messageBody ?? ""}`;
  const messaging = isMessagingAttachmentSourceApp(input.sourceApp) || isMessagingAttachmentPath(input.archivePath);
  const camera = isLikelyAttachmentCameraPath(input.archivePath) || isLikelyAttachmentCameraPath(input.fileName);
  const screenshot = isLikelyAttachmentScreenshotPath(input.archivePath) || isLikelyAttachmentScreenshotPath(input.fileName);
  const game = isLikelyAttachmentGamePath(input.archivePath) || isLikelyAttachmentGamePath(input.fileName);
  const bankLike = hasAttachmentBankTransferSignal(joinedSignals);

  if (kind === "pdf" || kind === "audio" || kind === "other") return { allowed: true as const, kind };
  if (kind === "image") {
    if (isAttachmentGifMedia(input)) return { allowed: false as const, kind, reason: "IMAGE_GIF_DISCARDED" };
    if (shouldDiscardTinyAttachmentImage(input)) {
      return { allowed: false as const, kind, reason: "IMAGE_TOO_SMALL_DISCARDED" };
    }
    if (camera || screenshot || bankLike) return { allowed: true as const, kind };
    return { allowed: false as const, kind, reason: "IMAGE_NOT_RELEVANT_POLICY" };
  }
  if (kind === "video") {
    if (game) return { allowed: false as const, kind, reason: "VIDEO_GAME_PATH_DISCARDED" };
    if (camera || screenshot || messaging) return { allowed: true as const, kind };
    return { allowed: false as const, kind, reason: "VIDEO_NON_RELEVANT_PATH_DISCARDED" };
  }
  return { allowed: true as const, kind };
}

function safeAttachmentCacheName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readUInt24LE(buffer: Buffer, offset: number) {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8) + ((buffer[offset + 2] ?? 0) << 16);
}

function readJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return {};
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return {};
}

function readPngDimensions(buffer: Buffer) {
  if (buffer.length < 24) return {};
  if (buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return {};
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function readWebpDimensions(buffer: Buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return {};
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + readUInt24LE(buffer, 24),
      height: 1 + readUInt24LE(buffer, 27)
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const b0 = buffer[21] ?? 0;
    const b1 = buffer[22] ?? 0;
    const b2 = buffer[23] ?? 0;
    const b3 = buffer[24] ?? 0;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    };
  }
  return {};
}

function readImageDimensions(buffer: Buffer, fileName?: string | null) {
  const ext = path.extname(fileName ?? "").toLowerCase();
  if (ext === ".png") return readPngDimensions(buffer);
  if (ext === ".jpg" || ext === ".jpeg") return readJpegDimensions(buffer);
  if (ext === ".webp") return readWebpDimensions(buffer);
  return readPngDimensions(buffer).width ? readPngDimensions(buffer) : readJpegDimensions(buffer);
}

function stripPdfTextNoise(value: string) {
  return value
    .replace(/\\[()\\]/g, "")
    .replace(/\\[nrtbf]/g, " ")
    .replace(/[^\p{L}\p{N}@._:/ -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inspectPdfBytes(buffer: Buffer) {
  const ascii = buffer.toString("latin1");
  const pages = Math.max(0, (ascii.match(/\/Type\s*\/Page\b/g) ?? []).length);
  const snippets: string[] = [];
  const literalRe = /\(([^()]{3,500})\)/g;
  let match: RegExpExecArray | null;
  while ((match = literalRe.exec(ascii)) && snippets.join(" ").length < 8000) {
    snippets.push(match[1] ?? "");
  }
  const text = stripPdfTextNoise(snippets.join(" "));
  return {
    pages,
    textLength: text.length
  };
}

function resolveFfprobeBin() {
  const ffmpeg = process.env.FFMPEG_BIN;
  if (!ffmpeg) return "ffprobe";
  const dir = path.dirname(ffmpeg);
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.resolve(dir, `ffprobe${ext}`);
}

async function runFfprobeMetadata(filePath: string): Promise<{ width?: number; height?: number; durationSeconds?: number; codecName?: string }> {
  const ffprobeBin = resolveFfprobeBin();
  return new Promise((resolve) => {
    const child = spawn(ffprobeBin, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height:format=duration",
      "-of",
      "json",
      filePath
    ]);
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.on("error", () => resolve({}));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const stream = parsed.streams?.[0];
        const duration = Number(parsed.format?.duration);
        resolve({
          width: typeof stream?.width === "number" ? stream.width : undefined,
          height: typeof stream?.height === "number" ? stream.height : undefined,
          durationSeconds: Number.isFinite(duration) ? duration : undefined,
          codecName: typeof stream?.codec_name === "string" ? stream.codec_name : undefined
        });
      } catch {
        resolve({});
      }
    });
  });
}

async function ensureAttachmentAuditCache(input: {
  ufdrAbsolutePath: string;
  caseId: string;
  evidenceId: string;
  attachmentId: string;
  archivePath: string;
  fileName: string;
}) {
  const storageRoot = resolveStorageRoot();
  const cacheDir = path.resolve(storageRoot, "derived", input.caseId, input.evidenceId, "attachment-audit-cache");
  await mkdir(cacheDir, { recursive: true });
  const extension = path.extname(input.fileName) || path.extname(input.archivePath);
  const cacheName = `${input.attachmentId}-${safeAttachmentCacheName(path.basename(input.fileName, path.extname(input.fileName)))}${extension}`;
  const outputPath = path.resolve(cacheDir, cacheName);
  const existing = await stat(outputPath).catch(() => null);
  if (existing?.isFile() && existing.size > 0) return outputPath;
  await extractArchiveEntryToFile({
    ufdrAbsolutePath: input.ufdrAbsolutePath,
    entryPath: input.archivePath,
    outputPath
  });
  return outputPath;
}

function buildQualityMetadata(current: unknown, decision: AttachmentQualityDecision, source: string) {
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  return {
    ...base,
    quality: {
      status: decision.status,
      score: decision.score,
      reason: decision.reason,
      kind: decision.kind,
      width: decision.width ?? null,
      height: decision.height ?? null,
      durationSeconds: decision.durationSeconds ?? null,
      pages: decision.pages ?? null,
      textLength: decision.textLength ?? null,
      bytes: decision.bytes ?? null,
      auditCachePath: decision.auditCachePath ?? null,
      ocrCandidate: decision.ocrCandidate ?? false,
      checkedAt: new Date().toISOString(),
      checkedBy: source
    }
  };
}

async function analyzeAttachmentQuality(input: {
  ufdrAbsolutePath: string;
  caseId: string;
  evidenceId: string;
  attachmentId: string;
  mimeType?: string | null;
  fileName?: string | null;
  archivePath: string;
  sizeBytes?: bigint | null;
  sourceApp?: string | null;
  messageBody?: string | null;
}) {
  const kind = detectAttachmentMediaKind(input);
  const joinedSignals = `${input.fileName ?? ""} ${input.archivePath} ${input.messageBody ?? ""}`;
  const messaging = isMessagingAttachmentSourceApp(input.sourceApp) || isMessagingAttachmentPath(input.archivePath);
  const camera = isLikelyAttachmentCameraPath(input.archivePath) || isLikelyAttachmentCameraPath(input.fileName);
  const screenshot = isLikelyAttachmentScreenshotPath(input.archivePath) || isLikelyAttachmentScreenshotPath(input.fileName);
  const bankLike = hasAttachmentBankTransferSignal(joinedSignals);
  const bytesFromDb = Number(input.sizeBytes ?? 0n);
  const baseDecision = (decision: Omit<AttachmentQualityDecision, "kind" | "bytes">): AttachmentQualityDecision => ({
    ...decision,
    kind,
    bytes: Number.isFinite(bytesFromDb) && bytesFromDb > 0 ? bytesFromDb : undefined
  });

  if (kind === "audio") return baseDecision({ status: "AUDITABLE", score: 0.9, reason: "AUDIO_INDEXED" });
  if (kind === "other") return baseDecision({ status: "REVIEWABLE", score: 0.45, reason: "UNKNOWN_FILE_TYPE_REVIEW" });

  if (kind === "image") {
    if (isAttachmentGifMedia(input)) return baseDecision({ status: "DISCARDED", score: 0.02, reason: "IMAGE_GIF_DISCARDED" });
    if (ATTACHMENT_STICKER_NAME_RE.test(joinedSignals) || /(^|[\\/])stickers?([\\/]|$)|\bsticker\b|emoji/i.test(joinedSignals)) {
      return baseDecision({ status: "DISCARDED", score: 0.01, reason: "WHATSAPP_STICKER_OR_EMOJI" });
    }
    if (/(^|[\\/])(thumbs?|thumbnails?|cache|icons?|avatars?|profile)([\\/]|$)|\b(icon|thumbnail|avatar|profile|cache)\b/i.test(joinedSignals)) {
      return baseDecision({ status: "DISCARDED", score: 0.03, reason: "IMAGE_ICON_THUMBNAIL_CACHE" });
    }

    const auditCachePath = await ensureAttachmentAuditCache({
      ufdrAbsolutePath: input.ufdrAbsolutePath,
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      attachmentId: input.attachmentId,
      archivePath: input.archivePath,
      fileName: input.fileName ?? path.basename(input.archivePath)
    }).catch(() => undefined);
    const info = auditCachePath ? await stat(auditCachePath).catch(() => null) : null;
    const bytes = info?.size ?? (Number.isFinite(bytesFromDb) ? bytesFromDb : undefined);
    const buffer = auditCachePath ? await readFile(auditCachePath).catch(() => null) : null;
    const dimensions = buffer ? readImageDimensions(buffer, input.fileName ?? input.archivePath) : {};
    const minWidth = parsePositiveAttachmentIntEnv("ATTACHMENT_IMAGE_MIN_WIDTH", ATTACHMENT_MIN_IMAGE_WIDTH_DEFAULT);
    const minHeight = parsePositiveAttachmentIntEnv("ATTACHMENT_IMAGE_MIN_HEIGHT", ATTACHMENT_MIN_IMAGE_HEIGHT_DEFAULT);
    const minBytes = parsePositiveAttachmentIntEnv("ATTACHMENT_IMAGE_MIN_BYTES", ATTACHMENT_MIN_IMAGE_BYTES_DEFAULT);
    if (bytes && bytes < minBytes) {
      return { ...baseDecision({ status: "DISCARDED", score: 0.05, reason: "IMAGE_TOO_SMALL_DISCARDED" }), ...dimensions, bytes, auditCachePath };
    }
    if (dimensions.width && dimensions.height && (dimensions.width < minWidth || dimensions.height < minHeight)) {
      return {
        ...baseDecision({ status: "DISCARDED", score: 0.06, reason: "IMAGE_LOW_RESOLUTION_DISCARDED" }),
        ...dimensions,
        bytes,
        auditCachePath
      };
    }
    if (camera || screenshot || bankLike) {
      return {
        ...baseDecision({ status: "AUDITABLE", score: bankLike ? 0.95 : 0.86, reason: bankLike ? "IMAGE_BANK_OR_PAYMENT_SIGNAL" : "IMAGE_VISUAL_EVIDENCE_SIGNAL" }),
        ...dimensions,
        bytes,
        auditCachePath,
        ocrCandidate: true
      };
    }
    return {
      ...baseDecision({ status: "REVIEWABLE", score: 0.52, reason: "IMAGE_VISIBLE_REVIEW_REQUIRED" }),
      ...dimensions,
      bytes,
      auditCachePath,
      ocrCandidate: true
    };
  }

  if (kind === "pdf") {
    const auditCachePath = await ensureAttachmentAuditCache({
      ufdrAbsolutePath: input.ufdrAbsolutePath,
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      attachmentId: input.attachmentId,
      archivePath: input.archivePath,
      fileName: input.fileName ?? path.basename(input.archivePath)
    }).catch(() => undefined);
    const info = auditCachePath ? await stat(auditCachePath).catch(() => null) : null;
    const bytes = info?.size ?? (Number.isFinite(bytesFromDb) ? bytesFromDb : undefined);
    const minBytes = parsePositiveAttachmentIntEnv("ATTACHMENT_PDF_MIN_BYTES", ATTACHMENT_MIN_PDF_BYTES_DEFAULT);
    if (bytes && bytes < minBytes) {
      return { ...baseDecision({ status: "DISCARDED", score: 0.04, reason: "PDF_TOO_SMALL_DISCARDED" }), bytes, auditCachePath };
    }
    const buffer = auditCachePath ? await readFile(auditCachePath).catch(() => null) : null;
    const pdf = buffer ? inspectPdfBytes(buffer) : { pages: 0, textLength: 0 };
    if (pdf.pages === 0 && pdf.textLength === 0) {
      return { ...baseDecision({ status: "DISCARDED", score: 0.03, reason: "PDF_EMPTY_OR_UNREADABLE" }), ...pdf, bytes, auditCachePath };
    }
    if (pdf.textLength >= 80 || bankLike) {
      return {
        ...baseDecision({ status: "AUDITABLE", score: bankLike ? 0.96 : 0.82, reason: bankLike ? "PDF_BANK_OR_PAYMENT_SIGNAL" : "PDF_TEXT_EXTRACTABLE" }),
        ...pdf,
        bytes,
        auditCachePath,
        ocrCandidate: pdf.textLength < 300
      };
    }
    return {
      ...baseDecision({ status: "REVIEWABLE", score: 0.55, reason: "PDF_NEEDS_OCR_OR_MANUAL_REVIEW" }),
      ...pdf,
      bytes,
      auditCachePath,
      ocrCandidate: true
    };
  }

  if (kind === "video") {
    if (isLikelyAttachmentGamePath(input.archivePath) || isLikelyAttachmentGamePath(input.fileName)) {
      return baseDecision({ status: "DISCARDED", score: 0.04, reason: "VIDEO_GAME_PATH_DISCARDED" });
    }
    const auditCachePath = await ensureAttachmentAuditCache({
      ufdrAbsolutePath: input.ufdrAbsolutePath,
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      attachmentId: input.attachmentId,
      archivePath: input.archivePath,
      fileName: input.fileName ?? path.basename(input.archivePath)
    }).catch(() => undefined);
    const info = auditCachePath ? await stat(auditCachePath).catch(() => null) : null;
    const video = auditCachePath ? await runFfprobeMetadata(auditCachePath) : {};
    const minSeconds = parsePositiveAttachmentIntEnv("ATTACHMENT_VIDEO_MIN_SECONDS", ATTACHMENT_MIN_VIDEO_SECONDS_DEFAULT);
    const videoBytes = info?.size ?? (Number.isFinite(bytesFromDb) ? bytesFromDb : undefined);
    if (videoBytes && videoBytes < 16 * 1024) {
      return {
        ...baseDecision({ status: "DISCARDED", score: 0.04, reason: "VIDEO_TOO_SMALL_OR_THUMBNAIL_DISCARDED" }),
        ...video,
        bytes: videoBytes,
        auditCachePath
      };
    }
    if (!video.durationSeconds && video.codecName === "mjpeg") {
      return {
        ...baseDecision({ status: "DISCARDED", score: 0.04, reason: "VIDEO_MJPEG_THUMBNAIL_DISCARDED" }),
        ...video,
        bytes: videoBytes,
        auditCachePath
      };
    }
    if (video.durationSeconds !== undefined && video.durationSeconds < minSeconds) {
      return {
        ...baseDecision({ status: "DISCARDED", score: 0.08, reason: "VIDEO_TOO_SHORT_DISCARDED" }),
        ...video,
        bytes: videoBytes,
        auditCachePath
      };
    }
    if (video.width && video.height && (video.width < 240 || video.height < 240)) {
      return {
        ...baseDecision({ status: "DISCARDED", score: 0.08, reason: "VIDEO_LOW_RESOLUTION_DISCARDED" }),
        ...video,
        bytes: videoBytes,
        auditCachePath
      };
    }
    if (messaging || camera || screenshot) {
      return {
        ...baseDecision({ status: "AUDITABLE", score: 0.82, reason: "VIDEO_VISUAL_EVIDENCE_SIGNAL" }),
        ...video,
        bytes: videoBytes,
        auditCachePath
      };
    }
    return {
      ...baseDecision({ status: "REVIEWABLE", score: 0.5, reason: "VIDEO_REVIEW_REQUIRED" }),
      ...video,
      bytes: videoBytes,
      auditCachePath
    };
  }

  return baseDecision({ status: "REVIEWABLE", score: 0.45, reason: "REVIEW_REQUIRED" });
}

function markAttachmentMissingInExtraction(current: unknown, source: string) {
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

function markAttachmentExcludedByPolicy(current: unknown, source: string, reason: string) {
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

async function indexAttachmentArchivePathsForEvidence(input: {
  caseId: string;
  evidenceId: string;
  extractionId?: string;
  ufdrAbsolutePath: string;
  scannedFiles: string[];
  source: string;
}) {
  const attachments = await prisma.attachment.findMany({
    where: {
      evidenceId: input.evidenceId
    },
    select: {
      id: true,
      caseId: true,
      evidenceId: true,
      fileName: true,
      archivePath: true,
      mimeType: true,
      sizeBytes: true,
      metadata: true,
      message: {
        select: {
          body: true,
          chat: { select: { sourceApp: true } }
        }
      }
    }
  });

  const byBasename = new Map<string, string[]>();
  for (const entry of input.scannedFiles) {
    const key = attachmentBasenameLower(entry);
    if (!key) continue;
    const list = byBasename.get(key) ?? [];
    list.push(entry);
    byBasename.set(key, list);
  }

  let indexed = 0;
  let unresolved = 0;
  let excludedByPolicy = 0;
  let ambiguous = 0;
  let auditable = 0;
  let reviewable = 0;
  let discardedByQuality = 0;
  let ocrQueued = 0;

  for (const attachment of attachments) {
    const initialKind = detectAttachmentMediaKind(attachment);
    if (initialKind === "audio") continue;

    const filenameForMatch = attachment.fileName?.trim();
    if (!filenameForMatch && !attachment.archivePath?.trim()) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          metadata: markAttachmentMissingInExtraction(attachment.metadata, input.source) as Prisma.InputJsonValue
        }
      });
      unresolved += 1;
      continue;
    }

    const candidates = filenameForMatch ? (byBasename.get(filenameForMatch.toLowerCase()) ?? []) : [];
    if (candidates.length > 1) ambiguous += 1;
    const chosen = attachment.archivePath?.trim() || (filenameForMatch ? pickBestAttachmentArchiveMatch(filenameForMatch, candidates) : undefined);
    if (!chosen) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          metadata: markAttachmentMissingInExtraction(attachment.metadata, input.source) as Prisma.InputJsonValue
        }
      });
      unresolved += 1;
      continue;
    }

    const indexedMetadata = {
      ...((attachment.metadata as Record<string, unknown> | null) ?? {}),
      indexedArchivePathAt: new Date().toISOString(),
      indexedArchivePathBy: input.source
    };
    const policy = shouldIndexAttachmentByPolicy({
      mimeType: attachment.mimeType,
      fileName: attachment.fileName ?? filenameForMatch ?? path.basename(chosen),
      archivePath: chosen,
      sizeBytes: attachment.sizeBytes,
      sourceApp: attachment.message?.chat?.sourceApp,
      messageBody: attachment.message?.body
    });
    let quality: AttachmentQualityDecision;
    try {
      quality = await analyzeAttachmentQuality({
        ufdrAbsolutePath: input.ufdrAbsolutePath,
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        attachmentId: attachment.id,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName ?? filenameForMatch ?? path.basename(chosen),
        archivePath: chosen,
        sizeBytes: attachment.sizeBytes,
        sourceApp: attachment.message?.chat?.sourceApp,
        messageBody: attachment.message?.body
      });
    } catch (error) {
      quality = {
        status: "REVIEWABLE",
        score: 0.4,
        reason: error instanceof Error ? `QUALITY_ANALYSIS_FAILED: ${error.message.slice(0, 120)}` : "QUALITY_ANALYSIS_FAILED",
        kind: detectAttachmentMediaKind({ mimeType: attachment.mimeType, fileName: attachment.fileName, archivePath: chosen }),
        bytes: Number(attachment.sizeBytes ?? 0n) || undefined
      };
    }

    if (!policy.allowed || quality.status === "DISCARDED") {
      const reason = !policy.allowed ? policy.reason : quality.reason;
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          archivePath: null,
          fileName: attachment.fileName ?? filenameForMatch ?? path.basename(chosen),
          metadata: markAttachmentExcludedByPolicy(
            buildQualityMetadata(
              {
                ...indexedMetadata,
                indexedArchivePathCandidate: chosen
              },
              quality.status === "DISCARDED" ? quality : { ...quality, status: "DISCARDED", reason: reason ?? quality.reason },
              input.source
            ),
            input.source,
            reason ?? quality.reason
          ) as Prisma.InputJsonValue
        }
      });
      if (!policy.allowed) excludedByPolicy += 1;
      else discardedByQuality += 1;
      continue;
    }

    await prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        archivePath: chosen,
        fileName: attachment.fileName ?? filenameForMatch ?? path.basename(chosen),
        metadata: buildQualityMetadata(indexedMetadata, quality, input.source) as Prisma.InputJsonValue
      }
    });
    if (quality.status === "AUDITABLE") auditable += 1;
    if (quality.status === "REVIEWABLE") reviewable += 1;
    if (quality.ocrCandidate && quality.auditCachePath && (quality.kind === "image" || quality.kind === "pdf")) {
      const existingOcr = await prisma.ocrDocument.findFirst({
        where: {
          attachmentId: attachment.id,
          sourcePath: quality.auditCachePath
        },
        select: { id: true }
      });
      if (!existingOcr) {
        await enqueueOcrDocument({
          caseId: input.caseId,
          evidenceId: input.evidenceId,
          extractionId: input.extractionId,
          attachmentId: attachment.id,
          sourcePath: quality.auditCachePath,
          language: "por"
        }).catch(() => "");
        ocrQueued += 1;
      }
    }
    indexed += 1;
  }

  return {
    processed: attachments.length,
    indexed,
    unresolved,
    excludedByPolicy,
    discardedByQuality,
    auditable,
    reviewable,
    ocrQueued,
    ambiguous
  };
}

function isWhatsAppSourceApp(value?: string | null) {
  if (!value) return false;
  return value.trim().toLowerCase().includes("whatsapp");
}

function isWhatsAppArchivePath(value?: string | null) {
  if (!value) return false;
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/com.whatsapp/") || normalized.includes("/whatsapp/");
}

function isUfdrFilePath(value: string) {
  return value.toLowerCase().endsWith(".ufdr");
}

async function calculateDirectorySizeBytes(rootDir: string): Promise<number> {
  let total = 0;
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.resolve(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const info = await stat(abs);
      total += Number(info.size);
    }
  }
  await walk(rootDir);
  return total;
}

async function collectUfdrFiles(rootDir: string, maxResults = 5) {
  const matches: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0 && matches.length < maxResults) {
    const current = stack.pop();
    if (!current) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && isUfdrFilePath(entry.name)) {
        matches.push(abs);
        if (matches.length >= maxResults) break;
      }
    }
  }
  return matches;
}

async function resolveOriginalUfdrPath(input: {
  sourcePath: string;
  sourceIsDirectory: boolean;
  explicitPath?: string;
}) {
  if (!input.sourceIsDirectory) return input.sourcePath;
  if (input.explicitPath) {
    if (!path.isAbsolute(input.explicitPath)) throw new Error("originalUfdrFilePath deve ser absoluto.");
    if (!isUfdrFilePath(input.explicitPath)) throw new Error("originalUfdrFilePath deve apontar para arquivo .ufdr.");
    const info = await stat(input.explicitPath);
    if (!info.isFile()) throw new Error("originalUfdrFilePath nao aponta para arquivo valido.");
    return input.explicitPath;
  }
  const found = await collectUfdrFiles(input.sourcePath, 3);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw new Error(
      "Hash obrigatorio do UFDR original: nenhum arquivo .ufdr encontrado na pasta informada. Informe originalUfdrFilePath."
    );
  }
  throw new Error(
    "Hash obrigatorio do UFDR original: multiplos arquivos .ufdr encontrados. Informe originalUfdrPath para desambiguar."
  );
}

function publicRuntimeDetails(runtimeDetails: LocalUfdrImportJob["transcriptionRuntime"]) {
  return {
    enabled: runtimeDetails?.enabled ?? true,
    engine: runtimeDetails?.engine ?? "local",
    model: runtimeDetails?.model ?? null,
    language: runtimeDetails?.language ?? null
  };
}

type TranscriptionEligibility = {
  eligible: boolean;
  sourceApp?: string | null;
  reason?: string;
};

async function buildAttachmentTranscriptionEligibilityMap(
  attachmentIds: string[]
): Promise<Map<string, TranscriptionEligibility>> {
  const uniqueIds = [...new Set(attachmentIds.map((value) => value.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const rows = await prisma.attachment.findMany({
    where: { id: { in: uniqueIds } },
    select: {
      id: true,
      fileName: true,
      archivePath: true,
      message: {
        select: {
          chat: {
            select: {
              sourceApp: true
            }
          }
        }
      }
    }
  });

  const map = new Map<string, TranscriptionEligibility>();
  for (const row of rows) {
    const sourceApp = row.message?.chat?.sourceApp ?? null;
    const opusByMetadata = hasOpusExtension(row.fileName) || hasOpusExtension(row.archivePath);
    if (!opusByMetadata) {
      map.set(row.id, {
        eligible: false,
        sourceApp,
        reason: "Descartado pela politica: somente arquivos .opus sao transcritos."
      });
      continue;
    }

    map.set(row.id, { eligible: true, sourceApp });
  }

  return map;
}

function severityRank(severity: OperationalAlertSeverity) {
  if (severity === "CRITICAL") return 3;
  if (severity === "WARN") return 2;
  return 1;
}

function buildOperationalAlertSnapshot(input: {
  audioCapReached: boolean;
  audioExtractedCount: number;
  audioMaxFiles?: number;
  audioTimeoutManualReviewRequired?: boolean;
  audioExtractionTimeoutMs?: number;
  audioExtractionLastArchivePath?: string | null;
  parserDropped: { chats?: number; messages?: number; audioFiles?: number };
}) {
  const alerts: OperationalAlert[] = [];
  if (input.audioCapReached) {
    alerts.push({
      code: "AUDIO_CAP_REACHED",
      severity: "WARN",
      message: `Limite de audios atingido (${input.audioExtractedCount}/${input.audioMaxFiles ?? "N/D"}).`
    });
  }
  if ((input.parserDropped.messages ?? 0) > 0) {
    alerts.push({
      code: "PARSER_DROPPED_MESSAGES",
      severity: "CRITICAL",
      message: `Parser descartou ${input.parserDropped.messages} mensagens por limite configurado.`
    });
  }
  if ((input.parserDropped.chats ?? 0) > 0) {
    alerts.push({
      code: "PARSER_DROPPED_CHATS",
      severity: "CRITICAL",
      message: `Parser descartou ${input.parserDropped.chats} chats por limite configurado.`
    });
  }
  if ((input.parserDropped.audioFiles ?? 0) > 0) {
    alerts.push({
      code: "PARSER_DROPPED_AUDIO_FILES",
      severity: "WARN",
      message: `Parser descartou ${input.parserDropped.audioFiles} arquivos de audio por limite configurado.`
    });
  }
  if (input.audioTimeoutManualReviewRequired) {
    alerts.push({
      code: "AUDIO_EXTRACTION_TIMEOUT",
      severity: "WARN",
      message: `Extracao de audios excedeu o timeout (${input.audioExtractionTimeoutMs ?? "N/D"}ms). Revisao manual necessaria.${input.audioExtractionLastArchivePath ? ` Ultimo arquivo processado: ${input.audioExtractionLastArchivePath}.` : ""}`
    });
  }

  const highestSeverity = alerts.reduce<OperationalAlertSeverity | null>((current, alert) => {
    if (!current) return alert.severity;
    return severityRank(alert.severity) > severityRank(current) ? alert.severity : current;
  }, null);

  return {
    generatedAt: new Date().toISOString(),
    highestSeverity,
    alerts
  };
}

async function withOptionalTimeout<T>(input: {
  label: string;
  timeoutMs?: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  if (!input.timeoutMs || input.timeoutMs <= 0) {
    return input.run(controller.signal);
  }
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${input.label} excedeu o tempo limite de ${input.timeoutMs}ms.`));
      }, input.timeoutMs);
    });
    return await Promise.race([input.run(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const AUDIO_ENTRY_EXTENSIONS = new Set([".aac", ".amr", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".wma"]);

function normalizeAudioArchivePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function isAudioArchivePath(value: string) {
  const ext = path.extname(value).toLowerCase();
  return AUDIO_ENTRY_EXTENSIONS.has(ext);
}

type ResolvedRecoveryTarget = {
  entryPath: string;
  archivePath: string;
  fileName?: string;
  timestamp?: string;
  senderExternalId?: string;
  chatExternalId?: string;
  messageExternalId?: string;
};

type ProcessingDetailsRecord = Record<string, unknown>;

function toProcessingDetailsRecord(value: unknown): ProcessingDetailsRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ProcessingDetailsRecord;
}

function readNumberFromDetails(details: ProcessingDetailsRecord, field: string, fallback = 0) {
  const raw = details[field];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readStringFromDetails(details: ProcessingDetailsRecord, field: string): string | undefined {
  const raw = details[field];
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  return undefined;
}

function readNumberArrayFromDetails(details: ProcessingDetailsRecord, field: string) {
  const raw = details[field];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0);
}

function parseDateMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roundedMetric(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function sqlNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isAudioRecoveryResumeDetails(details: ProcessingDetailsRecord) {
  const phase = readStringFromDetails(details, "phase") ?? "";
  return (
    details.resumeMode === "audio-recovery" ||
    details.audioRecoveryAsync === true ||
    phase.includes("audio-recovery")
  );
}

type AudioRecoveryCheckpointBaseline = {
  capturedAt: string;
  completedBatches: number[];
  batchProcessed: number;
  targetProcessedCount: number;
  extractedCount: number;
  skippedTimeoutCount: number;
  skippedErrorCount: number;
  transcriptionQueuedCount: number;
  transcriptionSkippedMissingCount: number;
  transcriptionSkippedPolicyCount: number;
};

function readCheckpointBaseline(details: ProcessingDetailsRecord): AudioRecoveryCheckpointBaseline | undefined {
  const raw = details.audioRecoveryCheckpointBaseline;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as ProcessingDetailsRecord;
  return {
    capturedAt:
      typeof record.capturedAt === "string" && record.capturedAt.trim().length > 0
        ? record.capturedAt
        : new Date().toISOString(),
    completedBatches: readNumberArrayFromDetails(record, "completedBatches"),
    batchProcessed: readNumberFromDetails(record, "batchProcessed", 0),
    targetProcessedCount: readNumberFromDetails(record, "targetProcessedCount", 0),
    extractedCount: readNumberFromDetails(record, "extractedCount", 0),
    skippedTimeoutCount: readNumberFromDetails(record, "skippedTimeoutCount", 0),
    skippedErrorCount: readNumberFromDetails(record, "skippedErrorCount", 0),
    transcriptionQueuedCount: readNumberFromDetails(record, "transcriptionQueuedCount", 0),
    transcriptionSkippedMissingCount: readNumberFromDetails(record, "transcriptionSkippedMissingCount", 0),
    transcriptionSkippedPolicyCount: readNumberFromDetails(record, "transcriptionSkippedPolicyCount", 0)
  };
}

function buildCheckpointBaseline(details: ProcessingDetailsRecord, capturedAt: string): AudioRecoveryCheckpointBaseline {
  return {
    capturedAt,
    completedBatches: readNumberArrayFromDetails(details, "audioRecoveryCompletedBatches"),
    batchProcessed: readNumberFromDetails(details, "audioRecoveryBatchProcessed", 0),
    targetProcessedCount: readNumberFromDetails(details, "audioRecoveryTargetProcessedCount", 0),
    extractedCount: readNumberFromDetails(details, "audioRecoveryExtractedCount", 0),
    skippedTimeoutCount: readNumberFromDetails(details, "audioRecoverySkippedTimeoutCount", 0),
    skippedErrorCount: readNumberFromDetails(details, "audioRecoverySkippedErrorCount", 0),
    transcriptionQueuedCount: readNumberFromDetails(details, "audioTranscriptionJobsCount", 0),
    transcriptionSkippedMissingCount: readNumberFromDetails(details, "audioTranscriptionSkippedMissingFileCount", 0),
    transcriptionSkippedPolicyCount: readNumberFromDetails(details, "audioTranscriptionSkippedPolicyCount", 0)
  };
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const effectiveSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += effectiveSize) {
    chunks.push(rows.slice(i, i + effectiveSize));
  }
  return chunks;
}

function shouldUseXmlStreamParse(scan: {
  files: string[];
  reportXmlContent?: string;
}) {
  if (!scan.reportXmlContent) return true;
  if (UFDR_FORCE_XML_STREAM) return true;
  if (scan.files.length >= UFDR_XML_STREAM_MIN_FILES) return true;
  if (scan.reportXmlContent.length > UFDR_XML_IN_MEMORY_MAX_CHARS) return true;
  return false;
}

async function resolveAudioRecoveryTargets(input: {
  ufdrAbsolutePath: string;
  hints: AudioExtractionHintRow[];
  maxFiles?: number;
}): Promise<{
  targets: ResolvedRecoveryTarget[];
  unresolvedHints: number;
}> {
  const dedupHints = new Map<string, AudioExtractionHintRow>();
  for (const hint of input.hints) {
    const rawArchivePath = hint.archivePath?.trim();
    const rawFileName = hint.fileName?.trim();
    if (!rawArchivePath && !rawFileName) continue;
    const key = `${rawArchivePath ? normalizeAudioArchivePath(rawArchivePath) : ""}::${rawFileName?.toLowerCase() ?? ""}`;
    if (!dedupHints.has(key)) dedupHints.set(key, hint);
  }

  const uniqueHints = [...dedupHints.values()];

  let scannedAudioEntries: string[] = [];
  let scanSucceeded = false;
  try {
    const scan = await scanUfdrArchive(input.ufdrAbsolutePath);
    scannedAudioEntries = scan.files.filter((filePath) => isAudioArchivePath(filePath));
    scanSucceeded = true;
  } catch {
    scanSucceeded = false;
  }

  const byNormalizedEntry = new Map<string, string>();
  const byBaseName = new Map<string, string[]>();
  for (const entry of scannedAudioEntries) {
    const normalized = normalizeAudioArchivePath(entry);
    byNormalizedEntry.set(normalized, entry);
    const baseName = path.basename(entry).toLowerCase();
    const bucket = byBaseName.get(baseName);
    if (bucket) bucket.push(entry);
    else byBaseName.set(baseName, [entry]);
  }

  const targets: ResolvedRecoveryTarget[] = [];
  const usedEntries = new Set<string>();
  let unresolvedHints = 0;

  for (const hint of uniqueHints) {
    const rawArchivePath = hint.archivePath?.trim();
    const rawFileName = hint.fileName?.trim();
    const preferredBaseName = (rawFileName || (rawArchivePath ? path.basename(rawArchivePath) : "")).toLowerCase();

    let resolvedEntryPath: string | undefined;
    if (rawArchivePath) {
      resolvedEntryPath = byNormalizedEntry.get(normalizeAudioArchivePath(rawArchivePath));
    }
    if (!resolvedEntryPath && preferredBaseName) {
      const candidates = byBaseName.get(preferredBaseName) ?? [];
      resolvedEntryPath = candidates.find((entry) => !usedEntries.has(normalizeAudioArchivePath(entry))) ?? candidates[0];
    }
    if (!resolvedEntryPath && !scanSucceeded && rawArchivePath) {
      resolvedEntryPath = rawArchivePath;
    }

    if (!resolvedEntryPath) {
      unresolvedHints += 1;
      continue;
    }

    const entryKey = normalizeAudioArchivePath(resolvedEntryPath);
    if (usedEntries.has(entryKey)) {
      continue;
    }
    usedEntries.add(entryKey);

    targets.push({
      entryPath: resolvedEntryPath,
      archivePath: rawArchivePath || resolvedEntryPath,
      fileName: rawFileName,
      timestamp: hint.timestamp,
      senderExternalId: hint.senderExternalId,
      chatExternalId: hint.chatExternalId,
      messageExternalId: hint.messageExternalId
    });
  }

  if (targets.length === 0 && scannedAudioEntries.length > 0) {
    for (const entry of scannedAudioEntries) {
      const entryKey = normalizeAudioArchivePath(entry);
      if (usedEntries.has(entryKey)) continue;
      usedEntries.add(entryKey);
      targets.push({
        entryPath: entry,
        archivePath: entry,
        fileName: path.basename(entry)
      });
    }
  }

  const limitedTargets =
    typeof input.maxFiles === "number" && Number.isFinite(input.maxFiles) && input.maxFiles > 0
      ? targets.slice(0, Math.floor(input.maxFiles))
      : targets;

  return {
    targets: limitedTargets,
    unresolvedHints
  };
}

async function extractAudioEntriesFromResolvedTargetsBestEffort(input: {
  ufdrAbsolutePath: string;
  outputDir: string;
  targets: ResolvedRecoveryTarget[];
  timeoutMs?: number;
  unresolvedHints?: number;
  batchSize?: number;
  onProgress?: (input: {
    processed: number;
    total: number;
    extracted: number;
    skippedByTimeout: number;
    skippedByError: number;
    batchIndex: number;
    batchTotal: number;
    batchProcessed: number;
    batchSize: number;
    archivePath?: string;
  }) => void;
}): Promise<{
  items: ExtractedAudioArtifact[];
  totalTargets: number;
  skippedByTimeout: number;
  skippedByError: number;
}> {
  const targets = input.targets;
  const unresolvedHints = Math.max(0, Math.floor(input.unresolvedHints ?? 0));

  await mkdir(input.outputDir, { recursive: true });

  const items: ExtractedAudioArtifact[] = [];
  let processed = 0;
  let skippedByTimeout = 0;
  let skippedByError = unresolvedHints;
  const totalTargets = targets.length + unresolvedHints;
  const configuredBatchSize =
    typeof input.batchSize === "number" && Number.isFinite(input.batchSize) && input.batchSize > 0
      ? Math.floor(input.batchSize)
      : UFDR_AUDIO_RECOVERY_BATCH_SIZE;
  const totalBatches = targets.length > 0 ? Math.ceil(targets.length / configuredBatchSize) : 0;

  if (unresolvedHints > 0) {
    processed = unresolvedHints;
    input.onProgress?.({
      processed,
      total: totalTargets,
      extracted: items.length,
      skippedByTimeout,
      skippedByError
      ,
      batchIndex: 0,
      batchTotal: totalBatches,
      batchProcessed: 0,
      batchSize: configuredBatchSize
    });
  }

  for (let batchStart = 0; batchStart < targets.length; batchStart += configuredBatchSize) {
    const batchEnd = Math.min(targets.length, batchStart + configuredBatchSize);
    const batchIndex = Math.floor(batchStart / configuredBatchSize) + 1;
    const batchTargets = targets.slice(batchStart, batchEnd);
    const outputStartedAt = Date.now();
    const extractionRequests = batchTargets.map((target, offset) => {
      const targetIndex = batchStart + offset;
      const extractionEntryPath = target.entryPath;
      const fallbackName = path.basename(target.fileName?.trim() || extractionEntryPath);
      const safeBase = (target.fileName?.trim() || fallbackName).replace(/[^a-zA-Z0-9._-]/g, "_");
      const outputName = `${outputStartedAt}-${targetIndex}-${safeBase}`;
      const outputPath = path.resolve(input.outputDir, outputName);

      return {
        target,
        safeBase,
        outputPath,
        request: {
          entryPath: extractionEntryPath,
          outputPath
        }
      };
    });

    let batchResults: Awaited<ReturnType<typeof extractArchiveEntriesToFiles>> = [];
    let batchExtractionError: string | undefined;
    try {
      batchResults = await withOptionalTimeout({
        label: `Extracao de lote de audio (${batchIndex}/${totalBatches})`,
        timeoutMs: Math.max(input.timeoutMs ?? 0, UFDR_AUDIO_RECOVERY_BATCH_TIMEOUT_MS),
        run: (signal) =>
          extractArchiveEntriesToFiles({
            ufdrAbsolutePath: input.ufdrAbsolutePath,
            entries: extractionRequests.map((entry) => entry.request),
            signal
          })
      });
    } catch (error) {
      batchExtractionError = error instanceof Error ? error.message : String(error);
    }

    for (let offset = 0; offset < extractionRequests.length; offset += 1) {
      const extractionRequest = extractionRequests[offset]!;
      const target = extractionRequest.target;
      const archivePath = target.archivePath;
      const result = batchResults[offset];

      try {
        if (batchExtractionError) {
          throw new Error(batchExtractionError);
        }
        if (!result || result.error) {
          throw new Error(result?.error ?? `Resultado ausente para ${archivePath}.`);
        }

        const fileInfo = await stat(result.outputPath).catch(() => null);
        const sizeBytes = Number(fileInfo?.size ?? result.sizeBytes ?? 0);
        if (!fileInfo || !fileInfo.isFile() || sizeBytes <= 0) {
          throw new Error(`Arquivo extraido invalido para ${archivePath}.`);
        }

        items.push({
          archivePath,
          fileName: extractionRequest.safeBase,
          absolutePath: result.outputPath,
          sizeBytes,
          chatExternalId: target.chatExternalId,
          messageExternalId: target.messageExternalId
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("excedeu o tempo limite")) skippedByTimeout += 1;
        else skippedByError += 1;
        await rm(extractionRequest.outputPath, { force: true }).catch(() => undefined);
      }

      processed += 1;
      input.onProgress?.({
        processed,
        total: totalTargets,
        extracted: items.length,
        skippedByTimeout,
        skippedByError,
        batchIndex,
        batchTotal: totalBatches,
        batchProcessed: offset + 1,
        batchSize: configuredBatchSize,
        archivePath
      });
    }

    await yieldToEventLoop();
  }

  return {
    items,
    totalTargets,
    skippedByTimeout,
    skippedByError
  };
}

async function extractAudioEntriesFromHintsBestEffort(input: {
  ufdrAbsolutePath: string;
  outputDir: string;
  hints: AudioExtractionHintRow[];
  timeoutMs?: number;
  maxFiles?: number;
  batchSize?: number;
  onProgress?: (input: {
    processed: number;
    total: number;
    extracted: number;
    skippedByTimeout: number;
    skippedByError: number;
    batchIndex: number;
    batchTotal: number;
    batchProcessed: number;
    batchSize: number;
    archivePath?: string;
  }) => void;
}): Promise<{
  items: ExtractedAudioArtifact[];
  totalTargets: number;
  skippedByTimeout: number;
  skippedByError: number;
}> {
  const { targets, unresolvedHints } = await resolveAudioRecoveryTargets({
    ufdrAbsolutePath: input.ufdrAbsolutePath,
    hints: input.hints,
    maxFiles: input.maxFiles
  });

  return extractAudioEntriesFromResolvedTargetsBestEffort({
    ufdrAbsolutePath: input.ufdrAbsolutePath,
    outputDir: input.outputDir,
    targets,
    timeoutMs: input.timeoutMs,
    unresolvedHints,
    batchSize: input.batchSize,
    onProgress: input.onProgress
  });
}

function buildAudioOutputDir(caseId: string, evidenceId: string) {
  return path.resolve(resolveStorageRoot(), "derived", caseId, evidenceId, "audio");
}

async function waitForUfdrSourceAvailable(input: { absolutePath: string; timeoutMs: number }) {
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt <= input.timeoutMs) {
    try {
      const info = await stat(input.absolutePath);
      if (info.isFile() || info.isDirectory()) {
        return;
      }
      lastError = "caminho nao aponta para arquivo ou diretorio";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(
    `UFDR source unavailable after ${input.timeoutMs}ms: ${input.absolutePath}${lastError ? ` (${lastError})` : ""}`
  );
}

function resolveTranscriptionRuntime(runtime?: {
  engine?: "local" | "openai" | "assemblyai";
  model?: string;
  language?: string;
  openaiApiKey?: string;
  assemblyAiApiKey?: string;
}) {
  const engine = runtime?.engine ?? "local";
  const model =
    runtime?.model ??
    (engine === "openai"
      ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
      : engine === "assemblyai"
        ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL || "best"
      : process.env.WHISPER_MODEL || "base");
  return {
    engine,
    model,
    language: runtime?.language,
    openaiApiKey: runtime?.openaiApiKey,
    assemblyAiApiKey: runtime?.assemblyAiApiKey
  };
}

type AudioRecoveryBatchRuntime = {
  jobId?: string;
  enqueuedAtMs?: number;
  processedOnMs?: number;
};

type AudioRecoveryBatchMetrics = {
  extractedCount: number;
  skippedTimeoutCount: number;
  skippedErrorCount: number;
  transcriptionQueuedCount: number;
  transcriptionSkippedMissingCount: number;
  transcriptionSkippedPolicyCount: number;
  fatalError?: string;
  startedAtMs: number;
  finishedAtMs: number;
  queueDelayMs?: number;
  lastArchivePath?: string;
};

type AudioRecoveryProgressSnapshot = {
  details: ProcessingDetailsRecord;
  totalBatches: number;
  processedBatches: number;
  extractedCount: number;
  skippedTimeoutCount: number;
  skippedErrorCount: number;
  transcriptionQueuedCount: number;
  transcriptionSkippedMissingCount: number;
  transcriptionSkippedPolicyCount: number;
  filesPerMin: number;
  batchesPerMin: number;
  etaSec: number | null;
  progress: number;
};

async function buildAudioRecoveryProgressSnapshot(
  tx: Prisma.TransactionClient,
  input: {
    extractionId: string;
    detailsCurrent: ProcessingDetailsRecord;
    totalBatchesFallback: number;
    now: Date;
    lastArchivePath?: string;
  }
): Promise<AudioRecoveryProgressSnapshot> {
  const nowIso = input.now.toISOString();
  const baseline = readCheckpointBaseline(input.detailsCurrent) ?? buildCheckpointBaseline(input.detailsCurrent, nowIso);
  const baselineCompletedSet = new Set(baseline.completedBatches);
  const checkpointRows = await tx.$queryRaw<
    Array<{
      batchIndex: number;
      batchTotal: number | bigint;
      targetCount: number | bigint;
      extractedCount: number | bigint;
      skippedTimeoutCount: number | bigint;
      skippedErrorCount: number | bigint;
      transcriptionQueuedCount: number | bigint;
      transcriptionSkippedMissingCount: number | bigint;
      transcriptionSkippedPolicyCount: number | bigint;
      durationMs: number | null;
      queueDelayMs: number | null;
      startedAt: Date | null;
    }>
  >`
    SELECT
      "batchIndex",
      "batchTotal",
      "targetCount",
      "extractedCount",
      "skippedTimeoutCount",
      "skippedErrorCount",
      "transcriptionQueuedCount",
      "transcriptionSkippedMissingCount",
      "transcriptionSkippedPolicyCount",
      "durationMs",
      "queueDelayMs",
      "startedAt"
    FROM "AudioRecoveryBatchCheckpoint"
    WHERE "extractionId" = ${input.extractionId}
      AND "status" = 'COMPLETED'
    ORDER BY "batchIndex" ASC
  `;
  const checkpointIndexes = checkpointRows.map((row) => sqlNumber(row.batchIndex));
  const checkpointBatchTotals = checkpointRows.map((row) => sqlNumber(row.batchTotal)).filter((value) => value > 0);
  const newCheckpointIndexes = checkpointIndexes.filter((batchIndex) => !baselineCompletedSet.has(batchIndex));
  const newCheckpointRows = checkpointRows.filter((row) => !baselineCompletedSet.has(sqlNumber(row.batchIndex)));
  const aggregate = newCheckpointRows.reduce(
    (acc, row) => {
      acc.targetCount += sqlNumber(row.targetCount);
      acc.extractedCount += sqlNumber(row.extractedCount);
      acc.skippedTimeoutCount += sqlNumber(row.skippedTimeoutCount);
      acc.skippedErrorCount += sqlNumber(row.skippedErrorCount);
      acc.transcriptionQueuedCount += sqlNumber(row.transcriptionQueuedCount);
      acc.transcriptionSkippedMissingCount += sqlNumber(row.transcriptionSkippedMissingCount);
      acc.transcriptionSkippedPolicyCount += sqlNumber(row.transcriptionSkippedPolicyCount);
      if (typeof row.durationMs === "number") {
        acc.durationMsTotal += row.durationMs;
        acc.durationMsCount += 1;
      }
      if (typeof row.queueDelayMs === "number") {
        acc.queueDelayMsTotal += row.queueDelayMs;
        acc.queueDelayMsCount += 1;
      }
      if (row.startedAt && (!acc.minStartedAt || row.startedAt < acc.minStartedAt)) {
        acc.minStartedAt = row.startedAt;
      }
      return acc;
    },
    {
      targetCount: 0,
      extractedCount: 0,
      skippedTimeoutCount: 0,
      skippedErrorCount: 0,
      transcriptionQueuedCount: 0,
      transcriptionSkippedMissingCount: 0,
      transcriptionSkippedPolicyCount: 0,
      durationMsTotal: 0,
      durationMsCount: 0,
      queueDelayMsTotal: 0,
      queueDelayMsCount: 0,
      minStartedAt: null as Date | null
    }
  );

  const completedBatchesAfter = [...new Set([...baseline.completedBatches, ...checkpointIndexes])].sort((a, b) => a - b);
  const totalBatches = Math.max(
    0,
    readNumberFromDetails(input.detailsCurrent, "audioRecoveryBatchTotal", input.totalBatchesFallback),
    input.totalBatchesFallback,
    ...checkpointBatchTotals,
    ...checkpointIndexes,
    completedBatchesAfter.length
  );
  const processedFromBaseline = Math.max(baseline.batchProcessed, baseline.completedBatches.length);
  const processedBatches = Math.min(
    totalBatches,
    Math.max(completedBatchesAfter.length, processedFromBaseline + newCheckpointIndexes.length)
  );
  const targetProcessedCount = baseline.targetProcessedCount + aggregate.targetCount;
  const extractedCount = baseline.extractedCount + aggregate.extractedCount;
  const skippedTimeoutCount = baseline.skippedTimeoutCount + aggregate.skippedTimeoutCount;
  const skippedErrorCount = baseline.skippedErrorCount + aggregate.skippedErrorCount;
  const transcriptionQueuedCount = baseline.transcriptionQueuedCount + aggregate.transcriptionQueuedCount;
  const transcriptionSkippedMissingCount =
    baseline.transcriptionSkippedMissingCount + aggregate.transcriptionSkippedMissingCount;
  const transcriptionSkippedPolicyCount =
    baseline.transcriptionSkippedPolicyCount + aggregate.transcriptionSkippedPolicyCount;

  const recoveryStartedAtMs =
    parseDateMs(input.detailsCurrent.audioRecoveryStartedAt) ??
    aggregate.minStartedAt?.getTime() ??
    parseDateMs(baseline.capturedAt) ??
    input.now.getTime();
  const elapsedMs = Math.max(1, input.now.getTime() - recoveryStartedAtMs);
  const batchesPerMin = roundedMetric((processedBatches * 60000) / elapsedMs);
  const filesPerMin = roundedMetric((extractedCount * 60000) / elapsedMs);
  const remainingBatches = Math.max(0, totalBatches - processedBatches);
  const etaSec = batchesPerMin > 0 && remainingBatches > 0 ? Math.round((remainingBatches / batchesPerMin) * 60) : null;
  const progress = totalBatches > 0 ? Math.min(97, 69 + Math.floor((processedBatches / totalBatches) * 28)) : 69;
  const lastProgressAtMs =
    parseDateMs(input.detailsCurrent.audioRecoveryProgressUpdatedAt) ??
    parseDateMs(input.detailsCurrent.audioRecoveryLastBatchAt);
  const progressUpdateDeltaMs =
    typeof lastProgressAtMs === "number" ? Math.max(0, input.now.getTime() - lastProgressAtMs) : null;
  const lastArchivePath =
    input.lastArchivePath ??
    readStringFromDetails(input.detailsCurrent, "audioExtractionLastArchivePath") ??
    readStringFromDetails(input.detailsCurrent, "audioRecoveryLastArchivePath");
  const phase =
    totalBatches > 0 && processedBatches >= totalBatches
      ? "audio-recovery-batches-complete-pending-finalize"
      : "audio-recovery-batches-running";

  return {
    details: {
      ...input.detailsCurrent,
      phase,
      progress,
      audioRecoveryAsync: true,
      audioRecoveryProgressSource: "batch-checkpoints",
      audioRecoveryCheckpointBaseline: baseline,
      audioRecoveryBatchTotal: totalBatches,
      audioRecoveryBatchProcessed: processedBatches,
      audioRecoveryCompletedBatches: completedBatchesAfter,
      audioRecoveryTargetProcessedCount: targetProcessedCount,
      audioRecoveryExtractedCount: extractedCount,
      audioRecoverySkippedTimeoutCount: skippedTimeoutCount,
      audioRecoverySkippedErrorCount: skippedErrorCount,
      audioTranscriptionJobsCount: transcriptionQueuedCount,
      audioTranscriptionSkippedMissingFileCount: transcriptionSkippedMissingCount,
      audioTranscriptionSkippedPolicyCount: transcriptionSkippedPolicyCount,
      audioRecoveryBatchesPerMin: batchesPerMin,
      audioRecoveryFilesPerMin: filesPerMin,
      audioRecoveryEtaSec: etaSec,
      audioRecoveryAverageBatchDurationMs:
        aggregate.durationMsCount > 0 ? Math.round(aggregate.durationMsTotal / aggregate.durationMsCount) : null,
      audioRecoveryAverageQueueDelayMs:
        aggregate.queueDelayMsCount > 0 ? Math.round(aggregate.queueDelayMsTotal / aggregate.queueDelayMsCount) : null,
      audioRecoveryProgressUpdateDeltaMs: progressUpdateDeltaMs,
      audioRecoveryProgressUpdatedAt: nowIso,
      audioRecoveryLastBatchAt: nowIso,
      ...(lastArchivePath ? { audioExtractionLastArchivePath: lastArchivePath, audioRecoveryLastArchivePath: lastArchivePath } : {})
    },
    totalBatches,
    processedBatches,
    extractedCount,
    skippedTimeoutCount,
    skippedErrorCount,
    transcriptionQueuedCount,
    transcriptionSkippedMissingCount,
    transcriptionSkippedPolicyCount,
    filesPerMin,
    batchesPerMin,
    etaSec,
    progress
  };
}

async function recordAudioRecoveryBatchCheckpoint(
  payload: AudioRecoveryBatchJob,
  metrics: AudioRecoveryBatchMetrics
) {
  const now = new Date(metrics.finishedAtMs);
  const nowIso = now.toISOString();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Extraction" WHERE id = ${payload.extractionId} FOR UPDATE`;
    const extraction = await tx.extraction.findUnique({
      where: { id: payload.extractionId },
      select: { processingDetails: true, status: true }
    });

    if (!extraction || extraction.status === "COMPLETED" || extraction.status === "FAILED") {
      log("info", "Audio recovery checkpoint skipped: extraction is terminal", {
        extractionId: payload.extractionId,
        batchIndex: payload.batchIndex,
        status: extraction?.status ?? null
      });
      return {
        details: toProcessingDetailsRecord(extraction?.processingDetails),
        completedBatches: [],
        processedBatches: 0,
        completedCount: 0,
        totalBatches: payload.batchTotal,
        extractedCount: 0,
        skippedTimeoutCount: 0,
        skippedErrorCount: 0,
        transcriptionQueuedCount: 0,
        transcriptionSkippedMissingCount: 0,
        transcriptionSkippedPolicyCount: 0,
        filesPerMin: 0,
        batchesPerMin: 0,
        etaSec: null,
        progress: 100,
        duplicateCompletion: true
      };
    }
    const detailsCurrent = toProcessingDetailsRecord(extraction?.processingDetails);
    const existingRows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"
      FROM "AudioRecoveryBatchCheckpoint"
      WHERE "extractionId" = ${payload.extractionId}
        AND "batchIndex" = ${payload.batchIndex}
      LIMIT 1
    `;
    const existing = existingRows[0];
    const duplicateCompletion = existing?.status === "COMPLETED";

    if (!duplicateCompletion) {
      const durationMs = Math.max(0, Math.round(metrics.finishedAtMs - metrics.startedAtMs));
      const checkpointQueueDelayMs =
        typeof metrics.queueDelayMs === "number" && Number.isFinite(metrics.queueDelayMs)
          ? Math.max(0, Math.round(metrics.queueDelayMs))
          : null;
      await tx.$executeRaw`
        INSERT INTO "AudioRecoveryBatchCheckpoint" (
          "id",
          "extractionId",
          "batchIndex",
          "batchTotal",
          "targetCount",
          "extractedCount",
          "skippedTimeoutCount",
          "skippedErrorCount",
          "transcriptionQueuedCount",
          "transcriptionSkippedMissingCount",
          "transcriptionSkippedPolicyCount",
          "durationMs",
          "queueDelayMs",
          "status",
          "error",
          "lastArchivePath",
          "startedAt",
          "finishedAt",
          "updatedAt"
        )
        VALUES (
          ${randomUUID()},
          ${payload.extractionId},
          ${payload.batchIndex},
          ${payload.batchTotal},
          ${payload.targets.length},
          ${metrics.extractedCount},
          ${metrics.skippedTimeoutCount},
          ${metrics.skippedErrorCount},
          ${metrics.transcriptionQueuedCount},
          ${metrics.transcriptionSkippedMissingCount},
          ${metrics.transcriptionSkippedPolicyCount},
          ${durationMs},
          ${checkpointQueueDelayMs},
          'COMPLETED',
          ${metrics.fatalError ?? null},
          ${metrics.lastArchivePath ?? null},
          ${new Date(metrics.startedAtMs)},
          ${now},
          ${now}
        )
        ON CONFLICT ("extractionId", "batchIndex") DO UPDATE SET
          "batchTotal" = EXCLUDED."batchTotal",
          "targetCount" = EXCLUDED."targetCount",
          "extractedCount" = EXCLUDED."extractedCount",
          "skippedTimeoutCount" = EXCLUDED."skippedTimeoutCount",
          "skippedErrorCount" = EXCLUDED."skippedErrorCount",
          "transcriptionQueuedCount" = EXCLUDED."transcriptionQueuedCount",
          "transcriptionSkippedMissingCount" = EXCLUDED."transcriptionSkippedMissingCount",
          "transcriptionSkippedPolicyCount" = EXCLUDED."transcriptionSkippedPolicyCount",
          "durationMs" = EXCLUDED."durationMs",
          "queueDelayMs" = EXCLUDED."queueDelayMs",
          "status" = EXCLUDED."status",
          "error" = EXCLUDED."error",
          "lastArchivePath" = EXCLUDED."lastArchivePath",
          "startedAt" = EXCLUDED."startedAt",
          "finishedAt" = EXCLUDED."finishedAt",
          "updatedAt" = EXCLUDED."updatedAt"
      `;
    }

    const snapshot = await buildAudioRecoveryProgressSnapshot(tx, {
      extractionId: payload.extractionId,
      detailsCurrent,
      totalBatchesFallback: payload.batchTotal,
      now,
      lastArchivePath: metrics.lastArchivePath
    });
    const nextDetails: ProcessingDetailsRecord = {
      ...snapshot.details,
      audioRecoveryBatchIndex: payload.batchIndex,
      audioRecoveryBatchSize: payload.targets.length,
      audioRecoveryLastCheckpointDuplicate: duplicateCompletion,
      audioRecoveryLastCheckpointAt: nowIso,
      ...(metrics.fatalError ? { audioRecoveryLastBatchError: metrics.fatalError } : {})
    };
    const audioExtractedTotal = readNumberFromDetails(nextDetails, "audioHintsCount", snapshot.extractedCount);

    await tx.extraction.update({
      where: { id: payload.extractionId },
      data: {
        status: "PROCESSING",
        processingDetails: nextDetails as Prisma.InputJsonValue,
        processingPhase: String(nextDetails.phase),
        processingProgress: snapshot.progress,
        audioExtractedCount: snapshot.extractedCount,
        audioExtractedTotal: audioExtractedTotal > 0 ? audioExtractedTotal : undefined,
        audioRatePerMin: snapshot.filesPerMin,
        audioEtaSec: snapshot.etaSec,
        audioLastArchivePath: metrics.lastArchivePath
      }
    });

    return {
      ...snapshot,
      details: nextDetails,
      duplicateCompletion
    };
  });
}

async function processAudioRecoveryBatchJob(jobData: AudioRecoveryBatchJob, runtime?: AudioRecoveryBatchRuntime) {
  const payload = audioRecoveryBatchJobSchema.parse(jobData);
  const batchStartedAtMs = runtime?.processedOnMs ?? Date.now();
  const queueDelayMs =
    typeof runtime?.enqueuedAtMs === "number" && Number.isFinite(runtime.enqueuedAtMs)
      ? Math.max(0, batchStartedAtMs - runtime.enqueuedAtMs)
      : undefined;

  const extraction = await prisma.extraction.findUnique({
    where: { id: payload.extractionId },
    select: {
      status: true,
      processingDetails: true
    }
  });

  if (!extraction) {
    log("warn", "Audio recovery batch skipped: extraction not found", {
      extractionId: payload.extractionId,
      batchIndex: payload.batchIndex
    });
    return;
  }

  if (extraction.status === "COMPLETED" || extraction.status === "FAILED") {
    return;
  }

  const detailsBefore = toProcessingDetailsRecord(extraction.processingDetails);
  const checkpointBeforeRows = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status"
    FROM "AudioRecoveryBatchCheckpoint"
    WHERE "extractionId" = ${payload.extractionId}
      AND "batchIndex" = ${payload.batchIndex}
    LIMIT 1
  `;
  const checkpointBefore = checkpointBeforeRows[0];
  const completedBatchesBefore = readNumberArrayFromDetails(detailsBefore, "audioRecoveryCompletedBatches");
  if (completedBatchesBefore.includes(payload.batchIndex)) {
    log("info", "Audio recovery batch skipped: already completed", {
      extractionId: payload.extractionId,
      batchIndex: payload.batchIndex
    });
    return;
  }
  if (checkpointBefore?.status === "COMPLETED") {
    log("info", "Audio recovery batch skipped: checkpoint already completed", {
      extractionId: payload.extractionId,
      batchIndex: payload.batchIndex,
      checkpointId: checkpointBefore.id
    });
    return;
  }

  let batchExtracted = 0;
  let batchSkippedTimeout = 0;
  let batchSkippedError = 0;
  let batchQueued = 0;
  let batchSkippedMissing = 0;
  let batchSkippedPolicy = 0;
  let batchFatalError: string | undefined;

  const audioOutputDir = buildAudioOutputDir(payload.caseId, payload.evidenceId);

  try {
    const recovery = await extractAudioEntriesFromResolvedTargetsBestEffort({
      ufdrAbsolutePath: payload.ufdrAbsolutePath,
      outputDir: audioOutputDir,
      targets: payload.targets,
      timeoutMs: Math.min(UFDR_AUDIO_EXTRACTION_TIMEOUT_MS, UFDR_AUDIO_ENTRY_TIMEOUT_MS),
      unresolvedHints: 0,
      batchSize: payload.targets.length
    });

    batchExtracted = recovery.items.length;
    batchSkippedTimeout = recovery.skippedByTimeout;
    batchSkippedError = recovery.skippedByError;

    if (recovery.items.length > 0) {
      const messageExternalIds = [...new Set(payload.targets.map((target) => target.messageExternalId?.trim()).filter(Boolean))] as string[];
      const chatExternalIds = [...new Set(payload.targets.map((target) => target.chatExternalId?.trim()).filter(Boolean))] as string[];

      const linkage = await buildEvidenceMessageLinkageContext({
        evidenceId: payload.evidenceId,
        messageExternalIds,
        chatExternalIds
      });

      const transcriptionRows = await persistAudioAttachments({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        extractionId: payload.extractionId,
        items: recovery.items,
        audioHints: payload.targets.map((target) => ({
          archivePath: target.archivePath,
          fileName: target.fileName,
          timestamp: target.timestamp,
          chatExternalId: target.chatExternalId,
          messageExternalId: target.messageExternalId,
          senderExternalId: target.senderExternalId
        })),
        chatExternalToId: linkage.chatExternalToId,
        messageExternalToId: linkage.messageExternalToId,
        messageTimeline: linkage.messageTimeline
      });

      const runtime = resolveTranscriptionRuntime(payload.transcriptionRuntime);
      const eligibilityByAttachment = await buildAttachmentTranscriptionEligibilityMap(
        transcriptionRows.map((row) => row.attachmentId)
      );
      for (const row of transcriptionRows) {
        const eligibility = eligibilityByAttachment.get(row.attachmentId);
        const opusByPath = hasOpusExtension(row.audioAbsolutePath);
        if (!eligibility?.eligible || !opusByPath) {
          await prisma.audioTranscription.update({
            where: { id: row.transcriptionId },
            data: {
              status: "FAILED",
              error:
                eligibility?.reason ??
                "Descartado pela politica: somente arquivos .opus do WhatsApp sao transcritos.",
              finishedAt: new Date()
            }
          });
          batchSkippedPolicy += 1;
          continue;
        }

        const fileInfo = await stat(row.audioAbsolutePath).catch(() => null);
        if (!fileInfo || !fileInfo.isFile() || fileInfo.size <= 0) {
          await prisma.audioTranscription.update({
            where: { id: row.transcriptionId },
            data: {
              status: "FAILED",
              error: `Arquivo de audio ausente/invalido antes do enqueue (bytes=${fileInfo?.size ?? 0}).`,
              finishedAt: new Date()
            }
          });
          batchSkippedMissing += 1;
          continue;
        }

        await enqueueAudioTranscription({
          transcriptionId: row.transcriptionId,
          attachmentId: row.attachmentId,
          caseId: payload.caseId,
          evidenceId: payload.evidenceId,
          extractionId: payload.extractionId,
          audioAbsolutePath: row.audioAbsolutePath,
          language: runtime.language,
          engine: runtime.engine,
          model: runtime.model,
          openaiApiKey: runtime.openaiApiKey,
          assemblyAiApiKey: runtime.assemblyAiApiKey
        });
        batchQueued += 1;
      }
    }
  } catch (error) {
    batchFatalError = error instanceof Error ? error.message : String(error);
    batchSkippedError += payload.targets.length;
    log("warn", "Audio recovery batch failed", {
      extractionId: payload.extractionId,
      batchIndex: payload.batchIndex,
      error: batchFatalError
    });
  }

  const batchFinishedAtMs = Date.now();
  const lastArchivePath =
    payload.targets[payload.targets.length - 1]?.archivePath ??
    readStringFromDetails(detailsBefore, "audioExtractionLastArchivePath");
  const checkpoint = await recordAudioRecoveryBatchCheckpoint(payload, {
    extractedCount: batchExtracted,
    skippedTimeoutCount: batchSkippedTimeout,
    skippedErrorCount: batchSkippedError,
    transcriptionQueuedCount: batchQueued,
    transcriptionSkippedMissingCount: batchSkippedMissing,
    transcriptionSkippedPolicyCount: batchSkippedPolicy,
    fatalError: batchFatalError,
    startedAtMs: batchStartedAtMs,
    finishedAtMs: batchFinishedAtMs,
    queueDelayMs,
    lastArchivePath
  });

  log("info", "Audio recovery batch checkpoint persisted", {
    extractionId: payload.extractionId,
    batchIndex: payload.batchIndex,
    batchTotal: payload.batchTotal,
    targetCount: payload.targets.length,
    durationMs: batchFinishedAtMs - batchStartedAtMs,
    queueDelayMs,
    batchExtracted,
    batchQueued,
    batchSkippedTimeout,
    batchSkippedError,
    processedBatches: checkpoint.processedBatches,
    totalBatches: checkpoint.totalBatches,
    batchesPerMin: checkpoint.batchesPerMin,
    filesPerMin: checkpoint.filesPerMin,
    duplicateCompletion: checkpoint.duplicateCompletion
  });

  if (batchFatalError) {
    await addCustodyEvent({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      action: "INGESTION_AUDIO_RECOVERY_BATCH_FAILED",
      source: "worker-ingest-audio-recovery",
      details: {
        extractionId: payload.extractionId,
        batchIndex: payload.batchIndex,
        error: batchFatalError
      }
    });
  }

  if (checkpoint.processedBatches >= checkpoint.totalBatches && checkpoint.totalBatches > 0) {
    await enqueueAudioRecoveryFinalize({
      extractionId: payload.extractionId,
      evidenceId: payload.evidenceId,
      caseId: payload.caseId
    });
  }
}

async function processAudioRecoveryFinalizeJob(jobData: AudioRecoveryFinalizeJob) {
  const payload = audioRecoveryFinalizeJobSchema.parse(jobData);
  const queueSummary = await summarizeAudioRecoveryBatchQueueForExtraction(payload.extractionId);

  const finalizeResult = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Extraction" WHERE id = ${payload.extractionId} FOR UPDATE`;
    const extraction = await tx.extraction.findUnique({
      where: { id: payload.extractionId },
      select: {
        status: true,
        processingDetails: true
      }
    });

    if (!extraction || extraction.status === "FAILED" || extraction.status === "COMPLETED") {
      return {
        ignored: true as const,
        finalized: false as const,
        detailsForFinalize: toProcessingDetailsRecord(extraction?.processingDetails),
        snapshot: null
      };
    }

    const details = toProcessingDetailsRecord(extraction.processingDetails);
    const now = new Date();
    const snapshot = await buildAudioRecoveryProgressSnapshot(tx, {
      extractionId: payload.extractionId,
      detailsCurrent: details,
      totalBatchesFallback: readNumberFromDetails(details, "audioRecoveryBatchTotal", 0),
      now
    });
    const expectedRemainingBatches = Math.max(0, snapshot.totalBatches - snapshot.processedBatches);
    const queuePersistedDelta = queueSummary.outstanding - expectedRemainingBatches;
    const readyToFinalize =
      snapshot.totalBatches > 0 &&
      snapshot.processedBatches >= snapshot.totalBatches &&
      queueSummary.outstanding === 0 &&
      !queueSummary.scanError;

    if (!readyToFinalize) {
      const pendingDetails: ProcessingDetailsRecord = {
        ...snapshot.details,
        phase: "audio-recovery-batches-running",
        progress: Math.min(snapshot.progress, 97),
        audioRecoveryFinalizeDeferredAt: now.toISOString(),
        audioRecoveryQueueSnapshot: queueSummary,
        audioRecoveryQueueOutstandingBatches: queueSummary.outstanding,
        audioRecoveryExpectedRemainingBatches: expectedRemainingBatches,
        audioRecoveryQueuePersistedDelta: queuePersistedDelta
      };
      await tx.extraction.update({
        where: { id: payload.extractionId },
        data: {
          status: "PROCESSING",
          reportError: null,
          processingDetails: pendingDetails as Prisma.InputJsonValue,
          processingPhase: String(pendingDetails.phase),
          processingProgress: Number(pendingDetails.progress),
          audioExtractedCount: snapshot.extractedCount,
          audioRatePerMin: snapshot.filesPerMin,
          audioEtaSec: snapshot.etaSec
        }
      });
      return {
        ignored: false as const,
        finalized: false as const,
        detailsForFinalize: pendingDetails,
        snapshot
      };
    }

    const finalizedAt = new Date();
    const detailsForFinalize: ProcessingDetailsRecord = {
      ...snapshot.details,
      phase: "completed",
      progress: 100,
      audioRecoveryQueueSnapshot: queueSummary,
      audioRecoveryQueueOutstandingBatches: 0,
      audioRecoveryFinalizedAt: finalizedAt.toISOString()
    };
    await tx.extraction.update({
      where: { id: payload.extractionId },
      data: {
        status: "COMPLETED",
        reportError: null,
        processingDetails: detailsForFinalize as Prisma.InputJsonValue,
        processingPhase: "completed",
        processingProgress: 100,
        audioExtractedCount: snapshot.extractedCount,
        audioRatePerMin: snapshot.filesPerMin,
        audioEtaSec: snapshot.etaSec,
        finishedAt: finalizedAt
      }
    });

    return {
      ignored: false as const,
      finalized: true as const,
      detailsForFinalize,
      snapshot
    };
  });

  if (finalizeResult.ignored) return;

  if (!finalizeResult.finalized) {
    log("info", "Audio recovery finalize deferred", {
      extractionId: payload.extractionId,
      processedBatches: finalizeResult.snapshot?.processedBatches ?? null,
      totalBatches: finalizeResult.snapshot?.totalBatches ?? null,
      queueOutstandingBatches: queueSummary.outstanding,
      queueSummary
    });
    await enqueueAudioRecoveryFinalize(payload, {
      delayMs: UFDR_AUDIO_RECOVERY_FINALIZE_DELAY_MS,
      deferred: true
    });
    return;
  }

  const detailsForFinalize: ProcessingDetailsRecord = finalizeResult.detailsForFinalize;

  await addCustodyEvent({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId,
    action: "INGESTION_COMPLETED",
    source: "worker-ingest-audio-recovery-finalizer",
    details: {
      extractionId: payload.extractionId,
      audioTranscriptionsQueued: readNumberFromDetails(detailsForFinalize, "audioTranscriptionJobsCount", 0),
      audioTranscriptionsSkippedMissingFile: readNumberFromDetails(detailsForFinalize, "audioTranscriptionSkippedMissingFileCount", 0),
      audioTimeoutManualReviewRequired: Boolean(detailsForFinalize.audioTimeoutManualReviewRequired),
      audioTimeoutErrorMessage: readStringFromDetails(detailsForFinalize, "audioTimeoutErrorMessage") ?? null,
      audioExtractionLastArchivePath: readStringFromDetails(detailsForFinalize, "audioExtractionLastArchivePath") ?? null,
      audioRecoveryExtractedCount: readNumberFromDetails(detailsForFinalize, "audioRecoveryExtractedCount", 0),
      audioRecoverySkippedTimeoutCount: readNumberFromDetails(detailsForFinalize, "audioRecoverySkippedTimeoutCount", 0),
      audioRecoverySkippedErrorCount: readNumberFromDetails(detailsForFinalize, "audioRecoverySkippedErrorCount", 0)
    }
  });

  await syncCaseTimeline({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId
  });
}

type AudioRecoveryQueueSummary = {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  waitingChildren: number;
  outstanding: number;
  scanned: number;
  truncated: boolean;
  scanError?: string;
};

function isAudioRecoveryBatchJobForExtraction(job: Awaited<ReturnType<typeof audioRecoveryBatchQueue.getJob>>, extractionId: string) {
  if (!job) return false;
  const jobId = String(job.id ?? "");
  if (jobId.startsWith(`${extractionId}__batch__`)) return true;
  const data = job.data && typeof job.data === "object" ? (job.data as Record<string, unknown>) : null;
  return data?.extractionId === extractionId;
}

async function summarizeAudioRecoveryBatchQueueForExtraction(extractionId: string): Promise<AudioRecoveryQueueSummary> {
  const summary: AudioRecoveryQueueSummary = {
    waiting: 0,
    active: 0,
    delayed: 0,
    prioritized: 0,
    waitingChildren: 0,
    outstanding: 0,
    scanned: 0,
    truncated: false
  };
  const statuses = [
    ["waiting", "waiting"],
    ["active", "active"],
    ["delayed", "delayed"],
    ["prioritized", "prioritized"],
    ["waiting-children", "waitingChildren"]
  ] as const;

  try {
    for (const [status, key] of statuses) {
      let start = 0;
      while (summary.scanned < UFDR_AUDIO_RECOVERY_QUEUE_SCAN_MAX_JOBS) {
        const end = start + UFDR_AUDIO_RECOVERY_QUEUE_SCAN_PAGE_SIZE - 1;
        const jobs = await audioRecoveryBatchQueue.getJobs([status], start, end, true);
        summary.scanned += jobs.length;
        for (const job of jobs) {
          if (isAudioRecoveryBatchJobForExtraction(job, extractionId)) {
            summary[key] += 1;
          }
        }
        if (jobs.length < UFDR_AUDIO_RECOVERY_QUEUE_SCAN_PAGE_SIZE) break;
        start += UFDR_AUDIO_RECOVERY_QUEUE_SCAN_PAGE_SIZE;
      }
      if (summary.scanned >= UFDR_AUDIO_RECOVERY_QUEUE_SCAN_MAX_JOBS) {
        summary.truncated = true;
        break;
      }
    }
  } catch (error) {
    summary.scanError = error instanceof Error ? error.message : String(error);
  }

  summary.outstanding =
    summary.waiting + summary.active + summary.delayed + summary.prioritized + summary.waitingChildren;
  return summary;
}

async function loadAudioRecoveryQueueDeltaForHeartbeat(extractionId: string, details: ProcessingDetailsRecord) {
  const summary = await summarizeAudioRecoveryBatchQueueForExtraction(extractionId);
  const totalBatches = readNumberFromDetails(details, "audioRecoveryBatchTotal", 0);
  const processedBatches = readNumberFromDetails(details, "audioRecoveryBatchProcessed", 0);
  const expectedRemainingBatches = Math.max(0, totalBatches - processedBatches);

  return {
    ...summary,
    expectedRemainingBatches,
    persistedQueueDelta: summary.outstanding - expectedRemainingBatches
  };
}

async function updateLocalImportProgress(
  payload: LocalUfdrImportJob,
  patch: Record<string, unknown>,
  options?: { status?: "PENDING" | "PROCESSING" | "FAILED"; reportError?: string | null; finishedAt?: Date | null }
) {
  const row = await prisma.extraction.findUnique({
    where: { id: payload.extractionId },
    select: { processingDetails: true, startedAt: true }
  });
  const previous =
    row?.processingDetails && typeof row.processingDetails === "object" && !Array.isArray(row.processingDetails)
      ? (row.processingDetails as Record<string, unknown>)
      : {};
  const startedAtMs = row?.startedAt?.getTime() ?? Date.now();
  await prisma.extraction.update({
    where: { id: payload.extractionId },
    data: {
      status: options?.status,
      reportError: options && "reportError" in options ? options.reportError : undefined,
      finishedAt: options && "finishedAt" in options ? options.finishedAt : undefined,
      processingDetails: {
        ...previous,
        ...patch,
        elapsedMs: Date.now() - startedAtMs,
        localImportHeartbeatAt: new Date().toISOString(),
        transcriptionRuntime: publicRuntimeDetails(payload.transcriptionRuntime)
      }
    }
  });
}

async function processLocalUfdrImport(jobData: LocalUfdrImportJob) {
  const payload = localUfdrImportJobSchema.parse(jobData);
  try {
    await updateLocalImportProgress(payload, { phase: "local-import-resolving-original", progress: 5 }, { status: "PROCESSING" });
    const originalUfdrAbsolutePath = await resolveOriginalUfdrPath({
      sourcePath: payload.sourcePath,
      sourceIsDirectory: payload.sourceIsDirectory,
      explicitPath: payload.explicitOriginalUfdrPath
    });

    await updateLocalImportProgress(payload, {
      phase: "local-import-scanning-report",
      progress: 12,
      originalUfdrPath: originalUfdrAbsolutePath
    });
    const scan = await scanUfdrArchive(payload.sourcePath);
    if (!scan.reportXmlPath) {
      throw new Error(
        "report.xml nao encontrado na origem informada. Selecione a raiz da extracao descompactada ou um arquivo .ufdr valido."
      );
    }

    await updateLocalImportProgress(payload, { phase: "local-import-hashing", progress: 25, reportPath: scan.reportXmlPath });
    const sha256 = await computeSha256FromFile(originalUfdrAbsolutePath);
    const duplicated = await findExistingUfdrAnalysisBySha({ caseId: payload.caseId, sha256 });
    if (duplicated?.extraction && duplicated.extraction.id !== payload.extractionId) {
      throw new Error(
        `Este UFDR ja foi inserido para este caso. Extracao existente: ${duplicated.extraction.id} (${duplicated.extraction.status}).`
      );
    }

    await updateLocalImportProgress(payload, { phase: "local-import-copying-storage", progress: 45, sha256 });
    await cp(payload.sourcePath, payload.storedAbsolutePath, {
      recursive: payload.sourceIsDirectory,
      force: true,
      errorOnExist: false
    });
    const sizeBytes = payload.sourceIsDirectory
      ? await calculateDirectorySizeBytes(payload.storedAbsolutePath)
      : payload.sourceSizeBytes;

    await prisma.evidence.update({
      where: { id: payload.evidenceId },
      data: {
        originalPath: payload.storedRelativePath,
        sizeBytes: BigInt(sizeBytes),
        sha256
      }
    });

    await addCustodyEvent({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      actorId: payload.uploadedById,
      action: "EVIDENCE_REGISTERED",
      source: "worker-ingest-local-import",
      currentHash: sha256,
      details: {
        fileName: payload.filename,
        sizeBytes,
        storagePath: payload.storedRelativePath,
        sourcePath: payload.sourcePath
      }
    });

    await updateLocalImportProgress(payload, { phase: "local-import-queueing-ingestion", progress: 80, sizeBytes });
    const queuedJobId = await enqueueUfdrIngestion({
      extractionId: payload.extractionId,
      evidenceId: payload.evidenceId,
      caseId: payload.caseId,
      ufdrAbsolutePath: payload.storedAbsolutePath,
      originalFilename: payload.filename,
      transcriptionRuntime: payload.transcriptionRuntime
    });

    await prisma.extraction.update({
      where: { id: payload.extractionId },
      data: {
        status: "PENDING",
        reportError: null,
        reportPath: null,
        reportFound: false,
        processingDetails: {
          phase: "local-import-queued",
          progress: 90,
          sourcePath: payload.sourcePath,
          originalUfdrPath: originalUfdrAbsolutePath,
          storagePath: payload.storedRelativePath,
          sha256,
          sizeBytes,
          queueJobId: queuedJobId || null,
          localImportHeartbeatAt: new Date().toISOString(),
          transcriptionRuntime: publicRuntimeDetails(payload.transcriptionRuntime)
        }
      }
    });

    await addCustodyEvent({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      actorId: payload.uploadedById,
      action: "UFDR_IMPORT_PATH_QUEUED",
      source: "worker-ingest-local-import",
      currentHash: sha256,
      details: {
        extractionId: payload.extractionId,
        sourcePath: payload.sourcePath,
        originalUfdrPath: originalUfdrAbsolutePath,
        transcriptionRuntime: publicRuntimeDetails(payload.transcriptionRuntime),
        queueJobId: queuedJobId || null
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rm(payload.storedAbsolutePath, { recursive: true, force: true }).catch(() => undefined);
    await updateLocalImportProgress(
      payload,
      {
        phase: "local-import-failed",
        progress: 100,
        error: message
      },
      { status: "FAILED", reportError: message, finishedAt: new Date() }
    );
    await addCustodyEvent({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      actorId: payload.uploadedById,
      action: "INGESTION_FAILED",
      source: "worker-ingest-local-import",
      details: {
        extractionId: payload.extractionId,
        sourcePath: payload.sourcePath,
        error: message
      }
    });
    throw error;
  }
}

async function processUfdr(jobData: IngestJob) {
  const payload = ingestJobSchema.parse(jobData);
  const existingExtraction = await prisma.extraction.findUnique({
    where: { id: payload.extractionId },
    select: { status: true, processingDetails: true }
  });

  if (!existingExtraction) {
    log("warn", "Ingestion job skipped: extraction not found", {
      extractionId: payload.extractionId,
      caseId: payload.caseId,
      evidenceId: payload.evidenceId
    });
    return;
  }

  if (existingExtraction.status === "COMPLETED" || existingExtraction.status === "FAILED") {
    log("info", "Ingestion job skipped: extraction is terminal", {
      extractionId: payload.extractionId,
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      status: existingExtraction.status
    });
    return;
  }

  const startedAtMs = Date.now();
  let lastPhaseAtMs = startedAtMs;
  const reportXmlInMemory = { value: false };
  const parserMode = { value: "xml-dom" as "xml-dom" | "xml-stream" };
  const transcriptionRuntime = resolveTranscriptionRuntime(payload.transcriptionRuntime);
  const transcriptionRequestedEnabled = payload.transcriptionRuntime?.enabled ?? true;

  const setProgress = async (phase: string, progress: number, extra?: Record<string, unknown>) => {
    const nowMs = Date.now();
    const phaseDetails = {
      extractionId: payload.extractionId,
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      phase,
      progress,
      elapsedMs: nowMs - startedAtMs,
      phaseElapsedMs: nowMs - lastPhaseAtMs,
      transcriptionRuntime: {
        enabled: transcriptionRequestedEnabled,
        engine: transcriptionRuntime.engine,
        model: transcriptionRuntime.model,
        language: transcriptionRuntime.language ?? null
      },
      ...(extra ?? {})
    };
    await updateExtractionStatus(payload.extractionId, "PROCESSING", {
      processingDetails: {
        ...phaseDetails
      }
    });
    if (WORKER_INGEST_DEBUG_PHASES) {
      log("debug", "Ingestion phase update", phaseDetails);
    }
    lastPhaseAtMs = nowMs;
  };

  const phaseTimers = {
    scanStartedAtMs: 0,
    scanFinishedAtMs: 0,
    parseStartedAtMs: 0,
    parseFinishedAtMs: 0,
    persistStartedAtMs: 0,
    persistFinishedAtMs: 0,
    audioStartedAtMs: 0,
    audioFinishedAtMs: 0,
    indexStartedAtMs: 0,
    indexFinishedAtMs: 0
  };

  await updateExtractionStatus(payload.extractionId, "PROCESSING", {
    startedAt: new Date(),
    finishedAt: null,
    reportError: null,
    reportFound: false,
    reportPath: null,
    processingDetails: {
      phase: "queued",
      progress: 2,
      elapsedMs: 0,
      phaseElapsedMs: 0,
      transcriptionRuntime: {
        enabled: transcriptionRequestedEnabled,
        engine: transcriptionRuntime.engine,
        model: transcriptionRuntime.model,
        language: transcriptionRuntime.language ?? null
      }
    }
  });
  await addCustodyEvent({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId,
    action: "INGESTION_STARTED",
    source: "worker-ingest",
    details: {
      extractionId: payload.extractionId,
      filename: payload.originalFilename
    }
  });
  if (WORKER_INGEST_DEBUG_PHASES) {
    log("debug", "Ingestion job payload received", {
      job: {
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        extractionId: payload.extractionId,
        originalFilename: payload.originalFilename,
        ufdrAbsolutePath: payload.ufdrAbsolutePath,
        transcriptionRuntime: payload.transcriptionRuntime ?? null
      }
    });
  }
  await setProgress("opening-ufdr", 8);
  await waitForUfdrSourceAvailable({
    absolutePath: payload.ufdrAbsolutePath,
    timeoutMs: UFDR_SOURCE_AVAILABILITY_TIMEOUT_MS
  });

  phaseTimers.scanStartedAtMs = Date.now();
  const scan = await scanUfdrArchive(payload.ufdrAbsolutePath);
  phaseTimers.scanFinishedAtMs = Date.now();
  const useXmlStream = shouldUseXmlStreamParse(scan);
  reportXmlInMemory.value = Boolean(scan.reportXmlContent) && !useXmlStream;
  await setProgress("report-lookup", 15, {
    filesScanned: scan.files.length,
    reportXmlInMemoryReady: reportXmlInMemory.value,
    xmlParseStrategy: useXmlStream ? "stream" : "in-memory"
  });

  if (!scan.reportXmlPath) {
    const details = {
      reportFound: false,
      reportXmlPath: null,
      filesScanned: scan.files.length,
      sampleFiles: scan.files.slice(0, 50)
    };
    await updateExtractionStatus(payload.extractionId, "FAILED", {
      reportFound: false,
      reportError: "report.xml not found in UFDR source (archive or extracted directory)",
      processingDetails: {
        ...details,
        phase: "failed-report-missing",
        progress: 100
      },
      finishedAt: new Date()
    });
    throw new Error("report.xml not found in UFDR source (archive or extracted directory)");
  }

  let normalized;
  phaseTimers.parseStartedAtMs = Date.now();
  if (scan.reportXmlContent && !useXmlStream) {
    parserMode.value = "xml-dom";
    if (WORKER_INGEST_DEBUG_PHASES) {
      log("debug", "Parsing report.xml in memory", {
        extractionId: payload.extractionId,
        parserMode: parserMode.value,
        reportXmlPath: scan.reportXmlPath
      });
    }
    normalized = parseUfdrReportXml(scan.reportXmlContent);
  } else {
    parserMode.value = "xml-stream";
    const tmpDir = path.resolve(resolveStorageRoot(), "derived", payload.caseId, payload.evidenceId, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const reportTmpPath = path.resolve(tmpDir, `${payload.extractionId}-report.xml`);
    await setProgress("report-extract-to-disk", 22, {
      reportPath: scan.reportXmlPath,
      reason: scan.reportXmlContentError ?? "report.xml too large for in-memory parse"
    });
    await extractArchiveEntryToFile({
      ufdrAbsolutePath: payload.ufdrAbsolutePath,
      entryPath: scan.reportXmlPath,
      outputPath: reportTmpPath
    });
    await setProgress("xml-stream-parsing", 26, {
      reportTmpPath
    });
    const reportStat = await stat(reportTmpPath).catch(() => null);
    const reportSizeBytes = reportStat?.size ?? null;
    let lastParseProgressUpdateAt = 0;
    try {
      if (WORKER_INGEST_DEBUG_PHASES) {
        log("debug", "Parsing report.xml from disk stream", {
          extractionId: payload.extractionId,
          parserMode: parserMode.value,
          reportXmlPath: scan.reportXmlPath,
          reportTmpPath
        });
      }
      normalized = await parseUfdrReportXmlStream(reportTmpPath, {
        onProgress: ({ bytesRead }) => {
          const now = Date.now();
          if (now - lastParseProgressUpdateAt < 3000) return;
          lastParseProgressUpdateAt = now;
          const parseProgress =
            typeof reportSizeBytes === "number" && reportSizeBytes > 0
              ? Math.min(29, 26 + Math.floor((bytesRead / reportSizeBytes) * 3))
              : 26;
          void setProgress("xml-stream-parsing", parseProgress, {
            reportTmpPath,
            reportSizeBytes,
            xmlBytesRead: bytesRead
          });
        }
      });
    } finally {
      await rm(reportTmpPath, { force: true }).catch(() => undefined);
    }
  }
  phaseTimers.parseFinishedAtMs = Date.now();
  await setProgress("xml-parsed", 30, {
    reportPath: scan.reportXmlPath,
    contactsCount: normalized.contacts.length,
    chatsCount: normalized.chats.length,
    parserMode: parserMode.value
  });

  const rawMetadata = (normalized.rawMetadata ?? {}) as Record<string, unknown>;
  const parserLimits =
    rawMetadata.parserLimits && typeof rawMetadata.parserLimits === "object"
      ? (rawMetadata.parserLimits as Record<string, unknown>)
      : undefined;
  const parserDropped =
    rawMetadata.parserDropped && typeof rawMetadata.parserDropped === "object"
      ? (rawMetadata.parserDropped as Record<string, unknown>)
      : undefined;
  const parserLimitsMetrics = {
    maxChats: typeof parserLimits?.maxChats === "number" ? parserLimits.maxChats : undefined,
    maxMessagesPerChat:
      typeof parserLimits?.maxMessagesPerChat === "number" ? parserLimits.maxMessagesPerChat : undefined,
    maxTotalMessages: typeof parserLimits?.maxTotalMessages === "number" ? parserLimits.maxTotalMessages : undefined,
    maxAudioFiles: typeof parserLimits?.maxAudioFiles === "number" ? parserLimits.maxAudioFiles : undefined
  };
  const parserDroppedMetrics = {
    chats: typeof parserDropped?.chats === "number" ? parserDropped.chats : undefined,
    messages: typeof parserDropped?.messages === "number" ? parserDropped.messages : undefined,
    audioFiles: typeof parserDropped?.audioFiles === "number" ? parserDropped.audioFiles : undefined
  };

  await clearDerivedDataByEvidence(payload.evidenceId);
  phaseTimers.persistStartedAtMs = Date.now();
  await setProgress("persisting-domain", 42);

  if (normalized.device) {
    if (WORKER_INGEST_DEBUG_PHASES) {
      log("debug", "Detected device metadata from UFDR", {
        extractionId: payload.extractionId,
        manufacturer: normalized.device.manufacturer ?? null,
        model: normalized.device.model ?? null,
        imei: normalized.device.imei ?? null,
        serialNumber: normalized.device.serialNumber ?? null
      });
    }
    const devicePayload: {
      extractionId: string;
      manufacturer?: string;
      model?: string;
      osVersion?: string;
      imei?: string;
      serialNumber?: string;
      metadata?: any;
    } = {
      extractionId: payload.extractionId,
      metadata: {
        imei2: normalized.device.imei2 ?? null,
        iccid: normalized.device.iccid ?? null,
        msisdn: normalized.device.msisdn ?? null,
        macAddress: normalized.device.macAddress ?? null,
        bluetoothAddress: normalized.device.bluetoothAddress ?? null
      }
    };
    if (normalized.device.manufacturer) devicePayload.manufacturer = normalized.device.manufacturer;
    if (normalized.device.model) devicePayload.model = normalized.device.model;
    if (normalized.device.osVersion) devicePayload.osVersion = normalized.device.osVersion;
    if (normalized.device.imei) devicePayload.imei = normalized.device.imei;
    if (normalized.device.serialNumber) devicePayload.serialNumber = normalized.device.serialNumber;

    await saveExtractionDevice({
      ...devicePayload
    });
  }

  const ufdrCaseContext =
    rawMetadata.ufdrCaseContext && typeof rawMetadata.ufdrCaseContext === "object"
      ? (rawMetadata.ufdrCaseContext as {
          inquiryType?: string;
          inquiryNumber?: string;
          policeUnit?: string;
          inquiryLegalFraming?: string;
          inquirySummaryText?: string;
          inquiryMainFacts?: string;
          inquiryInvestigativeFocus?: string;
          extractionReportSummary?: string;
          inquiryInvolvedPeople?: string[];
        })
      : undefined;
  await enrichCaseContextFromUfdrMetadata({
    caseId: payload.caseId,
    context: ufdrCaseContext
  });

  const persisted = await persistNormalizedExtraction({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId,
    extractionId: payload.extractionId,
    normalized
  });
  phaseTimers.persistFinishedAtMs = Date.now();
  await setProgress("domain-persisted", 58);

  const audioOutputDir = path.resolve(resolveStorageRoot(), "derived", payload.caseId, payload.evidenceId, "audio");

  let transcriptionEnabled = transcriptionRequestedEnabled;
  const audioHintsCount = normalized.audioArtifacts.length;
  const normalizedAudioHints: AudioExtractionHintRow[] = normalized.audioArtifacts.map((row) => ({
    archivePath: row.archivePath,
    fileName: row.fileName,
    timestamp: row.timestamp,
    senderExternalId: row.senderExternalId,
    chatExternalId: row.chatExternalId,
    messageExternalId: row.messageExternalId
  }));
  let audioTimeoutManualReviewRequired = false;
  let audioTimeoutErrorMessage: string | null = null;
  let audioExtractionLastArchivePath: string | null = null;
  let audioRecoveryExtractedCount = 0;
  let audioRecoverySkippedTimeoutCount = 0;
  let audioRecoverySkippedErrorCount = 0;
  phaseTimers.audioStartedAtMs = Date.now();
  let extractedAudio: ExtractedAudioArtifact[] = [];
  let transcriptionRows: Array<{
    attachmentId: string;
    transcriptionId: string;
    audioAbsolutePath: string;
    linkageStrategy: "direct-id" | "hint-id" | "attachment-key" | "timestamp-nearest" | "chat-fallback" | "unlinked";
    linkageScore: number;
  }> = [];
  let audioHintsIndexedCount = 0;
  let audioHintsLinkedCount = 0;
  let audioHintLinkageSummary: Record<string, number> = {};

  if (transcriptionEnabled) {
    let lastAudioProgressUpdateAt = 0;
    const audioStartedAt = Date.now();
    await setProgress("audio-extracting", 62, {
      audioHintsCount,
      audioMaxFiles: UFDR_AUDIO_MAX_FILES ?? null,
      audioExtractionTimeoutMs: UFDR_AUDIO_EXTRACTION_TIMEOUT_MS ?? null
    });
    try {
      extractedAudio = await withOptionalTimeout({
        label: "Extracao de audios do UFDR",
        timeoutMs: UFDR_AUDIO_EXTRACTION_TIMEOUT_MS,
        run: () =>
          extractAudioEntriesFromUfdr({
            ufdrAbsolutePath: payload.ufdrAbsolutePath,
            outputDir: audioOutputDir,
            hints: normalizedAudioHints.map((row) => ({
              archivePath: row.archivePath,
              fileName: row.fileName,
              chatExternalId: row.chatExternalId,
              messageExternalId: row.messageExternalId
            })),
            maxFiles: UFDR_AUDIO_MAX_FILES,
            onProgress: ({ processed, total, archivePath }) => {
              if (archivePath) {
                audioExtractionLastArchivePath = archivePath;
              }
              const now = Date.now();
              if (processed > 0 && (now - lastAudioProgressUpdateAt >= 3000 || (typeof total === "number" && processed >= total))) {
                lastAudioProgressUpdateAt = now;
                const phaseProgress =
                  typeof total === "number" && total > 0 ? Math.min(69, 62 + Math.floor((processed / total) * 7)) : 62;
                const elapsedMs = Math.max(1, now - audioStartedAt);
                const ratePerMin = (processed * 60000) / elapsedMs;
                const etaSec =
                  typeof total === "number" && total > processed && ratePerMin > 0
                    ? Math.round(((total - processed) / ratePerMin) * 60)
                    : null;
                void setProgress("audio-extracting", phaseProgress, {
                  audioHintsCount,
                  audioExtractionProcessed: processed,
                  audioExtractionTotal: total ?? null,
                  audioExtractionRatePerMin: Number(ratePerMin.toFixed(2)),
                  audioExtractionEtaSec: etaSec,
                  audioExtractionLastArchivePath
                });
              }
            }
          })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Extracao de audios do UFDR excedeu o tempo limite")) {
        log("warn", "Audio extraction timeout; manual review required", {
          extractionId: payload.extractionId,
          evidenceId: payload.evidenceId,
          caseId: payload.caseId,
          timeoutMs: UFDR_AUDIO_EXTRACTION_TIMEOUT_MS,
          audioExtractionLastArchivePath
        });
        audioTimeoutManualReviewRequired = true;
        audioTimeoutErrorMessage = `${message} [MANUAL_AUDIO_REVIEW_REQUIRED] Verifique manualmente os audios da evidencia.${audioExtractionLastArchivePath ? ` Ultimo arquivo processado: ${audioExtractionLastArchivePath}.` : ""}`;

        if (UFDR_AUDIO_RECOVERY_ASYNC_ENABLED) {
          const resolvedRecovery = await resolveAudioRecoveryTargets({
            ufdrAbsolutePath: payload.ufdrAbsolutePath,
            hints: normalizedAudioHints,
            maxFiles: UFDR_AUDIO_MAX_FILES
          });
          const recoveryBatches = chunkRows(resolvedRecovery.targets, UFDR_AUDIO_RECOVERY_BATCH_SIZE);
          audioRecoverySkippedErrorCount = resolvedRecovery.unresolvedHints;

          if (recoveryBatches.length > 0) {
            const runtime = payload.transcriptionRuntime;
            const runtimeEngine = payload.transcriptionRuntime?.engine ?? "local";
            const runtimeModel =
              payload.transcriptionRuntime?.model ??
              (runtimeEngine === "openai"
                ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
                : runtimeEngine === "assemblyai"
                  ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL || "best"
                : process.env.WHISPER_MODEL || "base");

            audioTimeoutErrorMessage = `${audioTimeoutErrorMessage} Recuperacao pos-timeout assincrona em lotes: ${recoveryBatches.length} lotes planejados (unresolved ${resolvedRecovery.unresolvedHints}).`;

            await updateExtractionStatus(payload.extractionId, "PROCESSING", {
              processingDetails: {
                phase: "audio-recovery-batches-running",
                progress: 92,
                audioRecoveryStartedAt: new Date().toISOString(),
                filesScanned: scan.files.length,
                contactsCount: normalized.contacts.length,
                chatsCount: normalized.chats.length,
                callsCount: normalized.calls.length,
                filesCount: normalized.files.length,
                audioHintsCount,
                audioExtractedCount: 0,
                audioHintsIndexedCount,
                audioHintsLinkedCount,
                audioTranscriptionJobsCount: 0,
                audioTranscriptionSkippedMissingFileCount: 0,
                audioTranscriptionEnabled: true,
                audioTimeoutManualReviewRequired,
                audioTimeoutErrorMessage,
                audioExtractionLastArchivePath,
                audioRecoveryAsync: true,
                audioRecoveryBatchTotal: recoveryBatches.length,
                audioRecoveryBatchProcessed: 0,
                audioRecoveryCompletedBatches: [],
                audioRecoveryBatchSize: UFDR_AUDIO_RECOVERY_BATCH_SIZE,
                audioRecoveryExtractedCount: 0,
                audioRecoverySkippedTimeoutCount: 0,
                audioRecoverySkippedErrorCount: resolvedRecovery.unresolvedHints,
                audioRecoveryUnresolvedHintCount: resolvedRecovery.unresolvedHints,
                parserMode: parserMode.value,
                reportXmlInMemoryReady: reportXmlInMemory.value,
                parserLimits: parserLimitsMetrics,
                parserDropped: parserDroppedMetrics,
                transcriptionRuntime: {
                  enabled: true,
                  requestedEnabled: transcriptionRequestedEnabled,
                  engine: runtimeEngine,
                  model: runtimeModel,
                  language: payload.transcriptionRuntime?.language ?? null
                }
              }
            });

            for (let i = 0; i < recoveryBatches.length; i += 1) {
              const batchTargets = recoveryBatches[i] ?? [];
              await enqueueAudioRecoveryBatch({
                extractionId: payload.extractionId,
                evidenceId: payload.evidenceId,
                caseId: payload.caseId,
                ufdrAbsolutePath: payload.ufdrAbsolutePath,
                targets: batchTargets,
                batchIndex: i + 1,
                batchTotal: recoveryBatches.length,
                unresolvedHintsInBatchPlan: resolvedRecovery.unresolvedHints,
                transcriptionRuntime: runtime
                  ? {
                      engine: runtime.engine,
                      model: runtime.model,
                      openaiApiKey: runtime.openaiApiKey,
                      assemblyAiApiKey: runtime.assemblyAiApiKey,
                      language: runtime.language
                    }
                  : undefined
              });
            }

            phaseTimers.audioFinishedAtMs = Date.now();
            await ensureSearchIndices();
            phaseTimers.indexStartedAtMs = Date.now();
            await setProgress("indexing", 90);
            await indexExtractionSummary({
              caseId: payload.caseId,
              evidenceId: payload.evidenceId,
              extractionId: payload.extractionId,
              normalized
            });
            const attachmentPathIndexResult = await indexAttachmentArchivePathsForEvidence({
              caseId: payload.caseId,
              evidenceId: payload.evidenceId,
              extractionId: payload.extractionId,
              ufdrAbsolutePath: payload.ufdrAbsolutePath,
              scannedFiles: scan.files,
              source: "worker-ingest"
            });
            phaseTimers.indexFinishedAtMs = Date.now();

            await addCustodyEvent({
              caseId: payload.caseId,
              evidenceId: payload.evidenceId,
              action: "INGESTION_AUDIO_RECOVERY_BATCHES_QUEUED",
              source: "worker-ingest",
              details: {
                extractionId: payload.extractionId,
                audioRecoveryBatchTotal: recoveryBatches.length,
                audioRecoveryBatchSize: UFDR_AUDIO_RECOVERY_BATCH_SIZE,
                unresolvedHints: resolvedRecovery.unresolvedHints,
                timeoutMs: UFDR_AUDIO_EXTRACTION_TIMEOUT_MS,
                audioExtractionLastArchivePath,
                attachmentPathIndexResult
              }
            });

            await enqueueAudioRecoveryFinalize(
              {
                extractionId: payload.extractionId,
                evidenceId: payload.evidenceId,
                caseId: payload.caseId
              },
              { delayMs: UFDR_AUDIO_RECOVERY_FINALIZE_DELAY_MS }
            );

            return;
          }

          transcriptionEnabled = false;
          audioRecoveryExtractedCount = 0;
          audioRecoverySkippedTimeoutCount = 0;
          audioRecoverySkippedErrorCount = resolvedRecovery.unresolvedHints;
          const recoveredSkippedTotal = audioRecoverySkippedTimeoutCount + audioRecoverySkippedErrorCount;
          audioTimeoutErrorMessage = `${audioTimeoutErrorMessage} Recuperacao pos-timeout: extraidos 0, ignorados ${recoveredSkippedTotal} (timeout ${audioRecoverySkippedTimeoutCount}, erro ${audioRecoverySkippedErrorCount}).`;
          await setProgress("audio-timeout-manual-review", 69, {
            audioHintsCount,
            audioExtractionProcessed: 0,
            audioExtractionTotal: audioHintsCount,
            audioExtractionTimeoutMs: UFDR_AUDIO_EXTRACTION_TIMEOUT_MS,
            manualAudioReviewRequired: true,
            audioExtractionLastArchivePath,
            audioRecoveryExtractedCount,
            audioRecoverySkippedTimeoutCount,
            audioRecoverySkippedErrorCount
          });
        } else {
          let lastRecoveryProgressUpdateAt = 0;
          const recoveryStartedAt = Date.now();
          const recovery = await extractAudioEntriesFromHintsBestEffort({
            ufdrAbsolutePath: payload.ufdrAbsolutePath,
            outputDir: audioOutputDir,
            hints: normalizedAudioHints,
            timeoutMs: Math.min(UFDR_AUDIO_EXTRACTION_TIMEOUT_MS, UFDR_AUDIO_ENTRY_TIMEOUT_MS),
            maxFiles: UFDR_AUDIO_MAX_FILES,
            batchSize: UFDR_AUDIO_RECOVERY_BATCH_SIZE,
            onProgress: ({
              processed,
              total,
              extracted,
              skippedByTimeout,
              skippedByError,
              batchIndex,
              batchTotal,
              batchProcessed,
              batchSize,
              archivePath
            }) => {
              if (archivePath) {
                audioExtractionLastArchivePath = archivePath;
              }
              const now = Date.now();
              if (processed > 0 && (now - lastRecoveryProgressUpdateAt >= 3000 || processed >= total)) {
                lastRecoveryProgressUpdateAt = now;
                const phaseProgress = total > 0 ? Math.min(69, 62 + Math.floor((processed / total) * 7)) : 62;
                const elapsedMs = Math.max(1, now - recoveryStartedAt);
                const ratePerMin = (processed * 60000) / elapsedMs;
                const etaSec = total > processed && ratePerMin > 0 ? Math.round(((total - processed) / ratePerMin) * 60) : null;
                void setProgress("audio-extracting-recovery", phaseProgress, {
                  audioHintsCount,
                  audioRecoveryProcessed: processed,
                  audioRecoveryTotal: total,
                  audioRecoveryExtractedCount: extracted,
                  audioRecoverySkippedTimeoutCount: skippedByTimeout,
                  audioRecoverySkippedErrorCount: skippedByError,
                  audioRecoveryBatchIndex: batchIndex,
                  audioRecoveryBatchTotal: batchTotal,
                  audioRecoveryBatchProcessed: batchProcessed,
                  audioRecoveryBatchSize: batchSize,
                  audioRecoveryRatePerMin: Number(ratePerMin.toFixed(2)),
                  audioRecoveryEtaSec: etaSec,
                  audioExtractionLastArchivePath
                });
              }
            }
          });

          extractedAudio = recovery.items;
          audioRecoveryExtractedCount = recovery.items.length;
          audioRecoverySkippedTimeoutCount = recovery.skippedByTimeout;
          audioRecoverySkippedErrorCount = recovery.skippedByError;

          const recoveredSkippedTotal = recovery.skippedByTimeout + recovery.skippedByError;
          if (recovery.items.length === 0) {
            transcriptionEnabled = false;
          }

          audioTimeoutErrorMessage = `${audioTimeoutErrorMessage} Recuperacao pos-timeout: extraidos ${recovery.items.length}, ignorados ${recoveredSkippedTotal} (timeout ${recovery.skippedByTimeout}, erro ${recovery.skippedByError}).`;
          await setProgress("audio-timeout-manual-review", 69, {
            audioHintsCount,
            audioExtractionProcessed: extractedAudio.length,
            audioExtractionTotal: audioHintsCount,
            audioExtractionTimeoutMs: UFDR_AUDIO_EXTRACTION_TIMEOUT_MS,
            manualAudioReviewRequired: true,
            audioExtractionLastArchivePath,
            audioRecoveryExtractedCount,
            audioRecoverySkippedTimeoutCount,
            audioRecoverySkippedErrorCount
          });
        }
      } else {
        throw error;
      }
    }

    if (transcriptionEnabled) {
      if (WORKER_INGEST_DEBUG_PHASES) {
        log("debug", "Audio extraction completed", {
          extractionId: payload.extractionId,
          extractedAudioCount: extractedAudio.length,
          audioHintsCount,
          audioCapReached:
            typeof UFDR_AUDIO_MAX_FILES === "number" && extractedAudio.length >= UFDR_AUDIO_MAX_FILES && audioHintsCount > extractedAudio.length
        });
      }

      transcriptionRows = await persistAudioAttachments({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        extractionId: payload.extractionId,
        items: extractedAudio,
        audioHints: normalizedAudioHints,
        chatExternalToId: persisted.chatExternalToId,
        messageExternalToId: persisted.messageExternalToId,
        messageTimeline: persisted.messageTimeline
      });
    }
  }
  if (!transcriptionEnabled) {
    let lastMetadataProgressUpdateAt = 0;
    const metadataStartedAt = Date.now();
    await setProgress("audio-indexing-metadata", 62, {
      audioHintsCount,
      transcriptionEnabled: false
    });
    const indexed = await persistAudioArtifactsIndex({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      items: normalized.audioArtifacts.map((row) => ({
        archivePath: row.archivePath,
        fileName: row.fileName,
        mimeType: row.mimeType,
        timestamp: row.timestamp,
        chatExternalId: row.chatExternalId,
        messageExternalId: row.messageExternalId,
        senderExternalId: row.senderExternalId,
        metadata: row.metadata
      })),
      messageExternalToId: persisted.messageExternalToId,
      messageTimeline: persisted.messageTimeline,
      onProgress: ({ processed, total }) => {
        const now = Date.now();
        if (processed > 0 && (now - lastMetadataProgressUpdateAt >= 3000 || processed >= total)) {
          lastMetadataProgressUpdateAt = now;
          const phaseProgress = total > 0 ? Math.min(69, 62 + Math.floor((processed / total) * 7)) : 62;
          const elapsedMs = Math.max(1, now - metadataStartedAt);
          const ratePerMin = (processed * 60000) / elapsedMs;
          const etaSec = total > processed && ratePerMin > 0 ? Math.round(((total - processed) / ratePerMin) * 60) : 0;
          void setProgress("audio-indexing-metadata", phaseProgress, {
            audioHintsCount,
            audioMetadataIndexedProcessed: processed,
            audioMetadataIndexedTotal: total,
            audioMetadataIndexedRatePerMin: Number(ratePerMin.toFixed(2)),
            audioMetadataIndexedEtaSec: etaSec
          });
        }
      }
    });
    audioHintsIndexedCount = indexed.created;
    audioHintsLinkedCount = indexed.linked;
    audioHintLinkageSummary = indexed.linkageSummary;
  }
  phaseTimers.audioFinishedAtMs = Date.now();
  const audioCapReached =
    transcriptionEnabled &&
    typeof UFDR_AUDIO_MAX_FILES === "number" &&
    extractedAudio.length >= UFDR_AUDIO_MAX_FILES &&
    audioHintsCount > extractedAudio.length;
  await setProgress("audio-extracted", 70, {
    audioExtractedCount: extractedAudio.length,
    audioHintsCount,
    audioHintsIndexedCount,
    audioHintsLinkedCount,
    audioRecoveryExtractedCount,
    audioRecoverySkippedTimeoutCount,
    audioRecoverySkippedErrorCount,
    audioMaxFiles: UFDR_AUDIO_MAX_FILES ?? null,
    audioCapReached
  });

  let transcriptionJobsQueued = 0;
  let transcriptionJobsSkippedMissingFile = 0;
  let transcriptionJobsSkippedPolicy = 0;
  if (transcriptionEnabled) {
    const eligibilityByAttachment = await buildAttachmentTranscriptionEligibilityMap(
      transcriptionRows.map((row) => row.attachmentId)
    );
    for (const row of transcriptionRows) {
      const eligibility = eligibilityByAttachment.get(row.attachmentId);
      const opusByPath = hasOpusExtension(row.audioAbsolutePath);
      if (!eligibility?.eligible || !opusByPath) {
        await prisma.audioTranscription.update({
          where: { id: row.transcriptionId },
          data: {
            status: "FAILED",
            error:
              eligibility?.reason ?? "Descartado pela politica: somente arquivos .opus do WhatsApp sao transcritos.",
            finishedAt: new Date()
          }
        });
        transcriptionJobsSkippedPolicy += 1;
        continue;
      }

      const fileInfo = await stat(row.audioAbsolutePath).catch(() => null);
      if (!fileInfo || !fileInfo.isFile() || fileInfo.size <= 0) {
        await prisma.audioTranscription.update({
          where: { id: row.transcriptionId },
          data: {
            status: "FAILED",
            error: `Arquivo de audio ausente/invalido antes do enqueue (bytes=${fileInfo?.size ?? 0}).`,
            finishedAt: new Date()
          }
        });
        transcriptionJobsSkippedMissingFile += 1;
        log("warn", "Skipping missing/empty audio before enqueue", {
          extractionId: payload.extractionId,
          transcriptionId: row.transcriptionId,
          attachmentId: row.attachmentId,
          audioAbsolutePath: row.audioAbsolutePath,
          bytes: fileInfo?.size ?? 0
        });
        continue;
      }

      const runtime = payload.transcriptionRuntime;
      const runtimeEngine = runtime?.engine ?? "local";
      const runtimeModel =
        runtime?.model ??
        (runtimeEngine === "openai"
          ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
          : runtimeEngine === "assemblyai"
            ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL || "best"
          : process.env.WHISPER_MODEL || "base");
      await enqueueAudioTranscription({
        transcriptionId: row.transcriptionId,
        attachmentId: row.attachmentId,
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        extractionId: payload.extractionId,
        audioAbsolutePath: row.audioAbsolutePath,
        language: runtime?.language,
        engine: runtimeEngine,
        model: runtimeModel,
        openaiApiKey: runtime?.openaiApiKey,
        assemblyAiApiKey: runtime?.assemblyAiApiKey
      });
      transcriptionJobsQueued += 1;
    }
  }
  await setProgress(transcriptionEnabled ? "audio-transcription-queued" : "audio-transcription-skipped", 82, {
    audioTranscriptionJobsCount: transcriptionJobsQueued,
    audioTranscriptionSkippedMissingFileCount: transcriptionJobsSkippedMissingFile,
    audioTranscriptionSkippedPolicyCount: transcriptionJobsSkippedPolicy,
    audioTranscriptionEnabled: transcriptionEnabled
  });

  const linkageSummary = transcriptionRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.linkageStrategy] = (acc[row.linkageStrategy] ?? 0) + 1;
    return acc;
  }, {});

  await ensureSearchIndices();
  phaseTimers.indexStartedAtMs = Date.now();
  await setProgress("indexing", 90);
  await indexExtractionSummary({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId,
    extractionId: payload.extractionId,
    normalized
  });
  const attachmentPathIndexResult = await indexAttachmentArchivePathsForEvidence({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId,
    extractionId: payload.extractionId,
    ufdrAbsolutePath: payload.ufdrAbsolutePath,
    scannedFiles: scan.files,
    source: "worker-ingest"
  });
  phaseTimers.indexFinishedAtMs = Date.now();

  if (WORKER_INGEST_DEBUG_PHASES) {
    log("debug", "Ingestion indexing completed", {
      extractionId: payload.extractionId,
      contactsCount: normalized.contacts.length,
      chatsCount: normalized.chats.length,
      callsCount: normalized.calls.length,
      filesCount: normalized.files.length,
      locationsCount: normalized.locations.length,
      audioArtifactsCount: normalized.audioArtifacts.length
    });
  }

  const nowMs = Date.now();
  const operationalAlertSnapshot = buildOperationalAlertSnapshot({
    audioCapReached,
    audioExtractedCount: extractedAudio.length,
    audioMaxFiles: UFDR_AUDIO_MAX_FILES,
    audioTimeoutManualReviewRequired,
    audioExtractionTimeoutMs: UFDR_AUDIO_EXTRACTION_TIMEOUT_MS,
    audioExtractionLastArchivePath,
    parserDropped: parserDroppedMetrics
  });
  const ingestMetrics = {
    parserMode: parserMode.value,
    reportXmlInMemoryReady: reportXmlInMemory.value,
    filesScanned: scan.files.length,
    audioHintsCount,
    audioMaxFiles: UFDR_AUDIO_MAX_FILES ?? null,
    audioCapReached,
    audioTimeoutManualReviewRequired,
    audioExtractionTimeoutMs: UFDR_AUDIO_EXTRACTION_TIMEOUT_MS,
    audioExtractionLastArchivePath,
    audioRecoveryExtractedCount,
    audioRecoverySkippedTimeoutCount,
    audioRecoverySkippedErrorCount,
    parserLimits: parserLimitsMetrics,
    parserDropped: parserDroppedMetrics,
    timingsMs: {
      scan: phaseTimers.scanFinishedAtMs - phaseTimers.scanStartedAtMs,
      parse: phaseTimers.parseFinishedAtMs - phaseTimers.parseStartedAtMs,
      persist: phaseTimers.persistFinishedAtMs - phaseTimers.persistStartedAtMs,
      audio: phaseTimers.audioFinishedAtMs - phaseTimers.audioStartedAtMs,
      index: phaseTimers.indexFinishedAtMs - phaseTimers.indexStartedAtMs,
      total: nowMs - startedAtMs
    },
    attachmentPathIndexResult
  };

  await updateExtractionStatus(payload.extractionId, "COMPLETED", {
    reportFound: true,
    reportPath: scan.reportXmlPath,
    processingDetails: {
      phase: "completed",
      progress: 100,
      filesScanned: scan.files.length,
      contactsCount: normalized.contacts.length,
      chatsCount: normalized.chats.length,
      callsCount: normalized.calls.length,
      filesCount: normalized.files.length,
      audioExtractedCount: extractedAudio.length,
      audioHintsIndexedCount,
      audioHintsLinkedCount,
      audioTranscriptionJobsCount: transcriptionJobsQueued,
      audioTranscriptionSkippedMissingFileCount: transcriptionJobsSkippedMissingFile,
      audioTranscriptionEnabled: transcriptionEnabled,
      audioTimeoutManualReviewRequired,
      audioTimeoutErrorMessage,
      audioExtractionLastArchivePath,
      audioRecoveryExtractedCount,
      audioRecoverySkippedTimeoutCount,
      audioRecoverySkippedErrorCount,
      audioLinkageSummary: transcriptionEnabled ? linkageSummary : audioHintLinkageSummary,
      operationalAlertSnapshot,
      ingestMetrics,
      attachmentPathIndexResult,
          transcriptionRuntime: {
        enabled: transcriptionEnabled,
        requestedEnabled: transcriptionRequestedEnabled,
        engine: payload.transcriptionRuntime?.engine ?? "local",
        model:
          payload.transcriptionRuntime?.model ??
          ((payload.transcriptionRuntime?.engine ?? "local") === "openai"
            ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
            : process.env.WHISPER_MODEL || "base"),
        language: payload.transcriptionRuntime?.language ?? null
      }
    },
    finishedAt: new Date()
  });
  log("info", "Ingestion metrics", {
    extractionId: payload.extractionId,
    ...ingestMetrics
  });
  await addCustodyEvent({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId,
    action: "INGESTION_COMPLETED",
    source: "worker-ingest",
    details: {
      extractionId: payload.extractionId,
      audioTranscriptionsQueued: transcriptionJobsQueued,
      audioTranscriptionsSkippedMissingFile: transcriptionJobsSkippedMissingFile,
      audioTranscriptionEnabled: transcriptionEnabled,
      audioTimeoutManualReviewRequired,
      audioTimeoutErrorMessage,
      audioExtractionLastArchivePath,
      audioRecoveryExtractedCount,
      audioRecoverySkippedTimeoutCount,
      audioRecoverySkippedErrorCount,
      ufdrCaseContextApplied: Boolean(ufdrCaseContext),
      operationalAlertSnapshot,
      attachmentPathIndexResult
    }
  });
  await syncCaseTimeline({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId
  });
}

async function main() {
  log("info", "Starting ingestion worker");
  const localUfdrImportQueue = new Queue(QUEUE_NAMES.localUfdrImport, { connection: redisConnection });
  const ingestQueue = new Queue(QUEUE_NAMES.ingestUfdr, { connection: redisConnection });
  const audioRecoveryBatchQueue = new Queue(QUEUE_NAMES.audioRecoveryBatch, { connection: redisConnection });
  const audioRecoveryFinalizeQueue = new Queue(QUEUE_NAMES.audioRecoveryFinalize, { connection: redisConnection });
  log("info", "Audio recovery worker configuration", {
    batchSize: UFDR_AUDIO_RECOVERY_BATCH_SIZE,
    batchTimeoutMs: UFDR_AUDIO_RECOVERY_BATCH_TIMEOUT_MS,
    finalizeDelayMs: UFDR_AUDIO_RECOVERY_FINALIZE_DELAY_MS,
    workerConcurrency: UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY,
    asyncEnabled: UFDR_AUDIO_RECOVERY_ASYNC_ENABLED,
    queueScanMaxJobs: UFDR_AUDIO_RECOVERY_QUEUE_SCAN_MAX_JOBS
  });
  const localImportWorker = new Worker<LocalUfdrImportJob>(
    QUEUE_NAMES.localUfdrImport,
    async (job) => {
      log("info", "Processing local UFDR import preparation", { jobId: job.id, extractionId: job.data.extractionId });
      await processLocalUfdrImport(job.data);
      log("info", "Local UFDR import preparation completed", { jobId: job.id, extractionId: job.data.extractionId });
    },
    {
      connection: redisConnection,
      concurrency: 1,
      lockDuration: 30 * 60 * 1000,
      stalledInterval: 60 * 1000,
      maxStalledCount: 5
    }
  );

  const worker = new Worker<IngestJob>(
    QUEUE_NAMES.ingestUfdr,
    async (job) => {
      log("info", "Processing job", { jobId: job.id, extractionId: job.data.extractionId });
      await processUfdr(job.data);
      log("info", "Job completed", { jobId: job.id, extractionId: job.data.extractionId });
    },
    {
      connection: redisConnection,
      concurrency: 1,
      lockDuration: 30 * 60 * 1000,
      stalledInterval: 60 * 1000,
      maxStalledCount: 5
    }
  );

  const audioRecoveryBatchWorker = new Worker<AudioRecoveryBatchJob>(
    QUEUE_NAMES.audioRecoveryBatch,
    async (job) => {
      log("info", "Processing audio recovery batch", {
        jobId: job.id,
        extractionId: job.data.extractionId,
        batchIndex: job.data.batchIndex,
        batchTotal: job.data.batchTotal,
        targetCount: job.data.targets.length,
        queueDelayMs:
          typeof job.timestamp === "number" && Number.isFinite(job.timestamp) ? Date.now() - job.timestamp : null,
        configuredConcurrency: UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY
      });
      await processAudioRecoveryBatchJob(job.data, {
        jobId: String(job.id ?? ""),
        enqueuedAtMs: typeof job.timestamp === "number" ? job.timestamp : undefined,
        processedOnMs: Date.now()
      });
    },
    {
      connection: redisConnection,
      concurrency: UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY,
      lockDuration: 30 * 60 * 1000,
      stalledInterval: 60 * 1000,
      maxStalledCount: 3
    }
  );

  const audioRecoveryFinalizeWorker = new Worker<AudioRecoveryFinalizeJob>(
    QUEUE_NAMES.audioRecoveryFinalize,
    async (job) => {
      log("info", "Processing audio recovery finalize", {
        jobId: job.id,
        extractionId: job.data.extractionId,
        queueDelayMs:
          typeof job.timestamp === "number" && Number.isFinite(job.timestamp) ? Date.now() - job.timestamp : null
      });
      await processAudioRecoveryFinalizeJob(job.data);
    },
    {
      connection: redisConnection,
      concurrency: 1,
      lockDuration: 10 * 60 * 1000,
      stalledInterval: 30 * 1000,
      maxStalledCount: 3
    }
  );

  localImportWorker.on("failed", async (job, error) => {
    if (job?.data?.extractionId) {
      await updateExtractionStatus(job.data.extractionId, "FAILED", {
        reportError: error.message,
        processingDetails: {
          phase: "local-import-failed",
          progress: 100,
          error: error.message
        },
        finishedAt: new Date()
      }).catch(() => undefined);
    }
    log("error", "Local UFDR import preparation failed", {
      jobId: job?.id,
      extractionId: job?.data?.extractionId,
      error: error.message
    });
  });

  localImportWorker.on("active", (job) => {
    log("info", "Local UFDR import job active", {
      jobId: job.id,
      extractionId: job.data.extractionId,
      queue: QUEUE_NAMES.localUfdrImport
    });
  });

  worker.on("failed", async (job, error) => {
    if (job?.data?.extractionId) {
      const extraction = await prisma.extraction.findUnique({
        where: { id: job.data.extractionId },
        select: { status: true }
      });
      if (extraction?.status === "COMPLETED") {
        log("warn", "Job failure ignored: extraction is already completed", {
          jobId: job.id,
          extractionId: job.data.extractionId,
          error: error.message
        });
        return;
      }
      await updateExtractionStatus(job.data.extractionId, "FAILED", {
        reportFound: false,
        reportError: error.message,
        processingDetails: {
          phase: "failed",
          progress: 100,
          error: error.message
        },
        finishedAt: new Date()
      });
      await addCustodyEvent({
        caseId: job.data.caseId,
        evidenceId: job.data.evidenceId,
        action: "INGESTION_FAILED",
        source: "worker-ingest",
        details: {
          extractionId: job.data.extractionId,
          error: error.message,
          operationalAlertSnapshot: {
            generatedAt: new Date().toISOString(),
            highestSeverity: "CRITICAL",
            alerts: [
              {
                code: "INGESTION_FAILED",
                severity: "CRITICAL",
                message: error.message
              }
            ]
          }
        }
      });
    }
    log("error", "Job failed", {
      jobId: job?.id,
      extractionId: job?.data?.extractionId,
      error: error.message
    });
  });

  worker.on("active", (job) => {
    log("info", "Job active", { jobId: job.id, extractionId: job.data.extractionId, queue: QUEUE_NAMES.ingestUfdr });
  });

  worker.on("completed", (job) => {
    log("info", "Job event completed", { jobId: job.id, extractionId: job.data.extractionId, queue: QUEUE_NAMES.ingestUfdr });
  });

  worker.on("stalled", (jobId) => {
    log("warn", "Job stalled", { jobId, queue: QUEUE_NAMES.ingestUfdr });
  });

  worker.on("drained", () => {
    log("info", "Queue drained", { queue: QUEUE_NAMES.ingestUfdr });
  });

  audioRecoveryBatchWorker.on("failed", (job, error) => {
    log("error", "Audio recovery batch job failed", {
      queue: QUEUE_NAMES.audioRecoveryBatch,
      jobId: job?.id,
      extractionId: job?.data?.extractionId,
      error: error.message
    });
  });

  audioRecoveryFinalizeWorker.on("failed", (job, error) => {
    log("error", "Audio recovery finalize job failed", {
      queue: QUEUE_NAMES.audioRecoveryFinalize,
      jobId: job?.id,
      extractionId: job?.data?.extractionId,
      error: error.message
    });
  });

  audioRecoveryBatchWorker.on("completed", (job) => {
    log("info", "Audio recovery batch job completed", {
      queue: QUEUE_NAMES.audioRecoveryBatch,
      jobId: job.id,
      extractionId: job.data.extractionId,
      batchIndex: job.data.batchIndex,
      batchTotal: job.data.batchTotal
    });
  });

  audioRecoveryFinalizeWorker.on("completed", (job) => {
    log("info", "Audio recovery finalize job completed", {
      queue: QUEUE_NAMES.audioRecoveryFinalize,
      jobId: job.id,
      extractionId: job.data.extractionId
    });
  });

  const heartbeatTimer = setInterval(async () => {
    try {
      const localImportCounts = await localUfdrImportQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
      const counts = await ingestQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
      const recoveryBatchCounts = await audioRecoveryBatchQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed"
      );
      const recoveryFinalizeCounts = await audioRecoveryFinalizeQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed"
      );
      const recoveryRows = await prisma.extraction.findMany({
        where: {
          status: "PROCESSING",
          processingPhase: { contains: "audio-recovery" }
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          updatedAt: true,
          processingDetails: true
        }
      });
      const audioRecoveryObservability = await Promise.all(
        recoveryRows.map(async (row) => {
          const details = toProcessingDetailsRecord(row.processingDetails);
          const queueDelta = await loadAudioRecoveryQueueDeltaForHeartbeat(row.id, details);
          return {
            extractionId: row.id,
            updatedAt: row.updatedAt.toISOString(),
            phase: readStringFromDetails(details, "phase") ?? null,
            batchProcessed: readNumberFromDetails(details, "audioRecoveryBatchProcessed", 0),
            batchTotal: readNumberFromDetails(details, "audioRecoveryBatchTotal", 0),
            extractedCount: readNumberFromDetails(details, "audioRecoveryExtractedCount", 0),
            transcriptionJobsCount: readNumberFromDetails(details, "audioTranscriptionJobsCount", 0),
            batchesPerMin: readNumberFromDetails(details, "audioRecoveryBatchesPerMin", 0),
            filesPerMin: readNumberFromDetails(details, "audioRecoveryFilesPerMin", 0),
            averageBatchDurationMs: readNumberFromDetails(details, "audioRecoveryAverageBatchDurationMs", 0),
            averageQueueDelayMs: readNumberFromDetails(details, "audioRecoveryAverageQueueDelayMs", 0),
            progressUpdateDeltaMs: readNumberFromDetails(details, "audioRecoveryProgressUpdateDeltaMs", 0),
            queueOutstandingBatches: queueDelta.outstanding,
            expectedRemainingBatches: queueDelta.expectedRemainingBatches,
            persistedQueueDelta: queueDelta.persistedQueueDelta,
            queueScanTruncated: queueDelta.truncated,
            queueScanError: queueDelta.scanError ?? null
          };
        })
      );
      log("info", "Queue heartbeat", {
        queue: QUEUE_NAMES.ingestUfdr,
        localUfdrImport: localImportCounts,
        waiting: counts.waiting,
        active: counts.active,
        delayed: counts.delayed,
        failed: counts.failed,
        completed: counts.completed,
        audioRecoveryBatch: recoveryBatchCounts,
        audioRecoveryFinalize: recoveryFinalizeCounts,
        audioRecoveryObservability
      });
    } catch (error) {
      log("warn", "Queue heartbeat failed", {
        queue: QUEUE_NAMES.ingestUfdr,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, WORKER_LOG_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  const staleWatchdog = setInterval(async () => {
    try {
      const pendingCutoff = new Date(Date.now() - UFDR_STALE_PENDING_TIMEOUT_MS);
      const stalePendingRows = await prisma.extraction.findMany({
        where: {
          status: "PENDING",
          updatedAt: { lt: pendingCutoff }
        },
        select: {
          id: true,
          caseId: true,
          evidenceId: true,
          updatedAt: true,
          processingDetails: true,
          evidence: {
            select: {
              fileName: true,
              originalPath: true
            }
          }
        }
      });

      for (const row of stalePendingRows) {
        const details =
          row.processingDetails && typeof row.processingDetails === "object" && !Array.isArray(row.processingDetails)
            ? (row.processingDetails as Record<string, unknown>)
            : {};
        const pendingRequeueCount =
          typeof details.watchdogPendingRequeueCount === "number" ? details.watchdogPendingRequeueCount : 0;
        const runtimeDetails =
          details.transcriptionRuntime &&
          typeof details.transcriptionRuntime === "object" &&
          !Array.isArray(details.transcriptionRuntime)
            ? (details.transcriptionRuntime as Record<string, unknown>)
            : undefined;

        if (!row.evidence?.originalPath) {
          const err = "Watchdog: extracao PENDING sem evidencia associada para reenfileirar.";
          await updateExtractionStatus(row.id, "FAILED", {
            reportError: err,
            processingDetails: {
              ...details,
              phase: "failed-watchdog-pending-missing-evidence",
              progress: 100,
              staleSince: row.updatedAt.toISOString(),
              watchdogPendingRequeueCount: pendingRequeueCount
            },
            finishedAt: new Date()
          });
          continue;
        }

        if (pendingRequeueCount >= 2) {
          const err = `Watchdog: extracao permaneceu PENDING sem consumo de fila apos ${pendingRequeueCount} tentativas.`;
          await updateExtractionStatus(row.id, "FAILED", {
            reportError: err,
            processingDetails: {
              ...details,
              phase: "failed-watchdog-pending-stuck",
              progress: 100,
              staleSince: row.updatedAt.toISOString(),
              watchdogPendingRequeueCount: pendingRequeueCount
            },
            finishedAt: new Date()
          });
          await addCustodyEvent({
            caseId: row.caseId,
            evidenceId: row.evidenceId,
            action: "INGESTION_FAILED",
            source: "worker-ingest-watchdog",
            details: {
              extractionId: row.id,
              error: err
            }
          });
          continue;
        }

        const ufdrAbsolutePath = path.resolve(resolveStorageRoot(), row.evidence.originalPath);
        const ufdrInfo = await stat(ufdrAbsolutePath).catch(() => null);
        if (!ufdrInfo) {
          const err = `Watchdog: extracao PENDING sem job na fila e arquivo UFDR nao encontrado no caminho ${ufdrAbsolutePath}.`;
          await updateExtractionStatus(row.id, "FAILED", {
            reportError: err,
            processingDetails: {
              ...details,
              phase: "failed-watchdog-pending-missing-ufdr",
              progress: 100,
              staleSince: row.updatedAt.toISOString(),
              watchdogPendingRequeueCount: pendingRequeueCount
            },
            finishedAt: new Date()
          });
          await addCustodyEvent({
            caseId: row.caseId,
            evidenceId: row.evidenceId,
            action: "INGESTION_FAILED",
            source: "worker-ingest-watchdog",
            details: {
              extractionId: row.id,
              error: err
            }
          });
          continue;
        }

        try {
          const queuedJobId = await enqueueUfdrIngestion({
            extractionId: row.id,
            caseId: row.caseId,
            evidenceId: row.evidenceId,
            ufdrAbsolutePath,
            originalFilename: row.evidence.fileName,
            transcriptionRuntime: runtimeDetails
              ? {
                  enabled: typeof runtimeDetails.enabled === "boolean" ? runtimeDetails.enabled : undefined,
                  engine:
                    runtimeDetails.engine === "openai"
                      ? "openai"
                      : runtimeDetails.engine === "assemblyai"
                        ? "assemblyai"
                        : "local",
                  model: typeof runtimeDetails.model === "string" ? runtimeDetails.model : undefined,
                  language: typeof runtimeDetails.language === "string" ? runtimeDetails.language : undefined
                }
              : undefined
          });

          await updateExtractionStatus(row.id, "PENDING", {
            reportError: null,
            processingDetails: {
              ...details,
              phase: "requeued-by-watchdog",
              progress: 0,
              staleSince: row.updatedAt.toISOString(),
              watchdogPendingRequeueCount: pendingRequeueCount + 1,
              watchdogPendingRequeuedAt: new Date().toISOString(),
              watchdogPendingQueueJobId: queuedJobId || null
            }
          });

          await addCustodyEvent({
            caseId: row.caseId,
            evidenceId: row.evidenceId,
            action: "INGESTION_REQUEUED",
            source: "worker-ingest-watchdog",
            details: {
              extractionId: row.id,
              staleSince: row.updatedAt.toISOString(),
              queuedJobId: queuedJobId || null,
              previousPendingRequeueCount: pendingRequeueCount
            }
          });
        } catch (error) {
          log("error", "Watchdog pending requeue failed", {
            extractionId: row.id,
            evidenceId: row.evidenceId,
            caseId: row.caseId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      const cutoff = new Date(Date.now() - UFDR_STALE_PROCESSING_TIMEOUT_MS);
      const staleRows = await prisma.extraction.findMany({
        where: {
          status: { in: ["PROCESSING", "INDEXING"] },
          updatedAt: { lt: cutoff }
        },
        select: {
          id: true,
          caseId: true,
          evidenceId: true,
          updatedAt: true,
          processingDetails: true,
          evidence: {
            select: {
              fileName: true,
              originalPath: true
            }
          }
        }
      });
      for (const row of staleRows) {
        const details =
          row.processingDetails && typeof row.processingDetails === "object" && !Array.isArray(row.processingDetails)
            ? (row.processingDetails as Record<string, unknown>)
            : {};
        const processingRequeueCount =
          typeof details.watchdogProcessingRequeueCount === "number" ? details.watchdogProcessingRequeueCount : 0;
        const runtimeDetails =
          details.transcriptionRuntime &&
          typeof details.transcriptionRuntime === "object" &&
          !Array.isArray(details.transcriptionRuntime)
            ? (details.transcriptionRuntime as Record<string, unknown>)
            : undefined;

        if (!row.evidence?.originalPath) {
          const err = "Watchdog: extracao PROCESSING/INDEXING sem evidencia associada para reenfileirar.";
          await updateExtractionStatus(row.id, "FAILED", {
            reportError: err,
            processingDetails: {
              ...details,
              phase: "failed-watchdog-processing-missing-evidence",
              progress: 100,
              staleSince: row.updatedAt.toISOString(),
              watchdogProcessingRequeueCount: processingRequeueCount
            },
            finishedAt: new Date()
          });
          continue;
        }

        if (isAudioRecoveryResumeDetails(details)) {
          const skippedAt = new Date().toISOString();
          await updateExtractionStatus(row.id, "PROCESSING", {
            reportError: null,
            processingDetails: {
              ...details,
              watchdogSkippedDestructiveRequeueAt: skippedAt,
              watchdogSkippedDestructiveRequeueReason:
                "Audio recovery/resume em andamento; watchdog nao reenfileira ingestao completa para evitar apagar transcricoes ja recuperadas."
            }
          });
          log("warn", "Watchdog skipped destructive UFDR requeue during audio recovery", {
            extractionId: row.id,
            evidenceId: row.evidenceId,
            caseId: row.caseId,
            staleSince: row.updatedAt.toISOString(),
            phase: readStringFromDetails(details, "phase") ?? null,
            resumeMode: details.resumeMode ?? null
          });
          continue;
        }

        if (processingRequeueCount >= 2) {
          const err = `Watchdog: extracao permaneceu PROCESSING/INDEXING sem heartbeat apos ${processingRequeueCount} tentativas de recuperacao.`;
          await updateExtractionStatus(row.id, "FAILED", {
            reportError: err,
            processingDetails: {
              ...details,
              phase: "failed-watchdog-processing-stuck",
              progress: 100,
              staleSince: row.updatedAt.toISOString(),
              watchdogProcessingRequeueCount: processingRequeueCount
            },
            finishedAt: new Date()
          });
          await addCustodyEvent({
            caseId: row.caseId,
            evidenceId: row.evidenceId,
            action: "INGESTION_FAILED",
            source: "worker-ingest-watchdog",
            details: {
              extractionId: row.id,
              error: err
            }
          });
          continue;
        }

        const ufdrAbsolutePath = path.resolve(resolveStorageRoot(), row.evidence.originalPath);
        const ufdrInfo = await stat(ufdrAbsolutePath).catch(() => null);
        if (!ufdrInfo) {
          const err = `Watchdog: extracao PROCESSING/INDEXING sem heartbeat e arquivo UFDR nao encontrado no caminho ${ufdrAbsolutePath}.`;
          await updateExtractionStatus(row.id, "FAILED", {
            reportError: err,
            processingDetails: {
              ...details,
              phase: "failed-watchdog-processing-missing-ufdr",
              progress: 100,
              staleSince: row.updatedAt.toISOString(),
              watchdogProcessingRequeueCount: processingRequeueCount
            },
            finishedAt: new Date()
          });
          await addCustodyEvent({
            caseId: row.caseId,
            evidenceId: row.evidenceId,
            action: "INGESTION_FAILED",
            source: "worker-ingest-watchdog",
            details: {
              extractionId: row.id,
              error: err
            }
          });
          continue;
        }

        try {
          const queuedJobId = await enqueueUfdrIngestion({
            extractionId: row.id,
            caseId: row.caseId,
            evidenceId: row.evidenceId,
            ufdrAbsolutePath,
            originalFilename: row.evidence.fileName,
            transcriptionRuntime: runtimeDetails
              ? {
                  enabled: typeof runtimeDetails.enabled === "boolean" ? runtimeDetails.enabled : undefined,
                  engine:
                    runtimeDetails.engine === "openai"
                      ? "openai"
                      : runtimeDetails.engine === "assemblyai"
                        ? "assemblyai"
                        : "local",
                  model: typeof runtimeDetails.model === "string" ? runtimeDetails.model : undefined,
                  language: typeof runtimeDetails.language === "string" ? runtimeDetails.language : undefined
                }
              : undefined
          });

          await updateExtractionStatus(row.id, "PENDING", {
            reportError: null,
            processingDetails: {
              ...details,
              phase: "requeued-by-watchdog-processing",
              progress: 0,
              staleSince: row.updatedAt.toISOString(),
              watchdogProcessingRequeueCount: processingRequeueCount + 1,
              watchdogProcessingRequeuedAt: new Date().toISOString(),
              watchdogProcessingQueueJobId: queuedJobId || null
            }
          });

          await addCustodyEvent({
            caseId: row.caseId,
            evidenceId: row.evidenceId,
            action: "INGESTION_REQUEUED",
            source: "worker-ingest-watchdog",
            details: {
              extractionId: row.id,
              staleSince: row.updatedAt.toISOString(),
              queuedJobId: queuedJobId || null,
              previousProcessingRequeueCount: processingRequeueCount
            }
          });
        } catch (error) {
          log("error", "Watchdog processing requeue failed", {
            extractionId: row.id,
            evidenceId: row.evidenceId,
            caseId: row.caseId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      log("error", "Ingestion watchdog failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, UFDR_STALE_WATCHDOG_INTERVAL_MS);
  staleWatchdog.unref?.();
}

main().catch((error: Error) => {
  log("error", "Worker startup failed", { error: error.message });
  process.exit(1);
});
