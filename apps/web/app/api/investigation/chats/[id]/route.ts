import { NextResponse } from "next/server";
import { getInvestigationChatModalPayload } from "@core/cases";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

type Ctx = { params: Promise<{ id: string }> };

const paramsSchema = z.object({
  id: z.string().uuid()
});

const querySchema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  triageInsightId: z.string().uuid().optional(),
  relevantOnly: z.boolean().optional()
});

export async function GET(request: Request, context: Ctx) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const params = paramsSchema.parse(await context.params);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      caseId: url.searchParams.get("caseId") ?? "",
      extractionId: url.searchParams.get("extractionId") ?? undefined,
      evidenceId: url.searchParams.get("evidenceId") ?? undefined,
      triageInsightId: url.searchParams.get("triageInsightId") ?? undefined,
      relevantOnly: url.searchParams.get("relevantOnly") === "1"
    });

    if (!parsed.success) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    const payload = await getInvestigationChatModalPayload({
      caseId: parsed.data.caseId,
      extractionId: parsed.data.extractionId,
      evidenceId: parsed.data.evidenceId,
      triageInsightId: parsed.data.triageInsightId,
      relevantOnly: parsed.data.relevantOnly,
      chatId: params.id
    });

    return NextResponse.json({ chat: payload });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    if (error instanceof Error && /chat nao encontrado/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao carregar mensagens do chat." },
      { status: 500 }
    );
  }
}
