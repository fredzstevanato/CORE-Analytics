import path from "node:path";
import type { PdfProcessingConfig } from "../types/pdf-types";

const DEFAULT_TEMP_DIR = path.resolve(process.env.STORAGE_ROOT ?? "./storage", "tmp", "pdf-processing");
const DEFAULT_OUTPUT_DIR = path.resolve(process.env.STORAGE_ROOT ?? "./storage", "derived", "pdf-processing");

export const DEFAULT_PDF_PROCESSING_CONFIG: PdfProcessingConfig = {
  thresholds: {
    minimumUsefulTextLength: 24,
    blankVisualDensityThreshold: 0.02,
    smallMarkAreaTolerance: 0.0035,
    duplicateSimilarityThreshold: 0.92
  },
  ocr: {
    enabled: false,
    language: process.env.PDF_OCR_LANGUAGE ?? "por+eng",
    command: process.env.PDF_OCR_COMMAND,
    commandArgs: process.env.PDF_OCR_COMMAND_ARGS?.split(" ").filter(Boolean)
  },
  paths: {
    tempDir: process.env.PDF_TEMP_DIR ?? DEFAULT_TEMP_DIR,
    outputDir: process.env.PDF_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR
  },
  debug: process.env.PDF_PROCESSING_DEBUG === "1" || process.env.PDF_PROCESSING_DEBUG === "true"
};

export function resolvePdfProcessingConfig(
  partialConfig?: Partial<PdfProcessingConfig>
): PdfProcessingConfig {
  return {
    thresholds: {
      ...DEFAULT_PDF_PROCESSING_CONFIG.thresholds,
      ...partialConfig?.thresholds
    },
    ocr: {
      ...DEFAULT_PDF_PROCESSING_CONFIG.ocr,
      ...partialConfig?.ocr
    },
    paths: {
      ...DEFAULT_PDF_PROCESSING_CONFIG.paths,
      ...partialConfig?.paths
    },
    debug: partialConfig?.debug ?? DEFAULT_PDF_PROCESSING_CONFIG.debug
  };
}
