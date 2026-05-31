import path from "node:path";
import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@core/db";

const paramsSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid()
});

export async function DELETE(_: Request, context: { params: Promise<{ id: string; documentId: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const document = await prisma.caseDocument.findFirst({
      where: {
        id: params.documentId,
        caseId: params.id
      }
    });
    if (!document) {
      return NextResponse.json({ error: "Documento nao encontrado no caso." }, { status: 404 });
    }

    await prisma.caseDocument.delete({
      where: { id: params.documentId }
    });

    const absolutePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", document.storagePath);
    await rm(absolutePath, { force: true }).catch(() => undefined);

    return NextResponse.json({ success: true, documentId: params.documentId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao excluir documento." },
      { status: 500 }
    );
  }
}
