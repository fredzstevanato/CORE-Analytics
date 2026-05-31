-- AlterTable
ALTER TABLE "SeizedObject" ADD COLUMN     "iccid1" TEXT,
ADD COLUMN     "iccid2" TEXT,
ADD COLUMN     "imei2" TEXT;

-- CreateTable
CREATE TABLE "ExpertReportIdentifier" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "expertReportId" TEXT NOT NULL,
    "seizedObjectId" TEXT,
    "kind" TEXT NOT NULL,
    "algorithm" TEXT,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "sourceReference" TEXT,
    "confidence" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertReportIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpertReportIdentifier_caseId_kind_normalizedValue_idx" ON "ExpertReportIdentifier"("caseId", "kind", "normalizedValue");

-- CreateIndex
CREATE INDEX "ExpertReportIdentifier_expertReportId_kind_createdAt_idx" ON "ExpertReportIdentifier"("expertReportId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "ExpertReportIdentifier" ADD CONSTRAINT "ExpertReportIdentifier_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertReportIdentifier" ADD CONSTRAINT "ExpertReportIdentifier_expertReportId_fkey" FOREIGN KEY ("expertReportId") REFERENCES "ExpertReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertReportIdentifier" ADD CONSTRAINT "ExpertReportIdentifier_seizedObjectId_fkey" FOREIGN KEY ("seizedObjectId") REFERENCES "SeizedObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
