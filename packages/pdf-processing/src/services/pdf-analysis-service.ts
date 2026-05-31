import type { PdfPageAnalysis, PdfProcessingConfig } from "../types/pdf-types";
import type { PdfEngineAdapter } from "../adapters/pdf-engine-adapter";
import { PdfTextDetectionService } from "./pdf-text-detection-service";
import { PdfBlankPageService } from "./pdf-blank-page-service";
import { PdfDuplicateDetectionService } from "./pdf-duplicate-detection-service";

export interface PdfAnalysisOutput {
  pages: PdfPageAnalysis[];
  duplicateGroups: Array<{
    anchorPageNumber: number;
    pageNumbers: number[];
    strategy: "text-hash" | "visual-hash" | "hybrid-similarity";
    confidenceScore: number;
  }>;
}

export class PdfAnalysisService {
  private readonly textDetectionService: PdfTextDetectionService;
  private readonly blankPageService: PdfBlankPageService;
  private readonly duplicateDetectionService: PdfDuplicateDetectionService;

  constructor(
    private readonly config: PdfProcessingConfig,
    private readonly pdfEngineAdapter: PdfEngineAdapter
  ) {
    this.textDetectionService = new PdfTextDetectionService(config);
    this.blankPageService = new PdfBlankPageService(config);
    this.duplicateDetectionService = new PdfDuplicateDetectionService(config);
  }

  async analyze(inputFilePath: string): Promise<PdfAnalysisOutput> {
    const document = await this.pdfEngineAdapter.readDocument(inputFilePath);
    const sourceRows = document.pages.map((page) => {
      const text = this.textDetectionService.detect({ textLength: page.rawTextLength });
      const blank = this.blankPageService.detect({
        textLength: page.rawTextLength,
        visualDensity: page.visualDensity,
        hasImages: page.hasImages,
        hasSmallMarks: page.hasSmallMarks
      });

      const confidenceScore = Math.max(blank.confidenceScore, text.hasExtractableText ? 0.9 : 0.72);
      const analysis: PdfPageAnalysis = {
        pageNumber: page.pageNumber,
        hasExtractableText: text.hasExtractableText,
        needsOcr: text.needsOcr,
        isLikelyBlank: blank.isLikelyBlank,
        isLikelyDuplicate: false,
        confidenceScore,
        extractedTextLength: page.rawTextLength,
        debug: this.config.debug
          ? {
              textHash: page.textHash,
              visualHash: page.visualHash,
              pageObjectId: page.pageObjectId,
              streamLength: page.streamLength,
              visualDensity: page.visualDensity,
              operatorStats: page.operatorStats
            }
          : undefined
      };

      return {
        analysis,
        source: {
          pageNumber: page.pageNumber,
          textHash: page.textHash,
          visualHash: page.visualHash,
          extractedText: page.extractedText,
          visualFingerprint: page.visualFingerprint
        }
      };
    });

    const duplicate = this.duplicateDetectionService.detect(
      sourceRows.map((row) => row.analysis),
      sourceRows.map((row) => row.source)
    );

    return {
      pages: duplicate.pages,
      duplicateGroups: duplicate.duplicateGroups
    };
  }
}
