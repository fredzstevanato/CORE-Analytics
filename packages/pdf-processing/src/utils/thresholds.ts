import type { PdfProcessingThresholdConfig } from "../types/pdf-types";
import { clampConfidence } from "./hashing";

export function isUsefulText(textLength: number, config: PdfProcessingThresholdConfig): boolean {
  return textLength >= config.minimumUsefulTextLength;
}

export function computeBlankConfidence(input: {
  textLength: number;
  visualDensity: number;
  hasImages: boolean;
  hasSmallMarks: boolean;
  config: PdfProcessingThresholdConfig;
}): number {
  const textPenalty = input.textLength > 0 ? 0.55 : 0;
  const imagePenalty = input.hasImages ? 0.4 : 0;
  const smallMarkPenalty = input.hasSmallMarks ? 0.25 : 0;
  const normalizedDensity = Math.min(1, input.visualDensity / Math.max(0.001, input.config.blankVisualDensityThreshold));
  const densityPenalty = normalizedDensity * 0.8;
  const score = 1 - textPenalty - imagePenalty - smallMarkPenalty - densityPenalty;
  return clampConfidence(score);
}

export function computeDuplicateConfidence(input: {
  textSimilarity: number;
  visualSimilarity: number;
}): number {
  return clampConfidence(input.textSimilarity * 0.55 + input.visualSimilarity * 0.45);
}
