import path, { basename } from "node:path";
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent, getAppSettingValue } from "@core/cases";
import { enqueueLocalUfdrImport } from "@core/queue";
import { prisma } from "@core/db";
import { requireApiSession } from "@/lib/api-auth";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const schema = z.object({
  filePath: z.string().min(3),
  originalUfdrFilePath: z.string().min(3).optional(),
  caseId: z.string().uuid(),
  transcriptionRuntime: z
    .object({
      enabled: z.boolean().optional(),
      engine: z.enum(["local", "openai", "assemblyai"]).optional(),
      model: z.string().min(1).optional(),
      language: z.string().optional()
    })
    .optional()
});

function normalizePathInput(value: string) {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^"(.*)"$/);
  return quoted ? (quoted[1] ?? "").trim() : trimmed;
}

function isUfdrFilePath(value: string) {
  return value.toLowerCase().endsWith(".ufdr");
}

function buildStorageDirectoryTarget(input: { caseId: string; evidenceId: string; sourcePath: string }) {
  const safeName = basename(input.sourcePath).replace(/[^a-zA-Z0-9._-]/g, "_") || "ufdr-extracted";
  const relativeDir = path.join(
    "evidences",
    input.caseId,
    input.evidenceId,
    `${Date.now()}-${crypto.randomUUID()}-${safeName}`
  );
  const absoluteDir = path.resolve(process.env.STORAGE_ROOT ?? "./storage", relativeDir);
  return { relativeDir, absoluteDir };
}

function runtimePublicDetails(runtimeDetails: {
  enabled: boolean;
  engine: "local" | "openai" | "assemblyai";
  model: string;
  language?: string;
}) {
  return {
    enabled: runtimeDetails.enabled,
    engine: runtimeDetails.engine,
    model: runtimeDetails.model,
    language: runtimeDetails.language ?? null
  };
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const session = auth.session;

    const body = schema.parse(await request.json());
    const sourcePath = normalizePathInput(body.filePath);
    const explicitOriginalUfdrPath = body.originalUfdrFilePath ? normalizePathInput(body.originalUfdrFilePath) : undefined;
    if (!path.isAbsolute(sourcePath)) {
      return NextResponse.json(
        { error: "Caminho invalido: informe caminho absoluto de uma pasta descompactada ou arquivo .ufdr." },
        { status: 400 }
      );
    }

    const sourceStat = await stat(sourcePath);
    const sourceIsDirectory = sourceStat.isDirectory();
    const sourceIsFile = sourceStat.isFile();
    if (!sourceIsDirectory && !sourceIsFile) {
      return NextResponse.json(
        { error: "Caminho informado deve apontar para uma pasta descompactada ou para um arquivo .ufdr." },
        { status: 400 }
      );
    }
    if (sourceIsFile && !isUfdrFilePath(sourcePath)) {
      return NextResponse.json({ error: "Quando informar arquivo, ele deve ter extensao .ufdr." }, { status: 400 });
    }

    const filename = basename(sourcePath);
    const runtimeEngine = body.transcriptionRuntime?.engine ?? "local";
    const runtimeModel =
      body.transcriptionRuntime?.model?.trim() ||
      (runtimeEngine === "openai"
        ? process.env.OPENAI_AUDIO_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
        : runtimeEngine === "assemblyai"
          ? process.env.ASSEMBLYAI_TRANSCRIBE_MODEL || "best"
          : process.env.WHISPER_MODEL || "base");
    const runtimeLanguage = body.transcriptionRuntime?.language?.trim() || undefined;
    const runtimeEnabled = body.transcriptionRuntime?.enabled ?? true;
    const runtimeOpenAiApiKey =
      runtimeEngine === "openai"
        ? (await getAppSettingValue("OPENAI_API_KEY"))?.trim() || process.env.OPENAI_API_KEY?.trim()
        : undefined;
    const runtimeAssemblyAiApiKey =
      runtimeEngine === "assemblyai"
        ? (await getAppSettingValue("ASSEMBLYAI_API_KEY"))?.trim() || process.env.ASSEMBLYAI_API_KEY?.trim()
        : undefined;
    if (runtimeEnabled && runtimeEngine === "openai" && !runtimeOpenAiApiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY ausente. Configure em Configuracoes para transcricao online." }, { status: 422 });
    }
    if (runtimeEnabled && runtimeEngine === "assemblyai" && !runtimeAssemblyAiApiKey) {
      return NextResponse.json({ error: "ASSEMBLYAI_API_KEY ausente. Configure em Configuracoes para transcricao online." }, { status: 422 });
    }

    const existingCase = await prisma.case.findUnique({ where: { id: body.caseId }, select: { id: true } });
    if (!existingCase) return NextResponse.json({ error: "Case ID nao encontrado." }, { status: 404 });

    const evidenceId = crypto.randomUUID();
    const extractionId = crypto.randomUUID();
    const stored = buildStorageDirectoryTarget({ caseId: existingCase.id, evidenceId, sourcePath });
    const sourceSizeBytes = Number(sourceStat.size);
    const transcriptionRuntime = {
      enabled: runtimeEnabled,
      engine: runtimeEngine,
      model: runtimeModel,
      language: runtimeLanguage,
      openaiApiKey: runtimeOpenAiApiKey,
      assemblyAiApiKey: runtimeAssemblyAiApiKey
    };

    await prisma.$transaction(async (tx) => {
      await tx.evidence.create({
        data: {
          id: evidenceId,
          caseId: existingCase.id,
          label: `UFDR - ${filename}`,
          fileName: filename,
          mimeType: sourceIsDirectory ? "inode/directory" : "application/octet-stream",
          source: "Cellebrite UFDR",
          originalPath: stored.relativeDir,
          sizeBytes: BigInt(sourceIsDirectory ? 0 : sourceSizeBytes),
          sha256: `pending:${evidenceId}`,
          uploadedById: session.id
        }
      });
      await tx.extraction.create({
        data: {
          id: extractionId,
          caseId: existingCase.id,
          evidenceId,
          status: "PENDING",
          sourceFormat: "UFDR",
          startedAt: new Date(),
          processingDetails: {
            phase: "local-import-queued-for-worker",
            progress: 1,
            sourcePath,
            storagePath: stored.relativeDir,
            sourceSizeBytes,
            sourceIsDirectory,
            localImportStartedAt: new Date().toISOString(),
            localImportHeartbeatAt: new Date().toISOString(),
            transcriptionRuntime: runtimePublicDetails(transcriptionRuntime)
          }
        }
      });
      await tx.custodyEvent.create({
        data: {
          caseId: existingCase.id,
          evidenceId,
          actorId: session.id,
          action: "UFDR_IMPORT_PATH_STARTED",
          source: "api/import-ufdr-path",
          details: {
            extractionId,
            sourcePath,
            storagePath: stored.relativeDir,
            sourceSizeBytes,
            transcriptionRuntime: runtimePublicDetails(transcriptionRuntime)
          }
        }
      });
    });

    const queueJobId = await enqueueLocalUfdrImport({
      extractionId,
      evidenceId,
      caseId: existingCase.id,
      uploadedById: session.id,
      sourcePath,
      explicitOriginalUfdrPath,
      sourceIsDirectory,
      sourceSizeBytes,
      filename,
      storedRelativePath: stored.relativeDir,
      storedAbsolutePath: stored.absoluteDir,
      transcriptionRuntime
    });

    await prisma.extraction.update({
      where: { id: extractionId },
      data: {
        processingDetails: {
          phase: "local-import-worker-queued",
          progress: 2,
          sourcePath,
          storagePath: stored.relativeDir,
          sourceSizeBytes,
          sourceIsDirectory,
          queueJobId,
          localImportStartedAt: new Date().toISOString(),
          localImportHeartbeatAt: new Date().toISOString(),
          transcriptionRuntime: runtimePublicDetails(transcriptionRuntime)
        }
      }
    });

    return NextResponse.json({
      extractionId,
      evidenceId,
      caseId: existingCase.id,
      importStarted: true,
      queueJobId,
      transcriptionRuntime: runtimePublicDetails(transcriptionRuntime)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("ENOENT")) {
      return NextResponse.json(
        { error: "Arquivo nao encontrado no caminho informado. Verifique o caminho absoluto e permissoes." },
        { status: 404 }
      );
    }
    log("error", "UFDR local path import failed before tracking", { error: message });
    return NextResponse.json({ error: `Falha ao iniciar importacao UFDR por caminho local: ${message}` }, { status: 500 });
  }
}
