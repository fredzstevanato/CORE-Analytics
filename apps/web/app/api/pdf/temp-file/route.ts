import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const MAX_PDF_BYTES = 80 * 1024 * 1024;

function temporaryRoot(): string {
  const root = path.resolve(process.env.STORAGE_ROOT ?? "./storage");
  return path.resolve(root, "tmp", "pdf-processing-sessions");
}

function resolveTemporaryTarget(relativePath: string) {
  const root = temporaryRoot();
  const target = path.resolve(root, relativePath);
  const allowed = target === root || target.startsWith(`${root}${path.sep}`);
  return { root, target, allowed };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const relativePath = searchParams.get("path");
  const download = searchParams.get("download") === "1";
  const deleteAfterDownload = searchParams.get("deleteAfterDownload") !== "0";

  if (!relativePath) {
    return NextResponse.json({ error: "Parametro path obrigatorio." }, { status: 400 });
  }

  const { target, allowed } = resolveTemporaryTarget(relativePath);
  if (!allowed) {
    return NextResponse.json({ error: "Caminho nao permitido." }, { status: 403 });
  }

  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    return NextResponse.json({ error: "Arquivo temporario nao encontrado." }, { status: 404 });
  }
  if (info.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: "Arquivo excede limite de tamanho." }, { status: 413 });
  }

  const bytes = await readFile(target);
  if (download && deleteAfterDownload) {
    await rm(target, { force: true }).catch(() => undefined);
  }

  const disposition = download ? "attachment" : "inline";
  const safeName = path.basename(target).replace(/"/g, "");
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, max-age=60",
      "Content-Disposition": `${disposition}; filename=\"${safeName}\"`
    }
  });
}
