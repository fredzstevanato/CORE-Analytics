import { NextResponse } from "next/server";
import { reanalyzeInvestigativeChat } from "@core/cases";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

const schema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  triageInsightId: z.string().uuid(),
  chatId: z.string().uuid(),
  analystContext: z.string().min(8),
  aiEngine: z.enum(["local", "openai"]).optional(),
  analysisModel: z.string().min(1),
  openaiApiKey: z.string().min(20).optional(),
  approve: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const body = schema.parse(await request.json());
    const result = await reanalyzeInvestigativeChat(body);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao reanalisar chat." },
      { status: 500 }
    );
  }
}
