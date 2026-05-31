import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmCaseImportSession } from "@core/cases";
import { prisma } from "@core/db";
import { getSessionUser } from "@/lib/session";

const paramsSchema = z.object({
  sessionId: z.string().uuid()
});

const schema = z.object({
  caseNumber: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  inquiryType: z.string().optional(),
  inquiryNumber: z.string().optional(),
  policeUnit: z.string().optional(),
  inquiryLegalFraming: z.string().optional(),
  inquiryInvolvedPeople: z.array(z.string()).optional(),
  inquiryInvolvedPeopleCategorized: z.unknown().optional(),
  inquirySummaryText: z.string().optional(),
  inquiryMainFacts: z.string().optional(),
  inquiryInvestigativeFocus: z.string().optional(),
  extractionReportSummary: z.string().optional()
});

function deriveCaseTitleFromIdentifiers(input: {
  caseNumber: string;
  inquiryNumber?: string;
  inquiryType?: string;
  fallbackTitle?: string;
}) {
  const normalize = (value?: string) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const inquiryNumber = normalize(input.inquiryNumber);
  const caseNumber = normalize(input.caseNumber);
  const inquiryType = normalize(input.inquiryType).toUpperCase();
  const fallbackTitle = normalize(input.fallbackTitle);
  const primary = inquiryNumber || caseNumber;
  if (primary) return primary;

  const patterns: RegExp[] = [];
  if (inquiryType.includes("TCO")) patterns.push(/\b(TCO[\s:/-]*[A-Z0-9./-]+)\b/i);
  if (inquiryType.includes("BOC")) patterns.push(/\b(BOC[\s:/-]*[A-Z0-9./-]+)\b/i);
  patterns.push(/\b((?:IP|INQ(?:UERITO)?|INQU[ÉE]RITO|TCO|BOC)[\s:/-]*[A-Z0-9./-]+)\b/i);

  for (const regex of patterns) {
    const match = fallbackTitle.match(regex)?.[1]?.trim();
    if (match) return match;
  }

  return caseNumber || fallbackTitle || "Caso importado por PDF";
}

function fallbackCaseNumber() {
  return `CASE-${Date.now()}`;
}

async function ensureUniqueCaseNumber(base: string) {
  const normalized = (base || "").trim() || fallbackCaseNumber();
  let current = normalized;
  let suffix = 1;
  for (;;) {
    const found = await prisma.case.findUnique({ where: { caseNumber: current }, select: { id: true } });
    if (!found) return current;
    suffix += 1;
    current = `${normalized}-${suffix}`;
  }
}

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const body = schema.parse(await request.json());
    const sessionUser = await getSessionUser();

    const caseNumber = await ensureUniqueCaseNumber(body.caseNumber);
    const derivedTitle = deriveCaseTitleFromIdentifiers({
      caseNumber,
      inquiryNumber: body.inquiryNumber,
      inquiryType: body.inquiryType,
      fallbackTitle: body.title
    });
    const confirmed = await confirmCaseImportSession({
      sessionId: params.sessionId,
      caseData: {
        caseNumber,
        title: derivedTitle,
        description: body.description,
        ownerId: sessionUser?.id,
        inquiryType: body.inquiryType,
        inquiryNumber: body.inquiryNumber,
        policeUnit: body.policeUnit,
        inquiryLegalFraming: body.inquiryLegalFraming,
        inquiryInvolvedPeople: body.inquiryInvolvedPeopleCategorized ?? body.inquiryInvolvedPeople,
        inquirySummaryText: body.inquirySummaryText,
        inquiryMainFacts: body.inquiryMainFacts,
        inquiryInvestigativeFocus: body.inquiryInvestigativeFocus,
        extractionReportSummary: body.extractionReportSummary,
        initialContextSource: "PDF_IMPORT_REVIEW",
        reviewedById: sessionUser?.id
      }
    });

    return NextResponse.json({
      sessionId: confirmed.session.id,
      caseId: confirmed.case.id,
      caseNumber: confirmed.case.caseNumber
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao confirmar rascunho do caso." },
      { status: 500 }
    );
  }
}
