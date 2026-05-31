import "./load-env.js";
import { Queue, Worker } from "bullmq";
import { stat } from "node:fs/promises";
import {
  addCustodyEvent,
  createAiInsight,
  getAppSettingValue,
  generateInvestigativeReport,
  runCaseInvestigativeTriage,
  saveOcrDocument,
  updateTranscriptionStatus
} from "@core/cases";
import { prisma } from "@core/db";
import { enqueueAiClassification, redisConnection, QUEUE_NAMES } from "@core/queue";
import {
  aiClassificationJobSchema,
  investigationReportJobSchema,
  investigationTriageJobSchema,
  ocrJobSchema,
  transcriptionJobSchema,
  type AiClassificationJob,
  type InvestigationReportJob,
  type InvestigationTriageJob,
  type OcrJob,
  type TranscriptionJob
} from "@core/shared";
import { log } from "./logger.js";
import { classifyInvestigativeText } from "./classifier.js";
import { runOcr } from "./ocr.js";
import { transcribeWithWhisper } from "./whisper.js";

function parseOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

const WORKER_LOG_HEARTBEAT_MS = (parseOptionalPositiveIntEnv("WORKER_LOG_HEARTBEAT_SECONDS") ?? 30) * 1000;
const TRANSCRIPTION_WORKER_CONCURRENCY =
  parseOptionalPositiveIntEnv("AI_TRANSCRIPTION_WORKER_CONCURRENCY") ??
  parseOptionalPositiveIntEnv("TRANSCRIPTION_WORKER_CONCURRENCY") ??
  8;
const TRANSCRIPTION_LOCK_DURATION_MS =
  (parseOptionalPositiveIntEnv("AI_TRANSCRIPTION_LOCK_DURATION_SECONDS") ??
    parseOptionalPositiveIntEnv("TRANSCRIPTION_LOCK_DURATION_SECONDS") ??
    120) * 1000;
const TRANSCRIPTION_STALLED_INTERVAL_MS =
  (parseOptionalPositiveIntEnv("AI_TRANSCRIPTION_STALLED_INTERVAL_SECONDS") ??
    parseOptionalPositiveIntEnv("TRANSCRIPTION_STALLED_INTERVAL_SECONDS") ??
    30) * 1000;
const TRANSCRIPTION_MAX_STALLED_COUNT =
  parseOptionalPositiveIntEnv("AI_TRANSCRIPTION_MAX_STALLED_COUNT") ??
  parseOptionalPositiveIntEnv("TRANSCRIPTION_MAX_STALLED_COUNT") ??
  3;
const DEFAULT_TRANSCRIPTION_STALE_PROCESSING_SECONDS = Math.max(
  240,
  Math.ceil((TRANSCRIPTION_LOCK_DURATION_MS * 2) / 1000)
);
const TRANSCRIPTION_STALE_PROCESSING_MS =
  (parseOptionalPositiveIntEnv("AI_TRANSCRIPTION_STALE_PROCESSING_SECONDS") ??
    parseOptionalPositiveIntEnv("TRANSCRIPTION_STALE_PROCESSING_SECONDS") ??
    DEFAULT_TRANSCRIPTION_STALE_PROCESSING_SECONDS) * 1000;

type TranscriptionProcessResult = "completed" | "skipped";
type TranscriptionStartResult = "started" | "stale-recovered" | false;

const OPUS_EXT_RE = /\.opus$/i;

function hasOpusExtension(value?: string | null) {
  if (!value) return false;
  return OPUS_EXT_RE.test(value.trim());
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

function isTerminalTranscriptionError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("bytes=0") ||
    message.includes("arquivo opus invalido") ||
    message.includes("corrompido para transcricao") ||
    message.includes("invalid data found when processing input") ||
    message.includes("falha ao converter audio para openai")
  );
}

function isAssemblyAiBillingOrQuotaError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("assemblyai") &&
    (message.includes("402") ||
      message.includes("payment") ||
      message.includes("billing") ||
      message.includes("credit") ||
      message.includes("credits") ||
      message.includes("quota") ||
      message.includes("balance") ||
      message.includes("prepaid") ||
      message.includes("insufficient funds") ||
      message.includes("not enough"))
  );
}

async function markTranscriptionStarted(input: {
  transcriptionId: string;
  engine: string;
  language?: string;
  startedAt: Date;
}): Promise<TranscriptionStartResult> {
  const started = await prisma.audioTranscription.updateMany({
    where: {
      id: input.transcriptionId,
      status: { in: ["PENDING", "FAILED"] }
    },
    data: {
      status: "PROCESSING",
      engine: input.engine,
      language: input.language,
      startedAt: input.startedAt,
      finishedAt: null,
      error: null
    }
  });
  if (started.count > 0) return "started";

  const staleCutoff = new Date(Date.now() - TRANSCRIPTION_STALE_PROCESSING_MS);
  const recovered = await prisma.audioTranscription.updateMany({
    where: {
      id: input.transcriptionId,
      status: "PROCESSING",
      OR: [{ startedAt: null }, { startedAt: { lt: staleCutoff } }]
    },
    data: {
      engine: input.engine,
      language: input.language,
      startedAt: input.startedAt,
      finishedAt: null,
      error: null
    }
  });

  return recovered.count > 0 ? "stale-recovered" : false;
}

async function pruneOrphanTranscriptionJobs(input: {
  queue: Queue<TranscriptionJob>;
  maxPerRun?: number;
}) {
  const maxPerRun = Math.max(1, input.maxPerRun ?? 300);
  const jobs = await input.queue.getJobs(["waiting", "delayed", "prioritized"], 0, maxPerRun - 1, true);
  if (jobs.length === 0) return { scanned: 0, removed: 0 };

  const candidates = jobs
    .map((job) => ({ job, transcriptionId: job.data?.transcriptionId }))
    .filter((row): row is { job: (typeof jobs)[number]; transcriptionId: string } => typeof row.transcriptionId === "string");

  if (candidates.length === 0) return { scanned: jobs.length, removed: 0 };

  const ids = [...new Set(candidates.map((row) => row.transcriptionId))];
  const existing = await prisma.audioTranscription.findMany({
    where: { id: { in: ids } },
    select: { id: true }
  });
  const existingSet = new Set(existing.map((row) => row.id));

  let removed = 0;
  for (const row of candidates) {
    if (existingSet.has(row.transcriptionId)) continue;
    await row.job.remove().catch(() => undefined);
    removed += 1;
  }

  return { scanned: jobs.length, removed };
}

async function syncCompletedTranscriptionIntoMessageBody(transcriptionId: string) {
  const row = await prisma.audioTranscription.findUnique({
    where: { id: transcriptionId },
    select: {
      text: true,
      attachment: {
        select: {
          messageId: true
        }
      }
    }
  });

  const text = row?.text?.trim();
  const messageId = row?.attachment?.messageId;
  if (!text || !messageId) return false;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { body: true }
  });
  if (!message) return false;

  const current = (message.body ?? "").trim();
  if (current.includes(text)) return false;

  const transcriptionBlock = `[Transcricao de audio]\n${text}`;
  const nextBody = current.length === 0 ? transcriptionBlock : `${current}\n\n${transcriptionBlock}`;

  await prisma.message.update({
    where: { id: messageId },
    data: { body: nextBody }
  });

  return true;
}

async function processTranscription(jobData: TranscriptionJob) {
  const payload = transcriptionJobSchema.parse(jobData);
  const startedAtMs = Date.now();
  const runtimeEngine = payload.engine ?? "local";
  const runtimeModel =
    payload.model ??
    (runtimeEngine === "openai"
      ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
      : runtimeEngine === "assemblyai"
        ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL || "best"
      : process.env.WHISPER_MODEL || "base");
  log("debug", "Transcription runtime resolved", {
    transcriptionId: payload.transcriptionId,
    extractionId: payload.extractionId,
    engine: runtimeEngine,
    model: runtimeModel,
    language: payload.language ?? null
  });
  const started = await markTranscriptionStarted({
    transcriptionId: payload.transcriptionId,
    engine:
      runtimeEngine === "openai"
        ? `openai:${runtimeModel}`
        : runtimeEngine === "assemblyai"
          ? `assemblyai:${runtimeModel}`
          : "whisper-local",
    language: payload.language,
    startedAt: new Date()
  });
  if (!started) {
    log("warn", "Skipping orphan transcription job (record not found at start)", {
      transcriptionId: payload.transcriptionId
    });
    return "skipped" satisfies TranscriptionProcessResult;
  }
  if (started === "stale-recovered") {
    log("warn", "Recovered stale PROCESSING transcription at start", {
      transcriptionId: payload.transcriptionId,
      extractionId: payload.extractionId,
      staleAfterMs: TRANSCRIPTION_STALE_PROCESSING_MS
    });
  }

  const transcriptionContext = await prisma.audioTranscription.findUnique({
    where: { id: payload.transcriptionId },
    select: {
      attachment: {
        select: {
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
      }
    }
  });

  const sourceApp = transcriptionContext?.attachment?.message?.chat?.sourceApp;
  const archivePath = transcriptionContext?.attachment?.archivePath;
  const isEligibleSource = isWhatsAppSourceApp(sourceApp) || isWhatsAppArchivePath(archivePath);
  const isOpus =
    hasOpusExtension(payload.audioAbsolutePath) ||
    hasOpusExtension(transcriptionContext?.attachment?.fileName) ||
    hasOpusExtension(transcriptionContext?.attachment?.archivePath);
  if (!isEligibleSource || !isOpus) {
    await updateTranscriptionStatus({
      transcriptionId: payload.transcriptionId,
      status: "FAILED",
      fromStatuses: ["PROCESSING"],
      error: "Descartado pela politica: somente arquivos .opus de chats WhatsApp sao transcritos.",
      finishedAt: new Date()
    });
    log("info", "Transcription discarded by policy", {
      transcriptionId: payload.transcriptionId,
      sourceApp: sourceApp ?? null,
      audioAbsolutePath: payload.audioAbsolutePath,
      durationMs: Date.now() - startedAtMs
    });
    return "skipped" satisfies TranscriptionProcessResult;
  }

  const fileInfo = await stat(payload.audioAbsolutePath).catch(() => null);
  if (!fileInfo || fileInfo.size <= 0) {
    await updateTranscriptionStatus({
      transcriptionId: payload.transcriptionId,
      status: "FAILED",
      fromStatuses: ["PROCESSING"],
      error: `Arquivo de audio vazio/invalido para transcricao (bytes=${fileInfo?.size ?? 0}).`,
      finishedAt: new Date()
    });
    log("warn", "Skipping invalid empty audio transcription", {
      transcriptionId: payload.transcriptionId,
      audioAbsolutePath: payload.audioAbsolutePath,
      bytes: fileInfo?.size ?? 0,
      durationMs: Date.now() - startedAtMs
    });
    return "skipped" satisfies TranscriptionProcessResult;
  }

  const runtimeOpenAiApiKey =
    runtimeEngine === "openai"
      ? payload.openaiApiKey?.trim() || (await getAppSettingValue("OPENAI_API_KEY"))?.trim()
      : undefined;
  const runtimeAssemblyAiApiKey =
    runtimeEngine === "assemblyai"
      ? payload.assemblyAiApiKey?.trim() || (await getAppSettingValue("ASSEMBLYAI_API_KEY"))?.trim()
      : undefined;

  let result: { text: string; segments?: unknown };
  let completedRuntimeEngine = runtimeEngine;
  let completedRuntimeModel = runtimeModel;
  try {
    result = await transcribeWithWhisper({
      audioPath: payload.audioAbsolutePath,
      language: payload.language,
      engine: runtimeEngine,
      model: payload.model,
      openaiApiKey: runtimeOpenAiApiKey,
      assemblyAiApiKey: runtimeAssemblyAiApiKey
    });
    log("debug", "Transcription engine completed", {
      transcriptionId: payload.transcriptionId,
      extractionId: payload.extractionId,
      textLength: result.text.length,
      hasSegments: Boolean(result.segments),
      engine: runtimeEngine,
      model: runtimeModel,
      durationMs: Date.now() - startedAtMs
    });
  } catch (error) {
    if (runtimeEngine === "assemblyai" && isAssemblyAiBillingOrQuotaError(error)) {
      const fallbackModel = process.env.WHISPER_MODEL || "base";
      log("warn", "AssemblyAI billing/quota error; falling back to local Whisper", {
        transcriptionId: payload.transcriptionId,
        extractionId: payload.extractionId,
        error: error instanceof Error ? error.message : String(error),
        fallbackModel
      });
      try {
        result = await transcribeWithWhisper({
          audioPath: payload.audioAbsolutePath,
          language: payload.language,
          engine: "local",
          model: fallbackModel
        });
        completedRuntimeEngine = "local";
        completedRuntimeModel = fallbackModel;
      } catch (fallbackError) {
        if (isTerminalTranscriptionError(fallbackError)) {
          await updateTranscriptionStatus({
            transcriptionId: payload.transcriptionId,
            status: "FAILED",
            fromStatuses: ["PROCESSING"],
            error:
              fallbackError instanceof Error
                ? `Fallback local apos erro AssemblyAI tambem falhou: ${fallbackError.message}`
                : "Fallback local apos erro AssemblyAI tambem falhou.",
            finishedAt: new Date()
          });
          log("warn", "Skipping terminal local fallback transcription error without retry", {
            transcriptionId: payload.transcriptionId,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            durationMs: Date.now() - startedAtMs
          });
          return "skipped" satisfies TranscriptionProcessResult;
        }
        throw fallbackError;
      }
    } else if (isTerminalTranscriptionError(error)) {
      await updateTranscriptionStatus({
        transcriptionId: payload.transcriptionId,
        status: "FAILED",
        fromStatuses: ["PROCESSING"],
        error: error instanceof Error ? error.message : "Falha terminal de transcricao.",
        finishedAt: new Date()
      });
      log("warn", "Skipping terminal transcription error without retry", {
        transcriptionId: payload.transcriptionId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAtMs
      });
      return "skipped" satisfies TranscriptionProcessResult;
    }
    throw error;
  }
  const completed = await updateTranscriptionStatus({
    transcriptionId: payload.transcriptionId,
    status: "COMPLETED",
    fromStatuses: ["PROCESSING"],
    engine:
      completedRuntimeEngine === "openai"
        ? `openai:${completedRuntimeModel}`
        : completedRuntimeEngine === "assemblyai"
          ? `assemblyai:${completedRuntimeModel}`
          : "whisper-local",
    language: payload.language,
    text: result.text,
    segments: (result.segments ?? {}) as any,
    finishedAt: new Date()
  });
  if (!completed) {
    log("warn", "Skipping orphan transcription job (record not found at completion)", {
      transcriptionId: payload.transcriptionId
    });
    return "skipped" satisfies TranscriptionProcessResult;
  }

  const injected = await syncCompletedTranscriptionIntoMessageBody(payload.transcriptionId).catch(() => false);
  if (injected) {
    log("debug", "Transcription injected into message body", {
      transcriptionId: payload.transcriptionId,
      extractionId: payload.extractionId
    });
  }

  if (result.text.trim().length > 0) {
    await enqueueAiClassification({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      extractionId: payload.extractionId,
      sourceType: "TRANSCRIPTION",
      sourceId: payload.transcriptionId,
      text: result.text.slice(0, 12000)
    });
  }

  await addCustodyEvent({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId,
    action: "AUDIO_TRANSCRIBED",
    source: "worker-ai",
    details: {
      transcriptionId: payload.transcriptionId,
      extractionId: payload.extractionId,
      transcriptionRuntime: {
        engine: completedRuntimeEngine,
        model: completedRuntimeModel,
        fallbackFrom: completedRuntimeEngine === runtimeEngine ? undefined : runtimeEngine
      }
    }
  });
  log("info", "Transcription persisted", {
    transcriptionId: payload.transcriptionId,
    extractionId: payload.extractionId,
    engine: completedRuntimeEngine,
    model: completedRuntimeModel,
    textLength: result.text.length,
    durationMs: Date.now() - startedAtMs
  });
  return "completed" satisfies TranscriptionProcessResult;
}

async function main() {
  log("info", "Starting AI worker for local Whisper transcription");
  const transcriptionQueue = new Queue(QUEUE_NAMES.audioTranscription, { connection: redisConnection });
  const ocrQueue = new Queue(QUEUE_NAMES.ocrDocuments, { connection: redisConnection });
  const classificationQueue = new Queue(QUEUE_NAMES.aiClassification, { connection: redisConnection });
  const triageQueue = new Queue(QUEUE_NAMES.investigationTriage, { connection: redisConnection });
  const reportQueue = new Queue(QUEUE_NAMES.investigationReport, { connection: redisConnection });
  log("info", "AI worker configuration", {
    transcriptionConcurrency: TRANSCRIPTION_WORKER_CONCURRENCY,
    transcriptionLockDurationMs: TRANSCRIPTION_LOCK_DURATION_MS,
    transcriptionStalledIntervalMs: TRANSCRIPTION_STALLED_INTERVAL_MS,
    transcriptionMaxStalledCount: TRANSCRIPTION_MAX_STALLED_COUNT,
    heartbeatMs: WORKER_LOG_HEARTBEAT_MS,
    whisperModel: process.env.WHISPER_MODEL ?? "base",
    openAiModel: process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe",
    assemblyAiModel: process.env.ASSEMBLYAI_TRANSCRIBE_MODEL ?? "best"
  });

  const initialPrune = await pruneOrphanTranscriptionJobs({
    queue: transcriptionQueue,
    maxPerRun: 1000
  });
  if (initialPrune.removed > 0) {
    log("warn", "Pruned orphan transcription jobs on startup", initialPrune);
  } else {
    log("debug", "Transcription orphan-prune startup scan", initialPrune);
  }

  const transcriptionWorker = new Worker<TranscriptionJob>(
    QUEUE_NAMES.audioTranscription,
    async (job) => {
      const result = await processTranscription(job.data);
      if (result === "completed") {
        log("info", "Transcription completed", { transcriptionId: job.data.transcriptionId, jobId: job.id });
      } else {
        log("info", "Transcription skipped", { transcriptionId: job.data.transcriptionId, jobId: job.id });
      }
    },
    {
      connection: redisConnection,
      concurrency: TRANSCRIPTION_WORKER_CONCURRENCY,
      lockDuration: TRANSCRIPTION_LOCK_DURATION_MS,
      stalledInterval: TRANSCRIPTION_STALLED_INTERVAL_MS,
      maxStalledCount: TRANSCRIPTION_MAX_STALLED_COUNT
    }
  );

  transcriptionWorker.on("failed", async (job, error) => {
    if (job?.data?.transcriptionId) {
      await updateTranscriptionStatus({
        transcriptionId: job.data.transcriptionId,
        status: "FAILED",
        fromStatuses: ["PENDING", "PROCESSING", "FAILED"],
        error: error.message,
        finishedAt: new Date()
      });
    }
    log("error", "Transcription failed", {
      transcriptionId: job?.data?.transcriptionId,
      error: error.message
    });
  });

  transcriptionWorker.on("active", (job) => {
    log("info", "Transcription active", { jobId: job.id, transcriptionId: job.data.transcriptionId });
  });

  transcriptionWorker.on("completed", (job) => {
    log("debug", "Transcription event completed", { jobId: job.id, transcriptionId: job.data.transcriptionId });
  });

  transcriptionWorker.on("stalled", (jobId) => {
    log("warn", "Transcription stalled", { jobId, queue: QUEUE_NAMES.audioTranscription });
  });

  const ocrWorker = new Worker<OcrJob>(
    QUEUE_NAMES.ocrDocuments,
    async (job) => {
      const payload = ocrJobSchema.parse(job.data);
      const ocr = await runOcr({
        sourcePath: payload.sourcePath,
        language: payload.language
      });
      await saveOcrDocument({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        extractionId: payload.extractionId,
        attachmentId: payload.attachmentId,
        sourcePath: payload.sourcePath,
        text: ocr.text,
        confidence: ocr.confidence
      });
      await addCustodyEvent({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        action: "OCR_COMPLETED",
        source: "worker-ai",
        details: {
          sourcePath: payload.sourcePath,
          extractionId: payload.extractionId
        }
      });
      log("info", "OCR completed", { jobId: job.id, caseId: payload.caseId });
    },
    { connection: redisConnection, concurrency: 1 }
  );

  ocrWorker.on("failed", (job, error) => {
    log("error", "OCR failed", { jobId: job?.id, error: error.message });
  });

  ocrWorker.on("active", (job) => {
    log("info", "OCR active", { jobId: job.id, attachmentId: job.data.attachmentId });
  });

  const classifierWorker = new Worker<AiClassificationJob>(
    QUEUE_NAMES.aiClassification,
    async (job) => {
      const payload = aiClassificationJobSchema.parse(job.data);
      const classified = classifyInvestigativeText(payload.text);
      await createAiInsight({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        extractionId: payload.extractionId,
        type: payload.sourceType,
        title: classified.title,
        summary: classified.summary,
        score: classified.score,
        metadata: {
          tags: classified.tags,
          sourceId: payload.sourceId
        }
      });
      await addCustodyEvent({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        action: "AI_CLASSIFICATION_COMPLETED",
        source: "worker-ai",
        details: {
          sourceType: payload.sourceType,
          sourceId: payload.sourceId
        }
      });
      log("info", "Classification completed", { jobId: job.id, caseId: payload.caseId });
    },
    { connection: redisConnection, concurrency: 2 }
  );

  classifierWorker.on("failed", (job, error) => {
    log("error", "Classification failed", { jobId: job?.id, error: error.message });
  });

  classifierWorker.on("active", (job) => {
    log("info", "Classification active", { jobId: job.id, sourceType: job.data.sourceType, sourceId: job.data.sourceId });
  });

  const investigationTriageWorker = new Worker<InvestigationTriageJob>(
    QUEUE_NAMES.investigationTriage,
    async (job) => {
      const payload = investigationTriageJobSchema.parse(job.data);
      await job.updateProgress(3);
      const result = await runCaseInvestigativeTriage({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        maxChats: payload.maxChats,
        contextHint: payload.contextHint,
        aiEngine: payload.aiEngine,
        analysisModel: payload.analysisModel,
        openaiApiKey: payload.openaiApiKey,
        onProgress: async (progress) => {
          await job.updateProgress(progress);
        }
      });
      await addCustodyEvent({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        action: "INVESTIGATION_TRIAGE_COMPLETED",
        source: "worker-ai",
        details: {
          insightId: result.insightId,
          analysisModel: payload.analysisModel,
          aiEngine: payload.aiEngine ?? "openai"
        }
      });
      await job.updateProgress(100);
      return result;
    },
    { connection: redisConnection, concurrency: 1 }
  );

  investigationTriageWorker.on("failed", (job, error) => {
    log("error", "Investigation triage failed", { jobId: job?.id, error: error.message });
  });

  investigationTriageWorker.on("active", (job) => {
    log("info", "Investigation triage active", { jobId: job.id, caseId: job.data.caseId, evidenceId: job.data.evidenceId });
  });

  const investigationReportWorker = new Worker<InvestigationReportJob>(
    QUEUE_NAMES.investigationReport,
    async (job) => {
      const payload = investigationReportJobSchema.parse(job.data);
      await job.updateProgress(5);
      const report = await generateInvestigativeReport({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        triageInsightId: payload.triageInsightId,
        selectedChatIds: payload.selectedChatIds,
        contextHint: payload.contextHint,
        authorId: payload.authorId,
        aiEngine: payload.aiEngine,
        reportModel: payload.reportModel,
        openaiApiKey: payload.openaiApiKey,
        onProgress: async (progress) => {
          await job.updateProgress(progress);
        }
      });
      await addCustodyEvent({
        caseId: payload.caseId,
        evidenceId: payload.evidenceId,
        action: "INVESTIGATION_REPORT_COMPLETED",
        source: "worker-ai",
        details: {
          reportId: report.id,
          reportModel: payload.reportModel,
          aiEngine: payload.aiEngine ?? "openai"
        }
      });
      await job.updateProgress(100);
      return { reportId: report.id, title: report.title };
    },
    { connection: redisConnection, concurrency: 1 }
  );

  investigationReportWorker.on("failed", (job, error) => {
    log("error", "Investigation report failed", { jobId: job?.id, error: error.message });
  });

  investigationReportWorker.on("active", (job) => {
    log("info", "Investigation report active", { jobId: job.id, caseId: job.data.caseId, evidenceId: job.data.evidenceId });
  });

  const heartbeatTimer = setInterval(async () => {
    try {
      const pruned = await pruneOrphanTranscriptionJobs({
        queue: transcriptionQueue,
        maxPerRun: 300
      });
      const [transcription, ocr, classification, triage, report] = await Promise.all([
        transcriptionQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
        ocrQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
        classificationQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
        triageQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
        reportQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed")
      ]);
      log("info", "AI queues heartbeat", {
        audioTranscription: transcription,
        ocrDocuments: ocr,
        aiClassification: classification,
        investigationTriage: triage,
        investigationReport: report,
        transcriptionOrphanPrune: pruned
      });
    } catch (error) {
      log("warn", "AI heartbeat failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, WORKER_LOG_HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

main().catch((error: Error) => {
  log("error", "Worker AI startup failed", { error: error.message });
  process.exit(1);
});
