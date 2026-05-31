import type { z } from "zod";
import type {
  audioRecoveryBatchJobSchema,
  audioRecoveryFinalizeJobSchema,
  audioRecoveryTargetSchema,
  extractionStatusSchema,
  ingestJobSchema,
  localUfdrImportJobSchema,
  investigativeSearchFiltersSchema,
  normalizedChatSchema,
  normalizedExtractionSchema,
  normalizedMessageSchema,
  normalizedParticipantSchema,
  normalizedUserAccountSchema,
  normalizedUserAccountEntrySchema,
  ocrJobSchema,
  aiClassificationJobSchema,
  investigationReportJobSchema,
  investigationTriageJobSchema,
  transcriptionJobSchema,
  transcriptionStatusSchema
} from "./schemas";

export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;
export type TranscriptionStatus = z.infer<typeof transcriptionStatusSchema>;
export type IngestJob = z.infer<typeof ingestJobSchema>;
export type LocalUfdrImportJob = z.infer<typeof localUfdrImportJobSchema>;
export type AudioRecoveryTarget = z.infer<typeof audioRecoveryTargetSchema>;
export type AudioRecoveryBatchJob = z.infer<typeof audioRecoveryBatchJobSchema>;
export type AudioRecoveryFinalizeJob = z.infer<typeof audioRecoveryFinalizeJobSchema>;
export type TranscriptionJob = z.infer<typeof transcriptionJobSchema>;
export type OcrJob = z.infer<typeof ocrJobSchema>;
export type AiClassificationJob = z.infer<typeof aiClassificationJobSchema>;
export type InvestigationTriageJob = z.infer<typeof investigationTriageJobSchema>;
export type InvestigationReportJob = z.infer<typeof investigationReportJobSchema>;
export type InvestigativeSearchFilters = z.infer<typeof investigativeSearchFiltersSchema>;
export type NormalizedParticipant = z.infer<typeof normalizedParticipantSchema>;
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;
export type NormalizedChat = z.infer<typeof normalizedChatSchema>;
export type NormalizedUserAccount = z.infer<typeof normalizedUserAccountSchema>;
export type NormalizedUserAccountEntry = z.infer<typeof normalizedUserAccountEntrySchema>;
export type NormalizedExtraction = z.infer<typeof normalizedExtractionSchema>;
