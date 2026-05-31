import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

export async function ensureDirectory(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export function sanitizeOutputFileName(input: string): string {
  const base = input.replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.length > 0 ? base : "processed.pdf";
}

export async function safeFileSize(filePath: string): Promise<number | undefined> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return undefined;
  return Number(info.size);
}
