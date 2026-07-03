import { NextResponse } from "next/server";
import { prisma } from "@core/db";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

const postSchema = z.object({
  caseId: z.string().uuid(),
  evidenceId: z.string().uuid().optional(),
  extractionId: z.string().uuid().optional(),
  selectedAttachmentIds: z.array(z.string().uuid()).default([]),
  visibleAttachmentIds: z.array(z.string().uuid()).default([]),
  toggleAttachmentId: z.string().uuid().optional(),
  toggleSelected: z.boolean().optional()
});

function readStringArrayFromMetadata(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const body = postSchema.parse(await request.json());
    const visibleAttachmentIds = [...new Set(body.visibleAttachmentIds)];
    const latestSelection =
      body.toggleAttachmentId
        ? await prisma.aiInsight.findFirst({
            where: {
              caseId: body.caseId,
              type: "AUDIO_UNLINKED_SELECTION",
              ...(body.evidenceId ? { evidenceId: body.evidenceId } : {})
            },
            orderBy: { createdAt: "desc" },
            select: { metadata: true }
          })
        : null;

    const selectedAttachmentIds = body.toggleAttachmentId
      ? (() => {
          const current = new Set(readStringArrayFromMetadata(latestSelection?.metadata, "selectedAttachmentIds"));
          if (body.toggleSelected) current.add(body.toggleAttachmentId);
          else current.delete(body.toggleAttachmentId);
          return [...current];
        })()
      : [...new Set(body.selectedAttachmentIds)];

    const validSelected = selectedAttachmentIds.length
      ? await prisma.attachment.findMany({
          where: {
            id: { in: selectedAttachmentIds },
            caseId: body.caseId,
            messageId: null,
            ...(body.evidenceId ? { evidenceId: body.evidenceId } : {})
          },
          select: { id: true }
        })
      : [];

    const validSelectedIds = validSelected.map((item) => item.id);
    const now = new Date();

    const insight = await prisma.aiInsight.create({
      data: {
        caseId: body.caseId,
        evidenceId: body.evidenceId,
        extractionId: body.extractionId,
        type: "AUDIO_UNLINKED_SELECTION",
        title: `Audios soltos selecionados (${validSelectedIds.length})`,
        summary:
          validSelectedIds.length > 0
            ? "Selecao de audios sem vinculo com chat para revisao analitica."
            : "Selecao de audios sem vinculo com chat foi limpa.",
        score: validSelectedIds.length,
        metadata: {
          selectedAttachmentIds: validSelectedIds,
          visibleAttachmentIds,
          savedAt: now.toISOString(),
          savedById: auth.session.id,
          scope: {
            caseId: body.caseId,
            evidenceId: body.evidenceId ?? null,
            extractionId: body.extractionId ?? null,
            unlinkedOnly: true
          }
        }
      }
    });

    return NextResponse.json({
      insightId: insight.id,
      selectedAttachmentIds: validSelectedIds,
      selectedCount: validSelectedIds.length
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao salvar selecao de audios." },
      { status: 500 }
    );
  }
}
