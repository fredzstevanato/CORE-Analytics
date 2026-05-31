import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, prisma } from "@core/db";
import { createCaseDocument, createCaseImportSession, extractCaseContextFromPdfText, markCaseImportSessionFailed, markCaseImportSessionReady } from "@core/cases";
import { computeSha256FromBuffer } from "@core/forensics";
import { LightweightPdfEngineAdapter, runPdfImportPipeline, type PdfProcessingMode } from "@core/pdf-processing";
import { createStorageDriver } from "@core/storage";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const boolSchema = z.enum(["true", "false"]).optional();

function asJsonValue<T>(value: T) {
  return value as Prisma.InputJsonValue;
}

function asBoolean(value: string | null | undefined, fallback = false): boolean {
  const parsed = boolSchema.safeParse(value ?? undefined);
  if (!parsed.success) return fallback;
  return parsed.data === "true";
}

function sanitizeFileName(fileName: string) {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "case-import.pdf";
}

function normalizeMode(value: FormDataEntryValue | null): PdfProcessingMode {
  return value === "analysis-and-ocr" ? "analysis-and-ocr" : "analysis-only";
}

function buildPdfText(pages: Array<{ pageNumber: number; extractedText: string }>) {
  return pages
    .map((page) => `[Page ${page.pageNumber}]\n${page.extractedText || ""}`.trim())
    .join("\n\n")
    .trim();
}

type InvolvedCategory = "SUSPECT" | "VICTIM" | "WITNESS" | "OTHER";

function classifyInvolvedPerson(raw: string): InvolvedCategory {
  const value = raw.toLowerCase();
  if (/(suspeit|investigad|indiciad|acusad|autor|reu|réu)/i.test(value)) return "SUSPECT";
  if (/(testemunh|declarante|vitima|vítima)/i.test(value)) return "WITNESS";
  return "OTHER";
}

function buildInvolvedPeopleCategorized(involvedPeople: string[], sourceDocument: { id: string; fileName: string }) {
  return involvedPeople.map((person) => {
    const category = classifyInvolvedPerson(person);
    const institutional = /(polici|delegad|perit|escriv|agente|promotor|juiz|defensor|advogad)/i.test(person);
    const reasonByCategory =
      category === "SUSPECT"
        ? "Classificado automaticamente por termo de suspeição/investigação no texto."
        : category === "WITNESS"
          ? "Classificado automaticamente por termo de testemunho/vítima no texto."
          : institutional
            ? "Classificado como relacionado institucional (policial/perito/outro servidor)."
            : "Classificado como outro relacionado por citação contextual.";

    return {
      name: person,
      category,
      confidence: category === "OTHER" ? "REVIEW_RECOMMENDED" : "AUTO_EXTRACTED",
      reason: reasonByCategory,
      sourceDocuments: [
        {
          documentId: sourceDocument.id,
          fileName: sourceDocument.fileName
        }
      ]
    };
  });
}

function buildInvolvedPeopleCategorizedFromExtraction(
  extractedCategorized: unknown,
  involvedPeople: string[],
  sourceDocument: { id: string; fileName: string }
) {
  const rows: Array<{
    name: string;
    category: InvolvedCategory;
    confidence: "AUTO_EXTRACTED" | "REVIEW_RECOMMENDED";
    reason: string;
    evidenceExcerpt: string;
    sourceReference: string;
    sourceDocuments: Array<{ documentId?: string; fileName: string }>;
  }> = [];
  const seen = new Set<string>();

  const add = (row: {
    name: string;
    category: InvolvedCategory;
    confidence: "AUTO_EXTRACTED" | "REVIEW_RECOMMENDED";
    reason: string;
    evidenceExcerpt: string;
    sourceReference: string;
  }) => {
    const key = `${row.name}|${row.category}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      ...row,
      sourceDocuments: [{ documentId: sourceDocument.id, fileName: sourceDocument.fileName }]
    });
  };

  if (Array.isArray(extractedCategorized)) {
    for (const item of extractedCategorized) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) continue;
      const categoryRaw = typeof record.category === "string" ? record.category.toUpperCase() : "OTHER";
      const category: InvolvedCategory =
        categoryRaw === "SUSPECT" || categoryRaw === "VICTIM" || categoryRaw === "WITNESS" || categoryRaw === "OTHER"
          ? (categoryRaw as InvolvedCategory)
          : "OTHER";
      const confidenceRaw =
        typeof record.confidence === "string" ? record.confidence.toUpperCase() : "REVIEW_RECOMMENDED";

      add({
        name,
        category,
        confidence: confidenceRaw === "AUTO_EXTRACTED" ? "AUTO_EXTRACTED" : "REVIEW_RECOMMENDED",
        reason:
          typeof record.reason === "string" && record.reason.trim().length > 0
            ? record.reason.trim()
            : "Classificação gerada automaticamente com base no contexto textual.",
        evidenceExcerpt:
          typeof record.evidenceExcerpt === "string" && record.evidenceExcerpt.trim().length > 0
            ? record.evidenceExcerpt.trim()
            : "",
        sourceReference:
          typeof record.sourceReference === "string" && record.sourceReference.trim().length > 0
            ? record.sourceReference.trim()
            : sourceDocument.fileName
      });
    }
  }

  if (rows.length === 0) {
    return buildInvolvedPeopleCategorized(involvedPeople, sourceDocument).map((item) => ({
      ...item,
      evidenceExcerpt: "",
      sourceReference: sourceDocument.fileName
    }));
  }

  return rows;
}

function deriveCaseTitleFromIdentifiers(input: {
  caseNumber?: string;
  inquiryNumber?: string;
  inquiryType?: string;
  fallbackTitle?: string;
}) {
  const normalize = (value?: string) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const inquiryNumber = normalize(input.inquiryNumber);
  const caseNumber = normalize(input.caseNumber);
  const inquiryType = normalize(input.inquiryType).toUpperCase();
  const fallbackTitle = normalize(input.fallbackTitle);
  const primary = inquiryNumber || caseNumber;
  if (primary) return primary;

  const patterns: RegExp[] = [];
  if (inquiryType.includes("TCO")) patterns.push(/\b(TCO[\s:/-]*[A-Z0-9./-]+)\b/i);
  if (inquiryType.includes("BOC")) patterns.push(/\b(BOC[\s:/-]*[A-Z0-9./-]+)\b/i);
  patterns.push(/\b((?:IP|INQ(?:UERITO)?|INQU[ÉE]RITO|TCO|BOC)[\s:/-]*[A-Z0-9./-]+)\b/i);

  for (const regex of patterns) {
    const match = fallbackTitle.match(regex)?.[1]?.trim();
    if (match) return match;
  }
  return fallbackTitle || "Caso importado por PDF";
}

export async function POST(request: Request) {
  let sessionId: string | undefined;

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Arquivo PDF invalido." }, { status: 400 });
    }

    const safeFileName = sanitizeFileName(file.name || "case-import.pdf");
    if (!safeFileName.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Envie um arquivo PDF." }, { status: 400 });
    }

    const mode = normalizeMode(formData.get("mode"));
    const contextModel = String(formData.get("contextModel") || process.env.OPENAI_CASE_CONTEXT_MODEL || "gpt-5.4");
    const runtimeApiKey = String(formData.get("openaiApiKey") || "").trim() || undefined;
    const overwriteExisting = asBoolean(String(formData.get("overwriteExisting") ?? "false"), false);

    const sessionUser = await getSessionUser();
    const bytes = Buffer.from(await file.arrayBuffer());
    const sha256 = await computeSha256FromBuffer(bytes);

    const session = await createCaseImportSession({
      createdById: sessionUser?.id,
      status: "PENDING_ANALYSIS",
      sourceType: "PDF_IMPORT",
      draftPayload: asJsonValue({
        fileName: safeFileName
      })
    });
    sessionId = session.id;

    const storage = createStorageDriver();
    const stored = await storage.saveCaseDocumentFile({
      documentId: session.id,
      originalFilename: safeFileName,
      buffer: bytes
    });

    const document = await createCaseDocument({
      type: "INQUIRY_PDF",
      title: `PDF do Inquerito - ${safeFileName}`,
      fileName: safeFileName,
      mimeType: file.type || "application/pdf",
      storagePath: stored.relativePath,
      sizeBytes: stored.sizeBytes,
      sha256,
      source: "CASE_IMPORT_PDF",
      uploadedById: sessionUser?.id,
      metadata: {
        sessionId: session.id
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
      await markCaseImportSessionFailed({
        sessionId: session.id,
        pipelineSummary: asJsonValue({
          ...pipeline,
          documentId: document.id
        }),
        documentId: document.id,
        errorMessage: "Nao foi possivel extrair texto util do PDF."
      });

      return NextResponse.json(
        {
          error: "Nao foi possivel extrair texto util do PDF para criar rascunho do caso.",
          sessionId: session.id
        },
        { status: 422 }
      );
    }

    const extracted = await extractCaseContextFromPdfText({
      currentCaseContext: "",
      model: contextModel,
      openaiApiKey: runtimeApiKey,
      pdfText
    });
    const derivedTitle = deriveCaseTitleFromIdentifiers({
      caseNumber: extracted.caseNumber,
      inquiryNumber: extracted.inquiryNumber,
      inquiryType: extracted.inquiryType,
      fallbackTitle: extracted.title
    });
    const involvedPeopleCategorized = buildInvolvedPeopleCategorizedFromExtraction(
      extracted.involvedPeopleCategorized,
      extracted.involvedPeople,
      {
        id: document.id,
        fileName: safeFileName
      }
    );
    const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? "./storage");
    const processedRelativePath = pipeline.processedFile?.absolutePath
      ? path.relative(storageRoot, path.resolve(pipeline.processedFile.absolutePath))
      : undefined;
    await prisma.caseDocument.update({
      where: { id: document.id },
      data: {
        metadata: {
          sessionId: session.id,
          processedFile: pipeline.processedFile
            ? {
                ...pipeline.processedFile,
                relativePath: processedRelativePath
              }
            : null
        }
      }
    });

    await markCaseImportSessionReady({
      sessionId: session.id,
      documentId: document.id,
      draftPayload: {
        caseNumber: extracted.caseNumber,
        title: derivedTitle,
        description: extracted.description,
        inquiryType: extracted.inquiryType,
        inquiryNumber: extracted.inquiryNumber,
        policeUnit: extracted.policeUnit,
        inquirySummaryText: extracted.inquirySummary,
        inquiryMainFacts: extracted.inquiryMainFacts,
        inquiryInvestigativeFocus: extracted.inquiryInvestigativeFocus,
        extractionReportSummary: extracted.extractionSummary,
        involvedPeople: extracted.involvedPeople,
        involvedPeopleCategorized,
        inquiryLegalFraming: extracted.legalFraming,
        overwriteExisting
      } as Prisma.InputJsonValue,
      pipelineSummary: asJsonValue({
        documentId: document.id,
        mode,
        summary: pipeline.summary,
        warnings: pipeline.warnings,
        errors: pipeline.errors,
        processedFile: pipeline.processedFile,
        success: pipeline.success
      })
    });

    return NextResponse.json({
      sessionId: session.id,
      documentId: document.id,
      status: "READY_FOR_REVIEW"
    });
  } catch (error) {
    if (sessionId) {
      await markCaseImportSessionFailed({
        sessionId,
        documentId: undefined,
        errorMessage: error instanceof Error ? error.message : "Falha ao importar PDF."
      }).catch(() => undefined);
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao importar PDF." },
      { status: 500 }
    );
  }
}
