import path from "node:path";
import {
  type PdfImportPipelineOptions,
  type PdfProcessingMode,
  type PdfProcessingResult
} from "../types/pdf-types";
import { resolvePdfProcessingConfig } from "../config/pdf-config";
import { ensureDirectory, safeFileSize } from "../utils/temp-files";
import { LightweightPdfEngineAdapter } from "../adapters/pdf-engine-adapter";
import { createOcrAdapter } from "../adapters/ocr-adapter";
import { PdfAnalysisService } from "./pdf-analysis-service";
import { PdfOcrService } from "./pdf-ocr-service";

function resolveMode(input?: PdfProcessingMode): PdfProcessingMode {
  return input === "analysis-and-ocr" ? "analysis-and-ocr" : "analysis-only";
}

function buildOutputFileName(originalName: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const ext = path.extname(originalName) || ".pdf";
  const base = path.basename(originalName, ext);
  return `${base}.ocr${ext}`;
}

export async function runPdfImportPipeline(
  options: PdfImportPipelineOptions
): Promise<PdfProcessingResult> {
  const startedAt = Date.now();
  const mode = resolveMode(options.mode);
  const config = resolvePdfProcessingConfig(options.config);
  const warnings: string[] = [];
  const errors: string[] = [];

  try {
    await ensureDirectory(config.paths.tempDir);
    await ensureDirectory(config.paths.outputDir);

    const engine = new LightweightPdfEngineAdapter();
    const analysisService = new PdfAnalysisService(config, engine);
    const analysis = await analysisService.analyze(options.inputFilePath);

    const effectiveOriginalFileName = options.originalFileName ?? path.basename(options.inputFilePath);
    const outputFileName = buildOutputFileName(effectiveOriginalFileName, options.outputFileName);
    let processedFilePath: string | undefined;

    if (mode === "analysis-and-ocr") {
      const ocrService = new PdfOcrService(config, createOcrAdapter(config));
      const ocrResult = await ocrService.executeSelectiveOcr({
        inputFilePath: options.inputFilePath,
        outputFileName,
        pages: analysis.pages
      });
      warnings.push(...ocrResult.warnings);
      if (ocrResult.processedFilePath) {
        processedFilePath = ocrResult.processedFilePath;
      }
    } else if (config.ocr.enabled) {
      warnings.push("OCR is enabled in config but mode=analysis-only, therefore OCR was skipped.");
    }

    const summary = {
      totalPages: analysis.pages.length,
      pagesNeedingOcr: analysis.pages.filter((page) => page.needsOcr).length,
      blankPages: analysis.pages.filter((page) => page.isLikelyBlank).length,
      possibleDuplicatePages: analysis.pages.filter((page) => page.isLikelyDuplicate).length
    };

    const originalSize = await safeFileSize(options.inputFilePath);
    const processedSize = processedFilePath ? await safeFileSize(processedFilePath) : undefined;

    return {
      success: true,
      mode,
      originalFile: {
        fileName: effectiveOriginalFileName,
        absolutePath: path.resolve(options.inputFilePath),
        sizeBytes: originalSize
      },
      processedFile: processedFilePath
        ? {
            fileName: path.basename(processedFilePath),
            absolutePath: path.resolve(processedFilePath),
            sizeBytes: processedSize
          }
        : undefined,
      summary,
      pages: analysis.pages,
      duplicateGroups: analysis.duplicateGroups,
      warnings,
      errors,
      processingTimeMs: Date.now() - startedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown pipeline failure";
    errors.push(message);
    return {
      success: false,
      mode,
      originalFile: {
        fileName: options.originalFileName ?? path.basename(options.inputFilePath),
        absolutePath: path.resolve(options.inputFilePath)
      },
      summary: {
        totalPages: 0,
        pagesNeedingOcr: 0,
        blankPages: 0,
        possibleDuplicatePages: 0
      },
      pages: [],
      duplicateGroups: [],
      warnings,
      errors,
      processingTimeMs: Date.now() - startedAt
    };
  }
}
