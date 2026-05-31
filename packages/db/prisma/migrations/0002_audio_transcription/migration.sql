-- CreateEnum
CREATE TYPE "TranscriptionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN "archivePath" TEXT;

-- CreateTable
CREATE TABLE "AudioTranscription" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'whisper-local',
    "language" TEXT,
    "status" "TranscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "sourceFilePath" TEXT NOT NULL,
    "text" TEXT,
    "segments" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioTranscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudioTranscription_caseId_evidenceId_extractionId_status_idx"
ON "AudioTranscription"("caseId", "evidenceId", "extractionId", "status");

-- AddForeignKey
ALTER TABLE "AudioTranscription"
ADD CONSTRAINT "AudioTranscription_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioTranscription"
ADD CONSTRAINT "AudioTranscription_evidenceId_fkey"
FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioTranscription"
ADD CONSTRAINT "AudioTranscription_extractionId_fkey"
FOREIGN KEY ("extractionId") REFERENCES "Extraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioTranscription"
ADD CONSTRAINT "AudioTranscription_attachmentId_fkey"
FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
