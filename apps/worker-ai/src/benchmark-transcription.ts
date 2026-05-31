import "./load-env.js";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { transcribeWithWhisper } from "./whisper.js";

const AUDIO_EXTENSIONS = new Set([".aac", ".amr", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".wma"]);
const API_MAX_FILE_SIZE = 25 * 1024 * 1024;

type BenchMode = "both" | "local" | "api";

type BenchResult = {
  mode: "local" | "api";
  sampleCount: number;
  avgSecondsPerFile: number;
  wallSeconds: number;
  ok: number;
  failed: number;
};

type CostEstimate = {
  totalMinutes: number;
  whisper1Usd: number;
  gpt4oTranscribeUsd: number;
  gpt4oMiniTranscribeUsd: number;
};

function parseArg(name: string): string | undefined {
  const idx = process.argv.findIndex((arg) => arg === `--${name}`);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function parseIntArg(name: string, fallback: number) {
  const raw = parseArg(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parseMode(): BenchMode {
  const raw = (parseArg("mode") ?? "both").toLowerCase();
  if (raw === "local") return "local";
  if (raw === "api") return "api";
  return "both";
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const value = Number(stdout.trim());
      if (!Number.isFinite(value) || value <= 0) return resolve(null);
      resolve(value);
    });
  });
}

async function estimateAudioMinutes(files: string[]): Promise<{ totalMinutes: number; measuredFiles: number }> {
  let totalSeconds = 0;
  let measuredFiles = 0;
  for (const file of files) {
    const seconds = await probeDurationSeconds(file);
    if (seconds && Number.isFinite(seconds) && seconds > 0) {
      totalSeconds += seconds;
      measuredFiles += 1;
    }
  }
  return {
    totalMinutes: totalSeconds / 60,
    measuredFiles
  };
}

function estimateUsdCost(totalMinutes: number): CostEstimate {
  const whisper1 = 0.006;
  const gpt4oTranscribe = 0.006;
  const gpt4oMini = 0.003;
  return {
    totalMinutes,
    whisper1Usd: totalMinutes * whisper1,
    gpt4oTranscribeUsd: totalMinutes * gpt4oTranscribe,
    gpt4oMiniTranscribeUsd: totalMinutes * gpt4oMini
  };
}

async function listAudioFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAudioFilesRecursive(full)));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) files.push(full);
  }
  return files;
}

async function runLocalBenchmark(sample: string[]): Promise<BenchResult> {
  const started = Date.now();
  let ok = 0;
  let failed = 0;
  const elapsedEach: number[] = [];

  for (const file of sample) {
    const start = Date.now();
    try {
      await transcribeWithWhisper({ audioPath: file });
      ok += 1;
      elapsedEach.push((Date.now() - start) / 1000);
    } catch {
      failed += 1;
    }
  }

  const wallSeconds = (Date.now() - started) / 1000;
  const avgSecondsPerFile = elapsedEach.length > 0 ? elapsedEach.reduce((a, b) => a + b, 0) / elapsedEach.length : 0;
  return {
    mode: "local",
    sampleCount: sample.length,
    avgSecondsPerFile,
    wallSeconds,
    ok,
    failed
  };
}

async function transcribeWithOpenAiApi(filePath: string, model: string, apiKey: string) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([bytes]), path.basename(filePath));

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  const payload = (await response.json()) as { text?: string; error?: { message?: string } };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }
  return payload.text ?? "";
}

async function runApiBenchmark(sample: string[], apiConcurrency: number): Promise<BenchResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY nao definido para benchmark de API.");
  }
  const apiKeyValue = apiKey;
  const model = process.env.BENCH_OPENAI_MODEL ?? "gpt-4o-mini-transcribe";

  const started = Date.now();
  let ok = 0;
  let failed = 0;
  const elapsedEach: number[] = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= sample.length) return;
      const file = sample[current] as string;

      const start = Date.now();
      try {
        await transcribeWithOpenAiApi(file, model, apiKeyValue);
        ok += 1;
        elapsedEach.push((Date.now() - start) / 1000);
      } catch {
        failed += 1;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, apiConcurrency) }, () => worker());
  await Promise.all(workers);

  const wallSeconds = (Date.now() - started) / 1000;
  const avgSecondsPerFile = elapsedEach.length > 0 ? elapsedEach.reduce((a, b) => a + b, 0) / elapsedEach.length : 0;
  return {
    mode: "api",
    sampleCount: sample.length,
    avgSecondsPerFile,
    wallSeconds,
    ok,
    failed
  };
}

function formatProjection(result: BenchResult, totalFiles: number) {
  if (result.ok === 0 || result.avgSecondsPerFile <= 0) return "indisponivel";
  const projectedSeconds = result.avgSecondsPerFile * totalFiles;
  const projectedMinutes = projectedSeconds / 60;
  const projectedHours = projectedMinutes / 60;
  return `${projectedMinutes.toFixed(1)} min (~${projectedHours.toFixed(2)} h)`;
}

async function main() {
  const dir = parseArg("dir");
  if (!dir) {
    throw new Error("Uso: --dir <pasta-audios> [--sample 20] [--mode both|local|api] [--api-concurrency 5]");
  }

  const mode = parseMode();
  const sampleSize = parseIntArg("sample", 20);
  const apiConcurrency = parseIntArg("api-concurrency", 5);
  const allAudio = (await listAudioFilesRecursive(path.resolve(dir))).sort();
  if (allAudio.length === 0) {
    throw new Error("Nenhum audio encontrado na pasta informada.");
  }

  const sampleRaw = allAudio.slice(0, Math.min(sampleSize, allAudio.length));
  const sampleForApi: string[] = [];
  for (const file of sampleRaw) {
    const info = await stat(file);
    if (info.size <= API_MAX_FILE_SIZE) sampleForApi.push(file);
  }

  console.log("=== Benchmark Transcricao ===");
  console.log(`Pasta: ${path.resolve(dir)}`);
  console.log(`Total de audios encontrados: ${allAudio.length}`);
  console.log(`Amostra solicitada: ${sampleSize}`);
  console.log(`Amostra local: ${sampleRaw.length}`);
  console.log(`Amostra API (<=25MB): ${sampleForApi.length}`);

  console.log("Medindo duracao total do lote via ffprobe...");
  const duration = await estimateAudioMinutes(allAudio);
  const cost = estimateUsdCost(duration.totalMinutes);

  const results: BenchResult[] = [];

  if (mode === "both" || mode === "local") {
    console.log("Executando benchmark LOCAL...");
    const local = await runLocalBenchmark(sampleRaw);
    results.push(local);
  }

  if ((mode === "both" || mode === "api") && sampleForApi.length > 0) {
    console.log(`Executando benchmark API com concorrencia ${apiConcurrency}...`);
    const api = await runApiBenchmark(sampleForApi, apiConcurrency);
    results.push(api);
  }

  console.log("");
  console.log("=== Resultado ===");
  for (const result of results) {
    console.log(`[${result.mode.toUpperCase()}] ok=${result.ok} fail=${result.failed}`);
    console.log(`avg/file: ${result.avgSecondsPerFile.toFixed(2)} s`);
    console.log(`wall: ${result.wallSeconds.toFixed(2)} s`);
    console.log(`projecao para ${allAudio.length} audios: ${formatProjection(result, allAudio.length)}`);
    console.log("");
  }

  console.log("=== Custo Estimado (API) ===");
  console.log(`Arquivos com duracao medida: ${duration.measuredFiles}/${allAudio.length}`);
  console.log(`Minutos totais estimados: ${cost.totalMinutes.toFixed(2)} min`);
  console.log(`whisper-1 (US$0.006/min): US$ ${cost.whisper1Usd.toFixed(2)}`);
  console.log(`gpt-4o-transcribe (US$0.006/min): US$ ${cost.gpt4oTranscribeUsd.toFixed(2)}`);
  console.log(`gpt-4o-mini-transcribe (US$0.003/min): US$ ${cost.gpt4oMiniTranscribeUsd.toFixed(2)}`);
}

main().catch((error) => {
  console.error(`benchmark.error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
