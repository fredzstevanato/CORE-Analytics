-- CreateEnum
CREATE TYPE "ExpertReportStatus" AS ENUM ('UPLOADED', 'PARSED', 'REVIEWED');

-- CreateEnum
CREATE TYPE "DeviceMatchStatus" AS ENUM ('SUGGESTED', 'CONFIRMED', 'REJECTED');

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "matchedSeizedObjectId" TEXT;

-- CreateTable
CREATE TABLE "ExpertReport" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "caseDocumentId" TEXT,
    "uploadedById" TEXT,
    "status" "ExpertReportStatus" NOT NULL DEFAULT 'UPLOADED',
    "title" TEXT NOT NULL,
    "reportNumber" TEXT,
    "issuingAgency" TEXT,
    "examinerName" TEXT,
    "issuedAt" TIMESTAMP(3),
    "summary" TEXT,
    "parsedPayload" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpertReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeizedObject" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "expertReportId" TEXT,
    "label" TEXT NOT NULL,
    "objectType" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "imei" TEXT,
    "serialNumber" TEXT,
    "custodyTag" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeizedObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceMatch" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "seizedObjectId" TEXT NOT NULL,
    "expertReportId" TEXT,
    "status" "DeviceMatchStatus" NOT NULL DEFAULT 'SUGGESTED',
    "confidence" DOUBLE PRECISION,
    "justification" TEXT,
    "metadata" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpertReport_caseDocumentId_key" ON "ExpertReport"("caseDocumentId");

-- CreateIndex
CREATE INDEX "ExpertReport_caseId_createdAt_idx" ON "ExpertReport"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "SeizedObject_caseId_createdAt_idx" ON "SeizedObject"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceMatch_caseId_status_createdAt_idx" ON "DeviceMatch"("caseId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceMatch_deviceId_seizedObjectId_key" ON "DeviceMatch"("deviceId", "seizedObjectId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_matchedSeizedObjectId_fkey" FOREIGN KEY ("matchedSeizedObjectId") REFERENCES "SeizedObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertReport" ADD CONSTRAINT "ExpertReport_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertReport" ADD CONSTRAINT "ExpertReport_caseDocumentId_fkey" FOREIGN KEY ("caseDocumentId") REFERENCES "CaseDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertReport" ADD CONSTRAINT "ExpertReport_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeizedObject" ADD CONSTRAINT "SeizedObject_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeizedObject" ADD CONSTRAINT "SeizedObject_expertReportId_fkey" FOREIGN KEY ("expertReportId") REFERENCES "ExpertReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMatch" ADD CONSTRAINT "DeviceMatch_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMatch" ADD CONSTRAINT "DeviceMatch_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMatch" ADD CONSTRAINT "DeviceMatch_seizedObjectId_fkey" FOREIGN KEY ("seizedObjectId") REFERENCES "SeizedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMatch" ADD CONSTRAINT "DeviceMatch_expertReportId_fkey" FOREIGN KEY ("expertReportId") REFERENCES "ExpertReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMatch" ADD CONSTRAINT "DeviceMatch_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
