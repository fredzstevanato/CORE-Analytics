import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function contentTypeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

function getAllowedRoots() {
  const roots = new Set<string>();
  const envRoot = process.env.STORAGE_ROOT;
  if (envRoot) roots.add(path.resolve(envRoot));
  roots.add(path.resolve(process.cwd(), "storage"));
  roots.add(path.resolve(process.cwd(), "..", "worker-ingest", "storage"));
  return [...roots];
}

function isPathAllowed(targetPath: string) {
  const normalizedTarget = path.resolve(targetPath);
  return getAllowedRoots().some((root) => {
    const normalizedRoot = path.resolve(root);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("path");
  if (!raw) {
    return NextResponse.json({ error: "Parametro path obrigatorio." }, { status: 400 });
  }

  const target = path.resolve(raw);
  if (!isPathAllowed(target)) {
    return NextResponse.json({ error: "Caminho de imagem nao permitido." }, { status: 403 });
  }

  const fileInfo = await stat(target).catch(() => null);
  if (!fileInfo || !fileInfo.isFile()) {
    return NextResponse.json({ error: "Imagem nao encontrada." }, { status: 404 });
  }
  if (fileInfo.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "Imagem excede limite de tamanho." }, { status: 413 });
  }

  const bytes = await readFile(target);
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": contentTypeFromPath(target),
      "Cache-Control": "public, max-age=60"
    }
  });
}

