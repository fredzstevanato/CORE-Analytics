import { getExtractionById } from "@core/cases";
import { prisma } from "@core/db";
import { buildOperationalAlertsFromDetails } from "@/lib/extraction-alerts";

export type ExtractionProgressPayload = {
  id: string;
  status: string;
  phase: string;
  progress: number;
  updatedAt: string;
  reportError?: string | null;
  transcriptionRuntime?: {
    enabled?: boolean;
    engine?: "local" | "openai" | "assemblyai";
    model?: string;
    language?: string | null;
  };
  alerts?: string[];
  operationalAlerts?: Array<{
    code: string;
    severity: "INFO" | "WARN" | "CRITICAL";
    message: string;
  }>;
  diagnostics?: {
    elapsedMs?: number;
    phaseElapsedMs?: number;
    filesScanned?: number;
    parserMode?: string;
    parserDropped?: {
      chats?: number;
      messages?: number;
      audioFiles?: number;
    };
    parserLimits?: {
      maxChats?: number;
      maxMessagesPerChat?: number;
      maxTotalMessages?: number;
      maxAudioFiles?: number;
    };
    ingestTimingsMs?: {
      scan?: number;
      parse?: number;
      persist?: number;
      audio?: number;
      index?: number;
      total?: number;
    };
    audio?: {
      hintsCount?: number;
      extractedCount?: number;
      maxFiles?: number;
      capReached?: boolean;
      transcriptionJobs?: number;
      etaSec?: number;
      ratePerMin?: number;
      recovery?: {
        async?: boolean;
        batchTotal?: number;
        batchProcessed?: number;
        extractedCount?: number;
        skippedTimeoutCount?: number;
        skippedErrorCount?: number;
        skippedMissingFileCount?: number;
        skippedPolicyCount?: number;
      };
    };
  };
  stats: {
    chats: number;
    messages: number;
    attachments: number;
    transcriptions: {
      total: number;
      pending: number;
      processing: number;
      completed: number;
      failed: number;
      policyDiscarded: number;
      realFailed: number;
      eligible: number;
    };
    aiClassification: {
      expectedFromCompletedTranscriptions: number;
      completed: number;
    };
  };
};

function isTerminalStatus(status: string) {
  return status === "COMPLETED" || status === "FAILED";
}

export async function getExtractionProgressPayload(id: string): Promise<ExtractionProgressPayload | null> {
  const extraction = await getExtractionById(id);
  if (!extraction) return null;

  const extractionHot = extraction as unknown as {
    processingPhase?: string | null;
    processingProgress?: number | null;
    audioExtractedCount?: number | null;
    audioExtractedTotal?: number | null;
    audioRatePerMin?: number | null;
    audioEtaSec?: number | null;
    audioLastArchivePath?: string | null;
  };

  const details = (extraction.processingDetails ?? {}) as Record<string, unknown>;
  const runtimeDetails =
    details.transcriptionRuntime && typeof details.transcriptionRuntime === "object" && !Array.isArray(details.transcriptionRuntime)
      ? (details.transcriptionRuntime as Record<string, unknown>)
      : undefined;
  const operationalAlerts = buildOperationalAlertsFromDetails(details);
  const alerts = operationalAlerts.map((row) => row.message);
  const ingestMetrics =
    details.ingestMetrics && typeof details.ingestMetrics === "object"
      ? (details.ingestMetrics as Record<string, unknown>)
      : undefined;
  const parserDropped =
    ingestMetrics?.parserDropped && typeof ingestMetrics.parserDropped === "object"
      ? (ingestMetrics.parserDropped as Record<string, unknown>)
      : undefined;
  const parserLimits =
    ingestMetrics?.parserLimits && typeof ingestMetrics.parserLimits === "object"
      ? (ingestMetrics.parserLimits as Record<string, unknown>)
      : undefined;
  const ingestTimingsMs =
    ingestMetrics?.timingsMs && typeof ingestMetrics.timingsMs === "object"
      ? (ingestMetrics.timingsMs as Record<string, unknown>)
      : undefined;

  const evidenceId = extraction.evidenceId;
  const extractionId = extraction.id;

  const [chats, messages, attachments, trPending, trProcessing, trCompleted, trFailed, trPolicyDiscarded, aiCompleted] =
    await Promise.all([
    prisma.chat.count({ where: { evidenceId } }),
    prisma.message.count({ where: { evidenceId } }),
    prisma.attachment.count({ where: { evidenceId } }),
    prisma.audioTranscription.count({ where: { extractionId, status: "PENDING" } }),
    prisma.audioTranscription.count({ where: { extractionId, status: "PROCESSING" } }),
    prisma.audioTranscription.count({ where: { extractionId, status: "COMPLETED" } }),
    prisma.audioTranscription.count({ where: { extractionId, status: "FAILED" } }),
    prisma.audioTranscription.count({
      where: {
        extractionId,
        status: "FAILED",
        error: { startsWith: "Descartado pela politica" }
      }
    }),
    prisma.aiInsight.count({
      where: {
        extractionId,
        type: "TRANSCRIPTION"
      }
    })
    ]);
  const trRealFailed = Math.max(0, trFailed - trPolicyDiscarded);
  const hasBackgroundWork = trPending > 0 || trProcessing > 0;
  const effectiveStatus = isTerminalStatus(extraction.status) && hasBackgroundWork ? "PROCESSING" : extraction.status;
  const rawPhase =
    typeof extractionHot.processingPhase === "string"
      ? extractionHot.processingPhase
      : typeof details.phase === "string"
        ? details.phase
        : extraction.status;
  const effectivePhase =
    isTerminalStatus(extraction.status) && hasBackgroundWork && (rawPhase === "completed" || rawPhase === "failed")
      ? "background-processing"
      : rawPhase;
  const effectiveProgress =
    typeof extractionHot.processingProgress === "number"
      ? isTerminalStatus(extraction.status) && hasBackgroundWork
        ? Math.min(extractionHot.processingProgress, 99)
        : extractionHot.processingProgress
      : typeof details.progress === "number"
        ? isTerminalStatus(extraction.status) && hasBackgroundWork
          ? Math.min(details.progress, 99)
          : details.progress
      : effectiveStatus === "COMPLETED"
        ? 100
        : 0;

  return {
    id: extraction.id,
    status: effectiveStatus,
    phase: effectivePhase,
    progress: effectiveProgress,
    updatedAt: extraction.updatedAt.toISOString(),
    reportError: extraction.reportError,
    transcriptionRuntime: runtimeDetails
      ? {
          enabled: typeof runtimeDetails.enabled === "boolean" ? runtimeDetails.enabled : undefined,
          engine:
            runtimeDetails.engine === "openai" || runtimeDetails.engine === "assemblyai" || runtimeDetails.engine === "local"
              ? runtimeDetails.engine
              : undefined,
          model: typeof runtimeDetails.model === "string" ? runtimeDetails.model : undefined,
          language: typeof runtimeDetails.language === "string" ? runtimeDetails.language : null
        }
      : undefined,
    alerts,
    operationalAlerts,
    diagnostics: {
      elapsedMs: typeof details.elapsedMs === "number" ? details.elapsedMs : undefined,
      phaseElapsedMs: typeof details.phaseElapsedMs === "number" ? details.phaseElapsedMs : undefined,
      filesScanned:
        typeof details.filesScanned === "number"
          ? details.filesScanned
          : typeof ingestMetrics?.filesScanned === "number"
            ? ingestMetrics.filesScanned
            : undefined,
      parserMode:
        typeof details.parserMode === "string"
          ? details.parserMode
          : typeof ingestMetrics?.parserMode === "string"
            ? ingestMetrics.parserMode
            : undefined,
      parserDropped: {
        chats: typeof parserDropped?.chats === "number" ? parserDropped.chats : undefined,
        messages: typeof parserDropped?.messages === "number" ? parserDropped.messages : undefined,
        audioFiles: typeof parserDropped?.audioFiles === "number" ? parserDropped.audioFiles : undefined
      },
      parserLimits: {
        maxChats: typeof parserLimits?.maxChats === "number" ? parserLimits.maxChats : undefined,
        maxMessagesPerChat:
          typeof parserLimits?.maxMessagesPerChat === "number" ? parserLimits.maxMessagesPerChat : undefined,
        maxTotalMessages: typeof parserLimits?.maxTotalMessages === "number" ? parserLimits.maxTotalMessages : undefined,
        maxAudioFiles: typeof parserLimits?.maxAudioFiles === "number" ? parserLimits.maxAudioFiles : undefined
      },
      ingestTimingsMs: {
        scan: typeof ingestTimingsMs?.scan === "number" ? ingestTimingsMs.scan : undefined,
        parse: typeof ingestTimingsMs?.parse === "number" ? ingestTimingsMs.parse : undefined,
        persist: typeof ingestTimingsMs?.persist === "number" ? ingestTimingsMs.persist : undefined,
        audio: typeof ingestTimingsMs?.audio === "number" ? ingestTimingsMs.audio : undefined,
        index: typeof ingestTimingsMs?.index === "number" ? ingestTimingsMs.index : undefined,
        total: typeof ingestTimingsMs?.total === "number" ? ingestTimingsMs.total : undefined
      },
      audio: {
        hintsCount:
          typeof details.audioHintsCount === "number"
            ? details.audioHintsCount
            : typeof ingestMetrics?.audioHintsCount === "number"
              ? ingestMetrics.audioHintsCount
              : undefined,
        extractedCount:
          typeof extractionHot.audioExtractedCount === "number"
            ? extractionHot.audioExtractedCount
            : typeof details.audioExtractedCount === "number"
              ? details.audioExtractedCount
            : typeof details.audioExtractionProcessed === "number"
              ? details.audioExtractionProcessed
              : undefined,
        maxFiles:
          typeof extractionHot.audioExtractedTotal === "number"
            ? extractionHot.audioExtractedTotal
            : typeof details.audioMaxFiles === "number"
            ? details.audioMaxFiles
            : typeof details.audioExtractionTotal === "number"
              ? details.audioExtractionTotal
            : typeof ingestMetrics?.audioMaxFiles === "number"
              ? ingestMetrics.audioMaxFiles
              : undefined,
        capReached:
          typeof details.audioCapReached === "boolean"
            ? details.audioCapReached
            : typeof ingestMetrics?.audioCapReached === "boolean"
              ? ingestMetrics.audioCapReached
              : undefined,
        transcriptionJobs:
          typeof details.audioTranscriptionJobsCount === "number" ? details.audioTranscriptionJobsCount : undefined,
        etaSec:
          typeof extractionHot.audioEtaSec === "number"
            ? extractionHot.audioEtaSec
            : typeof details.audioExtractionEtaSec === "number"
              ? details.audioExtractionEtaSec
            : undefined,
        ratePerMin:
          typeof extractionHot.audioRatePerMin === "number"
            ? extractionHot.audioRatePerMin
            : typeof details.audioExtractionRatePerMin === "number"
              ? details.audioExtractionRatePerMin
            : undefined,
        recovery: {
          async: typeof details.audioRecoveryAsync === "boolean" ? details.audioRecoveryAsync : undefined,
          batchTotal:
            typeof details.audioRecoveryBatchTotal === "number" ? details.audioRecoveryBatchTotal : undefined,
          batchProcessed:
            typeof details.audioRecoveryBatchProcessed === "number" ? details.audioRecoveryBatchProcessed : undefined,
          extractedCount:
            typeof details.audioRecoveryExtractedCount === "number" ? details.audioRecoveryExtractedCount : undefined,
          skippedTimeoutCount:
            typeof details.audioRecoverySkippedTimeoutCount === "number"
              ? details.audioRecoverySkippedTimeoutCount
              : undefined,
          skippedErrorCount:
            typeof details.audioRecoverySkippedErrorCount === "number" ? details.audioRecoverySkippedErrorCount : undefined,
          skippedMissingFileCount:
            typeof details.audioTranscriptionSkippedMissingFileCount === "number"
              ? details.audioTranscriptionSkippedMissingFileCount
              : undefined,
          skippedPolicyCount:
            typeof details.audioTranscriptionSkippedPolicyCount === "number"
              ? details.audioTranscriptionSkippedPolicyCount
              : undefined
        }
      }
    },
    stats: {
      chats,
      messages,
      attachments,
      transcriptions: {
        total: trPending + trProcessing + trCompleted + trFailed,
        pending: trPending,
        processing: trProcessing,
        completed: trCompleted,
        failed: trFailed,
        policyDiscarded: trPolicyDiscarded,
        realFailed: trRealFailed,
        eligible: trPending + trProcessing + trCompleted + trRealFailed
      },
      aiClassification: {
        expectedFromCompletedTranscriptions: trCompleted,
        completed: aiCompleted
      }
    }
  };
}
