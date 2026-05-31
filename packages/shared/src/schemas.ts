import { z } from "zod";

export const extractionStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "INDEXING",
  "COMPLETED",
  "FAILED"
]);

export const transcriptionStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED"
]);

export const ingestJobSchema = z.object({
  extractionId: z.string().uuid(),
  evidenceId: z.string().uuid(),
  caseId: z.string().uuid(),
  ufdrAbsolutePath: z.string().min(1),
  originalFilename: z.string().min(1),
  transcriptionRuntime: z
    .object({
      enabled: z.boolean().optional(),
      engine: z.enum(["local", "openai", "assemblyai"]).default("local"),
      model: z.string().min(1).optional(),
      openaiApiKey: z.string().min(20).optional(),
      assemblyAiApiKey: z.string().min(20).optional(),
      language: z.string().optional()
    })
    .optional()
});

export const localUfdrImportJobSchema = z.object({
  extractionId: z.string().uuid(),
  evidenceId: z.string().uuid(),
  caseId: z.string().uuid(),
  uploadedById: z.string().uuid(),
  sourcePath: z.string().min(1),
  explicitOriginalUfdrPath: z.string().min(1).optional(),
  sourceIsDirectory: z.boolean(),
  sourceSizeBytes: z.number().int().min(0),
  filename: z.string().min(1),
  storedRelativePath: z.string().min(1),
  storedAbsolutePath: z.string().min(1),
  transcriptionRuntime: z
    .object({
      enabled: z.boolean().optional(),
      engine: z.enum(["local", "openai", "assemblyai"]).default("local"),
      model: z.string().min(1).optional(),
      openaiApiKey: z.string().min(20).optional(),
      assemblyAiApiKey: z.string().min(20).optional(),
      language: z.string().optional()
    })
    .optional()
});

export const audioRecoveryTargetSchema = z.object({
  entryPath: z.string().min(1),
  archivePath: z.string().min(1),
  fileName: z.string().min(1).optional(),
  chatExternalId: z.string().min(1).optional(),
  messageExternalId: z.string().min(1).optional(),
  timestamp: z.string().optional(),
  senderExternalId: z.string().optional()
});

export const audioRecoveryBatchJobSchema = z.object({
  extractionId: z.string().uuid(),
  evidenceId: z.string().uuid(),
  caseId: z.string().uuid(),
  ufdrAbsolutePath: z.string().min(1),
  targets: z.array(audioRecoveryTargetSchema),
  batchIndex: z.number().int().positive(),
  batchTotal: z.number().int().positive(),
  unresolvedHintsInBatchPlan: z.number().int().min(0).optional(),
  transcriptionRuntime: z
    .object({
      engine: z.enum(["local", "openai", "assemblyai"]).default("local"),
      model: z.string().min(1).optional(),
      openaiApiKey: z.string().min(20).optional(),
      assemblyAiApiKey: z.string().min(20).optional(),
      language: z.string().optional()
    })
    .optional()
});

export const audioRecoveryFinalizeJobSchema = z.object({
  extractionId: z.string().uuid(),
  evidenceId: z.string().uuid(),
  caseId: z.string().uuid()
});

export const transcriptionJobSchema = z.object({
  transcriptionId: z.string().uuid(),
  attachmentId: z.string().uuid(),
  caseId: z.string().uuid(),
  evidenceId: z.string().uuid(),
  extractionId: z.string().uuid(),
  audioAbsolutePath: z.string().min(1),
  language: z.string().optional(),
  engine: z.enum(["local", "openai", "assemblyai"]).optional(),
  model: z.string().min(1).optional(),
  openaiApiKey: z.string().min(20).optional(),
  assemblyAiApiKey: z.string().min(20).optional()
});

export const ocrJobSchema = z.object({
  caseId: z.string().uuid(),
  evidenceId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  attachmentId: z.string().uuid().optional(),
  sourcePath: z.string().min(1),
  language: z.string().optional()
});

export const aiClassificationJobSchema = z.object({
  caseId: z.string().uuid(),
  evidenceId: z.string().uuid().optional(),
  extractionId: z.string().uuid().optional(),
  sourceType: z.enum(["TRANSCRIPTION", "OCR", "MESSAGE"]),
  sourceId: z.string().min(1),
  text: z.string().min(1)
});

export const investigationTriageJobSchema = z.object({
  caseId: z.string().uuid(),
  evidenceId: z.string().uuid().optional(),
  maxChats: z.number().int().min(1).optional(),
  contextHint: z.string().min(20).optional(),
  aiEngine: z.enum(["local", "openai"]).optional(),
  analysisModel: z.string().min(1),
  openaiApiKey: z.string().min(20).optional()
});

export const investigationReportJobSchema = z.object({
  caseId: z.string().uuid(),
  evidenceId: z.string().uuid().optional(),
  triageInsightId: z.string().uuid().optional(),
  selectedChatIds: z.array(z.string().uuid()).optional(),
  contextHint: z.string().min(20).optional(),
  authorId: z.string().uuid().optional(),
  aiEngine: z.enum(["local", "openai"]).optional(),
  reportModel: z.string().min(1),
  openaiApiKey: z.string().min(20).optional()
});

export const investigativeSearchFiltersSchema = z.object({
  caseId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  extractionId: z.string().uuid().optional(),
  sourceApp: z.string().optional(),
  participant: z.string().optional(),
  phoneOrEmail: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  artifactType: z.string().optional()
});

export const normalizedParticipantSchema = z.object({
  externalId: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  handle: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const normalizedMessageSchema = z.object({
  externalId: z.string().optional(),
  chatExternalId: z.string().optional(),
  senderExternalId: z.string().optional(),
  body: z.string().optional(),
  timestamp: z.string().optional(),
  direction: z.enum(["INCOMING", "OUTGOING", "SYSTEM"]).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const normalizedChatSchema = z.object({
  externalId: z.string().optional(),
  sourceApp: z.string().optional(),
  title: z.string().optional(),
  participants: z.array(normalizedParticipantSchema).default([]),
  messages: z.array(normalizedMessageSchema).default([]),
  metadata: z.record(z.unknown()).optional()
});

export const normalizedUserAccountEntrySchema = z.object({
  type: z.string().optional(),
  category: z.string().optional(),
  value: z.string().optional(),
  domain: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const normalizedUserAccountSchema = z.object({
  externalId: z.string().optional(),
  sourceApp: z.string().optional(),
  serviceType: z.string().optional(),
  serviceIdentifier: z.string().optional(),
  name: z.string().optional(),
  username: z.string().optional(),
  entries: z.array(normalizedUserAccountEntrySchema).default([]),
  metadata: z.record(z.unknown()).optional()
});

export const normalizedExtractionSchema = z.object({
  device: z
    .object({
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      osVersion: z.string().optional(),
      imei: z.string().optional(),
      imei2: z.string().optional(),
      serialNumber: z.string().optional(),
      iccid: z.string().optional(),
      msisdn: z.string().optional(),
      macAddress: z.string().optional(),
      bluetoothAddress: z.string().optional()
    })
    .optional(),
  contacts: z.array(normalizedParticipantSchema).default([]),
  chats: z.array(normalizedChatSchema).default([]),
  userAccounts: z.array(normalizedUserAccountSchema).default([]),
  calls: z.array(z.record(z.unknown())).default([]),
  files: z.array(z.record(z.unknown())).default([]),
  locations: z
    .array(
      z.object({
        latitude: z.number(),
        longitude: z.number(),
        timestamp: z.string().optional(),
        label: z.string().optional(),
        category: z.string().optional(),
        metadata: z.record(z.unknown()).optional()
      })
    )
    .default([]),
  audioArtifacts: z
    .array(
      z.object({
        externalId: z.string().optional(),
        chatExternalId: z.string().optional(),
        messageExternalId: z.string().optional(),
        senderExternalId: z.string().optional(),
        fileName: z.string().optional(),
        mimeType: z.string().optional(),
        archivePath: z.string().optional(),
        timestamp: z.string().optional(),
        metadata: z.record(z.unknown()).optional()
      })
    )
    .default([]),
  timeline: z.array(z.record(z.unknown())).default([]),
  rawMetadata: z.record(z.unknown()).default({})
});
