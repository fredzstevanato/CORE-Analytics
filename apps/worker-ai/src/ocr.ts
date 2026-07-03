import { spawn } from "node:child_process";

export async function runOcr(input: { sourcePath: string; language?: string }): Promise<{ text: string; confidence?: number }> {
  const languages = Array.from(new Set([input.language, "eng", undefined]));
  let lastError: unknown;
  for (const language of languages) {
    try {
      return await runTesseract({ sourcePath: input.sourcePath, language });
    } catch (error) {
      lastError = error;
      if (!isMissingLanguageError(error)) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("OCR failed.");
}

function runTesseract(input: { sourcePath: string; language?: string }): Promise<{ text: string; confidence?: number }> {
  const tesseractBin = process.env.TESSERACT_BIN ?? "tesseract";
  const args = [input.sourcePath, "stdout"];
  if (input.language) {
    args.push("-l", input.language);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(tesseractBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ text: stdout.trim(), confidence: undefined });
      } else {
        reject(new Error(`OCR failed (${code}): ${stderr.trim()}`));
      }
    });
  });
}

function isMissingLanguageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /failed loading language|couldn't load any languages|error opening data file/i.test(error.message);
}
