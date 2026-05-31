import path from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@core/db";
import { estimateAudioCostUsd, estimateTextCostUsd } from "@/lib/ai-estimation";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z
  .object({
    engine: z.enum(["local", "openai", "assemblyai"]).optional(),
    model: z.string().min(1).optional(),
    aiEngine: z.enum(["local", "openai"]).optional(),
    aiModel: z.string().min(1).optional()
  })
  .optional();

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
      const n = Number(stdout.trim());
      if (!Number.isFinite(n) || n <= 0) return resolve(null);
      resolve(n);
    });
  });
}

function estimateLocalRealtimeFactor(model: string) {
  const key = model.toLowerCase();
  if (key.includes("tiny")) return 8;
  if (key.includes("base")) return 5;
  if (key.includes("small")) return 3;
  if (key.includes("medium")) return 1.8;
  if (key.includes("large")) return 1;
  return 2.5;
}

const OPUS_EXT_RE = /\.opus$/i;

function isWhatsAppOpusAttachment(input: {
  fileName?: string | null;
  archivePath?: string | null;
  sourceApp?: string | null;
}) {
  const sourceApp = (input.sourceApp ?? "").trim().toLowerCase();
  if (!sourceApp.includes("whatsapp")) return false;
  const ref = (input.fileName ?? input.archivePath ?? "").trim();
  return OPUS_EXT_RE.test(ref);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const engine = body?.engine ?? "local";
    const model =
      body?.model?.trim() ||
      (engine === "openai"
        ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
        : engine === "assemblyai"
          ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL || "best"
        : process.env.WHISPER_MODEL || "base");
    const aiEngine = body?.aiEngine ?? "local";
    const aiModel =
      body?.aiModel?.trim() ||
      (aiEngine === "openai"
        ? process.env.OPENAI_INVESTIGATION_ANALYSIS_MODEL || "gpt-4.1-mini"
        : "local-heuristic-v1");

    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      select: { id: true, caseId: true, fileName: true }
    });
    if (!evidence) {
      return NextResponse.json({ error: "Evidencia nao encontrada." }, { status: 404 });
    }

    const rawAttachments = await prisma.attachment.findMany({
      where: {
        evidenceId: evidence.id
      },
      select: {
        id: true,
        path: true,
        fileName: true,
        mimeType: true,
        archivePath: true,
        sizeBytes: true,
        message: {
          select: {
            chat: {
              select: {
                sourceApp: true
              }
            }
          }
        }
      }
    });
    const attachments = rawAttachments.filter((row) =>
      isWhatsAppOpusAttachment({
        fileName: row.fileName,
        archivePath: row.archivePath,
        sourceApp: row.message?.chat?.sourceApp
      })
    );

    const durations = await Promise.all(
      attachments.map(async (row) => ({
        id: row.id,
        durationSec: row.path ? await probeDurationSeconds(row.path) : null
      }))
    );

    const totalDurationSec = durations.reduce((sum, row) => sum + (row.durationSec ?? 0), 0);
    const resolvedDurationFiles = durations.filter((row) => typeof row.durationSec === "number").length;
    const totalMinutes = totalDurationSec / 60;
    const totalSizeBytes = attachments.reduce((sum, row) => sum + Number(row.sizeBytes ?? 0n), 0);

    const estimatedOutputTokens = Math.round(totalDurationSec * 3);
    const estimatedTimeSeconds =
      engine === "openai"
        ? Math.round(totalDurationSec * 0.45 + attachments.length * 1.5)
        : engine === "assemblyai"
          ? Math.round(totalDurationSec * 0.5 + attachments.length * 1.8)
        : Math.round(totalDurationSec / estimateLocalRealtimeFactor(model) + attachments.length * 2.5);
    const estimatedCostUsd = engine === "openai" || engine === "assemblyai" ? estimateAudioCostUsd({ model, totalMinutes }) : 0;

    // Estimativa de IA para classificacao/analise baseada no texto total esperado das transcricoes.
    const estimatedAiInputTokens = Math.max(0, Math.round(totalDurationSec * 3.2));
    const estimatedAiOutputTokens = Math.max(0, Math.round(estimatedAiInputTokens * 0.18));
    const estimatedAiCostUsd =
      aiEngine === "openai"
        ? estimateTextCostUsd({
            model: aiModel,
            inputTokens: estimatedAiInputTokens,
            outputTokens: estimatedAiOutputTokens
          })
        : 0;
    const estimatedAiTimeSeconds =
      aiEngine === "openai"
        ? Math.round(Math.max(4, estimatedAiInputTokens / 240 + attachments.length * 0.4))
        : Math.round(Math.max(2, estimatedAiInputTokens / 800 + attachments.length * 0.3));

    return NextResponse.json({
      evidenceId: evidence.id,
      fileName: evidence.fileName,
      transcriptionRuntime: {
        engine,
        model
      },
      aiRuntime: {
        engine: aiEngine,
        model: aiModel
      },
      audioIndexing: {
        attachmentCount: attachments.length,
        attachmentCountWithPath: attachments.filter((row) => Boolean(row.path)).length,
        attachmentCountWithoutPath: attachments.filter((row) => !row.path).length,
        durationResolvedCount: resolvedDurationFiles,
        totalDurationSec: Number(totalDurationSec.toFixed(2)),
        totalDurationMin: Number(totalMinutes.toFixed(2)),
        totalSizeMB: Number((totalSizeBytes / (1024 * 1024)).toFixed(2))
      },
      estimate: {
        estimatedOutputTokens,
        estimatedTimeSeconds,
        estimatedTimeMinutes: Number((estimatedTimeSeconds / 60).toFixed(2)),
        estimatedCostUsd
      },
      aiEstimate: {
        estimatedInputTokens: estimatedAiInputTokens,
        estimatedOutputTokens: estimatedAiOutputTokens,
        estimatedTotalTokens: estimatedAiInputTokens + estimatedAiOutputTokens,
        estimatedTimeSeconds: estimatedAiTimeSeconds,
        estimatedTimeMinutes: Number((estimatedAiTimeSeconds / 60).toFixed(2)),
        estimatedCostUsd: estimatedAiCostUsd
      },
      notes: [
        "Estimativa baseada em duracao de audio indexada via ffprobe.",
        engine === "openai"
          ? "Custo usa tabela configuravel por minuto (OPENAI_AUDIO_PRICE_PER_MINUTE_JSON)."
          : engine === "assemblyai"
            ? "Custo estimado por minuto para provedores online (tabela configuravel no backend)."
          : "Custo local considera zero custo de API; inclui apenas tempo estimado de processamento.",
        aiEngine === "openai"
          ? "Estimativa IA usa tabela por token (OPENAI_MODEL_PRICING_JSON) para o modelo selecionado."
          : "Estimativa IA local considera custo de API zero."
      ]
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao estimar transcricao." },
      { status: 500 }
    );
  }
}
