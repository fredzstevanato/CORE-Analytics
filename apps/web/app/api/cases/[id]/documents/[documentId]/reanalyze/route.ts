import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { enrichCaseContextFromPdf, addCustodyEvent } from "@core/cases";
import { prisma } from "@core/db";
import { LightweightPdfEngineAdapter } from "@core/pdf-processing";
import { getSessionUser } from "@/lib/session";

const paramsSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid()
});

const bodySchema = z.object({
  overwriteExisting: z.boolean().optional(),
  contextModel: z.string().optional()
});

function buildPdfText(pages: Array<{ pageNumber: number; extractedText: string }>) {
  return pages
    .map((page) => `[Page ${page.pageNumber}]\n${page.extractedText || ""}`.trim())
    .join("\n\n")
    .trim();
}

export async function POST(request: Request, routeContext: { params: Promise<{ id: string; documentId: string }> }) {
  try {
    const params = paramsSchema.parse(await routeContext.params);
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const session = await getSessionUser();

    const document = await prisma.caseDocument.findFirst({
      where: {
        id: params.documentId,
        caseId: params.id
      }
    });
    if (!document) {
      return NextResponse.json({ error: "Documento nao encontrado no caso." }, { status: 404 });
    }
    const isPdfDocument =
      (document.mimeType ?? "").toLowerCase().includes("pdf") || document.fileName.toLowerCase().endsWith(".pdf");
    if (!isPdfDocument) {
      return NextResponse.json({ error: "A reanalise esta disponivel apenas para documentos PDF." }, { status: 422 });
    }

    const absolutePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", document.storagePath);
    const engine = new LightweightPdfEngineAdapter();
    const parsedDocument = await engine.readDocument(absolutePath);
    const pdfText = buildPdfText(
      parsedDocument.pages.map((page) => ({
        pageNumber: page.pageNumber,
        extractedText: page.extractedText
      }))
    );

    if (!pdfText || pdfText.length < 30) {
      return NextResponse.json(
        { error: "Nao foi possivel extrair texto util do documento para reanalise." },
        { status: 422 }
      );
    }

    const enriched = await enrichCaseContextFromPdf({
      caseId: params.id,
      model: body.contextModel || process.env.OPENAI_CASE_CONTEXT_MODEL || "gpt-5.4",
      pdfText,
      overwriteExisting: body.overwriteExisting ?? true,
      source: "api/cases/documents/reanalyze",
      sourceDocument: {
        documentId: document.id,
        fileName: document.fileName
      }
    });

    await addCustodyEvent({
      caseId: params.id,
      actorId: session?.id,
      action: "CASE_INQUIRY_DOCUMENT_REANALYZED",
      source: "api/cases/documents/reanalyze",
      details: {
        documentId: document.id,
        fileName: document.fileName
      }
    });

    return NextResponse.json({
      success: true,
      caseId: params.id,
      documentId: document.id,
      contextInsightId: enriched.insightId,
      contextUpdatedFields: enriched.updatedFields
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao reanalisar documento do inquerito." },
      { status: 500 }
    );
  }
}
