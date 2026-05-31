import { NextResponse } from "next/server";
import path from "node:path";
import { access, mkdir, stat } from "node:fs/promises";
import { z } from "zod";
import { extractArchiveEntryToFile, scanUfdrArchive } from "@core/parsers";
import { addCustodyEvent, getAppSettingValue } from "@core/cases";
import { prisma, Prisma } from "@core/db";
import { enqueueAudioTranscription } from "@core/queue";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z
  .object({
    engine: z.enum(["local", "openai", "assemblyai"]).optional(),
    model: z.string().min(1).optional(),
    language: z.string().optional()
  })
  .optional();

const OPUS_EXT_RE = /\.opus$/i;

function isWhatsAppOpusAttachment(input: {
  fileName?: string | null;
  archivePath?: string | null;
  sourceApp?: string | null;
}) {
  const sourceApp = (input.sourceApp ?? "").trim().toLowerCase();
  const archivePath = (input.archivePath ?? "").replace(/\\/g, "/").toLowerCase();
  const archiveLooksWhatsApp = archivePath.includes("/com.whatsapp/") || archivePath.includes("/whatsapp/");
  if (!sourceApp.includes("whatsapp") && !archiveLooksWhatsApp) return false;
  const ref = (input.fileName ?? input.archivePath ?? "").trim();
  return OPUS_EXT_RE.test(ref);
}

function transcriptionEngineLabel(engine: "local" | "openai" | "assemblyai", model: string) {
  if (engine === "openai") return `openai:${model}`;
  if (engine === "assemblyai") return `assemblyai:${model}`;
  return "whisper-local";
}

function normalizeEntryPath(input?: string | null) {
  if (!input) return "";
  return input.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function basenameLower(input?: string | null) {
  const normalized = normalizeEntryPath(input);
  if (!normalized) return "";
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

function pickPreferredEntry(entries: string[]) {
  if (entries.length <= 1) return entries[0];
  return (
    entries.find((entry) => /(^|[\\/])files[\\/]/i.test(entry)) ??
    entries.find((entry) => /(^|[\\/])audio[\\/]/i.test(entry)) ??
    entries[0]
  );
}

function markAsExcludedNotRecovered(
  current: Prisma.JsonValue | null,
  input: { source: string; reason: string }
): Prisma.InputJsonValue {
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  return {
    ...base,
    recovery: {
      ...(base.recovery && typeof base.recovery === "object" && !Array.isArray(base.recovery)
        ? (base.recovery as Record<string, unknown>)
        : {}),
      status: "NOT_RECOVERED",
      excluded: true,
      reason: input.reason,
      markedAt: new Date().toISOString(),
      markedBy: input.source
    }
  } as Prisma.InputJsonValue;
}

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const sessionUser = auth.session;

    const params = paramsSchema.parse(await context.params);
    const rawBody = await _.json().catch(() => ({}));
    const body = bodySchema.parse(rawBody);
    const runtimeEngine = body?.engine ?? "local";
    const runtimeModel =
      body?.model?.trim() ||
      (runtimeEngine === "openai"
        ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
        : runtimeEngine === "assemblyai"
          ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL || "best"
        : process.env.WHISPER_MODEL || "base");
    const runtimeLanguage = body?.language?.trim() || undefined;
    const configuredOpenAiApiKey = (await getAppSettingValue("OPENAI_API_KEY"))?.trim();
    const configuredAssemblyAiApiKey = (await getAppSettingValue("ASSEMBLYAI_API_KEY"))?.trim();
    const runtimeOpenAiApiKey =
      runtimeEngine === "openai" ? configuredOpenAiApiKey || process.env.OPENAI_API_KEY?.trim() : undefined;
    const runtimeAssemblyAiApiKey =
      runtimeEngine === "assemblyai"
        ? configuredAssemblyAiApiKey || process.env.ASSEMBLYAI_API_KEY?.trim()
        : undefined;
    if (runtimeEngine === "openai" && !runtimeOpenAiApiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY ausente. Configure em Configuracoes para transcricao online." },
        { status: 409 }
      );
    }
    if (runtimeEngine === "assemblyai" && !runtimeAssemblyAiApiKey) {
      return NextResponse.json(
        { error: "ASSEMBLYAI_API_KEY ausente. Configure em Configuracoes para transcricao online." },
        { status: 409 }
      );
    }

    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      include: { extraction: true }
    });
    if (!evidence) {
      return NextResponse.json({ error: "Evidencia nao encontrada." }, { status: 404 });
    }

    const extraction = evidence.extraction;
    if (!extraction) {
      return NextResponse.json({ error: "Extracao vinculada nao encontrada." }, { status: 409 });
    }
    if (extraction.status === "PROCESSING" || extraction.status === "INDEXING") {
      return NextResponse.json({ error: "Extracao em andamento. Aguarde para retranscrever." }, { status: 409 });
    }

    const attachmentsRaw = await prisma.attachment.findMany({
      where: {
        evidenceId: evidence.id
      },
      select: {
        id: true,
        path: true,
        archivePath: true,
        fileName: true,
        mimeType: true,
        metadata: true,
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
    const attachments = attachmentsRaw.filter((row) =>
      isWhatsAppOpusAttachment({
        fileName: row.fileName,
        archivePath: row.archivePath,
        sourceApp: row.message?.chat?.sourceApp
      })
    );
    if (attachments.length === 0) {
      return NextResponse.json(
        { error: "Nenhum anexo elegivel para retranscricao (somente .opus de chats WhatsApp)." },
        { status: 409 }
      );
    }

    const ufdrAbsolutePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", evidence.originalPath);
    try {
      await access(ufdrAbsolutePath);
    } catch {
      return NextResponse.json({ error: "Fonte da evidencia nao encontrada no storage." }, { status: 404 });
    }

    const extractedAudioDir = path.resolve(
      process.env.STORAGE_ROOT ?? "./storage",
      "derived",
      evidence.caseId,
      evidence.id,
      "audio"
    );
    await mkdir(extractedAudioDir, { recursive: true });
    const scan = await scanUfdrArchive(ufdrAbsolutePath);
    const byNormalizedPath = new Map<string, string>();
    const byBasename = new Map<string, string[]>();
    for (const entry of scan.files) {
      const normalized = normalizeEntryPath(entry);
      if (normalized && !byNormalizedPath.has(normalized)) {
        byNormalizedPath.set(normalized, entry);
      }
      const base = basenameLower(entry);
      if (!base) continue;
      const list = byBasename.get(base) ?? [];
      list.push(entry);
      byBasename.set(base, list);
    }

    const existingTranscriptions = await prisma.audioTranscription.findMany({
      where: {
        extractionId: extraction.id,
        attachmentId: { in: attachments.map((row) => row.id) }
      },
      select: {
        id: true,
        attachmentId: true,
        sourceFilePath: true,
        status: true
      }
    });

    const transcriptionByAttachment = new Map<
      string,
      {
        id: string;
        attachmentId: string;
        sourceFilePath: string;
        status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
      }
    >();
    for (const row of existingTranscriptions) {
      const previous = transcriptionByAttachment.get(row.attachmentId);
      if (!previous) {
        transcriptionByAttachment.set(row.attachmentId, row);
        continue;
      }
      if (previous.status !== "COMPLETED" && row.status === "COMPLETED") {
        transcriptionByAttachment.set(row.attachmentId, row);
      }
    }

    let jobsQueued = 0;
    let extractedOnDemand = 0;
    let extractionErrors = 0;
    let unresolvedPaths = 0;
    let preservedCompleted = 0;
    let preservedProcessing = 0;
    let resetFailedOrPending = 0;
    let createdNew = 0;
    let resolvedByLookup = 0;

    for (const attachment of attachments) {
      let sourceFilePath: string | undefined = attachment.path ?? undefined;
      if (sourceFilePath) {
        try {
          await access(sourceFilePath);
          const sourceInfo = await stat(sourceFilePath).catch(() => null);
          if (!sourceInfo || sourceInfo.size <= 0) {
            sourceFilePath = undefined;
          }
        } catch {
          sourceFilePath = undefined;
        }
      }

      if (!sourceFilePath && attachment.archivePath) {
        const candidateEntries = new Set<string>();
        const normalizedArchivePath = normalizeEntryPath(attachment.archivePath);
        if (normalizedArchivePath) {
          const direct = byNormalizedPath.get(normalizedArchivePath);
          if (direct) candidateEntries.add(direct);
        }
        const baseFromArchive = basenameLower(attachment.archivePath);
        if (baseFromArchive) {
          const picks = byBasename.get(baseFromArchive) ?? [];
          const preferred = pickPreferredEntry(picks);
          if (preferred) candidateEntries.add(preferred);
        }
        const baseFromFileName = basenameLower(attachment.fileName);
        if (baseFromFileName) {
          const picks = byBasename.get(baseFromFileName) ?? [];
          const preferred = pickPreferredEntry(picks);
          if (preferred) candidateEntries.add(preferred);
        }
        candidateEntries.add(attachment.archivePath);

        for (const entryPath of candidateEntries) {
          const fallbackBase = attachment.fileName ?? path.basename(entryPath);
          const safeBase = fallbackBase.replace(/[^a-zA-Z0-9._-]/g, "_");
          const outputName = `${Date.now()}-${attachment.id}-${safeBase}`;
          const outputPath = path.resolve(extractedAudioDir, outputName);
          try {
            await extractArchiveEntryToFile({
              ufdrAbsolutePath,
              entryPath,
              outputPath
            });
            const extractedInfo = await stat(outputPath).catch(() => null);
            if (!extractedInfo || extractedInfo.size <= 0) {
              continue;
            }
            sourceFilePath = outputPath;
            extractedOnDemand += 1;
            if (entryPath !== attachment.archivePath) {
              resolvedByLookup += 1;
            }
            await prisma.attachment.update({
              where: { id: attachment.id },
              data: {
                path: outputPath,
                archivePath: entryPath,
                mimeType: attachment.mimeType ?? "audio"
              }
            });
            break;
          } catch {
            continue;
          }
        }

        if (!sourceFilePath) {
          extractionErrors += 1;
        }
      }

      if (!sourceFilePath) {
        await prisma.attachment.update({
          where: { id: attachment.id },
          data: {
            metadata: markAsExcludedNotRecovered(attachment.metadata as Prisma.JsonValue | null, {
              source: "api/evidences/retranscribe",
              reason: "MISSING_IN_EXTRACTION"
            })
          }
        });
        unresolvedPaths += 1;
        continue;
      }

      const existing = transcriptionByAttachment.get(attachment.id);
      if (!existing) {
        const created = await prisma.audioTranscription.create({
          data: {
            caseId: evidence.caseId,
            evidenceId: evidence.id,
            extractionId: extraction.id,
            attachmentId: attachment.id,
            status: "PENDING",
            sourceFilePath,
            engine: transcriptionEngineLabel(runtimeEngine, runtimeModel),
            language: runtimeLanguage
          },
          select: {
            id: true,
            attachmentId: true,
            sourceFilePath: true
          }
        });
        await enqueueAudioTranscription({
          transcriptionId: created.id,
          attachmentId: created.attachmentId,
          caseId: evidence.caseId,
          evidenceId: evidence.id,
          extractionId: extraction.id,
          audioAbsolutePath: created.sourceFilePath,
          language: runtimeLanguage,
          engine: runtimeEngine,
          model: runtimeModel,
          openaiApiKey: runtimeOpenAiApiKey,
          assemblyAiApiKey: runtimeAssemblyAiApiKey
        });
        jobsQueued += 1;
        createdNew += 1;
        continue;
      }

      if (existing.status === "COMPLETED") {
        preservedCompleted += 1;
        continue;
      }
      if (existing.status === "PROCESSING") {
        preservedProcessing += 1;
        continue;
      }

      const reset = await prisma.audioTranscription.update({
        where: { id: existing.id },
        data: {
          status: "PENDING",
          sourceFilePath,
          engine: transcriptionEngineLabel(runtimeEngine, runtimeModel),
          language: runtimeLanguage,
          text: null,
          segments: Prisma.JsonNull,
          error: null,
          startedAt: null,
          finishedAt: null
        },
        select: {
          id: true,
          attachmentId: true,
          sourceFilePath: true
        }
      });
      await enqueueAudioTranscription({
        transcriptionId: reset.id,
        attachmentId: reset.attachmentId,
        caseId: evidence.caseId,
        evidenceId: evidence.id,
        extractionId: extraction.id,
        audioAbsolutePath: reset.sourceFilePath,
        language: runtimeLanguage,
        engine: runtimeEngine,
        model: runtimeModel,
        openaiApiKey: runtimeOpenAiApiKey,
        assemblyAiApiKey: runtimeAssemblyAiApiKey
      });
      jobsQueued += 1;
      resetFailedOrPending += 1;
    }

    if (jobsQueued === 0) {
      return NextResponse.json(
        {
          error: "Nenhum audio elegivel para reenfileirar (concluidos preservados ou caminho de arquivo indisponivel).",
          preservedCompleted,
          preservedProcessing,
          unresolvedPaths,
          extractionErrors
        },
        { status: 409 }
      );
    }

    await prisma.extraction.update({
      where: { id: extraction.id },
      data: {
        processingDetails: {
          phase: "retranscription-queued",
          progress: 100,
          retranscriptionJobsCount: jobsQueued,
          retranscriptionSummary: {
            queued: jobsQueued,
            preservedCompleted,
            preservedProcessing,
            resetFailedOrPending,
            createdNew,
            unresolvedPaths,
            engine: runtimeEngine,
            model: runtimeModel,
            resolvedByLookup
          }
        }
      }
    });

    await addCustodyEvent({
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      actorId: sessionUser.id,
      action: "RETRANSCRIPTION_QUEUED",
      source: "api/evidences/retranscribe",
      currentHash: evidence.sha256,
      details: {
        extractionId: extraction.id,
        jobsQueued,
        extractedOnDemand,
        extractionErrors,
        unresolvedPaths,
        resolvedByLookup,
        preservedCompleted,
        preservedProcessing,
        resetFailedOrPending,
        createdNew,
        transcriptionRuntime: {
          engine: runtimeEngine,
          model: runtimeModel
        }
      }
    });

    return NextResponse.json({
      ok: true,
      extractionId: extraction.id,
      jobsQueued,
      preservedCompleted,
      preservedProcessing,
      resetFailedOrPending,
      createdNew,
      extractedOnDemand,
      extractionErrors,
      unresolvedPaths,
      resolvedByLookup,
      transcriptionRuntime: {
        engine: runtimeEngine,
        model: runtimeModel
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao retranscrever audios."
      },
      { status: 500 }
    );
  }
}
