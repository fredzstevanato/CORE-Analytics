import { inflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { normalizeText, sha1 } from "../utils/hashing";

const OPERATORS = ["re", "m", "l", "c", "h", "f", "S", "s", "B", "b", "Do", "BT", "ET"] as const;
type OperatorName = (typeof OPERATORS)[number];
type OperatorStats = Record<OperatorName, number>;

export interface PdfEnginePageData {
  pageNumber: number;
  pageObjectId: string;
  extractedText: string;
  rawTextLength: number;
  visualDensity: number;
  streamLength: number;
  hasImages: boolean;
  hasSmallMarks: boolean;
  operatorStats: Record<string, number>;
  textHash: string;
  visualHash: string;
  visualFingerprint: string;
}

export interface PdfEngineDocumentData {
  absolutePath: string;
  pages: PdfEnginePageData[];
}

export interface PdfEngineAdapter {
  readDocument(inputFilePath: string): Promise<PdfEngineDocumentData>;
}

function decodePdfEscapedString(input: string): string {
  return input
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function parseObjectMap(pdfText: string): Map<string, string> {
  const map = new Map<string, string>();
  const objectRegex = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
  let match: RegExpExecArray | null;
  while ((match = objectRegex.exec(pdfText)) !== null) {
    const objectKey = `${match[1]} ${match[2]}`;
    map.set(objectKey, match[3] ?? "");
  }
  return map;
}

function collectContentObjectRefs(pageObjectBody: string): string[] {
  const refs = new Set<string>();
  const directRef = /\/Contents\s+(\d+)\s+(\d+)\s+R/g;
  let match: RegExpExecArray | null;
  while ((match = directRef.exec(pageObjectBody)) !== null) {
    refs.add(`${match[1]} ${match[2]}`);
  }

  const arrayRef = /\/Contents\s*\[(.*?)\]/s.exec(pageObjectBody);
  if (arrayRef?.[1]) {
    const subRefRegex = /(\d+)\s+(\d+)\s+R/g;
    let subMatch: RegExpExecArray | null;
    while ((subMatch = subRefRegex.exec(arrayRef[1])) !== null) {
      refs.add(`${subMatch[1]} ${subMatch[2]}`);
    }
  }

  return [...refs];
}

function parseStreamBodyAsLatin1(objectBody: string): string {
  const streamMatch = /stream\r?\n([\s\S]*?)\r?\nendstream/s.exec(objectBody);
  if (!streamMatch?.[1]) return "";
  return streamMatch[1];
}

function decodeStreamIfNeeded(objectBody: string, streamBodyLatin1: string): string {
  const hasFlateDecode = /\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode[^\]]*\])/s.test(objectBody);
  if (!hasFlateDecode) return streamBodyLatin1;
  try {
    const inflated = inflateSync(Buffer.from(streamBodyLatin1, "latin1"));
    return inflated.toString("latin1");
  } catch {
    return streamBodyLatin1;
  }
}

function extractTextFromContentStreams(streams: string[]): string {
  const parts: string[] = [];
  for (const stream of streams) {
    const literalRegex = /\((?:\\.|[^\\)])*\)/g;
    let match: RegExpExecArray | null;
    while ((match = literalRegex.exec(stream)) !== null) {
      const raw = match[0];
      const text = decodePdfEscapedString(raw.slice(1, -1));
      if (text.trim()) parts.push(text);
    }
  }
  return normalizeText(parts.join(" "));
}

function countOperators(streams: string[]): OperatorStats {
  const totals = Object.fromEntries(OPERATORS.map((name) => [name, 0])) as OperatorStats;
  for (const stream of streams) {
    for (const operator of OPERATORS) {
      const regex = new RegExp(`\\b${operator}\\b`, "g");
      const matches = stream.match(regex);
      if (matches) totals[operator] += matches.length;
    }
  }
  return totals;
}

function buildVisualDensity(input: {
  streamLength: number;
  operatorStats: OperatorStats;
  hasImages: boolean;
  rawTextLength: number;
}): number {
  const vectorOps =
    input.operatorStats.re +
    input.operatorStats.m +
    input.operatorStats.l +
    input.operatorStats.c +
    input.operatorStats.f +
    input.operatorStats.S +
    input.operatorStats.B;
  const imageWeight = input.hasImages ? 90 : 0;
  const textWeight = Math.min(180, input.rawTextLength);
  const weighted = vectorOps * 2.4 + imageWeight + textWeight;
  const normalizer = Math.max(500, input.streamLength);
  return Number((weighted / normalizer).toFixed(4));
}

function buildVisualFingerprint(input: {
  streamLength: number;
  operatorStats: OperatorStats;
  hasImages: boolean;
  rawTextLength: number;
}): string {
  const buckets = [
    `stream:${Math.round(input.streamLength / 200)}`,
    `text:${Math.round(input.rawTextLength / 15)}`,
    `img:${input.hasImages ? 1 : 0}`,
    ...Object.entries(input.operatorStats).map(([key, value]) => `${key}:${Math.round(value / 3)}`)
  ];
  return buckets.join("|");
}

function hasSmallInkMarks(operatorStats: OperatorStats, streamLength: number): boolean {
  const inkOps = operatorStats.re + operatorStats.m + operatorStats.l + operatorStats.S + operatorStats.f;
  return inkOps > 0 && inkOps <= 6 && streamLength < 2200;
}

export class LightweightPdfEngineAdapter implements PdfEngineAdapter {
  async readDocument(inputFilePath: string): Promise<PdfEngineDocumentData> {
    const bytes = await readFile(inputFilePath);
    const pdfText = bytes.toString("latin1");
    const objectMap = parseObjectMap(pdfText);

    const pageEntries: Array<{ pageObjectId: string; body: string }> = [];
    for (const [objectId, body] of objectMap.entries()) {
      if (/\/Type\s*\/Page\b/.test(body) && !/\/Type\s*\/Pages\b/.test(body)) {
        pageEntries.push({ pageObjectId: objectId, body });
      }
    }

    const pages = pageEntries.map((pageEntry, index) => {
      const refs = collectContentObjectRefs(pageEntry.body);
      const decodedStreams = refs
        .map((ref) => objectMap.get(ref))
        .filter((value): value is string => typeof value === "string")
        .map((body) => {
          const rawStream = parseStreamBodyAsLatin1(body);
          return decodeStreamIfNeeded(body, rawStream);
        });

      const extractedText = extractTextFromContentStreams(decodedStreams);
      const rawTextLength = extractedText.length;
      const operatorStats = countOperators(decodedStreams);
      const hasImages = /\/Subtype\s*\/Image\b/.test(pageEntry.body);
      const streamLength = decodedStreams.reduce((sum, stream) => sum + stream.length, 0);
      const hasSmallMarks = hasSmallInkMarks(operatorStats, streamLength);
      const visualDensity = buildVisualDensity({
        streamLength,
        operatorStats,
        hasImages,
        rawTextLength
      });
      const visualFingerprint = buildVisualFingerprint({
        streamLength,
        operatorStats,
        hasImages,
        rawTextLength
      });

      return {
        pageNumber: index + 1,
        pageObjectId: pageEntry.pageObjectId,
        extractedText,
        rawTextLength,
        visualDensity,
        streamLength,
        hasImages,
        hasSmallMarks,
        operatorStats,
        textHash: sha1(extractedText || `page:${index + 1}:empty`),
        visualHash: sha1(visualFingerprint),
        visualFingerprint
      };
    });

    return {
      absolutePath: inputFilePath,
      pages
    };
  }
}
