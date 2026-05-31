import path from "node:path";
import { access } from "node:fs/promises";
import { Queue } from "bullmq";
import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent, getAppSettingValue } from "@core/cases";
import { prisma } from "@core/db";
import {
  enqueueAudioRecoveryBatch,
  enqueueAudioRecoveryFinalize,
  QUEUE_NAMES,
  redisConnection
} from "@core/queue";
import type { AudioRecoveryBatchJob } from "@core/shared";
import { audioRecoveryBatchJobSchema } from "@core/shared";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z
  .object({
    mode: z.enum(["auto", "audio-recovery", "ingest"]).optional()
  })
  .optional();

function processingDetailsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function listRecoveryBatchPayloads(extractionId: string) {
  const queue = new Queue(QUEUE_NAMES.audioRecoveryBatch, { connection: redisConnection });
  try {
    const jobs = await queue.getJobs(["waiting", "active", "delayed", "failed", "completed"], 0, 50000, true);
    const payloads: AudioRecoveryBatchJob[] = [];
    for (const job of jobs) {
      const matches = String(job.id ?? "").includes(extractionId) || JSON.stringify(job.data ?? {}).includes(extractionId);
      if (!matches) continue;
      const parsed = audioRecoveryBatchJobSchema.safeParse(job.data);
      if (parsed.success) payloads.push(parsed.data);
    }
    return payloads.sort((a, b) => a.batchIndex - b.batchIndex);
  } finally {
    await queue.close();
  }
}

async function resolveRuntimeApiKeys(input: {
  engine?: "local" | "openai" | "assemblyai";
  openaiApiKey?: string;
  assemblyAiApiKey?: string;
}) {
  if (input.engine === "openai") {
    return {
      openaiApiKey: input.openaiApiKey ?? (await getAppSettingValue("OPENAI_API_KEY"))?.trim() ?? process.env.OPENAI_API_KEY?.trim()
    };
  }
  if (input.engine === "assemblyai") {
    return {
      assemblyAiApiKey:
        input.assemblyAiApiKey ??
        (await getAppSettingValue("ASSEMBLYAI_API_KEY"))?.trim() ??
        process.env.ASSEMBLYAI_API_KEY?.trim()
    };
  }
  return {};
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const sessionUser = auth.session;

    const params = paramsSchema.parse(await context.params);
    const rawBody = await request.json().catch(() => ({}));
    const body = bodySchema.parse(rawBody);
    const mode = body?.mode ?? "auto";

    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      include: { extraction: true }
    });
    if (!evidence) {
      return NextResponse.json({ error: "Evidencia nao encontrada." }, { status: 404 });
    }
    if (!evidence.extraction) {
      return NextResponse.json({ error: "Extracao vinculada nao encontrada." }, { status: 409 });
    }
    if (evidence.extraction.status === "PROCESSING" || evidence.extraction.status === "INDEXING") {
      return NextResponse.json({ error: "Extracao ja esta em andamento." }, { status: 409 });
    }

    const ufdrAbsolutePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", evidence.originalPath);
    try {
      await access(ufdrAbsolutePath);
    } catch {
      return NextResponse.json({ error: "Arquivo UFDR nao esta acessivel no storage. Verifique se o HD esta conectado." }, { status: 404 });
    }

    const details = processingDetailsRecord(evidence.extraction.processingDetails);
    const recoveryPayloads = mode !== "ingest" ? await listRecoveryBatchPayloads(evidence.extraction.id) : [];

    if (recoveryPayloads.length > 0) {
      let totalTargets = 0;
      let queuedBatches = 0;
      for (const payload of recoveryPayloads) {
        const runtimeKeys = await resolveRuntimeApiKeys(payload.transcriptionRuntime ?? {});
        await enqueueAudioRecoveryBatch({
          ...payload,
          ufdrAbsolutePath,
          transcriptionRuntime: payload.transcriptionRuntime
            ? {
                ...payload.transcriptionRuntime,
                ...runtimeKeys
              }
            : undefined
        });
        totalTargets += payload.targets.length;
        queuedBatches += 1;
      }

      await enqueueAudioRecoveryFinalize({
        extractionId: evidence.extraction.id,
        evidenceId: evidence.id,
        caseId: evidence.caseId
      });

      await prisma.extraction.update({
        where: { id: evidence.extraction.id },
        data: {
          status: "PROCESSING",
          reportError: null,
          finishedAt: null,
          processingDetails: {
            ...details,
            phase: "resume-audio-recovery-batches-running",
            progress: 92,
            resumeMode: "audio-recovery",
            resumeQueuedAt: new Date().toISOString(),
            resumeQueuedBy: "api/evidences/resume",
            audioRecoveryStartedAt: new Date().toISOString(),
            audioRecoveryAsync: true,
            audioRecoveryBatchTotal: queuedBatches,
            audioRecoveryBatchProcessed: 0,
            audioRecoveryCompletedBatches: [],
            audioRecoveryResumeTargetCount: totalTargets,
            audioRecoveryExtractedCount: 0,
            audioRecoverySkippedTimeoutCount: 0,
            audioRecoverySkippedErrorCount: 0,
            audioTranscriptionJobsCount: 0,
            audioTranscriptionSkippedMissingFileCount: 0,
            audioTranscriptionSkippedPolicyCount: 0
          }
        }
      });

      await addCustodyEvent({
        caseId: evidence.caseId,
        evidenceId: evidence.id,
        actorId: sessionUser.id,
        action: "INGESTION_RESUMED",
        source: "api/evidences/resume",
        currentHash: evidence.sha256,
        details: {
          extractionId: evidence.extraction.id,
          mode: "audio-recovery",
          queuedBatches,
          totalTargets
        }
      });

      return NextResponse.json({
        ok: true,
        extractionId: evidence.extraction.id,
        mode: "audio-recovery",
        queuedBatches,
        totalTargets
      });
    }

    return NextResponse.json(
      {
        error:
          mode === "ingest"
            ? "Resume seguro nao executa ingestao completa porque isso apaga dados derivados. Use Reprocessar completo se quiser refazer tudo."
            : "Nao encontrei lotes de recuperacao de audio para retomar. Use Reprocessar completo somente se quiser refazer tudo do zero."
      },
      { status: 409 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao retomar processamento."
      },
      { status: 500 }
    );
  }
}
