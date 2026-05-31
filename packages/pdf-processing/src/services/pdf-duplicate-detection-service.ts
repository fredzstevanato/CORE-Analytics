import type { PdfDuplicateGroup, PdfPageAnalysis, PdfProcessingConfig } from "../types/pdf-types";
import { diceSimilarity } from "../utils/hashing";
import { computeDuplicateConfidence } from "../utils/thresholds";

export interface DuplicateDetectionInput {
  pageNumber: number;
  textHash: string;
  visualHash: string;
  extractedText: string;
  visualFingerprint: string;
}

export interface DuplicateDetectionOutput {
  pages: PdfPageAnalysis[];
  duplicateGroups: PdfDuplicateGroup[];
}

type PageEnriched = PdfPageAnalysis & {
  textHash: string;
  visualHash: string;
  extractedText: string;
  visualFingerprint: string;
};

function buildGroup(
  anchor: number,
  pages: number[],
  strategy: "text-hash" | "visual-hash" | "hybrid-similarity",
  confidenceScore: number
): PdfDuplicateGroup {
  return {
    anchorPageNumber: anchor,
    pageNumbers: pages.sort((a, b) => a - b),
    strategy,
    confidenceScore
  };
}

export class PdfDuplicateDetectionService {
  constructor(private readonly config: PdfProcessingConfig) {}

  detect(basePages: PdfPageAnalysis[], source: DuplicateDetectionInput[]): DuplicateDetectionOutput {
    const byTextHash = new Map<string, number[]>();
    const byVisualHash = new Map<string, number[]>();

    for (const row of source) {
      if (row.extractedText.length > 0) {
        const list = byTextHash.get(row.textHash) ?? [];
        list.push(row.pageNumber);
        byTextHash.set(row.textHash, list);
      }
      const visualList = byVisualHash.get(row.visualHash) ?? [];
      visualList.push(row.pageNumber);
      byVisualHash.set(row.visualHash, visualList);
    }

    const enriched = basePages.map((page) => {
      const fromSource = source.find((item) => item.pageNumber === page.pageNumber);
      return {
        ...page,
        textHash: fromSource?.textHash ?? "",
        visualHash: fromSource?.visualHash ?? "",
        extractedText: fromSource?.extractedText ?? "",
        visualFingerprint: fromSource?.visualFingerprint ?? ""
      };
    }) as PageEnriched[];

    const groups: PdfDuplicateGroup[] = [];
    const duplicateOf = new Map<number, { anchor: number; score: number }>();

    for (const pages of byTextHash.values()) {
      if (pages.length < 2) continue;
      const anchor = pages[0];
      if (anchor === undefined) continue;
      groups.push(buildGroup(anchor, pages, "text-hash", 0.98));
      for (const page of pages.slice(1)) duplicateOf.set(page, { anchor, score: 0.98 });
    }

    for (const pages of byVisualHash.values()) {
      if (pages.length < 2) continue;
      const anchor = pages[0];
      if (anchor === undefined) continue;
      const existing = groups.some(
        (group) => group.anchorPageNumber === anchor && group.pageNumbers.join(",") === pages.join(",")
      );
      if (!existing) groups.push(buildGroup(anchor, pages, "visual-hash", 0.94));
      for (const page of pages.slice(1)) {
        const current = duplicateOf.get(page);
        if (!current || current.score < 0.94) duplicateOf.set(page, { anchor, score: 0.94 });
      }
    }

    for (let i = 0; i < enriched.length; i += 1) {
      for (let j = i + 1; j < enriched.length; j += 1) {
        const left = enriched[i];
        const right = enriched[j];
        if (!left || !right) continue;
        if (duplicateOf.has(right.pageNumber)) continue;
        const textSimilarity = diceSimilarity(left.extractedText, right.extractedText);
        const visualSimilarity = diceSimilarity(left.visualFingerprint, right.visualFingerprint);
        const confidence = computeDuplicateConfidence({ textSimilarity, visualSimilarity });
        if (confidence < this.config.thresholds.duplicateSimilarityThreshold) continue;

        duplicateOf.set(right.pageNumber, { anchor: left.pageNumber, score: confidence });
        groups.push(
          buildGroup(left.pageNumber, [left.pageNumber, right.pageNumber], "hybrid-similarity", confidence)
        );
      }
    }

    const pages = basePages.map((page) => {
      const duplicate = duplicateOf.get(page.pageNumber);
      if (!duplicate) return page;
      return {
        ...page,
        isLikelyDuplicate: true,
        duplicateOfPageNumber: duplicate.anchor,
        confidenceScore: Math.max(page.confidenceScore, duplicate.score)
      };
    });

    return {
      pages,
      duplicateGroups: groups.sort((a, b) => a.anchorPageNumber - b.anchorPageNumber)
    };
  }
}
