import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const MAX_PDF_BYTES = 80 * 1024 * 1024;

function allowedRoots(): string[] {
  const root = path.resolve(process.env.STORAGE_ROOT ?? "./storage");
  return [path.resolve(root, "derived", "pdf-processing")];
}

function pathIsAllowed(inputPath: string): boolean {
  const resolvedTarget = path.resolve(inputPath);
  return allowedRoots().some((root) => {
    const resolvedRoot = path.resolve(root);
    return (
      resolvedTarget === resolvedRoot ||
      resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
    );
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawPath = searchParams.get("path");
  const download = searchParams.get("download") === "1";
  const fileName = searchParams.get("filename")?.trim() || undefined;
  if (!rawPath) {
    return NextResponse.json({ error: "Parametro path obrigatorio." }, { status: 400 });
  }

  const target = path.resolve(rawPath);
  if (!pathIsAllowed(target)) {
    return NextResponse.json({ error: "Caminho nao permitido." }, { status: 403 });
  }

  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    return NextResponse.json({ error: "Arquivo nao encontrado." }, { status: 404 });
  }

  if (info.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: "Arquivo excede limite de tamanho." }, { status: 413 });
  }

  const bytes = await readFile(target);
  const disposition = download ? "attachment" : "inline";
  const safeName = (fileName || path.basename(target)).replace(/"/g, "");
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, max-age=120",
      "Content-Disposition": `${disposition}; filename=\"${safeName}\"`
    }
  });
}
