ALTER TABLE "Extraction"
  ADD COLUMN "processingPhase" TEXT,
  ADD COLUMN "processingProgress" INTEGER,
  ADD COLUMN "audioExtractedCount" INTEGER,
  ADD COLUMN "audioExtractedTotal" INTEGER,
  ADD COLUMN "audioRatePerMin" DOUBLE PRECISION,
  ADD COLUMN "audioEtaSec" INTEGER,
  ADD COLUMN "audioLastArchivePath" TEXT;

CREATE INDEX IF NOT EXISTS "Extraction_status_updatedAt_idx"
  ON "Extraction"("status", "updatedAt");

CREATE INDEX IF NOT EXISTS "Extraction_caseId_updatedAt_idx"
  ON "Extraction"("caseId", "updatedAt");

CREATE INDEX IF NOT EXISTS "Attachment_evidenceId_createdAt_idx"
  ON "Attachment"("evidenceId", "createdAt");

CREATE INDEX IF NOT EXISTS "AudioTranscription_extractionId_status_updatedAt_idx"
  ON "AudioTranscription"("extractionId", "status", "updatedAt");

CREATE INDEX IF NOT EXISTS "AudioTranscription_extractionId_createdAt_idx"
  ON "AudioTranscription"("extractionId", "createdAt");
