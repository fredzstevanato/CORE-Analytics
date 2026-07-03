import { NextResponse } from "next/server";
import { enqueueInvestigationReport } from "@core/queue";
import { prisma } from "@core/db";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

const schema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  triageInsightId: z.string().uuid().optional(),
  selectedChatIds: z.array(z.string().uuid()).optional(),
  contextHint: z.string().min(20).optional(),
  aiEngine: z.enum(["local", "openai"]).optional(),
  reportModel: z.string().min(1),
  openaiApiKey: z.string().min(20).optional()
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

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const body = schema.parse(await request.json());
    const evidenceId = await resolveEvidenceId(body);
    const jobId = await enqueueInvestigationReport({
      ...body,
      evidenceId,
      authorId: auth.session.id
    });
    return NextResponse.json({ jobId, queue: "report" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao enfileirar relatorio investigativo." },
      { status: 500 }
    );
  }
}
