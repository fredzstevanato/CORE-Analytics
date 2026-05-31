export const QUEUE_NAMES = {
  localUfdrImport: "local-ufdr-import",
  ingestUfdr: "ingest-ufdr",
  audioRecoveryBatch: "audio-recovery-batch",
  audioRecoveryFinalize: "audio-recovery-finalize",
  aiPostProcessing: "ai-post-processing",
  audioTranscription: "audio-transcription",
  ocrDocuments: "ocr-documents",
  aiClassification: "ai-classification",
  investigationTriage: "investigation-triage",
  investigationReport: "investigation-report"
} as const;
