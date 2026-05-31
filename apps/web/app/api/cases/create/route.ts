import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@core/db";
import { createManualCase } from "@core/cases";
import { getSessionUser } from "@/lib/session";

const schema = z.object({
  title: z.string().min(3),
  caseNumber: z.string().min(1),
  description: z.string().optional(),
  inquiryType: z.string().optional(),
  inquiryNumber: z.string().optional(),
  policeUnit: z.string().min(2),
  inquiryLegalFraming: z.string().min(3),
  inquirySummaryText: z.string().optional(),
  inquiryMainFacts: z.string().optional(),
  inquiryInvestigativeFocus: z.string().min(10),
  inquiryInvolvedPeople: z.array(z.string().min(1)).optional().default([])
});

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

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const session = await getSessionUser();
    const caseNumber = await ensureUniqueCaseNumber(body.caseNumber);

    const created = await createManualCase({
      caseNumber,
      title: body.title.trim(),
      description: body.description?.trim() || undefined,
      ownerId: session?.id,
      inquiryType: body.inquiryType?.trim() || undefined,
      inquiryNumber: body.inquiryNumber?.trim() || undefined,
      policeUnit: body.policeUnit.trim(),
      inquiryLegalFraming: body.inquiryLegalFraming.trim(),
      inquiryInvolvedPeople: body.inquiryInvolvedPeople,
      inquirySummaryText: body.inquirySummaryText?.trim() || undefined,
      inquiryMainFacts: body.inquiryMainFacts?.trim() || undefined,
      inquiryInvestigativeFocus: body.inquiryInvestigativeFocus.trim(),
      initialContextSource: "MANUAL_FORM"
    });

    return NextResponse.json({
      caseId: created.id,
      caseNumber: created.caseNumber,
      title: created.title
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao criar caso manualmente." },
      { status: 500 }
    );
  }
}
