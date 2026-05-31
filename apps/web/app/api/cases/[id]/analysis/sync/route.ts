import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@core/db";
import { syncCaseTimeline, syncEvidenceLocationArtifacts } from "@core/cases";
import { getSessionUser } from "@/lib/session";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z.object({
  evidenceId: z.string().uuid().optional()
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const session = await getSessionUser();

    const caseRow = await prisma.case.findUnique({
      where: { id: params.id },
      select: { id: true }
    });
    if (!caseRow) {
      return NextResponse.json({ error: "Caso nao encontrado." }, { status: 404 });
    }

    if (body.evidenceId) {
      const evidence = await prisma.evidence.findFirst({
        where: {
          id: body.evidenceId,
          caseId: params.id
        },
        select: { id: true }
      });
      if (!evidence) {
        return NextResponse.json({ error: "Evidencia nao encontrada para este caso." }, { status: 404 });
      }
    }

    const locationResult = body.evidenceId
      ? await syncEvidenceLocationArtifacts({
          caseId: params.id,
          evidenceId: body.evidenceId
        })
      : await prisma.evidence
          .findMany({
            where: { caseId: params.id },
            select: { id: true }
          })
          .then(async (evidences) => {
            let created = 0;
            for (const evidence of evidences) {
              const result = await syncEvidenceLocationArtifacts({
                caseId: params.id,
                evidenceId: evidence.id
              });
              created += result.created;
            }
            return { created };
          });

    const timelineResult = await syncCaseTimeline({
      caseId: params.id,
      evidenceId: body.evidenceId
    });

    await prisma.auditLog.create({
      data: {
        caseId: params.id,
        actorId: session?.id,
        action: "ANALYSIS_DERIVED_VIEWS_SYNCED",
        targetType: "CASE",
        targetId: params.id,
        metadata: {
          evidenceId: body.evidenceId ?? null,
          timelineCreated: timelineResult.created,
          locationArtifactsCreated: locationResult.created
        }
      }
    });

    return NextResponse.json({
      success: true,
      evidenceId: body.evidenceId ?? null,
      timelineCreated: timelineResult.created,
      locationArtifactsCreated: locationResult.created
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao sincronizar timeline e localizacoes." },
      { status: 500 }
    );
  }
}
