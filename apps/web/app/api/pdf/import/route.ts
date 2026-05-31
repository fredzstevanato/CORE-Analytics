import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { runPdfImportPipeline, type PdfProcessingMode } from "@core/pdf-processing";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

function resolveStorageRoot(): string {
  return path.resolve(process.env.STORAGE_ROOT ?? "./storage");
}

function safeInputName(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "uploaded.pdf";
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const modeRaw = formData.get("mode");
    const mode: PdfProcessingMode =
      modeRaw === "analysis-and-ocr" ? "analysis-and-ocr" : "analysis-only";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Arquivo PDF invalido." }, { status: 400 });
    }

    const fileName = file.name || "uploaded.pdf";
    const isPdf = /\.pdf$/i.test(fileName) || file.type === "application/pdf";
    if (!isPdf) {
      return NextResponse.json({ error: "Apenas arquivos PDF sao aceitos." }, { status: 400 });
    }

    const storageRoot = resolveStorageRoot();
    const tempDir = path.resolve(storageRoot, "tmp", "pdf-imports");
    await mkdir(tempDir, { recursive: true });

    const tempName = `${Date.now()}-${crypto.randomUUID()}-${safeInputName(fileName)}`;
    const tempPath = path.resolve(tempDir, tempName);
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(tempPath, bytes);

    const result = await runPdfImportPipeline({
      inputFilePath: tempPath,
      originalFileName: fileName,
      mode
    });

    const processedFileUrl = result.processedFile
      ? `/api/pdf/processed?path=${encodeURIComponent(result.processedFile.absolutePath)}`
      : null;

    return NextResponse.json({
      ...result,
      processedFileUrl
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("error", "PDF import pipeline failed", { error: message });
    return NextResponse.json({ error: "Falha ao processar PDF." }, { status: 500 });
  }
}
