import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { Job, Queue } from "bullmq";
import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent } from "@core/cases";
import { prisma } from "@core/db";
import { QUEUE_NAMES, redisConnection } from "@core/queue";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z
  .object({
    hardReset: z.boolean().optional()
  })
  .optional();

function ensureInsideStorage(targetPath: string) {
  const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? "./storage");
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(storageRoot)) {
    throw new Error("Tentativa de remocao fora do storage permitido.");
  }
  return { storageRoot, resolved };
}

const PURGE_JOB_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "paused",
  "waiting-children",
  "failed",
  "completed"
] as const;

type QueuePurgeSummary = {
  scanned: number;
  removed: number;
  failedToRemove: number;
};

function matchesEvidenceJob(input: {
  data: unknown;
  evidenceId: string;
  extractionId?: string;
  caseId: string;
  transcriptionIds: Set<string>;
}) {
  if (!input.data || typeof input.data !== "object") return false;
  const jobData = input.data as Record<string, unknown>;
  const jobEvidenceId = typeof jobData.evidenceId === "string" ? jobData.evidenceId : undefined;
  const jobCaseId = typeof jobData.caseId === "string" ? jobData.caseId : undefined;
  const jobExtractionId = typeof jobData.extractionId === "string" ? jobData.extractionId : undefined;
  const jobTranscriptionId = typeof jobData.transcriptionId === "string" ? jobData.transcriptionId : undefined;

  if (jobEvidenceId && jobEvidenceId === input.evidenceId) return true;
  if (input.extractionId && jobExtractionId && jobExtractionId === input.extractionId) return true;
  if (jobTranscriptionId && input.transcriptionIds.has(jobTranscriptionId)) return true;

  // Fallback for queue payloads that only carry case + extraction context.
  if (jobCaseId === input.caseId && input.extractionId && jobExtractionId === input.extractionId) {
    return true;
  }

  return false;
}

async function purgeQueueJobsByPredicate(
  queueName: string,
  predicate: (job: Job<unknown, unknown, string>) => boolean
): Promise<QueuePurgeSummary> {
  const queue = new Queue(queueName, { connection: redisConnection });
  try {
    const jobs = await queue.getJobs([...PURGE_JOB_STATES], 0, 5000);
    let removed = 0;
    let failedToRemove = 0;

    for (const job of jobs) {
      if (!predicate(job)) continue;
      try {
        await job.remove();
        removed += 1;
      } catch {
        failedToRemove += 1;
      }
    }

    return {
      scanned: jobs.length,
      removed,
      failedToRemove
    };
  } finally {
    await queue.close();
  }
}

async function purgeEvidenceQueueArtifacts(input: {
  caseId: string;
  evidenceId: string;
  extractionId?: string;
  transcriptionIds: string[];
}) {
  const transcriptionIdSet = new Set(input.transcriptionIds);

  const [ingest, transcription, ocr, aiClassification] = await Promise.all([
    purgeQueueJobsByPredicate(QUEUE_NAMES.ingestUfdr, (job) =>
      matchesEvidenceJob({
        data: job.data,
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        extractionId: input.extractionId,
        transcriptionIds: transcriptionIdSet
      })
    ),
    purgeQueueJobsByPredicate(QUEUE_NAMES.audioTranscription, (job) =>
      matchesEvidenceJob({
        data: job.data,
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        extractionId: input.extractionId,
        transcriptionIds: transcriptionIdSet
      })
    ),
    purgeQueueJobsByPredicate(QUEUE_NAMES.ocrDocuments, (job) =>
      matchesEvidenceJob({
        data: job.data,
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        extractionId: input.extractionId,
        transcriptionIds: transcriptionIdSet
      })
    ),
    purgeQueueJobsByPredicate(QUEUE_NAMES.aiClassification, (job) =>
      matchesEvidenceJob({
        data: job.data,
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        extractionId: input.extractionId,
        transcriptionIds: transcriptionIdSet
      })
    )
  ]);

  let staleIngestKeyDeleted = false;
  if (input.extractionId) {
    const staleJobKey = `bull:${QUEUE_NAMES.ingestUfdr}:${input.extractionId}`;
    staleIngestKeyDeleted = (await redisConnection.del(staleJobKey)) > 0;
    await redisConnection.zrem(`bull:${QUEUE_NAMES.ingestUfdr}:failed`, input.extractionId);
  }

  return {
    ingest,
    transcription,
    ocr,
    aiClassification,
    staleIngestKeyDeleted
  };
}

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const sessionUser = auth.session;

    const params = paramsSchema.parse(await context.params);
    const rawBody = await _.json().catch(() => ({}));
    const body = bodySchema.parse(rawBody);
    const hardReset = body?.hardReset === true;
    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      include: {
        extraction: true,
        transcriptions: {
          select: {
            id: true,
            status: true
          }
        }
      }
    });
    if (!evidence) {
      return NextResponse.json({ error: "Evidencia nao encontrada." }, { status: 404 });
    }

    if (evidence.extraction?.status === "PROCESSING" || evidence.extraction?.status === "INDEXING") {
      return NextResponse.json({ error: "Nao e possivel excluir enquanto ha processamento em andamento." }, { status: 409 });
    }

    const transcriptionProcessingCount = evidence.transcriptions.filter((row) => row.status === "PROCESSING").length;
    if (transcriptionProcessingCount > 0) {
      return NextResponse.json(
        { error: "Nao e possivel excluir enquanto ha transcricoes em andamento. Aguarde ou cancele-as primeiro." },
        { status: 409 }
      );
    }

    const queueCleanup = hardReset
      ? await purgeEvidenceQueueArtifacts({
          caseId: evidence.caseId,
          evidenceId: evidence.id,
          extractionId: evidence.extraction?.id,
          transcriptionIds: evidence.transcriptions.map((row) => row.id)
        })
      : null;

    await addCustodyEvent({
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      actorId: sessionUser.id,
      action: "EVIDENCE_DELETE_REQUESTED",
      source: "api/evidences/delete",
      currentHash: evidence.sha256,
      details: {
        deletionMode: hardReset ? "HARD_RESET" : "DELETE_ONLY",
        originalPath: evidence.originalPath,
        fileName: evidence.fileName,
        queueCleanup
      }
    });

    const absoluteFilePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", evidence.originalPath);
    const fileDir = path.dirname(absoluteFilePath);
    const derivedDir = path.resolve(
      process.env.STORAGE_ROOT ?? "./storage",
      "derived",
      evidence.caseId,
      evidence.id
    );

    const { resolved: safeFilePath } = ensureInsideStorage(absoluteFilePath);
    const { resolved: safeFileDir } = ensureInsideStorage(fileDir);
    const { resolved: safeDerivedDir } = ensureInsideStorage(derivedDir);

    await prisma.evidence.delete({ where: { id: evidence.id } });

    const targetInfo = await stat(safeFilePath).catch(() => null);
    if (targetInfo?.isDirectory()) {
      await rm(safeFilePath, { recursive: true, force: true });
    } else {
      await rm(safeFilePath, { force: true });
    }
    await rm(safeFileDir, { recursive: true, force: true });
    await rm(safeDerivedDir, { recursive: true, force: true });

    return NextResponse.json({ ok: true, deletionMode: hardReset ? "HARD_RESET" : "DELETE_ONLY" });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao excluir evidencia."
      },
      { status: 500 }
    );
  }
}
