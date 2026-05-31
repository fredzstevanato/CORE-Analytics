import type { PdfOcrResult, PdfPageAnalysis, PdfProcessingConfig } from "../types/pdf-types";
import type { OcrAdapter } from "../adapters/ocr-adapter";

export interface PdfSelectiveOcrInput {
  inputFilePath: string;
  outputFileName: string;
  pages: PdfPageAnalysis[];
}

export class PdfOcrService {
  constructor(
    private readonly config: PdfProcessingConfig,
    private readonly adapter: OcrAdapter
  ) {}

  async executeSelectiveOcr(input: PdfSelectiveOcrInput): Promise<PdfOcrResult> {
    const pagesToOcr = input.pages
      .filter((page) => page.needsOcr && !page.isLikelyBlank)
      .map((page) => page.pageNumber);

    if (pagesToOcr.length === 0) {
      return {
        attempted: false,
        applied: false,
        pagesRequested: [],
        pagesProcessed: [],
        warnings: ["No pages required OCR after analysis."]
      };
    }

    return this.adapter.performSelectiveOcr({
      inputFilePath: input.inputFilePath,
      outputDir: this.config.paths.outputDir,
      outputFileName: input.outputFileName,
      pagesToOcr,
      language: this.config.ocr.language
    });
  }
}
