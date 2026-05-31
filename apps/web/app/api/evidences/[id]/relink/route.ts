import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent, relinkAudioAttachmentsForEvidence } from "@core/cases";
import { prisma } from "@core/db";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const sessionUser = auth.session;

    const params = paramsSchema.parse(await context.params);
    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      include: { extraction: true }
    });
    if (!evidence) {
      return NextResponse.json({ error: "Evidencia nao encontrada." }, { status: 404 });
    }
    if (evidence.extraction?.status === "PROCESSING" || evidence.extraction?.status === "INDEXING") {
      return NextResponse.json({ error: "Extracao em andamento. Aguarde para recalcular vinculos." }, { status: 409 });
    }

    const result = await relinkAudioAttachmentsForEvidence({ evidenceId: evidence.id });

    await addCustodyEvent({
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      actorId: sessionUser.id,
      action: "AUDIO_LINKAGE_RECALCULATED",
      source: "api/evidences/relink",
      currentHash: evidence.sha256,
      details: result
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao recalcular vinculos."
      },
      { status: 500 }
    );
  }
}
