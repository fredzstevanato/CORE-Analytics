import type { PdfProcessingConfig } from "../types/pdf-types";
import { computeBlankConfidence } from "../utils/thresholds";

export interface BlankPageDetectionInput {
  textLength: number;
  visualDensity: number;
  hasImages: boolean;
  hasSmallMarks: boolean;
}

export interface BlankPageDetectionOutput {
  isLikelyBlank: boolean;
  confidenceScore: number;
}

export class PdfBlankPageService {
  constructor(private readonly config: PdfProcessingConfig) {}

  detect(input: BlankPageDetectionInput): BlankPageDetectionOutput {
    const confidenceScore = computeBlankConfidence({
      textLength: input.textLength,
      visualDensity: input.visualDensity,
      hasImages: input.hasImages,
      hasSmallMarks: input.hasSmallMarks,
      config: this.config.thresholds
    });
    const lowDensity = input.visualDensity <= this.config.thresholds.blankVisualDensityThreshold;
    const isLikelyBlank = confidenceScore >= 0.62 && lowDensity && !input.hasImages;

    return {
      isLikelyBlank,
      confidenceScore
    };
  }
}
