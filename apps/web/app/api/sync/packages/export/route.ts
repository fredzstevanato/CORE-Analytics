import { NextResponse } from "next/server";
import { z } from "zod";
import { buildConsolidatedSyncPackage, sendConsolidatedSyncPackage } from "@core/cases";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  caseId: z.string().uuid(),
  evidenceId: z.string().uuid().optional(),
  extractionId: z.string().uuid().optional(),
  selectedChatIds: z.array(z.string().uuid()).optional().default([]),
  selectedMessageIds: z.array(z.string().uuid()).optional().default([]),
  selectedAttachmentIds: z.array(z.string().uuid()).optional().default([]),
  includeTranscriptions: z.boolean().optional().default(true),
  includeOcr: z.boolean().optional().default(true),
  includeInsights: z.boolean().optional().default(true),
  includeMediaFiles: z.boolean().optional().default(true),
  sendToCentralizer: z.boolean().optional().default(false),
  maxFileBytes: z.number().int().positive().optional()
});

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const pkg = await buildConsolidatedSyncPackage({
      caseId: body.caseId,
      evidenceId: body.evidenceId,
      extractionId: body.extractionId,
      selectedChatIds: body.selectedChatIds,
      selectedMessageIds: body.selectedMessageIds,
      selectedAttachmentIds: body.selectedAttachmentIds,
      includeTranscriptions: body.includeTranscriptions,
      includeOcr: body.includeOcr,
      includeInsights: body.includeInsights,
      includeMediaFiles: body.includeMediaFiles,
      maxFileBytes: body.maxFileBytes
    });

    const centralizerResponse = body.sendToCentralizer ? await sendConsolidatedSyncPackage(pkg) : undefined;

    return NextResponse.json({
      ok: true,
      sent: body.sendToCentralizer,
      centralizerResponse,
      package: pkg
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao gerar pacote consolidado."
      },
      { status: 500 }
    );
  }
}
