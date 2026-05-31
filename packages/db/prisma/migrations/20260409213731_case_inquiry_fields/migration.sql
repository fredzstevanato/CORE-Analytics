-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "extractionReportSummary" TEXT,
ADD COLUMN     "inquiryInvestigativeFocus" TEXT,
ADD COLUMN     "inquiryInvolvedPeople" JSONB,
ADD COLUMN     "inquiryLegalFraming" TEXT,
ADD COLUMN     "inquiryMainFacts" TEXT,
ADD COLUMN     "inquiryNumber" TEXT,
ADD COLUMN     "inquirySummaryText" TEXT,
ADD COLUMN     "inquiryType" TEXT,
ADD COLUMN     "policeUnit" TEXT;
