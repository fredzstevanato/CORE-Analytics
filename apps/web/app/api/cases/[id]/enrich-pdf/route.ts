import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@core/db";
import {
  addCustodyEvent,
  enrichCaseContextFromPdf,
  generateInvestigativeReport,
  runCaseInvestigativeTriage
} from "@core/cases";
import { computeSha256FromBuffer } from "@core/forensics";
import { runPdfImportPipeline, LightweightPdfEngineAdapter, type PdfProcessingMode } from "@core/pdf-processing";
import { createStorageDriver } from "@core/storage";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const boolSchema = z.enum(["true", "false"]).optional();

function asBoolean(value: string | null | undefined, fallback = false): boolean {
  const parsed = boolSchema.safeParse(value ?? undefined);
  if (!parsed.success) return fallback;
  return parsed.data === "true";
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "case-context.pdf";
}

function normalizeMode(value: FormDataEntryValue | null): PdfProcessingMode {
  return value === "analysis-and-ocr" ? "analysis-and-ocr" : "analysis-only";
}

function parseMaxChats(value: FormDataEntryValue | null | undefined, fallback?: number) {
  if (value == null || String(value).trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.round(parsed));
}

function buildPdfText(pages: Array<{ pageNumber: number; extractedText: string }>) {
  return pages
    .map((page) => `[Page ${page.pageNumber}]\n${page.extractedText || ""}`.trim())
    .join("\n\n")
    .trim();
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: caseId } = await params;
    const existingCase = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!existingCase) {
      return NextResponse.json({ error: "Caso nao encontrado." }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Arquivo PDF invalido." }, { status: 400 });
    }

    const safeFileName = sanitizeFileName(file.name || "case-context.pdf");
    if (!safeFileName.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Envie um arquivo PDF." }, { status: 400 });
    }

    const mode = normalizeMode(formData.get("mode"));
    const overwriteExisting = asBoolean(String(formData.get("overwriteExisting") ?? "false"), false);
    const autoRunTriage = asBoolean(String(formData.get("autoRunTriage") ?? "false"), false);
    const autoRunFinalReport = asBoolean(String(formData.get("autoRunFinalReport") ?? "false"), false);
    const triageMaxChats = parseMaxChats(formData.get("triageMaxChats"));
    const contextModel = String(formData.get("contextModel") || process.env.OPENAI_CASE_CONTEXT_MODEL || "gpt-5.4");
    const analysisModel = String(
      formData.get("analysisModel") || process.env.OPENAI_INVESTIGATION_ANALYSIS_MODEL || "gpt-5.4-mini"
    );
    const reportModel = String(
      formData.get("reportModel") || process.env.OPENAI_INVESTIGATION_REPORT_MODEL || "gpt-5.4"
    );
    const runtimeApiKey = String(formData.get("openaiApiKey") || "").trim() || undefined;

    const session = await getSessionUser();
    const bytes = Buffer.from(await file.arrayBuffer());
    const sha256 = await computeSha256FromBuffer(bytes);

    const draftEvidenceId = crypto.randomUUID();
    const storage = createStorageDriver();
    const stored = await storage.saveEvidenceFile({
      caseId,
      evidenceId: draftEvidenceId,
      originalFilename: safeFileName,
      buffer: bytes
    });

    const evidence = await prisma.evidence.create({
      data: {
        caseId,
        label: `PDF Contexto - ${safeFileName}`,
        source: "CASE_CONTEXT_PDF",
        mimeType: file.type || "application/pdf",
        fileName: safeFileName,
        originalPath: stored.relativePath,
        sizeBytes: BigInt(stored.sizeBytes),
        sha256,
        uploadedById: session?.id
      }
    });

    await addCustodyEvent({
      caseId,
      evidenceId: evidence.id,
      actorId: session?.id,
      action: "CASE_PDF_CONTEXT_UPLOADED",
      source: "api/cases/enrich-pdf",
      currentHash: sha256,
      details: {
        fileName: safeFileName,
        mode
      }
    });

    const pipeline = await runPdfImportPipeline({
      inputFilePath: stored.absolutePath,
      originalFileName: safeFileName,
      mode,
      config: {
        ocr: {
          enabled: mode === "analysis-and-ocr",
          language: process.env.PDF_OCR_LANGUAGE ?? "por+eng",
          command: process.env.PDF_OCR_COMMAND,
          commandArgs: process.env.PDF_OCR_COMMAND_ARGS?.split(" ").filter(Boolean)
        }
      }
    });

    const textSourcePath = pipeline.processedFile?.absolutePath ?? stored.absolutePath;
    const engine = new LightweightPdfEngineAdapter();
    const parsedDocument = await engine.readDocument(textSourcePath);
    const pdfText = buildPdfText(
      parsedDocument.pages.map((page) => ({
        pageNumber: page.pageNumber,
        extractedText: page.extractedText
      }))
    );

    if (!pdfText || pdfText.length < 30) {
      return NextResponse.json(
        {
          error:
            "Nao foi possivel extrair texto util do PDF para contextualizacao. Verifique OCR/qualidade do documento.",
          pipeline
        },
        { status: 422 }
      );
    }

    const context = await enrichCaseContextFromPdf({
      caseId,
      evidenceId: evidence.id,
      model: contextModel,
      openaiApiKey: runtimeApiKey,
      pdfText,
      overwriteExisting,
      source: "api/cases/enrich-pdf"
    });

    let triageResult: { insightId: string; summary?: string } | null = null;
    let reportResult: { id: string; title: string } | null = null;

    if (autoRunTriage || autoRunFinalReport) {
      triageResult = await runCaseInvestigativeTriage({
        caseId,
        evidenceId: evidence.id,
        maxChats: triageMaxChats,
        analysisModel,
        openaiApiKey: runtimeApiKey
      });
    }

    if (autoRunFinalReport) {
      const report = await generateInvestigativeReport({
        caseId,
        evidenceId: evidence.id,
        triageInsightId: triageResult?.insightId,
        reportModel,
        openaiApiKey: runtimeApiKey,
        authorId: session?.id
      });
      reportResult = { id: report.id, title: report.title };
    }

    return NextResponse.json({
      success: true,
      caseId,
      evidenceId: evidence.id,
      contextInsightId: context.insightId,
      mode,
      pipeline,
      contextUpdatedFields: context.updatedFields,
      triage: triageResult,
      triageMaxChats,
      report: reportResult
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao enriquecer caso com PDF." },
      { status: 500 }
    );
  }
}
