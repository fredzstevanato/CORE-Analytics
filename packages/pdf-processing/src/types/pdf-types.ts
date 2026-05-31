export type PdfProcessingMode = "analysis-only" | "analysis-and-ocr";

export interface PdfOriginalFile {
  fileName: string;
  absolutePath: string;
  sizeBytes?: number;
}

export interface PdfProcessedFile {
  fileName: string;
  absolutePath: string;
  relativePath?: string;
  sizeBytes?: number;
}

export interface PdfPageDebugMetadata {
  textHash?: string;
  visualHash?: string;
  pageObjectId?: string;
  streamLength?: number;
  visualDensity?: number;
  operatorStats?: Record<string, number>;
  notes?: string[];
}

export interface PdfPageAnalysis {
  pageNumber: number;
  hasExtractableText: boolean;
  needsOcr: boolean;
  isLikelyBlank: boolean;
  isLikelyDuplicate: boolean;
  duplicateOfPageNumber?: number;
  confidenceScore: number;
  extractedTextLength: number;
  debug?: PdfPageDebugMetadata;
}

export interface PdfDuplicateGroup {
  anchorPageNumber: number;
  pageNumbers: number[];
  strategy: "text-hash" | "visual-hash" | "hybrid-similarity";
  confidenceScore: number;
}

export interface PdfAnalysisSummary {
  totalPages: number;
  pagesNeedingOcr: number;
  blankPages: number;
  possibleDuplicatePages: number;
}

export interface PdfOcrResult {
  attempted: boolean;
  applied: boolean;
  pagesRequested: number[];
  pagesProcessed: number[];
  processedFilePath?: string;
  warnings: string[];
}

export interface PdfProcessingThresholdConfig {
  minimumUsefulTextLength: number;
  blankVisualDensityThreshold: number;
  smallMarkAreaTolerance: number;
  duplicateSimilarityThreshold: number;
}

export interface PdfProcessingOcrConfig {
  enabled: boolean;
  language: string;
  command?: string;
  commandArgs?: string[];
}

export interface PdfProcessingPathConfig {
  tempDir: string;
  outputDir: string;
}

export interface PdfProcessingConfig {
  thresholds: PdfProcessingThresholdConfig;
  ocr: PdfProcessingOcrConfig;
  paths: PdfProcessingPathConfig;
  debug: boolean;
}

export interface PdfImportPipelineOptions {
  inputFilePath: string;
  originalFileName?: string;
  mode?: PdfProcessingMode;
  outputFileName?: string;
  config?: Partial<PdfProcessingConfig>;
}

export interface PdfProcessingResult {
  success: boolean;
  mode: PdfProcessingMode;
  originalFile: PdfOriginalFile;
  processedFile?: PdfProcessedFile;
  summary: PdfAnalysisSummary;
  pages: PdfPageAnalysis[];
  duplicateGroups: PdfDuplicateGroup[];
  warnings: string[];
  errors: string[];
  processingTimeMs: number;
}
