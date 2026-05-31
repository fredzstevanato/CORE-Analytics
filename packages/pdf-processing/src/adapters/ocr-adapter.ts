import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { sanitizeOutputFileName } from "../utils/temp-files";
import type { PdfProcessingConfig, PdfOcrResult } from "../types/pdf-types";

export interface OcrAdapterInput {
  inputFilePath: string;
  outputDir: string;
  outputFileName: string;
  pagesToOcr: number[];
  language: string;
}

export interface OcrAdapter {
  performSelectiveOcr(input: OcrAdapterInput): Promise<PdfOcrResult>;
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`OCR command exited with code ${code}: ${stderr.join("").trim()}`));
    });
  });
}

export class NoopOcrAdapter implements OcrAdapter {
  async performSelectiveOcr(input: OcrAdapterInput): Promise<PdfOcrResult> {
    return {
      attempted: false,
      applied: false,
      pagesRequested: input.pagesToOcr,
      pagesProcessed: [],
      warnings: ["OCR adapter is disabled. Returning analysis-only output."]
    };
  }
}

export class CommandOcrAdapter implements OcrAdapter {
  constructor(private readonly command: string, private readonly commandArgs: string[] = []) {}

  async performSelectiveOcr(input: OcrAdapterInput): Promise<PdfOcrResult> {
    await mkdir(input.outputDir, { recursive: true });
    const outputFileName = sanitizeOutputFileName(input.outputFileName);
    const outputPath = path.resolve(input.outputDir, outputFileName);

    const pagesCsv = input.pagesToOcr.join(",");
    const substitutedArgs = this.commandArgs.map((arg) =>
      arg
        .replaceAll("{input}", input.inputFilePath)
        .replaceAll("{output}", outputPath)
        .replaceAll("{pages}", pagesCsv)
        .replaceAll("{lang}", input.language)
        .replaceAll("{projectRoot}", process.cwd())
    );

    if (!substitutedArgs.some((arg) => arg.includes(outputPath))) {
      substitutedArgs.push(input.inputFilePath, outputPath);
    }

    await runProcess(this.command, substitutedArgs);
    return {
      attempted: true,
      applied: true,
      pagesRequested: input.pagesToOcr,
      pagesProcessed: input.pagesToOcr,
      processedFilePath: outputPath,
      warnings: []
    };
  }
}

export function createOcrAdapter(config: PdfProcessingConfig): OcrAdapter {
  if (!config.ocr.enabled) return new NoopOcrAdapter();
  if (!config.ocr.command) return new NoopOcrAdapter();
  return new CommandOcrAdapter(config.ocr.command, config.ocr.commandArgs ?? []);
}
