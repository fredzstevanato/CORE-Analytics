import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteGeneratedReport } from "@core/cases";
import { requireApiSession } from "@/lib/api-auth";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z.object({
  caseId: z.string().uuid().optional(),
  extractionId: z.string().uuid().optional(),
  workflow: z.enum(["ALL", "DRAFT", "UNDER_REVIEW", "APPROVED"]).optional()
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;

    const params = paramsSchema.parse(await context.params);

    const contentType = request.headers.get("content-type") ?? "";
    let body: z.infer<typeof bodySchema>;
    if (contentType.includes("application/json")) {
      body = bodySchema.parse(await request.json());
    } else {
      const form = await request.formData();
      body = bodySchema.parse({
        caseId: form.get("caseId") ? String(form.get("caseId")) : undefined,
        extractionId: form.get("extractionId") ? String(form.get("extractionId")) : undefined,
        workflow: form.get("workflow") ? String(form.get("workflow")) : undefined
      });
    }

    await deleteGeneratedReport({
      reportId: params.id,
      actorId: auth.session.id,
      actorName: auth.session.name
    });

    const redirectParams = new URLSearchParams();
    if (body.caseId) redirectParams.set("caseId", body.caseId);
    if (body.extractionId) redirectParams.set("extractionId", body.extractionId);
    if (body.workflow) redirectParams.set("workflow", body.workflow);
    const suffix = redirectParams.toString();

    return NextResponse.redirect(new URL(`/reports${suffix ? `?${suffix}` : ""}`, request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao excluir relatorio." },
      { status: 500 }
    );
  }
}
