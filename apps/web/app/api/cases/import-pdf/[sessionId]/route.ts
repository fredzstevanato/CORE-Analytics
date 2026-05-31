import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@core/db";
import { getCaseImportSessionById, updateCaseImportSessionDraft, discardCaseImportSession } from "@core/cases";

const paramsSchema = z.object({
  sessionId: z.string().uuid()
});

const patchSchema = z.object({
  draftPayload: z.record(z.unknown()).optional(),
  action: z.enum(["discard"]).optional()
});

export async function GET(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const session = await getCaseImportSessionById(params.sessionId);
    if (!session) {
      return NextResponse.json({ error: "Sessao de importacao nao encontrada." }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao carregar sessao de importacao." },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const body = patchSchema.parse(await request.json());

    if (body.action === "discard") {
      const discarded = await discardCaseImportSession({ sessionId: params.sessionId });
      return NextResponse.json({ session: discarded });
    }

    if (!body.draftPayload) {
      return NextResponse.json({ error: "Nenhuma alteracao informada." }, { status: 400 });
    }

    const updated = await updateCaseImportSessionDraft({
      sessionId: params.sessionId,
      draftPayload: body.draftPayload as Prisma.InputJsonValue,
      status: "READY_FOR_REVIEW"
    });

    return NextResponse.json({ session: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao atualizar sessao de importacao." },
      { status: 500 }
    );
  }
}
