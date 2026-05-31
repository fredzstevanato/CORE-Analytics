import path from "node:path";
import { access } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent, clearDerivedDataByEvidence, getAppSettingValue } from "@core/cases";
import { prisma } from "@core/db";
import { enqueueUfdrIngestion } from "@core/queue";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z
  .object({
    transcriptionRuntime: z
      .object({
        enabled: z.boolean().optional(),
        engine: z.enum(["local", "openai", "assemblyai"]).optional(),
        model: z.string().min(1).optional(),
        language: z.string().optional()
      })
      .optional(),
    aiRuntime: z
      .object({
        engine: z.enum(["local", "openai"]).optional(),
        model: z.string().min(1).optional()
      })
      .optional()
  })
  .optional();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const sessionUser = auth.session;

    const params = paramsSchema.parse(await context.params);
    const rawBody = await request.json().catch(() => ({}));
    const body = bodySchema.parse(rawBody);
    const runtimeEngine = body?.transcriptionRuntime?.engine ?? "local";
    const runtimeModel =
      body?.transcriptionRuntime?.model?.trim() ||
      (runtimeEngine === "openai"
        ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
        : runtimeEngine === "assemblyai"
          ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL || "best"
        : process.env.WHISPER_MODEL || "base");
    const runtimeLanguage = body?.transcriptionRuntime?.language?.trim() || undefined;
    const transcriptionEnabled = body?.transcriptionRuntime?.enabled ?? true;
    const runtimeOpenAiApiKey =
      runtimeEngine === "openai"
        ? (await getAppSettingValue("OPENAI_API_KEY"))?.trim() || process.env.OPENAI_API_KEY?.trim()
        : undefined;
    const runtimeAssemblyAiApiKey =
      runtimeEngine === "assemblyai"
        ? (await getAppSettingValue("ASSEMBLYAI_API_KEY"))?.trim() || process.env.ASSEMBLYAI_API_KEY?.trim()
        : undefined;
    if (transcriptionEnabled && runtimeEngine === "openai" && !runtimeOpenAiApiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY ausente. Configure em Configuracoes para transcricao online." },
        { status: 409 }
      );
    }
    if (transcriptionEnabled && runtimeEngine === "assemblyai" && !runtimeAssemblyAiApiKey) {
      return NextResponse.json(
        { error: "ASSEMBLYAI_API_KEY ausente. Configure em Configuracoes para transcricao online." },
        { status: 409 }
      );
    }
    const aiRuntimeEngine = body?.aiRuntime?.engine ?? "local";
    const aiRuntimeModel =
      body?.aiRuntime?.model?.trim() ||
      (aiRuntimeEngine === "openai" ? process.env.OPENAI_INVESTIGATION_ANALYSIS_MODEL || "gpt-4.1-mini" : "local-heuristic-v1");

    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      include: { extraction: true }
    });
    if (!evidence) {
      return NextResponse.json({ error: "Evidencia nao encontrada." }, { status: 404 });
    }

    const extraction = evidence.extraction;
    if (!extraction) {
      return NextResponse.json({ error: "Extracao vinculada nao encontrada para reprocessamento." }, { status: 409 });
    }
    if (extraction.status === "PROCESSING" || extraction.status === "INDEXING") {
      return NextResponse.json({ error: "Extracao em andamento. Aguarde para reprocessar." }, { status: 409 });
    }

    const absoluteUfdrPath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", evidence.originalPath);
    try {
      await access(absoluteUfdrPath);
    } catch {
      return NextResponse.json({ error: "Arquivo da evidencia nao foi encontrado no storage." }, { status: 404 });
    }

    await clearDerivedDataByEvidence(evidence.id);

    await prisma.extraction.update({
      where: { id: extraction.id },
      data: {
        status: "PENDING",
        reportFound: false,
        reportPath: null,
        reportParsedAt: null,
        reportError: null,
        processingDetails: {
          phase: "requeued",
          progress: 0,
          transcriptionRuntime: {
            enabled: transcriptionEnabled,
            engine: runtimeEngine,
            model: runtimeModel,
            language: runtimeLanguage ?? null
          },
          aiRuntime: {
            engine: aiRuntimeEngine,
            model: aiRuntimeModel
          }
        },
        startedAt: null,
        finishedAt: null
      }
    });

    let queuedJobId = "";
    try {
      queuedJobId = await enqueueUfdrIngestion({
        extractionId: extraction.id,
        evidenceId: evidence.id,
        caseId: evidence.caseId,
        ufdrAbsolutePath: absoluteUfdrPath,
        originalFilename: evidence.fileName,
        transcriptionRuntime: {
          enabled: transcriptionEnabled,
          engine: runtimeEngine,
          model: runtimeModel,
          language: runtimeLanguage,
          openaiApiKey: runtimeOpenAiApiKey,
          assemblyAiApiKey: runtimeAssemblyAiApiKey
        }
      });
    } catch (queueError) {
      const queueMessage =
        queueError instanceof Error
          ? `Falha ao enfileirar ingestao UFDR: ${queueError.message}`
          : "Falha ao enfileirar ingestao UFDR.";
      await prisma.extraction.update({
        where: { id: extraction.id },
        data: {
          status: "FAILED",
          reportError: queueMessage,
          processingDetails: {
            phase: "failed-queue-enqueue",
            progress: 100,
            error: queueMessage,
            transcriptionRuntime: {
              enabled: transcriptionEnabled,
              engine: runtimeEngine,
              model: runtimeModel,
              language: runtimeLanguage ?? null
            },
            aiRuntime: {
              engine: aiRuntimeEngine,
              model: aiRuntimeModel
            }
          },
          finishedAt: new Date()
        }
      });
      throw new Error(queueMessage);
    }

    await addCustodyEvent({
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      actorId: sessionUser.id,
      action: "REPROCESS_QUEUED",
      source: "api/evidences/reprocess",
      currentHash: evidence.sha256,
      details: {
        extractionId: extraction.id,
        originalPath: evidence.originalPath,
        transcriptionRuntime: {
          enabled: transcriptionEnabled,
          engine: runtimeEngine,
          model: runtimeModel,
          language: runtimeLanguage ?? null
        },
        aiRuntime: {
          engine: aiRuntimeEngine,
          model: aiRuntimeModel
        },
        queueJobId: queuedJobId || null
      }
    });

    return NextResponse.json({
      ok: true,
      extractionId: extraction.id,
      queueJobId: queuedJobId || null,
      transcriptionRuntime: {
        enabled: transcriptionEnabled,
        engine: runtimeEngine,
        model: runtimeModel,
        language: runtimeLanguage ?? null
      },
      aiRuntime: {
        engine: aiRuntimeEngine,
        model: aiRuntimeModel
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao reprocessar evidencia."
      },
      { status: 500 }
    );
  }
}
