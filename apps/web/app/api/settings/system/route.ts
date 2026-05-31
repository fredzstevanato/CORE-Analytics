import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(process.cwd(), "..", "..");
const ENV_PATH = path.resolve(PROJECT_ROOT, ".env");

const EDITABLE_ENV_KEYS = [
  "STORAGE_ROOT",
  "UFDR_SOURCE_ROOT",
  "WHISPER_BIN",
  "WHISPER_MODEL",
  "WHISPER_MODEL_DIR",
  "FFMPEG_BIN",
  "TESSERACT_BIN",
  "SEVEN_Z_BIN",
  "PDF_OCR_COMMAND",
  "PDF_OCR_COMMAND_ARGS",
  "PDF_OCR_LANGUAGE",
  "REPORT_XML_MAX_BYTES",
  "REPORT_XML_MAX_STRING_BYTES",
  "UFDR_FORCE_XML_STREAM",
  "UFDR_XML_STREAM_MIN_FILES",
  "UFDR_XML_IN_MEMORY_MAX_CHARS",
  "UFDR_AUDIO_MAX_FILES",
  "UFDR_AUDIO_EXTRACTION_TIMEOUT_MS",
  "UFDR_AUDIO_ENTRY_TIMEOUT_MS",
  "UFDR_AUDIO_RECOVERY_BATCH_SIZE",
  "UFDR_AUDIO_RECOVERY_BATCH_TIMEOUT_MS",
  "UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY",
  "UFDR_STALE_PROCESSING_TIMEOUT_MS",
  "UFDR_STALE_PENDING_TIMEOUT_MS",
  "UFDR_STALE_WATCHDOG_INTERVAL_MS",
  "WORKER_LOG_HEARTBEAT_SECONDS",
  "AI_TRANSCRIPTION_WORKER_CONCURRENCY",
  "AI_TRANSCRIPTION_LOCK_DURATION_SECONDS",
  "AI_TRANSCRIPTION_STALLED_INTERVAL_SECONDS",
  "AI_TRANSCRIPTION_MAX_STALLED_COUNT",
  "AI_TRANSCRIPTION_STALE_PROCESSING_SECONDS",
  "WORKER_LOG_LEVEL",
  "WORKER_INGEST_LOG_LEVEL",
  "WORKER_AI_LOG_LEVEL"
] as const;

type EditableEnvKey = (typeof EDITABLE_ENV_KEYS)[number];

type EnvEntry =
  | { type: "raw"; text: string }
  | { type: "variable"; key: string; value: string; prefix: string; quote: "'" | "\"" | null };

const updateSchema = z.object({
  targetOs: z.enum(["windows", "linux"]),
  values: z.record(z.string(), z.string().nullable())
});

function currentOs() {
  return process.platform === "win32" ? "windows" : "linux";
}

function splitEnvLine(line: string): EnvEntry {
  const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return { type: "raw", text: line };
  const rawValue = match[3] ?? "";
  const quote = rawValue.startsWith("\"") && rawValue.endsWith("\"") ? "\"" : rawValue.startsWith("'") && rawValue.endsWith("'") ? "'" : null;
  return {
    type: "variable",
    prefix: match[1] ?? "",
    key: match[2] ?? "",
    value: quote ? rawValue.slice(1, -1) : rawValue,
    quote
  };
}

async function readEnvFile() {
  const text = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf-8") : "";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const entries = lines.map(splitEnvLine);
  const values: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.type === "variable") values[entry.key] = entry.value;
  }
  return { text, newline, entries, values };
}

function needsQuoting(value: string) {
  return value.length === 0 || /\s|#/.test(value);
}

function formatEnvLine(key: string, value: string, quote: "'" | "\"" | null = null, prefix = "") {
  const selectedQuote = quote ?? (needsQuoting(value) ? "\"" : null);
  const escaped = selectedQuote === "\"" ? value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") : value;
  return `${prefix}${key}=${selectedQuote ? `${selectedQuote}${escaped}${selectedQuote}` : value}`;
}

function serializeEnv(entries: EnvEntry[], updates: Partial<Record<EditableEnvKey, string | null>>, newline: string) {
  const pending = new Map<string, string | null>();
  for (const key of EDITABLE_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) pending.set(key, updates[key] ?? null);
  }

  const nextLines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "variable" || !pending.has(entry.key)) {
      nextLines.push(entry.type === "raw" ? entry.text : formatEnvLine(entry.key, entry.value, entry.quote, entry.prefix));
      continue;
    }
    const value = pending.get(entry.key);
    pending.delete(entry.key);
    if (value == null) continue;
    nextLines.push(formatEnvLine(entry.key, value, entry.quote, entry.prefix));
  }

  const additions = [...pending.entries()].filter((entry): entry is [EditableEnvKey, string] => entry[1] !== null);
  if (additions.length > 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") nextLines.push("");
    nextLines.push("# System tuning managed by CORE Analytics UI");
    for (const [key, value] of additions) nextLines.push(formatEnvLine(key, value));
  }

  return nextLines.join(newline).replace(/\s+$/g, "") + newline;
}

async function detectDiskType() {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-Command", "Get-PhysicalDisk | Select-Object FriendlyName,MediaType,BusType,Size | ConvertTo-Json -Compress"],
        { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout || "[]") as unknown;
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
      const disks = rows.map((row) => ({
        name: String(row.FriendlyName ?? "Disco"),
        type: String(row.MediaType ?? "Unspecified"),
        busType: String(row.BusType ?? "Unknown"),
        sizeBytes: typeof row.Size === "number" ? row.Size : null
      }));
      const hasSsd = disks.some((disk) => /ssd|nvme/i.test(`${disk.type} ${disk.busType}`));
      const hasHdd = disks.some((disk) => /hdd|hard disk/i.test(disk.type));
      return { kind: hasSsd ? "ssd" : hasHdd ? "hdd" : "unknown", disks };
    } catch {
      return { kind: "unknown", disks: [] };
    }
  }

  try {
    const { stdout } = await execFileAsync("lsblk", ["-d", "-o", "NAME,ROTA,TYPE,TRAN,MODEL,SIZE", "-J"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(stdout || "{}") as { blockdevices?: Array<Record<string, unknown>> };
    const rows = Array.isArray(parsed.blockdevices) ? parsed.blockdevices : [];
    const disks = rows
      .filter((row) => row.type === "disk")
      .map((row) => ({
        name: String(row.name ?? "disk"),
        type: Number(row.rota) === 0 ? "SSD/NVMe" : "HDD",
        busType: String(row.tran ?? "unknown"),
        sizeBytes: null,
        size: String(row.size ?? "")
      }));
    const hasSsd = disks.some((disk) => /ssd|nvme|0/i.test(`${disk.type} ${disk.busType}`));
    const hasHdd = disks.some((disk) => /hdd/i.test(disk.type));
    return { kind: hasSsd ? "ssd" : hasHdd ? "hdd" : "unknown", disks };
  } catch {
    return { kind: "unknown", disks: [] };
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function buildPathDefaults(targetOs: "windows" | "linux") {
  if (targetOs === "windows") {
    return {
      STORAGE_ROOT: "D:/CORE-Analytics-storage",
      UFDR_SOURCE_ROOT: "D:/CORE-Analytics-ufdr-imports",
      WHISPER_BIN: "whisper",
      WHISPER_MODEL_DIR: "D:/CORE-Analytics-storage/models/whisper",
      FFMPEG_BIN: "ffmpeg",
      TESSERACT_BIN: "tesseract",
      SEVEN_Z_BIN: "7z",
      PDF_OCR_COMMAND: "powershell",
      PDF_OCR_COMMAND_ARGS:
        "-NoProfile -ExecutionPolicy Bypass -File {projectRoot}/scripts/ocrmypdf-portable.ps1 -InputFile {input} -OutputFile {output} -Pages {pages} -Language {lang}",
      exampleUfdrFolder: "C:\\laudos\\EXTRACTI.2026-0001",
      exampleUfdrFile: "C:\\laudos\\evidencia.ufdr"
    };
  }

  return {
    STORAGE_ROOT: "/var/lib/core-analytics/storage",
    UFDR_SOURCE_ROOT: "/mnt/evidencias",
    WHISPER_BIN: "whisper",
    WHISPER_MODEL_DIR: "/var/lib/core-analytics/storage/models/whisper",
    FFMPEG_BIN: "ffmpeg",
    TESSERACT_BIN: "tesseract",
    SEVEN_Z_BIN: "7z",
    PDF_OCR_COMMAND: "bash",
    PDF_OCR_COMMAND_ARGS:
      "-lc 'ocrmypdf --force-ocr --language {lang} --pages {pages} {input} {output}'",
    exampleUfdrFolder: "/mnt/ufdr/EXTRACTI.2026-0001",
    exampleUfdrFile: "/mnt/ufdr/evidencia.ufdr"
  };
}

function buildRecommendations(input: {
  targetOs: "windows" | "linux";
  cpuCount: number;
  totalMemoryBytes: number;
  diskKind: string;
}) {
  const memoryGb = input.totalMemoryBytes / 1024 ** 3;
  const diskMultiplier = input.diskKind === "ssd" ? 1 : 0.65;
  const transcriptionConcurrency = clamp(Math.min(input.cpuCount - 1, Math.floor(memoryGb / 2)) * diskMultiplier, 1, 16);
  const recoveryConcurrency = clamp(Math.min(4, Math.ceil(input.cpuCount / 6)) * diskMultiplier, 1, 4);
  const recoveryBatchSize = input.diskKind === "ssd" ? 350 : 150;
  const streamMinFiles = input.diskKind === "ssd" ? 30000 : 12000;
  const xmlMemoryChars = memoryGb >= 32 ? 16000000 : memoryGb >= 16 ? 10000000 : 6000000;
  const model = memoryGb >= 32 && input.cpuCount >= 12 ? "small" : "base";
  const paths = buildPathDefaults(input.targetOs);

  return {
    profile:
      memoryGb >= 32 && input.cpuCount >= 12 && input.diskKind === "ssd"
        ? "alta_performance"
        : memoryGb >= 16 && input.cpuCount >= 8
          ? "equilibrado"
          : "conservador",
    values: {
      ...paths,
      WHISPER_MODEL: model,
      UFDR_FORCE_XML_STREAM: "true",
      UFDR_XML_STREAM_MIN_FILES: String(streamMinFiles),
      UFDR_XML_IN_MEMORY_MAX_CHARS: String(xmlMemoryChars),
      UFDR_AUDIO_EXTRACTION_TIMEOUT_MS: "900000",
      UFDR_AUDIO_ENTRY_TIMEOUT_MS: "60000",
      UFDR_AUDIO_RECOVERY_BATCH_SIZE: String(recoveryBatchSize),
      UFDR_AUDIO_RECOVERY_BATCH_TIMEOUT_MS: "1800000",
      UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY: String(recoveryConcurrency),
      UFDR_STALE_PROCESSING_TIMEOUT_MS: "2700000",
      UFDR_STALE_PENDING_TIMEOUT_MS: "600000",
      UFDR_STALE_WATCHDOG_INTERVAL_MS: "120000",
      WORKER_LOG_HEARTBEAT_SECONDS: "30",
      AI_TRANSCRIPTION_WORKER_CONCURRENCY: String(transcriptionConcurrency),
      AI_TRANSCRIPTION_LOCK_DURATION_SECONDS: "180",
      AI_TRANSCRIPTION_STALLED_INTERVAL_SECONDS: "45",
      AI_TRANSCRIPTION_MAX_STALLED_COUNT: "3",
      AI_TRANSCRIPTION_STALE_PROCESSING_SECONDS: "360"
    }
  };
}

async function buildPayload(targetOs: "windows" | "linux" = currentOs()) {
  const env = await readEnvFile();
  const editableEnv = Object.fromEntries(EDITABLE_ENV_KEYS.map((key) => [key, env.values[key]]));
  const disk = await detectDiskType();
  const cpuCount = os.cpus().length;
  const recommendations = buildRecommendations({
    targetOs,
    cpuCount,
    totalMemoryBytes: os.totalmem(),
    diskKind: disk.kind
  });

  return {
    envPath: ENV_PATH,
    editableKeys: EDITABLE_ENV_KEYS,
    currentOs: currentOs(),
    targetOs,
    env: editableEnv,
    hardware: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpuModel: os.cpus()[0]?.model ?? "N/D",
      cpuCount,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      disk
    },
    recommendations
  };
}

export async function GET(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    if (auth.session.role !== "ADMIN") {
      return NextResponse.json({ error: "Acesso restrito a administradores." }, { status: 403 });
    }

    const url = new URL(request.url);
    const targetOs = url.searchParams.get("targetOs") === "linux" ? "linux" : url.searchParams.get("targetOs") === "windows" ? "windows" : currentOs();
    return NextResponse.json(await buildPayload(targetOs));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao carregar configuracao do sistema." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    if (auth.session.role !== "ADMIN") {
      return NextResponse.json({ error: "Acesso restrito a administradores." }, { status: 403 });
    }

    const parsed = updateSchema.parse(await request.json());
    const allowed = new Set<string>(EDITABLE_ENV_KEYS);
    const updates: Partial<Record<EditableEnvKey, string | null>> = {};
    for (const [key, value] of Object.entries(parsed.values)) {
      if (!allowed.has(key)) continue;
      updates[key as EditableEnvKey] = value === null || value.trim() === "" ? null : value.trim();
    }

    const env = await readEnvFile();
    const next = serializeEnv(env.entries, updates, env.newline);
    const backupPath = `${ENV_PATH}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    if (existsSync(ENV_PATH)) await copyFile(ENV_PATH, backupPath);

    const tempPath = `${ENV_PATH}.${randomUUID()}.tmp`;
    await writeFile(tempPath, next, "utf-8");
    await rename(tempPath, ENV_PATH);

    for (const [key, value] of Object.entries(updates)) {
      if (value === null) delete process.env[key];
      else process.env[key] = value;
    }

    return NextResponse.json({
      ...(await buildPayload(parsed.targetOs)),
      saved: true,
      backupPath: existsSync(backupPath) ? backupPath : null,
      restartRequired: true
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao salvar configuracao do sistema." },
      { status: 500 }
    );
  }
}
