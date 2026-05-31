import { spawn } from "node:child_process";

export async function runOcr(input: { sourcePath: string; language?: string }): Promise<{ text: string; confidence?: number }> {
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
