-- CreateEnum
CREATE TYPE "CaseSourceType" AS ENUM ('MANUAL', 'PDF_IMPORT', 'AI_INTAKE', 'UFDR_CONTEXT');

-- CreateEnum
CREATE TYPE "CaseOperationalStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'ACTIVE', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CaseDocumentType" AS ENUM ('INQUIRY_PDF', 'EXPERT_REPORT_PDF', 'SUPPORTING_DOCUMENT', 'CASE_NOTE_ATTACHMENT');

-- CreateEnum
CREATE TYPE "CaseImportSessionStatus" AS ENUM ('PENDING_ANALYSIS', 'READY_FOR_REVIEW', 'CONFIRMED', 'DISCARDED', 'FAILED');

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "initialContextSource" TEXT,
ADD COLUMN     "operationalStatus" "CaseOperationalStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "sourceType" "CaseSourceType" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "CaseDocument" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "type" "CaseDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "source" TEXT,
    "uploadedById" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseImportSession" (
    "id" TEXT NOT NULL,
    "status" "CaseImportSessionStatus" NOT NULL DEFAULT 'PENDING_ANALYSIS',
    "sourceType" "CaseSourceType" NOT NULL DEFAULT 'PDF_IMPORT',
    "documentId" TEXT,
    "createdCaseId" TEXT,
    "createdById" TEXT,
    "draftPayload" JSONB,
    "pipelineSummary" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseImportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseDocument_caseId_type_createdAt_idx" ON "CaseDocument"("caseId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "CaseImportSession_status_createdAt_idx" ON "CaseImportSession"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CaseImportSession_createdCaseId_idx" ON "CaseImportSession"("createdCaseId");

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseDocument" ADD CONSTRAINT "CaseDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseDocument" ADD CONSTRAINT "CaseDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseImportSession" ADD CONSTRAINT "CaseImportSession_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CaseDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseImportSession" ADD CONSTRAINT "CaseImportSession_createdCaseId_fkey" FOREIGN KEY ("createdCaseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseImportSession" ADD CONSTRAINT "CaseImportSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
