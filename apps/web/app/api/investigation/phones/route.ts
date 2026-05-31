import { NextResponse } from "next/server";
import { listCasePhoneRegistry, registerInvestigationSelectedMessagePhones } from "@core/cases";
import { prisma } from "@core/db";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

const getSchema = z.object({
  caseId: z.string().uuid()
});

const postSchema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  triageInsightId: z.string().uuid().optional(),
  selectedChatIds: z.array(z.string().uuid()).optional(),
  relevantOnly: z.boolean().optional()
});

async function resolveEvidenceId(input: { caseId: string; extractionId?: string; evidenceId?: string }) {
  if (input.extractionId) {
    const extraction = await prisma.extraction.findFirst({
      where: { id: input.extractionId, caseId: input.caseId },
      select: { evidenceId: true }
    });
    if (!extraction) {
      throw new Error("Extracao nao encontrada para o caso informado.");
    }
    return extraction.evidenceId;
  }
  return input.evidenceId;
}

export async function GET(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const url = new URL(request.url);
    const parsed = getSchema.safeParse({
      caseId: url.searchParams.get("caseId") ?? ""
    });

    if (!parsed.success) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    const phones = await listCasePhoneRegistry({ caseId: parsed.data.caseId });
    return NextResponse.json({ caseId: parsed.data.caseId, count: phones.length, phones });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao listar telefones do caso." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const parsed = postSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    const evidenceId = await resolveEvidenceId(parsed.data);
    const result = await registerInvestigationSelectedMessagePhones({
      caseId: parsed.data.caseId,
      evidenceId,
      triageInsightId: parsed.data.triageInsightId,
      selectedChatIds: parsed.data.selectedChatIds,
      relevantOnly: parsed.data.relevantOnly ?? true
    });

    return NextResponse.json({
      caseId: parsed.data.caseId,
      evidenceId: evidenceId ?? null,
      ...result
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao registrar telefones da selecao." },
      { status: 500 }
    );
  }
}
