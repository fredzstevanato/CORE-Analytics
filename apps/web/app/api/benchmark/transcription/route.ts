import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import crypto from "node:crypto";
import { getAppSettingValue } from "@core/cases";
import { resolveAttachmentAbsolutePath } from "@/lib/attachment-file";

export const runtime = "nodejs";

const requestSchema = z.object({
  attachmentIds: z.array(z.string().uuid()).min(1).max(50),
  openaiModel: z.string().min(1).optional(),
  runLocal: z.boolean().optional(),
  runApi: z.boolean().optional(),
  openaiApiKey: z.string().min(20).optional()
});

function ensureOpenAiEnv() {
  if (process.env.OPENAI_API_KEY) return;
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
    path.resolve(process.cwd(), "..", "..", ".env")
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    dotenvConfig({ path: file });
    if (process.env.OPENAI_API_KEY) return;
  }
}

function resolveFfprobeBin() {
  const explicit = process.env.FFPROBE_BIN;
  if (explicit && explicit.trim().length > 0) return explicit;
  const ffmpeg = process.env.FFMPEG_BIN;
  if (!ffmpeg) return "ffprobe";
  const dir = path.dirname(ffmpeg);
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.resolve(dir, `ffprobe${ext}`);
}

async function probeDurationSeconds(filePath: string): Promise<number | null> {
  const ffprobeBin = resolveFfprobeBin();
  return new Promise((resolve) => {
    const child = spawn(ffprobeBin, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const n = Number(stdout.trim());
      if (!Number.isFinite(n) || n <= 0) return resolve(null);
      resolve(n);
    });
  });
}

async function runLocalWhisper(filePath: string): Promise<{ seconds: number; text: string }> {
  const whisperBin = process.env.WHISPER_BIN ?? "whisper";
  const ffmpegBin = process.env.FFMPEG_BIN;
  const model = process.env.WHISPER_MODEL ?? "base";
  const modelDir = path.resolve(process.env.WHISPER_MODEL_DIR ?? "./storage/models/whisper");
  const outputRootDir = path.resolve(process.env.STORAGE_ROOT ?? "./storage", "transcriptions", "benchmark");
  const outputDir = path.resolve(outputRootDir, `${Date.now()}-${crypto.randomUUID()}`);
  await mkdir(outputDir, { recursive: true });
  const args = [
    filePath,
    "--model",
    model,
    "--model_dir",
    modelDir,
    "--output_dir",
    outputDir,
    "--output_format",
    "json",
    "--verbose",
    "False"
  ];

  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const mergedPath = ffmpegBin ? `${path.dirname(ffmpegBin)}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH;
    const child = spawn(whisperBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: mergedPath,
        PYTHONIOENCODING: "utf-8"
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Whisper local failed (${code}): ${stderr.trim()}`));
    });
  });
  const seconds = (Date.now() - started) / 1000;
  const files = await readdir(outputDir);
  const jsonFiles = files.filter((file) => file.endsWith(".json"));
  const jsonFile = jsonFiles[0];
  if (!jsonFile) {
    return { seconds, text: "" };
  }
  const raw = await readFile(path.resolve(outputDir, jsonFile), "utf-8");
  const parsed = JSON.parse(raw) as { text?: string };
  return { seconds, text: parsed.text ?? "" };
}

async function runOpenAiApi(filePath: string, model: string, apiKey: string): Promise<{ seconds: number; text: string }> {
  const supported = new Set([".flac", ".m4a", ".mp3", ".mp4", ".mpeg", ".mpga", ".oga", ".ogg", ".wav", ".webm"]);
  const extension = path.extname(filePath).toLowerCase();
  const needsTranscode = !supported.has(extension) || extension === ".opus";

  let uploadPath = filePath;
  let uploadName = path.basename(filePath);
  let tempOutputPath: string | null = null;

  if (needsTranscode) {
    const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
    tempOutputPath = path.resolve(tmpdir(), `benchmark-${crypto.randomUUID()}.wav`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegBin, ["-y", "-i", filePath, "-ac", "1", "-ar", "16000", tempOutputPath as string], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Falha ao converter audio para OpenAI (${code}): ${stderr.trim()}`));
      });
    });
    uploadPath = tempOutputPath;
    uploadName = `${path.basename(filePath, extension)}.wav`;
  }

  const bytes = await readFile(uploadPath);
  const form = new FormData();
  form.append("model", model);
  form.append("response_format", "json");
  form.append("file", new Blob([bytes], { type: "audio/wav" }), uploadName);
  const started = Date.now();
  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const raw = await response.text();
    let parsed: { text?: string; error?: { message?: string } } | null = null;
    try {
      parsed = JSON.parse(raw) as { text?: string; error?: { message?: string } };
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const message = parsed?.error?.message ?? raw?.trim() ?? `OpenAI API error ${response.status}`;
      throw new Error(message);
    }
    const text = parsed?.text ?? raw?.trim() ?? "";
    return {
      seconds: (Date.now() - started) / 1000,
      text
    };
  } finally {
    if (tempOutputPath) {
      try {
        await unlink(tempOutputPath);
      } catch {
        // no-op
      }
    }
  }
}

export async function POST(request: Request) {
  try {
    ensureOpenAiEnv();
    const body = requestSchema.parse(await request.json());
    const resolvedFiles: Array<{ attachmentId: string; absolutePath: string; fileName: string; sizeBytes: number }> = [];

    for (const attachmentId of body.attachmentIds) {
      const resolved = await resolveAttachmentAbsolutePath(attachmentId);
      if ("error" in resolved) continue;
      const info = await stat(resolved.absolutePath);
      resolvedFiles.push({
        attachmentId,
        absolutePath: resolved.absolutePath,
        fileName: resolved.fileName,
        sizeBytes: Number(info.size)
      });
    }

    if (resolvedFiles.length === 0) {
      return NextResponse.json({ error: "Nenhum anexo selecionado foi resolvido para benchmark." }, { status: 409 });
    }

    const runLocal = body.runLocal ?? true;
    const runApi = body.runApi ?? true;
    const localWhisperModel = process.env.WHISPER_MODEL ?? "base";
    const openaiModel = body.openaiModel ?? process.env.BENCH_OPENAI_MODEL ?? "whisper-1";
    const configuredApiKey = (await getAppSettingValue("OPENAI_API_KEY"))?.trim();
    const openaiApiKey = body.openaiApiKey?.trim() || configuredApiKey || process.env.OPENAI_API_KEY;

    const durations = await Promise.all(resolvedFiles.map((row) => probeDurationSeconds(row.absolutePath)));
    const totalMinutes = durations.reduce<number>((sum, value) => sum + (value ?? 0), 0) / 60;
    const totalSizeBytes = resolvedFiles.reduce((sum, row) => sum + row.sizeBytes, 0);

    const localBefore = process.memoryUsage().rss;
    const localTimes: number[] = [];
    const localTimeByAttachment = new Map<string, number>();
    const localTexts = new Map<string, string>();
    if (runLocal) {
      for (const row of resolvedFiles) {
        const localResult = await runLocalWhisper(row.absolutePath);
        localTimes.push(localResult.seconds);
        localTimeByAttachment.set(row.attachmentId, localResult.seconds);
        localTexts.set(row.attachmentId, localResult.text);
      }
    }
    const localAfter = process.memoryUsage().rss;

    const apiTimes: number[] = [];
    const apiTimeByAttachment = new Map<string, number>();
    const apiTexts = new Map<string, string>();
    let apiError: string | null = null;
    if (runApi && openaiApiKey) {
      for (const row of resolvedFiles) {
        try {
          const apiResult = await runOpenAiApi(row.absolutePath, openaiModel, openaiApiKey);
          apiTimes.push(apiResult.seconds);
          apiTimeByAttachment.set(row.attachmentId, apiResult.seconds);
          apiTexts.set(row.attachmentId, apiResult.text);
        } catch (error) {
          apiError = error instanceof Error ? error.message : "Falha na API OpenAI.";
          break;
        }
      }
    } else if (runApi) {
      apiError = "OPENAI_API_KEY ausente (configure em Configuracoes).";
    }

    const localTotalSeconds = localTimes.reduce((a, b) => a + b, 0);
    const apiTotalSeconds = apiTimes.reduce((a, b) => a + b, 0);

    const pricing = {
      whisper1: 0.006,
      gpt4oTranscribe: 0.006,
      gpt4oMiniTranscribe: 0.003
    };

    return NextResponse.json({
      sampleCount: resolvedFiles.length,
      files: resolvedFiles.map((row) => ({
        attachmentId: row.attachmentId,
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
        localText: localTexts.get(row.attachmentId) ?? "",
        apiText: apiTexts.get(row.attachmentId) ?? "",
        localSeconds: localTimeByAttachment.get(row.attachmentId) ?? null,
        apiSeconds: apiTimeByAttachment.get(row.attachmentId) ?? null
      })),
      totals: {
        totalMinutes,
        totalSizeMB: totalSizeBytes / (1024 * 1024)
      },
      local: {
        engine: `whisper-local:${localWhisperModel}`,
        totalSeconds: localTotalSeconds,
        avgSecondsPerFile: localTotalSeconds / Math.max(1, localTimes.length),
        rssBeforeMB: localBefore / (1024 * 1024),
        rssAfterMB: localAfter / (1024 * 1024),
        rssDeltaMB: (localAfter - localBefore) / (1024 * 1024)
      },
      api: {
        engine: `openai:${openaiModel}`,
        model: openaiModel,
        totalSeconds: apiTotalSeconds,
        avgSecondsPerFile: apiTotalSeconds / Math.max(1, apiTimes.length),
        error: apiError
      },
      costEstimateUsd: {
        whisper1: totalMinutes * pricing.whisper1,
        gpt4oTranscribe: totalMinutes * pricing.gpt4oTranscribe,
        gpt4oMiniTranscribe: totalMinutes * pricing.gpt4oMiniTranscribe
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao executar benchmark."
      },
      { status: 500 }
    );
  }
}
