import { NextResponse } from "next/server";
import { z } from "zod";
import { exportExtractionToCoreHub } from "@core/cases";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z
  .object({
    force: z.boolean().optional().default(true)
  })
  .optional();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const session = auth.session;

    const params = paramsSchema.parse(await context.params);
    const rawBody = await request.json().catch(() => ({}));
    const body = bodySchema.parse(rawBody);

    const result = await exportExtractionToCoreHub({
      extractionId: params.id,
      actorId: session.id,
      source: "api/extractions/core-hub-export",
      force: body?.force ?? true
    });

    return NextResponse.json({
      ok: true,
      skipped: result.skipped,
      reason: "reason" in result ? result.reason : undefined,
      response: "response" in result ? result.response : undefined
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao reenviar extracao para CORE HUB."
      },
      { status: 500 }
    );
  }
}
