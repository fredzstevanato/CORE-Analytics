import type { PdfProcessingConfig } from "../types/pdf-types";
import { isUsefulText } from "../utils/thresholds";

export interface TextDetectionInput {
  textLength: number;
}

export interface TextDetectionOutput {
  hasExtractableText: boolean;
  needsOcr: boolean;
}

export class PdfTextDetectionService {
  constructor(private readonly config: PdfProcessingConfig) {}

  detect(input: TextDetectionInput): TextDetectionOutput {
    const hasExtractableText = isUsefulText(input.textLength, this.config.thresholds);
    return {
      hasExtractableText,
      needsOcr: !hasExtractableText
    };
  }
}
