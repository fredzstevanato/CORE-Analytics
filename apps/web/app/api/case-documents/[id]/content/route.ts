import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@core/db";
import { contentTypeFromPath } from "@/lib/attachment-file";

const paramsSchema = {
  parse(value: { id?: string }) {
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!id) throw new Error("ID de documento invalido.");
    return { id };
  }
};

const MAX_FILE_BYTES = 120 * 1024 * 1024;

function isPathInsideRoot(targetPath: string) {
  const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? "./storage");
  const resolvedTarget = path.resolve(targetPath);
  return (
    resolvedTarget === storageRoot ||
    resolvedTarget.startsWith(`${storageRoot}${path.sep}`)
  );
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const download = new URL(request.url).searchParams.get("download") === "1";
    const row = await prisma.caseDocument.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        storagePath: true
      }
    });
    if (!row) {
      return NextResponse.json({ error: "Documento nao encontrado." }, { status: 404 });
    }

    const absolutePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", row.storagePath);
    if (!isPathInsideRoot(absolutePath)) {
      return NextResponse.json({ error: "Caminho de documento nao permitido." }, { status: 403 });
    }
    const fileInfo = await stat(absolutePath).catch(() => null);
    if (!fileInfo?.isFile()) {
      return NextResponse.json({ error: "Arquivo do documento nao encontrado." }, { status: 404 });
    }
    if (fileInfo.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Arquivo excede limite para download." }, { status: 413 });
    }

    const bytes = await readFile(absolutePath);
    const disposition = download ? "attachment" : "inline";
    const safeName = row.fileName.replace(/"/g, "");

    return new NextResponse(bytes, {
      headers: {
        "Content-Type": contentTypeFromPath(row.fileName, row.mimeType),
        "Content-Disposition": `${disposition}; filename="${safeName}"`,
        "Cache-Control": "private, max-age=120"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao obter documento." },
      { status: 500 }
    );
  }
}

