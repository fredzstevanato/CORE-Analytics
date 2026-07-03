import { NextResponse } from "next/server";
import { z } from "zod";
import type { JobType } from "bullmq";
import { prisma } from "@core/db";
import {
  audioRecoveryBatchQueue,
  audioRecoveryFinalizeQueue,
  classificationQueue,
  ingestQueue,
  investigationReportQueue,
  investigationTriageQueue,
  localUfdrImportQueue,
  ocrQueue,
  transcriptionQueue
} from "@core/queue";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const statusesSchema = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) {
      return ["active", "waiting", "delayed", "prioritized", "paused", "failed"] as JobType[];
    }
    const parsed = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean) as JobType[];
    return parsed.length > 0 ? parsed : (["active", "waiting", "delayed", "prioritized", "paused", "failed"] as JobType[]);
  });

const querySchema = z.object({
  queue: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(40),
  statuses: statusesSchema
});

const actionSchema = z.object({
  queue: z.string().optional(),
  jobId: z.string().optional(),
  referenceLabel: z.string().optional(),
  maxAgeHours: z.coerce.number().min(1).max(720).optional(),
  action: z.enum([
    "stop",
    "remove",
    "retry",
    "pause_queue",
    "resume_queue",
    "stop_by_reference",
    "remove_by_reference",
    "clean_old_paused"
  ])
});

const queueRegistry = {
  "local-ufdr-import": localUfdrImportQueue,
  "ingest-ufdr": ingestQueue,
  "audio-recovery-batch": audioRecoveryBatchQueue,
  "audio-recovery-finalize": audioRecoveryFinalizeQueue,
  "audio-transcription": transcriptionQueue,
  "ocr-documents": ocrQueue,
  "ai-classification": classificationQueue,
  "investigation-triage": investigationTriageQueue,
  "investigation-report": investigationReportQueue
} as const;

type QueueName = keyof typeof queueRegistry;

function isQueueName(value: string): value is QueueName {
  return Object.prototype.hasOwnProperty.call(queueRegistry, value);
}

function summarizeJobData(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const source = data as Record<string, unknown>;
  return {
    extractionId: typeof source.extractionId === "string" ? source.extractionId : null,
    caseId: typeof source.caseId === "string" ? source.caseId : null,
    evidenceId: typeof source.evidenceId === "string" ? source.evidenceId : null,
    transcriptionId: typeof source.transcriptionId === "string" ? source.transcriptionId : null,
    attachmentId: typeof source.attachmentId === "string" ? source.attachmentId : null,
    sourceType: typeof source.sourceType === "string" ? source.sourceType : null
  };
}

type JobSnapshot = {
  id: string;
  name: string;
  state: string;
  attemptsMade: number;
  priority: number | null;
  delay: number | null;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
  data: ReturnType<typeof summarizeJobData>;
};

function buildCaseLabel(input: { caseNumber: string; title: string } | null | undefined) {
  if (!input) return null;
  return `${input.caseNumber} - ${input.title}`;
}

function buildUfdrLabel(input: { fileName: string; label: string } | null | undefined) {
  if (!input) return null;
  return input.fileName || input.label || null;
}

const REFERENCE_SCAN_STATUSES: JobType[] = [
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "failed",
  "paused",
  "waiting-children",
  "completed"
];

function normalizeReference(value: string) {
  return value.trim().toLowerCase();
}

async function enrichJobReferences(jobs: JobSnapshot[]) {
  if (jobs.length === 0) return [];

  const extractionIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const caseIds = new Set<string>();
  const transcriptionIds = new Set<string>();

  for (const job of jobs) {
    if (job.data.extractionId) extractionIds.add(job.data.extractionId);
    if (job.data.evidenceId) evidenceIds.add(job.data.evidenceId);
    if (job.data.caseId) caseIds.add(job.data.caseId);
    if (job.data.transcriptionId) transcriptionIds.add(job.data.transcriptionId);
  }

  const transcriptions = transcriptionIds.size
    ? await prisma.audioTranscription.findMany({
        where: { id: { in: Array.from(transcriptionIds) } },
        select: { id: true, extractionId: true, evidenceId: true, caseId: true }
      })
    : [];
  const transcriptionMap = new Map(transcriptions.map((row) => [row.id, row]));

  for (const row of transcriptions) {
    extractionIds.add(row.extractionId);
    evidenceIds.add(row.evidenceId);
    caseIds.add(row.caseId);
  }

  const extractions = extractionIds.size
    ? await prisma.extraction.findMany({
        where: { id: { in: Array.from(extractionIds) } },
        select: {
          id: true,
          caseId: true,
          case: { select: { id: true, caseNumber: true, title: true } },
          evidence: { select: { id: true, caseId: true, fileName: true, label: true } }
        }
      })
    : [];
  const extractionMap = new Map(extractions.map((row) => [row.id, row]));

  for (const row of extractions) {
    caseIds.add(row.caseId);
    evidenceIds.add(row.evidence.id);
  }

  const evidences = evidenceIds.size
    ? await prisma.evidence.findMany({
        where: { id: { in: Array.from(evidenceIds) } },
        select: { id: true, caseId: true, fileName: true, label: true }
      })
    : [];
  const evidenceMap = new Map(evidences.map((row) => [row.id, row]));

  for (const row of evidences) {
    caseIds.add(row.caseId);
  }

  const cases = caseIds.size
    ? await prisma.case.findMany({
        where: { id: { in: Array.from(caseIds) } },
        select: { id: true, caseNumber: true, title: true }
      })
    : [];
  const caseMap = new Map(cases.map((row) => [row.id, row]));

  return jobs.map((job) => {
    const transcription = job.data.transcriptionId ? transcriptionMap.get(job.data.transcriptionId) : null;

    const extractionId = job.data.extractionId ?? transcription?.extractionId ?? null;
    const evidenceId = job.data.evidenceId ?? transcription?.evidenceId ?? null;

    const extraction = extractionId ? extractionMap.get(extractionId) : null;
    const evidence =
      (evidenceId ? evidenceMap.get(evidenceId) : null) ??
      (extraction
        ? {
            id: extraction.evidence.id,
            caseId: extraction.evidence.caseId,
            fileName: extraction.evidence.fileName,
            label: extraction.evidence.label
          }
        : null);

    const caseId =
      job.data.caseId ?? transcription?.caseId ?? extraction?.caseId ?? evidence?.caseId ?? null;
    const caseRecord =
      (caseId ? caseMap.get(caseId) : null) ??
      (extraction
        ? {
            id: extraction.case.id,
            caseNumber: extraction.case.caseNumber,
            title: extraction.case.title
          }
        : null);

    const caseLabel = buildCaseLabel(caseRecord);
    const ufdrLabel = buildUfdrLabel(evidence);
    const referenceLabel =
      caseLabel && ufdrLabel
        ? `${caseLabel} | UFDR: ${ufdrLabel}`
        : caseLabel ?? ufdrLabel ?? extractionId ?? evidenceId ?? caseId ?? job.id;

    return {
      ...job,
      referenceLabel,
      data: {
        ...job.data,
        extractionId,
        caseId,
        evidenceId
      }
    };
  });
}

async function snapshotQueueJobs(input: { queueName: QueueName; limit: number; statuses: JobType[] }) {
  const queue = queueRegistry[input.queueName];
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
    "prioritized",
    "paused",
    "waiting-children"
  );
  const workerCount = await queue.getWorkersCount();
  const isPaused = await queue.isPaused();

  const jobsByStatus = await Promise.all(
    input.statuses.map(async (status) => {
      const jobs = await queue.getJobs([status], 0, input.limit - 1, true);
      return jobs.map((job) => ({
        id: String(job.id),
        name: job.name,
        state: status,
        attemptsMade: job.attemptsMade,
        priority: job.opts.priority ?? null,
        delay: job.opts.delay ?? null,
        timestamp: job.timestamp,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null,
        failedReason: job.failedReason ?? null,
        data: summarizeJobData(job.data)
      }));
    })
  );

  const merged = new Map<string, (typeof jobsByStatus)[number][number]>();
  for (const rows of jobsByStatus) {
    for (const row of rows) {
      if (!merged.has(row.id)) merged.set(row.id, row);
    }
  }

  const jobs = await enrichJobReferences(Array.from(merged.values()));

  return {
    queue: input.queueName,
    workers: workerCount,
    paused: isPaused,
    counts,
    jobs
  };
}

async function collectQueueJobsForReference(input: { queueName: QueueName; referenceLabel: string }) {
  const queue = queueRegistry[input.queueName];
  const jobsByStatus = await Promise.all(
    REFERENCE_SCAN_STATUSES.map(async (status) => {
      const jobs = await queue.getJobs([status], 0, 50000, true);
      return jobs.map((job) => ({
        id: String(job.id),
        name: job.name,
        state: status,
        attemptsMade: job.attemptsMade,
        priority: job.opts.priority ?? null,
        delay: job.opts.delay ?? null,
        timestamp: job.timestamp,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null,
        failedReason: job.failedReason ?? null,
        data: summarizeJobData(job.data)
      }));
    })
  );

  const merged = new Map<string, (typeof jobsByStatus)[number][number]>();
  for (const rows of jobsByStatus) {
    for (const row of rows) {
      if (!merged.has(row.id)) merged.set(row.id, row);
    }
  }

  const enriched = await enrichJobReferences(Array.from(merged.values()));
  const ref = normalizeReference(input.referenceLabel);
  return enriched.filter((job) => normalizeReference(job.referenceLabel).includes(ref));
}

export async function GET(request: Request) {
  const auth = await requireApiSession();
  if ("error" in auth) return auth.error;
  const role = requireApiRole(auth.session, ["ADMIN"]);
  if ("error" in role) return role.error;

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    queue: url.searchParams.get("queue") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    statuses: url.searchParams.get("statuses") ?? undefined
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Parametros invalidos para consulta de jobs." }, { status: 400 });
  }

  const selectedQueues = parsed.data.queue
    ? isQueueName(parsed.data.queue)
      ? [parsed.data.queue]
      : null
    : (Object.keys(queueRegistry) as QueueName[]);

  if (!selectedQueues) {
    return NextResponse.json({ error: "Fila informada nao existe." }, { status: 404 });
  }

  const queues = await Promise.all(
    selectedQueues.map((queueName) =>
      snapshotQueueJobs({ queueName, limit: parsed.data.limit, statuses: parsed.data.statuses })
    )
  );

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    queues
  });
}

export async function POST(request: Request) {
  const auth = await requireApiSession();
  if ("error" in auth) return auth.error;
  const role = requireApiRole(auth.session, ["ADMIN"]);
  if ("error" in role) return role.error;

  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Payload invalido para acao de job." }, { status: 400 });
  }

  const { queue: queueName, action, jobId, referenceLabel, maxAgeHours } = parsed.data;

  if (action === "clean_old_paused") {
    const selectedQueues = queueName
      ? isQueueName(queueName)
        ? [queueName]
        : null
      : (Object.keys(queueRegistry) as QueueName[]);

    if (!selectedQueues) {
      return NextResponse.json({ error: "Fila informada nao existe." }, { status: 404 });
    }

    const ageHours = maxAgeHours ?? 24;
    const cutoff = Date.now() - ageHours * 60 * 60 * 1000;
    let matched = 0;
    let removed = 0;
    let failed = 0;
    const byQueue: Array<{ queue: QueueName; matched: number; removed: number; failed: number }> = [];

    for (const queueKey of selectedQueues) {
      const queue = queueRegistry[queueKey];
      const jobs = await queue.getJobs(["paused"], 0, 50000, true);
      let queueMatched = 0;
      let queueRemoved = 0;
      let queueFailed = 0;

      for (const job of jobs) {
        if (job.timestamp > cutoff) continue;
        matched += 1;
        queueMatched += 1;
        try {
          await job.remove();
          removed += 1;
          queueRemoved += 1;
        } catch {
          failed += 1;
          queueFailed += 1;
        }
      }

      byQueue.push({ queue: queueKey, matched: queueMatched, removed: queueRemoved, failed: queueFailed });
    }

    return NextResponse.json({
      ok: true,
      action,
      queue: queueName ?? "ALL",
      maxAgeHours: ageHours,
      matched,
      removed,
      failed,
      byQueue,
      message: `Limpeza concluida. Removidos ${removed}/${matched} jobs pausados com mais de ${ageHours}h.`
    });
  }

  if (action === "stop_by_reference" || action === "remove_by_reference") {
    if (!referenceLabel || !referenceLabel.trim()) {
      return NextResponse.json({ error: "referenceLabel e obrigatorio para acao por referencia." }, { status: 400 });
    }

    const selectedQueues = queueName
      ? isQueueName(queueName)
        ? [queueName]
        : null
      : (Object.keys(queueRegistry) as QueueName[]);

    if (!selectedQueues) {
      return NextResponse.json({ error: "Fila informada nao existe." }, { status: 404 });
    }

    let matched = 0;
    let removed = 0;
    let skippedActive = 0;
    let failed = 0;

    for (const queueKey of selectedQueues) {
      const queue = queueRegistry[queueKey];
      const jobs = await collectQueueJobsForReference({ queueName: queueKey, referenceLabel });
      for (const jobRow of jobs) {
        matched += 1;
        if (jobRow.state === "active") {
          skippedActive += 1;
          continue;
        }
        const job = await queue.getJob(jobRow.id);
        if (!job) {
          failed += 1;
          continue;
        }
        try {
          await job.remove();
          removed += 1;
        } catch {
          failed += 1;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      action,
      referenceLabel,
      queue: queueName ?? "ALL",
      matched,
      removed,
      skippedActive,
      failed,
      message:
        skippedActive > 0
          ? `Acao concluida. Removidos ${removed}/${matched}; ${skippedActive} ativos foram preservados.`
          : `Acao concluida. Removidos ${removed}/${matched}.`
    });
  }

  if (!queueName || !isQueueName(queueName)) {
    return NextResponse.json({ error: "Fila informada nao existe." }, { status: 404 });
  }

  const queue = queueRegistry[queueName];

  if (action === "pause_queue") {
    await queue.pause();
    return NextResponse.json({ ok: true, queue: queueName, action, message: "Fila pausada." });
  }

  if (action === "resume_queue") {
    await queue.resume();
    return NextResponse.json({ ok: true, queue: queueName, action, message: "Fila retomada." });
  }

  if (!jobId) {
    return NextResponse.json({ error: "jobId e obrigatorio para esta acao." }, { status: 400 });
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job nao encontrado na fila informada." }, { status: 404 });
  }

  if (action === "retry") {
    try {
      await job.retry();
      return NextResponse.json({ ok: true, queue: queueName, action, jobId, message: "Job reenfileirado." });
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Nao foi possivel reenfileirar o job."
        },
        { status: 409 }
      );
    }
  }

  if (action === "remove") {
    try {
      await job.remove();
      return NextResponse.json({ ok: true, queue: queueName, action, jobId, message: "Job removido." });
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Nao foi possivel remover o job."
        },
        { status: 409 }
      );
    }
  }

  const state = await job.getState();
  if (state === "active") {
    return NextResponse.json(
      {
        error:
          "Job ativo nao pode ser interrompido com seguranca por esta API. Pause a fila e interrompa o worker se precisar cortar imediatamente."
      },
      { status: 409 }
    );
  }

  try {
    await job.remove();
    return NextResponse.json({ ok: true, queue: queueName, action, jobId, state, message: "Job parado/removido." });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Nao foi possivel parar o job."
      },
      { status: 409 }
    );
  }
}
