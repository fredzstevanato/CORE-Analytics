import { stat, readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { contentTypeFromPath, resolveAttachmentAbsolutePath } from "@/lib/attachment-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INLINE_BYTES = 60 * 1024 * 1024;

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1";

  const resolved = await resolveAttachmentAbsolutePath(params.id);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const info = await stat(resolved.absolutePath).catch(() => null);
  if (!info || !info.isFile()) {
    return NextResponse.json({ error: "Arquivo do anexo nao encontrado." }, { status: 404 });
  }
  if (info.size > MAX_INLINE_BYTES && !download) {
    return NextResponse.json(
      { error: `Arquivo excede ${Math.floor(MAX_INLINE_BYTES / (1024 * 1024))}MB para visualizacao inline. Use download.` },
      { status: 413 }
    );
  }

  const bytes = await readFile(resolved.absolutePath);
  const contentType = contentTypeFromPath(resolved.fileName, resolved.mimeType);
  const disposition = download ? "attachment" : "inline";

  return new NextResponse(bytes, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${disposition}; filename="${safeName(resolved.fileName)}"`,
      "Cache-Control": "public, max-age=600"
    }
  });
}
