import { basename } from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const TRANSCRIPTION_CACHE_ENABLED = !["0", "false", "no", "off"].includes(
  (process.env.TRANSCRIPTION_CACHE_ENABLED ?? "true").trim().toLowerCase()
);

function normalizeCacheToken(value?: string) {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return normalized.length > 0 ? normalized : "default";
}

function readOptionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function splitWhisperExtraArgs(value?: string) {
  if (!value?.trim()) return [];
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((entry) => entry.replace(/^(['"])(.*)\1$/, "$2"));
}

async function hashFileSha256(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function buildTranscriptionCachePath(input: {
  engine: "local" | "openai" | "assemblyai";
  model: string;
  language?: string;
  audioHash: string;
}) {
  const root = path.resolve(process.env.STORAGE_ROOT ?? "./storage", "transcriptions", "cache");
  const modelToken = normalizeCacheToken(input.model);
  const languageToken = normalizeCacheToken(input.language ?? "auto");
  const fileName = `v1-${input.engine}-${modelToken}-${languageToken}-${input.audioHash}.json`;
  return path.resolve(root, fileName);
}

async function readTranscriptionCache(cachePath: string): Promise<{ text: string; segments?: unknown } | null> {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as { text?: unknown; segments?: unknown };
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      segments: parsed.segments
    };
  } catch {
    return null;
  }
}

async function writeTranscriptionCache(
  cachePath: string,
  payload: {
    text: string;
    segments?: unknown;
    engine: "local" | "openai" | "assemblyai";
    model: string;
    language?: string;
  }
) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify(
      {
        ...payload,
        cachedAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf-8"
  );
}

async function transcribeWithLocalWhisper(input: {
  audioPath: string;
  language?: string;
  model?: string;
}): Promise<{ text: string; segments?: unknown }> {
  const whisperBin = process.env.WHISPER_BIN ?? "whisper";
  const ffmpegBin = process.env.FFMPEG_BIN;
  const model = input.model ?? process.env.WHISPER_MODEL ?? "base";
  const language = input.language?.trim() || readOptionalEnv("WHISPER_LANGUAGE");
  const device = readOptionalEnv("WHISPER_DEVICE");
  const fp16 = readOptionalEnv("WHISPER_FP16");
  const threads = readOptionalEnv("WHISPER_THREADS");
  const modelDir = path.resolve(process.env.WHISPER_MODEL_DIR ?? "./storage/models/whisper");
  const outputRootDir = path.resolve(process.env.STORAGE_ROOT ?? "./storage", "transcriptions", "raw");
  await mkdir(modelDir, { recursive: true });
  await mkdir(outputRootDir, { recursive: true });

  const base = path.basename(input.audioPath).replace(/[^a-zA-Z0-9._-]/g, "_");
  const outputBase = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`;
  const outputDir = path.resolve(outputRootDir, outputBase);
  await mkdir(outputDir, { recursive: true });
  const args = [
    input.audioPath,
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
  if (language) {
    args.push("--language", language);
  }
  if (device) {
    args.push("--device", device);
  }
  if (fp16) {
    args.push("--fp16", fp16);
  }
  if (threads) {
    args.push("--threads", threads);
  }
  args.push(...splitWhisperExtraArgs(process.env.WHISPER_EXTRA_ARGS));

  await new Promise<void>((resolve, reject) => {
    const mergedPath = ffmpegBin
      ? `${path.dirname(ffmpegBin)}${path.delimiter}${process.env.PATH ?? ""}`
      : process.env.PATH;
    const child = spawn(whisperBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: mergedPath,
        PYTHONIOENCODING: "utf-8"
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Whisper failed (${code}): ${stderr.trim()}`));
    });
  });

  const files = await readdir(outputDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  let newestJson: string | undefined;
  if (jsonFiles.length > 0) {
    const scored = await Promise.all(
      jsonFiles.map(async (file) => {
        const filePath = path.resolve(outputDir, file);
        const info = await stat(filePath);
        return {
          file,
          score: file.includes(base) ? 1 : 0,
          mtimeMs: info.mtimeMs
        };
      })
    );
    newestJson = scored.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)[0]?.file;
  }

  if (!newestJson) {
    throw new Error("Whisper finished but no JSON output was found.");
  }

  const raw = await readFile(path.resolve(outputDir, newestJson), "utf-8");
  const parsed = JSON.parse(raw) as { text?: string; segments?: unknown };
  return {
    text: parsed.text ?? "",
    segments: parsed.segments
  };
}

async function transcribeWithOpenAi(input: {
  audioPath: string;
  language?: string;
  model?: string;
  openaiApiKey?: string;
}): Promise<{ text: string; segments?: unknown }> {
  const configuredApiKey = process.env.OPENAI_API_KEY?.trim();
  const apiKey = input.openaiApiKey?.trim() || configuredApiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY ausente para transcricao online.");
  }

  const model = input.model ?? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe";
  let uploadPath = input.audioPath;
  let uploadName = basename(input.audioPath);
  let cleanupTmp: (() => Promise<void>) | null = null;

  // Alguns dumps UFDR trazem .opus inconsistente; tentamos tratar de forma resiliente.
  if (/\.opus$/i.test(input.audioPath)) {
    const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
    const tmpRoot = path.resolve(process.env.STORAGE_ROOT ?? os.tmpdir(), "tmp", "openai-audio");
    await mkdir(tmpRoot, { recursive: true });
    const tmpDir = await mkdtemp(path.join(tmpRoot, "transcode-"));
    const wavName = `${path.basename(input.audioPath).replace(/[^a-zA-Z0-9._-]/g, "_")}.wav`;
    const wavPath = path.resolve(tmpDir, wavName);
    const header = await readFile(input.audioPath).then((buf) => buf.subarray(0, 4)).catch(() => Buffer.alloc(0));
    const hasOggHeader = header.length >= 4 && header.toString("ascii") === "OggS";

    const tryFfmpeg = async (args: string[]) => {
      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        ffmpeg.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        ffmpeg.on("error", (error) => {
          reject(new Error(`Falha ao iniciar ffmpeg: ${error.message}`));
        });
        ffmpeg.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `ffmpeg exit ${code}`));
        });
      });
    };

    let converted = false;
    let lastFfmpegError: string | null = null;
    const attempts: string[][] = [
      ["-y", "-i", input.audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      ["-y", "-f", "ogg", "-i", input.audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      ["-y", "-f", "opus", "-i", input.audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      ["-y", "-fflags", "+discardcorrupt", "-err_detect", "ignore_err", "-i", input.audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]
    ];

    for (const args of attempts) {
      try {
        await tryFfmpeg(args);
        converted = true;
        break;
      } catch (error) {
        lastFfmpegError = error instanceof Error ? error.message : String(error);
      }
    }

    if (converted) {
      uploadPath = wavPath;
      uploadName = basename(wavPath);
      cleanupTmp = async () => {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } else if (hasOggHeader) {
      // Fallback: se for OGG válido, envia direto como .ogg (evita bloquear por transcode).
      uploadPath = input.audioPath;
      uploadName = basename(input.audioPath).replace(/\.opus$/i, ".ogg");
      cleanupTmp = async () => {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } else {
      const fileInfo = await stat(input.audioPath).catch(() => null);
      const detail = lastFfmpegError?.toLowerCase().includes("invalid data found when processing input")
        ? "conteudo invalido para decodificacao"
        : "falha de decodificacao";
      throw new Error(`Arquivo OPUS invalido/corrompido para transcricao (bytes=${fileInfo?.size ?? "N/D"}, ${detail}).`);
    }
  }

  const fileBuffer = await readFile(uploadPath);
  const file = new File([fileBuffer], uploadName, { type: "application/octet-stream" });
  const form = new FormData();
  form.append("file", file);
  form.append("model", model);
  if (input.language) {
    form.append("language", input.language);
  }

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const message =
        (parsed.error && typeof parsed.error === "object" && typeof (parsed.error as Record<string, unknown>).message === "string"
          ? ((parsed.error as Record<string, unknown>).message as string)
          : raw) || `OpenAI transcribe error ${response.status}`;
      throw new Error(message);
    }

    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      segments: parsed.segments
    };
  } finally {
    if (cleanupTmp) {
      await cleanupTmp();
    }
  }
}

async function transcribeWithAssemblyAi(input: {
  audioPath: string;
  language?: string;
  model?: string;
  assemblyAiApiKey?: string;
}): Promise<{ text: string; segments?: unknown }> {
  const configuredApiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
  const apiKey = input.assemblyAiApiKey?.trim() || configuredApiKey;
  if (!apiKey) {
    throw new Error("ASSEMBLYAI_API_KEY ausente para transcricao online.");
  }

  const model = input.model ?? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL ?? "best";
  const language = input.language?.trim() || undefined;
  const speechModels = normalizeAssemblySpeechModels(model);

  const uploadBuffer = await readFile(input.audioPath);
  const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/octet-stream"
    },
    body: uploadBuffer
  });

  const uploadRaw = await uploadResponse.text();
  let uploadParsed: Record<string, unknown> = {};
  try {
    uploadParsed = JSON.parse(uploadRaw) as Record<string, unknown>;
  } catch {
    uploadParsed = {};
  }

  if (!uploadResponse.ok) {
    const detail =
      typeof uploadParsed.error === "string"
        ? uploadParsed.error
        : uploadRaw || `AssemblyAI upload error ${uploadResponse.status}`;
    throw new Error(`AssemblyAI upload error ${uploadResponse.status}: ${detail}`);
  }

  const audioUrl = typeof uploadParsed.upload_url === "string" ? uploadParsed.upload_url : "";
  if (!audioUrl) {
    throw new Error("AssemblyAI nao retornou upload_url.");
  }

  const transcriptBody: Record<string, unknown> = {
    audio_url: audioUrl,
    speech_models: speechModels
  };
  if (language) {
    transcriptBody.language_code = language;
  }

  const createResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify(transcriptBody)
  });

  const createRaw = await createResponse.text();
  let createParsed: Record<string, unknown> = {};
  try {
    createParsed = JSON.parse(createRaw) as Record<string, unknown>;
  } catch {
    createParsed = {};
  }

  if (!createResponse.ok) {
    const detail =
      typeof createParsed.error === "string"
        ? createParsed.error
        : createRaw || `AssemblyAI create transcript error ${createResponse.status}`;
    throw new Error(`AssemblyAI create transcript error ${createResponse.status}: ${detail}`);
  }

  const transcriptId = typeof createParsed.id === "string" ? createParsed.id : "";
  if (!transcriptId) {
    throw new Error("AssemblyAI nao retornou id de transcricao.");
  }

  const pollingIntervalMs = Math.max(1000, Number(process.env.ASSEMBLYAI_POLL_INTERVAL_MS ?? 2000));
  const timeoutMs = Math.max(30_000, Number(process.env.ASSEMBLYAI_POLL_TIMEOUT_MS ?? 15 * 60 * 1000));
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const pollResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      method: "GET",
      headers: {
        authorization: apiKey
      }
    });
    const pollRaw = await pollResponse.text();
    let pollParsed: Record<string, unknown> = {};
    try {
      pollParsed = JSON.parse(pollRaw) as Record<string, unknown>;
    } catch {
      pollParsed = {};
    }

    if (!pollResponse.ok) {
      const detail =
        typeof pollParsed.error === "string"
          ? pollParsed.error
          : pollRaw || `AssemblyAI poll error ${pollResponse.status}`;
      throw new Error(`AssemblyAI poll error ${pollResponse.status}: ${detail}`);
    }

    const status = typeof pollParsed.status === "string" ? pollParsed.status.toLowerCase() : "";
    if (status === "completed") {
      return {
        text: typeof pollParsed.text === "string" ? pollParsed.text : "",
        segments: pollParsed.words
      };
    }
    if (status === "error") {
      const detail = typeof pollParsed.error === "string" ? pollParsed.error : "Falha de transcricao na AssemblyAI.";
      throw new Error(detail);
    }

    await new Promise((resolve) => setTimeout(resolve, pollingIntervalMs));
  }

  throw new Error("Timeout aguardando transcricao da AssemblyAI.");
}

function normalizeAssemblySpeechModels(model: string) {
  const raw = model.trim().toLowerCase();
  const mapped =
    raw === "best" || raw === "nano"
      ? "universal-2"
      : raw;
  const list = mapped
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ["universal-2"];
}

export async function transcribeWithWhisper(input: {
  audioPath: string;
  language?: string;
  engine?: "local" | "openai" | "assemblyai";
  model?: string;
  openaiApiKey?: string;
  assemblyAiApiKey?: string;
}): Promise<{ text: string; segments?: unknown }> {
  const engine = input.engine === "openai" || input.engine === "assemblyai" ? input.engine : "local";
  const model =
    input.model ??
    (engine === "openai"
      ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe"
      : engine === "assemblyai"
        ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL ?? "best"
      : process.env.WHISPER_MODEL ?? "base");
  const language = input.language?.trim() || (engine === "local" ? readOptionalEnv("WHISPER_LANGUAGE") : undefined);

  let cachePath: string | undefined;
  if (TRANSCRIPTION_CACHE_ENABLED) {
    const audioHash = await hashFileSha256(input.audioPath).catch(() => "");
    if (audioHash) {
      cachePath = buildTranscriptionCachePath({
        engine,
        model,
        language,
        audioHash
      });
      const cached = await readTranscriptionCache(cachePath);
      if (cached) {
        return cached;
      }
    }
  }

  const result =
    engine === "openai"
      ? await transcribeWithOpenAi({
          audioPath: input.audioPath,
          openaiApiKey: input.openaiApiKey,
          model,
          language
        })
      : engine === "assemblyai"
        ? await transcribeWithAssemblyAi({
            audioPath: input.audioPath,
            assemblyAiApiKey: input.assemblyAiApiKey,
            model,
            language
          })
      : await transcribeWithLocalWhisper({
          audioPath: input.audioPath,
          model,
          language
        });

  if (cachePath) {
    await writeTranscriptionCache(cachePath, {
      text: result.text,
      segments: result.segments,
      engine,
      model,
      language
    }).catch(() => undefined);
  }

  return result;
}
