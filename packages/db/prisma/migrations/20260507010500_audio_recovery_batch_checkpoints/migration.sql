CREATE TABLE IF NOT EXISTS "AudioRecoveryBatchCheckpoint" (
  "id" TEXT NOT NULL,
  "extractionId" TEXT NOT NULL,
  "batchIndex" INTEGER NOT NULL,
  "batchTotal" INTEGER NOT NULL,
  "targetCount" INTEGER NOT NULL,
  "extractedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedTimeoutCount" INTEGER NOT NULL DEFAULT 0,
  "skippedErrorCount" INTEGER NOT NULL DEFAULT 0,
  "transcriptionQueuedCount" INTEGER NOT NULL DEFAULT 0,
  "transcriptionSkippedMissingCount" INTEGER NOT NULL DEFAULT 0,
  "transcriptionSkippedPolicyCount" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER,
  "queueDelayMs" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  "error" TEXT,
  "lastArchivePath" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AudioRecoveryBatchCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AudioRecoveryBatchCheckpoint_extractionId_batchIndex_key"
  ON "AudioRecoveryBatchCheckpoint"("extractionId", "batchIndex");

CREATE INDEX IF NOT EXISTS "AudioRecoveryBatchCheckpoint_extractionId_status_idx"
  ON "AudioRecoveryBatchCheckpoint"("extractionId", "status");

CREATE INDEX IF NOT EXISTS "AudioRecoveryBatchCheckpoint_finishedAt_idx"
  ON "AudioRecoveryBatchCheckpoint"("finishedAt");

ALTER TABLE "AudioRecoveryBatchCheckpoint"
  ADD CONSTRAINT "AudioRecoveryBatchCheckpoint_extractionId_fkey"
  FOREIGN KEY ("extractionId") REFERENCES "Extraction"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
