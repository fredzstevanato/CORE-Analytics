import { mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  addCustodyEvent,
  createCaseDocument,
  createExpertReportWithObjects,
  listCaseExpertReports,
  extractExpertReportContextFromText,
  getAppSettingValue
} from "@core/cases";
import { prisma, Prisma } from "@core/db";
import { computeSha256FromBuffer } from "@core/forensics";
import { LightweightPdfEngineAdapter } from "@core/pdf-processing";
import { createStorageDriver } from "@core/storage";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

function serializeForJson<T>(value: T): T {
  const walk = (input: unknown): unknown => {
    if (typeof input === "bigint") return input.toString();
    if (Array.isArray(input)) return input.map((item) => walk(item));
    if (input && typeof input === "object") {
      const entries = Object.entries(input as Record<string, unknown>).map(([key, val]) => [key, walk(val)]);
      return Object.fromEntries(entries);
    }
    return input;
  };
  return walk(value) as T;
}

function sanitizeFileName(fileName: string) {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "expert-report.pdf";
}

function buildPdfText(pages: Array<{ pageNumber: number; extractedText: string }>) {
  return pages
    .map((page) => `[Page ${page.pageNumber}]\n${page.extractedText || ""}`.trim())
    .join("\n\n")
    .trim();
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
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

function resolveWorkspaceRoot() {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "..", "..")
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "tools", "ocr", "env", "Library", "bin", "gswin64c.exe"))) {
      return candidate;
    }
  }
  return path.resolve(process.cwd(), "..", "..");
}

function replacePathTokens(value: string) {
  const root = resolveWorkspaceRoot();
  return value
    .replaceAll("{projectRoot}", root)
    .replaceAll("{workspaceRoot}", root)
    .replaceAll("{cwd}", process.cwd());
}

function resolvePrintSimulationCommandConfig() {
  const envCommand = process.env.PDF_PRINT_SIM_COMMAND?.trim();
  const envArgs = process.env.PDF_PRINT_SIM_COMMAND_ARGS?.split(" ").filter(Boolean);
  if (envCommand) {
    return {
      command: replacePathTokens(envCommand),
      args: envArgs
    };
  }

  const localGs = path.join(resolveWorkspaceRoot(), "tools", "ocr", "env", "Library", "bin", "gswin64c.exe");
  return {
    command: localGs,
    args: [
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.7",
      "-dPDFSETTINGS=/prepress",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-sOutputFile={output}",
      "{input}"
    ]
  };
}

async function createPrintSimulatedPdfCopy(input: { sourcePath: string; outputPath: string }) {
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  const config = resolvePrintSimulationCommandConfig();
  const args = (config.args ?? []).map((arg) =>
    arg
      .replaceAll("{projectRoot}", resolveWorkspaceRoot())
      .replaceAll("{input}", input.sourcePath)
      .replaceAll("{output}", input.outputPath)
  );
  await runCommand(replacePathTokens(config.command), args);
}

type FieldEvidence = {
  value?: string;
  sourceSnippet?: string;
  confidence: number;
  reason: string;
  provider: "deterministic" | "ai-mini" | "ai-strong";
};

type IdentifierEvidence = {
  value: string;
  sourceSnippet?: string;
  confidence: number;
  reason: string;
  provider: "deterministic" | "ai-mini" | "ai-strong";
};

type HybridExtraction = {
  parserScore: number;
  fallbackTriggered: boolean;
  strongRetryTriggered: boolean;
  routeReason: string;
  reportNumber?: FieldEvidence;
  protocol?: FieldEvidence;
  imeiCandidates: IdentifierEvidence[];
  iccidCandidates: IdentifierEvidence[];
};

function normalizeMode(value: FormDataEntryValue | null): "analysis-and-ocr" | "analysis-only" {
  return value === "analysis-only" ? "analysis-only" : "analysis-and-ocr";
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeDigits(value: string) {
  return value.replace(/\D+/g, "");
}

function isLikelyImei(value: string) {
  const digits = normalizeDigits(value);
  return digits.length >= 14 && digits.length <= 17;
}

function isLikelyIccid(value: string) {
  const digits = normalizeDigits(value);
  return digits.length >= 15 && digits.length <= 25;
}

function toIdentifierEvidenceMap(rows: IdentifierEvidence[]) {
  const map = new Map<string, IdentifierEvidence>();
  for (const row of rows) {
    const key = normalizeDigits(row.value) || normalizeSpaces(row.value).toLowerCase();
    if (!key) continue;
    const current = map.get(key);
    if (!current || row.confidence > current.confidence) {
      map.set(key, row);
    }
  }
  return map;
}

function findSourceLineByRegex(text: string, regexes: RegExp[]) {
  for (const regex of regexes) {
    const match = regex.exec(text);
    if (!match || typeof match.index !== "number") continue;
    const start = text.lastIndexOf("\n", match.index);
    const end = text.indexOf("\n", match.index);
    const line = text.slice(start >= 0 ? start + 1 : 0, end >= 0 ? end : text.length);
    const normalized = normalizeSpaces(line);
    if (normalized) return normalized.slice(0, 240);
  }
  return undefined;
}

function scoreDeterministicRoute(input: {
  parsedText: string;
  reportNumber?: string;
  protocol?: string;
  imeiCount: number;
  iccidCount: number;
}) {
  let score = 0;
  if (input.reportNumber) score += 0.26;
  if (input.protocol) score += 0.24;
  if (input.imeiCount > 0) score += 0.25;
  if (input.iccidCount > 0) score += 0.2;
  const textQuality = Math.min(1, Math.max(0, input.parsedText.length / 6000));
  score += textQuality * 0.05;
  return clamp01(Number(score.toFixed(3)));
}

function shouldTriggerFallback(input: {
  parserScore: number;
  reportNumber?: string;
  protocol?: string;
  imeiCount: number;
  iccidCount: number;
  parsedTextLength: number;
}) {
  if (input.parsedTextLength < 450) return { decision: true, reason: "texto-extraido-curto" };
  if (input.parserScore < 0.62) return { decision: true, reason: "score-deterministico-baixo" };
  const populated = [input.reportNumber, input.protocol].filter(Boolean).length + Number(input.imeiCount > 0) + Number(input.iccidCount > 0);
  if (populated < 2) return { decision: true, reason: "campos-insuficientes" };
  return { decision: false, reason: "deterministico-suficiente" };
}

async function resolveOpenAiApiKey(runtimeKey?: string) {
  const runtime = runtimeKey?.trim();
  if (runtime) return runtime;
  const appSetting = (await getAppSettingValue("OPENAI_API_KEY"))?.trim();
  const env = process.env.OPENAI_API_KEY?.trim();
  const key = appSetting || env;
  if (!key) {
    throw new Error("OPENAI_API_KEY ausente. Configure em Configuracoes > OPENAI_API_KEY.");
  }
  return key;
}

async function callOpenAiExpertReportStructuring(input: {
  apiKey: string;
  model: string;
  provider: "ai-mini" | "ai-strong";
  parsedText: string;
}) {
  const payloadText = input.parsedText.slice(0, 22000);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Voce extrai dados de laudo pericial de forma conservadora. Retorne apenas JSON valido no schema. Nunca invente valores. Para cada campo, informe motivo curto, trecho fonte e confianca 0-1."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                task: "Extrair numero de laudo, protocolo, IMEI e ICCID com evidencias.",
                text: payloadText
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "expert_report_structured_fields",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reportNumber: {
                type: "object",
                additionalProperties: false,
                properties: {
                  value: { type: "string" },
                  sourceSnippet: { type: "string" },
                  confidence: { type: "number" },
                  reason: { type: "string" }
                },
                required: ["value", "sourceSnippet", "confidence", "reason"]
              },
              protocol: {
                type: "object",
                additionalProperties: false,
                properties: {
                  value: { type: "string" },
                  sourceSnippet: { type: "string" },
                  confidence: { type: "number" },
                  reason: { type: "string" }
                },
                required: ["value", "sourceSnippet", "confidence", "reason"]
              },
              imeiCandidates: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    sourceSnippet: { type: "string" },
                    confidence: { type: "number" },
                    reason: { type: "string" }
                  },
                  required: ["value", "sourceSnippet", "confidence", "reason"]
                }
              },
              iccidCandidates: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    sourceSnippet: { type: "string" },
                    confidence: { type: "number" },
                    reason: { type: "string" }
                  },
                  required: ["value", "sourceSnippet", "confidence", "reason"]
                }
              }
            },
            required: ["reportNumber", "protocol", "imeiCandidates", "iccidCandidates"]
          }
        }
      }
    })
  });

  const raw = await response.text();
  let parsedRaw: any = null;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    parsedRaw = null;
  }

  if (!response.ok) {
    const message = parsedRaw?.error?.message ?? raw ?? `OpenAI error ${response.status}`;
    throw new Error(message);
  }

  const outputText =
    parsedRaw?.output_text ??
    parsedRaw?.output?.[0]?.content?.find((item: any) => item?.type === "output_text")?.text ??
    "";
  if (!outputText) {
    throw new Error("OpenAI nao retornou JSON de estruturacao do laudo.");
  }

  const parsed = JSON.parse(outputText) as {
    reportNumber?: { value?: string; sourceSnippet?: string; confidence?: number; reason?: string };
    protocol?: { value?: string; sourceSnippet?: string; confidence?: number; reason?: string };
    imeiCandidates?: Array<{ value?: string; sourceSnippet?: string; confidence?: number; reason?: string }>;
    iccidCandidates?: Array<{ value?: string; sourceSnippet?: string; confidence?: number; reason?: string }>;
  };

  const normalizeField = (
    row: { value?: string; sourceSnippet?: string; confidence?: number; reason?: string } | undefined
  ): FieldEvidence | undefined => {
    const value = normalizeSpaces(row?.value ?? "");
    if (!value) return undefined;
    return {
      value,
      sourceSnippet: normalizeSpaces(row?.sourceSnippet ?? "").slice(0, 240) || undefined,
      confidence: clamp01(Number(row?.confidence ?? 0)),
      reason: normalizeSpaces(row?.reason ?? "Extraido por IA.").slice(0, 180),
      provider: input.provider
    };
  };

  const normalizeCandidates = (
    rows: Array<{ value?: string; sourceSnippet?: string; confidence?: number; reason?: string }> | undefined,
    kind: "IMEI" | "ICCID"
  ) => {
    const output: IdentifierEvidence[] = [];
    const seen = new Set<string>();
    for (const row of rows ?? []) {
      const valueRaw = normalizeSpaces(row?.value ?? "");
      if (!valueRaw) continue;
      const valueDigits = normalizeDigits(valueRaw);
      const valid = kind === "IMEI" ? isLikelyImei(valueDigits) : isLikelyIccid(valueDigits);
      if (!valid) continue;
      if (seen.has(valueDigits)) continue;
      seen.add(valueDigits);
      output.push({
        value: valueDigits,
        sourceSnippet: normalizeSpaces(row?.sourceSnippet ?? "").slice(0, 240) || undefined,
        confidence: clamp01(Number(row?.confidence ?? 0)),
        reason: normalizeSpaces(row?.reason ?? "Extraido por IA.").slice(0, 180),
        provider: input.provider
      });
    }
    return output.slice(0, 8);
  };

  return {
    reportNumber: normalizeField(parsed.reportNumber),
    protocol: normalizeField(parsed.protocol),
    imeiCandidates: normalizeCandidates(parsed.imeiCandidates, "IMEI"),
    iccidCandidates: normalizeCandidates(parsed.iccidCandidates, "ICCID")
  };
}

function aiResultIsInconsistent(input: {
  reportNumber?: FieldEvidence;
  protocol?: FieldEvidence;
  imeiCandidates: IdentifierEvidence[];
  iccidCandidates: IdentifierEvidence[];
}) {
  const reportBad = input.reportNumber?.value ? input.reportNumber.value.length < 3 : false;
  const protocolBad = input.protocol?.value ? input.protocol.value.length < 3 : false;
  const lowConfidenceSignals = [
    input.reportNumber?.confidence ?? 0,
    input.protocol?.confidence ?? 0,
    ...input.imeiCandidates.map((item) => item.confidence),
    ...input.iccidCandidates.map((item) => item.confidence)
  ];
  const maxConfidence = lowConfidenceSignals.length > 0 ? Math.max(...lowConfidenceSignals) : 0;
  const poorCoverage =
    Number(!!input.reportNumber?.value) +
      Number(!!input.protocol?.value) +
      Number(input.imeiCandidates.length > 0) +
      Number(input.iccidCandidates.length > 0) <
    2;
  return reportBad || protocolBad || maxConfidence < 0.62 || poorCoverage;
}

function chooseBestField(a?: FieldEvidence, b?: FieldEvidence) {
  if (!a) return b;
  if (!b) return a;
  return b.confidence > a.confidence ? b : a;
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const reports = await listCaseExpertReports(params.id);
    return NextResponse.json({ reports: serializeForJson(reports) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao listar laudos periciais." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const caseRow = await prisma.case.findUnique({ where: { id: params.id }, select: { id: true } });
    if (!caseRow) {
      return NextResponse.json({ error: "Caso nao encontrado." }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Arquivo do laudo invalido." }, { status: 400 });
    }

    const safeFileName = sanitizeFileName(file.name || "expert-report.pdf");
    const title = String(formData.get("title") || "").trim() || `Laudo pericial - ${safeFileName}`;
    const mode = normalizeMode(formData.get("mode"));
    const simulatePrintCopy = true;
    const aiModelMini = String(formData.get("aiModel") || process.env.OPENAI_EXPERT_REPORT_MODEL || "gpt-4.1-mini");
    const aiModelStrong = String(
      formData.get("aiRetryModel") || process.env.OPENAI_EXPERT_REPORT_RETRY_MODEL || "gpt-5.4-mini"
    );
    const runtimeApiKey = String(formData.get("openaiApiKey") || "").trim() || undefined;
    const bytes = Buffer.from(await file.arrayBuffer());
    const sha256 = await computeSha256FromBuffer(bytes);
    const sessionUser = await getSessionUser();
    const storage = createStorageDriver();
    const documentId = crypto.randomUUID();
    const stored = await storage.saveCaseDocumentFile({
      caseId: params.id,
      documentId,
      originalFilename: safeFileName,
      buffer: bytes
    });

    const document = await createCaseDocument({
      caseId: params.id,
      type: "EXPERT_REPORT_PDF",
      title,
      fileName: safeFileName,
      mimeType: file.type || "application/pdf",
      storagePath: stored.relativePath,
      sizeBytes: stored.sizeBytes,
      sha256,
      source: "EXPERT_REPORT_UPLOAD",
      uploadedById: sessionUser?.id
    });

    let parsedText = "";
    let printSimulationDocument:
      | {
          id: string;
          fileName: string;
        }
      | undefined;
    let extractionSourcePath = stored.absolutePath;
    let extractionUsedPrintSimulation = false;
    let ocrPipelineWarnings: string[] = [];
    let ocrPipelineErrors: string[] = [];
    if ((file.type || "").includes("pdf") || safeFileName.toLowerCase().endsWith(".pdf")) {
      let pipelineInputPath = stored.absolutePath;
      const ext = path.extname(safeFileName) || ".pdf";
      const base = path.basename(safeFileName, ext);
      if (simulatePrintCopy) {
        const printOutputPath = path.resolve(
          process.env.PDF_OUTPUT_DIR ?? "./storage/tmp/pdf-processing/output",
          `${base}.print-simulated${ext}`
        );
        try {
          await createPrintSimulatedPdfCopy({
            sourcePath: stored.absolutePath,
            outputPath: printOutputPath
          });

          const printBytes = await readFile(printOutputPath);
          const printSha256 = await computeSha256FromBuffer(printBytes);
          const printStat = await stat(printOutputPath);
          const printFileName = `${base}.print-simulated${ext}`;
          const printStored = await storage.saveCaseDocumentFile({
            caseId: params.id,
            documentId: crypto.randomUUID(),
            originalFilename: printFileName,
            buffer: printBytes
          });
          const printDocument = await createCaseDocument({
            caseId: params.id,
            type: "SUPPORTING_DOCUMENT",
            title: `Copia simulacao de impressao - ${safeFileName}`,
            fileName: printFileName,
            mimeType: "application/pdf",
            storagePath: printStored.relativePath,
            sizeBytes: Number(printStat.size),
            sha256: printSha256,
            source: "EXPERT_REPORT_PRINT_SIM_DERIVED",
            uploadedById: sessionUser?.id,
            metadata: {
              derivedFromDocumentId: document.id,
              derivedFromStoragePath: stored.relativePath,
              strategy: "print-simulation"
            } as Prisma.InputJsonValue
          });

          printSimulationDocument = {
            id: printDocument.id,
            fileName: printDocument.fileName
          };
          pipelineInputPath = printStored.absolutePath;
          extractionUsedPrintSimulation = true;
          ocrPipelineWarnings = [...ocrPipelineWarnings, "Copia de simulacao de impressao gerada para extracao."];
        } catch (error) {
          const message = error instanceof Error ? error.message : "Falha ao gerar copia de simulacao de impressao.";
          return NextResponse.json(
            {
              error:
                "Nao foi possivel gerar a copia simulacao de impressao. A extracao nao sera feita no arquivo original.",
              details: message
            },
            { status: 422 }
          );
        }
      }

      const ocrLanguage = process.env.PDF_OCR_LANGUAGE ?? "por+eng";
      const ocrOutputDir = process.env.PDF_OUTPUT_DIR ?? "./storage/tmp/pdf-processing/output";
      const ocrOutputPath = path.resolve(ocrOutputDir, `${base}.ocr-output${ext}`);
      const sidecarPath = path.resolve(ocrOutputDir, `${base}.sidecar.txt`);

      if (mode === "analysis-and-ocr") {
        try {
          const root = resolveWorkspaceRoot();
          const scriptPath = path.join(root, "scripts", "ocrmypdf-portable.ps1");
          await mkdir(path.dirname(ocrOutputPath), { recursive: true });
          await runCommand("powershell", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-InputFile",
            pipelineInputPath,
            "-OutputFile",
            ocrOutputPath,
            "-Pages",
            "1-30",
            "-Language",
            ocrLanguage,
            "-OcrMode",
            "force-ocr",
            "-Sidecar",
            sidecarPath
          ]);
          const sidecarContent = await readFile(sidecarPath, "utf-8");
          if (sidecarContent.trim().length > 0) {
            parsedText = sidecarContent;
          }
          ocrPipelineWarnings.push("OCR force-ocr com sidecar executado nas paginas 1-30.");
        } catch (ocrError) {
          const ocrMsg = ocrError instanceof Error ? ocrError.message : "OCR com sidecar falhou.";
          ocrPipelineErrors.push(ocrMsg);
          ocrPipelineWarnings.push("OCR falhou, tentando extrair texto nativo do PDF.");
        }
      }

      if (!parsedText) {
        try {
          const engine = new LightweightPdfEngineAdapter();
          const parsedDocument = await engine.readDocument(pipelineInputPath);
          parsedText = buildPdfText(
            parsedDocument.pages.map((page) => ({
              pageNumber: page.pageNumber,
              extractedText: page.extractedText
            }))
          );
        } catch {
          ocrPipelineWarnings.push("Leitura de texto nativo do PDF tambem falhou.");
        }
      }
    }

    const extracted = parsedText ? extractExpertReportContextFromText({ text: parsedText }) : null;
    const extractedParsedPayload =
      extracted?.parsedPayload && typeof extracted.parsedPayload === "object"
        ? (extracted.parsedPayload as Record<string, unknown>)
        : null;
    const extractedPolitec =
      extractedParsedPayload?.politec && typeof extractedParsedPayload.politec === "object"
        ? (extractedParsedPayload.politec as Record<string, unknown>)
        : null;
    const deterministicReportNumberSource = parsedText
      ? findSourceLineByRegex(parsedText, [
          /laudo(?: pericial)?\s*(?:n[ºo°.]*)?\s*[:\-]?\s*([A-Z0-9./-]+)/i,
          /relat[oó]rio(?: pericial)?\s*(?:n[ºo°.]*)?\s*[:\-]?\s*([A-Z0-9./-]+)/i
        ])
      : undefined;
    const deterministicProtocolSource =
      typeof extractedPolitec?.sourceReferences === "object" && extractedPolitec.sourceReferences
        ? (extractedPolitec.sourceReferences as Record<string, unknown>).protocol
        : undefined;

    const deterministicImeiCandidates: IdentifierEvidence[] = [];
    const deterministicIccidCandidates: IdentifierEvidence[] = [];
    for (const item of extracted?.seizedObjects ?? []) {
      if (item.imei && isLikelyImei(item.imei)) {
        deterministicImeiCandidates.push({
          value: normalizeDigits(item.imei),
          sourceSnippet: item.sourceReference,
          confidence: 0.96,
          reason: "Detectado por regex local em objeto apreendido.",
          provider: "deterministic"
        });
      }
      if (item.imei2 && isLikelyImei(item.imei2)) {
        deterministicImeiCandidates.push({
          value: normalizeDigits(item.imei2),
          sourceSnippet: item.sourceReference,
          confidence: 0.95,
          reason: "Detectado por regex local em objeto apreendido.",
          provider: "deterministic"
        });
      }
      if (item.iccid1 && isLikelyIccid(item.iccid1)) {
        deterministicIccidCandidates.push({
          value: normalizeDigits(item.iccid1),
          sourceSnippet: item.sourceReference,
          confidence: 0.94,
          reason: "Detectado por regex local em objeto apreendido.",
          provider: "deterministic"
        });
      }
      if (item.iccid2 && isLikelyIccid(item.iccid2)) {
        deterministicIccidCandidates.push({
          value: normalizeDigits(item.iccid2),
          sourceSnippet: item.sourceReference,
          confidence: 0.94,
          reason: "Detectado por regex local em objeto apreendido.",
          provider: "deterministic"
        });
      }
    }

    const deterministicReportNumber: FieldEvidence | undefined = extracted?.reportNumber
      ? {
          value: normalizeSpaces(extracted.reportNumber),
          sourceSnippet: deterministicReportNumberSource,
          confidence: 0.93,
          reason: "Regex local para cabecalho de laudo.",
          provider: "deterministic"
        }
      : undefined;
    const deterministicProtocolValue =
      typeof extractedPolitec?.protocol === "string" ? normalizeSpaces(extractedPolitec.protocol) : undefined;
    const deterministicProtocol: FieldEvidence | undefined = deterministicProtocolValue
      ? {
          value: deterministicProtocolValue,
          sourceSnippet: typeof deterministicProtocolSource === "string" ? deterministicProtocolSource : undefined,
          confidence: 0.92,
          reason: "Regex local para protocolo.",
          provider: "deterministic"
        }
      : undefined;

    const parserScore = scoreDeterministicRoute({
      parsedText,
      reportNumber: deterministicReportNumber?.value,
      protocol: deterministicProtocol?.value,
      imeiCount: deterministicImeiCandidates.length,
      iccidCount: deterministicIccidCandidates.length
    });
    const fallbackGate = shouldTriggerFallback({
      parserScore,
      reportNumber: deterministicReportNumber?.value,
      protocol: deterministicProtocol?.value,
      imeiCount: deterministicImeiCandidates.length,
      iccidCount: deterministicIccidCandidates.length,
      parsedTextLength: parsedText.length
    });

    let fallbackTriggered = false;
    let strongRetryTriggered = false;
    let aiMiniResult:
      | {
          reportNumber?: FieldEvidence;
          protocol?: FieldEvidence;
          imeiCandidates: IdentifierEvidence[];
          iccidCandidates: IdentifierEvidence[];
        }
      | undefined;
    let aiStrongResult:
      | {
          reportNumber?: FieldEvidence;
          protocol?: FieldEvidence;
          imeiCandidates: IdentifierEvidence[];
          iccidCandidates: IdentifierEvidence[];
        }
      | undefined;

    if (parsedText && fallbackGate.decision) {
      fallbackTriggered = true;
      const apiKey = await resolveOpenAiApiKey(runtimeApiKey);
      aiMiniResult = await callOpenAiExpertReportStructuring({
        apiKey,
        model: aiModelMini,
        provider: "ai-mini",
        parsedText
      });

      const retryEnabled = String(process.env.OPENAI_EXPERT_REPORT_ENABLE_STRONG_RETRY ?? "true").toLowerCase() !== "false";
      if (retryEnabled && aiResultIsInconsistent(aiMiniResult)) {
        strongRetryTriggered = true;
        aiStrongResult = await callOpenAiExpertReportStructuring({
          apiKey,
          model: aiModelStrong,
          provider: "ai-strong",
          parsedText
        });
      }
    }

    const bestAiResult = aiStrongResult ?? aiMiniResult;
    const reportNumber = chooseBestField(deterministicReportNumber, bestAiResult?.reportNumber);
    const protocol = chooseBestField(deterministicProtocol, bestAiResult?.protocol);
    const imeiMap = toIdentifierEvidenceMap([
      ...deterministicImeiCandidates,
      ...(bestAiResult?.imeiCandidates ?? [])
    ]);
    const iccidMap = toIdentifierEvidenceMap([
      ...deterministicIccidCandidates,
      ...(bestAiResult?.iccidCandidates ?? [])
    ]);
    const mergedImeiCandidates = [...imeiMap.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 6);
    const mergedIccidCandidates = [...iccidMap.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 6);

    const hybridExtraction: HybridExtraction = {
      parserScore,
      fallbackTriggered,
      strongRetryTriggered,
      routeReason: fallbackGate.reason,
      reportNumber,
      protocol,
      imeiCandidates: mergedImeiCandidates,
      iccidCandidates: mergedIccidCandidates
    };

    const syntheticObjects =
      (extracted?.seizedObjects?.length ?? 0) === 0 && (mergedImeiCandidates.length > 0 || mergedIccidCandidates.length > 0)
        ? [
            {
              label: "Objeto extraido por fallback hibrido",
              objectType: "OBJETO_APREENDIDO",
              imei: mergedImeiCandidates[0]?.value,
              imei2: mergedImeiCandidates[1]?.value,
              iccid1: mergedIccidCandidates[0]?.value,
              iccid2: mergedIccidCandidates[1]?.value,
              sourceReference:
                mergedImeiCandidates[0]?.sourceSnippet ?? mergedIccidCandidates[0]?.sourceSnippet ?? "Fallback IA",
              metadata: {
                parsedFrom: "expert-report-hybrid-fallback",
                hybrid: true
              } as Prisma.InputJsonValue
            }
          ]
        : [];

    const parsedPayloadWithHybrid: Prisma.InputJsonValue = {
      ...(extractedParsedPayload ?? {}),
      politec: {
        ...(extractedPolitec ?? {}),
        reportNumber: reportNumber?.value,
        protocol: protocol?.value
      },
      hybridExtraction
    } as Prisma.InputJsonValue;

    const extractedHashes = Array.isArray(extractedParsedPayload?.hashes)
      ? extractedParsedPayload.hashes
      : [];
    const extractedNotes = Array.isArray(extractedParsedPayload?.descriptiveNotes)
      ? extractedParsedPayload.descriptiveNotes
      : [];
    const report = await createExpertReportWithObjects({
      caseId: params.id,
      caseDocumentId: document.id,
      uploadedById: sessionUser?.id,
      title,
      reportNumber: reportNumber?.value,
      issuingAgency: extracted?.issuingAgency,
      examinerName: extracted?.examinerName,
      summary: extracted?.summary,
      parsedPayload: parsedPayloadWithHybrid,
      metadata: {
        fileName: safeFileName,
        mimeType: file.type || "application/pdf",
        parseMode: parsedText ? `pdf-text-hybrid:${mode}` : "upload-only",
        fileSha256: sha256,
        originalDocumentId: document.id,
        printSimulationDocumentId: printSimulationDocument?.id,
        printSimulationFileName: printSimulationDocument?.fileName,
        unsignedCopyDocumentId: undefined,
        unsignedCopyFileName: undefined,
        extractionSourcePath:
          extractionUsedPrintSimulation && printSimulationDocument
            ? `case-document:${printSimulationDocument.id}`
            : "case-document:original",
        extractionUsedPrintSimulation,
        extractionUsedUnsignedCopy: false,
        ocrPipelineWarnings,
        ocrPipelineErrors,
        hashes: extractedHashes,
        hybridExtraction: {
          parserScore,
          fallbackTriggered,
          strongRetryTriggered,
          routeReason: fallbackGate.reason,
          aiModelMini: fallbackTriggered ? aiModelMini : undefined,
          aiModelStrong: strongRetryTriggered ? aiModelStrong : undefined
        },
        descriptiveFile: {
          generatedAt: new Date().toISOString(),
          lines: [
            `Arquivo: ${safeFileName}`,
            `SHA256 do arquivo: ${sha256}`,
            `Documento original ID: ${document.id}`,
            printSimulationDocument
              ? `Documento simulacao de impressao ID: ${printSimulationDocument.id}`
              : "Documento simulacao de impressao ID: nao-gerado",
            `Extracao em simulacao de impressao: ${extractionUsedPrintSimulation ? "sim" : "nao"}`,
            `Score parser deterministico: ${parserScore}`,
            `Fallback IA acionado: ${fallbackTriggered ? "sim" : "nao"}`,
            `Retry modelo forte: ${strongRetryTriggered ? "sim" : "nao"}`,
            ...extractedNotes.map((item) => String(item))
          ]
        }
      } as Prisma.InputJsonValue,
      seizedObjects: extracted?.seizedObjects?.length ? extracted.seizedObjects : syntheticObjects
    });

    await addCustodyEvent({
      caseId: params.id,
      actorId: sessionUser?.id,
      action: "EXPERT_REPORT_IMPORTED",
      source: "api/cases/expert-reports",
      currentHash: sha256,
      details: {
        reportId: report.id,
        documentId: document.id,
        printSimulationDocumentId: printSimulationDocument?.id ?? null,
        fileName: safeFileName,
        reportNumber: extracted?.reportNumber ?? null
      } as Prisma.InputJsonValue
    });

    return NextResponse.json({
      report: serializeForJson(report),
      extractionRoute: {
        parserScore,
        fallbackTriggered,
        strongRetryTriggered,
        reason: fallbackGate.reason
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao importar laudo pericial." },
      { status: 500 }
    );
  }
}
