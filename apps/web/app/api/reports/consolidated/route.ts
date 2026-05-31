import { NextResponse } from "next/server";
import { z } from "zod";
import { createGeneratedReport } from "@core/cases";
import { buildConsolidatedCaseReport } from "@core/reports";
import { getSessionUser } from "@/lib/session";

const bodySchema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  title: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let body: z.infer<typeof bodySchema>;
    if (contentType.includes("application/json")) {
      body = bodySchema.parse(await request.json());
    } else {
      const form = await request.formData();
      body = bodySchema.parse({
        caseId: String(form.get("caseId") ?? ""),
        extractionId: String(form.get("extractionId") ?? "") || undefined,
        title: String(form.get("title") ?? "")
      });
    }

    const built = await buildConsolidatedCaseReport({
      caseId: body.caseId,
      extractionId: body.extractionId,
      title: body.title
    });
    const session = await getSessionUser();
    await createGeneratedReport({
      caseId: body.caseId,
      evidenceId: built.primaryEvidenceId ?? undefined,
      authorId: session?.id,
      title: built.title,
      format: "MARKDOWN",
      content: built.content,
      metadata: {
        generatedBy: "api/reports/consolidated",
        reportType: "CONSOLIDATED_CASE_REPORT",
        linkage: built.linkage,
        snapshot: built.snapshot
      }
    });

    const params = new URLSearchParams({ caseId: body.caseId });
    if (body.extractionId) params.set("extractionId", body.extractionId);
    return NextResponse.redirect(new URL(`/reports?${params.toString()}`, request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao gerar relatório consolidado." },
      { status: 500 }
    );
  }
}
