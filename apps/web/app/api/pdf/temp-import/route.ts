import { mkdir, rm, writeFile } from "node:fs/promises";
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
    const mode: PdfProcessingMode = modeRaw === "analysis-and-ocr" ? "analysis-and-ocr" : "analysis-only";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Arquivo PDF invalido." }, { status: 400 });
    }

    const fileName = file.name || "uploaded.pdf";
    const isPdf = /\.pdf$/i.test(fileName) || file.type === "application/pdf";
    if (!isPdf) {
      return NextResponse.json({ error: "Apenas arquivos PDF sao aceitos." }, { status: 400 });
    }

    const storageRoot = resolveStorageRoot();
    const sessionsRoot = path.resolve(storageRoot, "tmp", "pdf-processing-sessions");
    const sessionId = `${Date.now()}-${crypto.randomUUID()}`;
    const sessionDir = path.resolve(sessionsRoot, sessionId);
    const inputDir = path.resolve(sessionDir, "input");
    const tempDir = path.resolve(sessionDir, "tmp");
    const outputDir = path.resolve(sessionDir, "output");
    await mkdir(inputDir, { recursive: true });
    await mkdir(tempDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const tempName = safeInputName(fileName);
    const tempPath = path.resolve(inputDir, tempName);
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(tempPath, bytes);

    const result = await runPdfImportPipeline({
      inputFilePath: tempPath,
      originalFileName: fileName,
      mode,
      config: {
        paths: {
          tempDir,
          outputDir
        }
      }
    });

    // O arquivo de entrada não é mais necessário.
    await rm(tempPath, { force: true }).catch(() => undefined);

    const processedRelative = result.processedFile
      ? path.relative(sessionsRoot, result.processedFile.absolutePath).replace(/\\/g, "/")
      : null;
    const processedFileUrl = processedRelative
      ? `/api/pdf/temp-file?path=${encodeURIComponent(processedRelative)}&download=1`
      : null;

    return NextResponse.json({
      ...result,
      temporary: true,
      sessionId,
      processedRelativePath: processedRelative,
      processedFileUrl,
      note: "Arquivo processado mantido temporariamente e removido apos download."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("error", "Temporary PDF import pipeline failed", { error: message });
    return NextResponse.json({ error: "Falha ao processar PDF temporario." }, { status: 500 });
  }
}
