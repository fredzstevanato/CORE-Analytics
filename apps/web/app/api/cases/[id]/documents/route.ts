import { NextResponse } from "next/server";
import { z } from "zod";
import { createCaseDocument, listCaseDocuments } from "@core/cases";
import { prisma } from "@core/db";
import { computeSha256FromBuffer } from "@core/forensics";
import { createStorageDriver } from "@core/storage";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

function sanitizeFileName(fileName: string) {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "case-document.pdf";
}

function serializeDocument(document: {
  id: string;
  caseId: string | null;
  type: string;
  title: string;
  fileName: string;
  mimeType: string | null;
  storagePath: string;
  sizeBytes: bigint;
  sha256: string;
  source: string | null;
  uploadedById: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...document,
    sizeBytes: document.sizeBytes.toString()
  };
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const documents = await listCaseDocuments(params.id);
    return NextResponse.json({ documents: documents.map(serializeDocument) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao listar documentos do caso." },
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
    const title = String(formData.get("title") || "").trim();
    const type = String(formData.get("type") || "SUPPORTING_DOCUMENT").trim();
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Arquivo invalido." }, { status: 400 });
    }

    const safeFileName = sanitizeFileName(file.name || "case-document.pdf");
    const bytes = Buffer.from(await file.arrayBuffer());
    const sha256 = await computeSha256FromBuffer(bytes);
    const storage = createStorageDriver();
    const documentId = crypto.randomUUID();
    const stored = await storage.saveCaseDocumentFile({
      caseId: params.id,
      documentId,
      originalFilename: safeFileName,
      buffer: bytes
    });

    const sessionUser = await getSessionUser();
    const document = await createCaseDocument({
      caseId: params.id,
      type:
        type === "INQUIRY_PDF" || type === "EXPERT_REPORT_PDF" || type === "CASE_NOTE_ATTACHMENT"
          ? type
          : "SUPPORTING_DOCUMENT",
      title: title || safeFileName,
      fileName: safeFileName,
      mimeType: file.type || "application/octet-stream",
      storagePath: stored.relativePath,
      sizeBytes: stored.sizeBytes,
      sha256,
      source: "CASE_DOCUMENT_UPLOAD",
      uploadedById: sessionUser?.id
    });

    return NextResponse.json({ document: serializeDocument(document) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao anexar documento ao caso." },
      { status: 500 }
    );
  }
}
