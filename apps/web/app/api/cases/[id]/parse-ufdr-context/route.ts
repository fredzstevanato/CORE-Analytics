import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent, enrichCaseContextFromUfdrMetadata } from "@core/cases";
import { extractArchiveEntryToFile, parseUfdrReportXml, parseUfdrReportXmlStream, scanUfdrArchive } from "@core/parsers";
import { prisma } from "@core/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z.object({
  evidenceId: z.string().uuid().optional()
});

type UfdrCaseContext = {
  inquiryType?: string;
  inquiryNumber?: string;
  policeUnit?: string;
  inquiryLegalFraming?: string;
  inquirySummaryText?: string;
  inquiryMainFacts?: string;
  inquiryInvestigativeFocus?: string;
  extractionReportSummary?: string;
  inquiryInvolvedPeople?: string[];
};

function asUfdrCaseContext(value: unknown): UfdrCaseContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  return {
    inquiryType: typeof row.inquiryType === "string" ? row.inquiryType : undefined,
    inquiryNumber: typeof row.inquiryNumber === "string" ? row.inquiryNumber : undefined,
    policeUnit: typeof row.policeUnit === "string" ? row.policeUnit : undefined,
    inquiryLegalFraming: typeof row.inquiryLegalFraming === "string" ? row.inquiryLegalFraming : undefined,
    inquirySummaryText: typeof row.inquirySummaryText === "string" ? row.inquirySummaryText : undefined,
    inquiryMainFacts: typeof row.inquiryMainFacts === "string" ? row.inquiryMainFacts : undefined,
    inquiryInvestigativeFocus:
      typeof row.inquiryInvestigativeFocus === "string" ? row.inquiryInvestigativeFocus : undefined,
    extractionReportSummary: typeof row.extractionReportSummary === "string" ? row.extractionReportSummary : undefined,
    inquiryInvolvedPeople: Array.isArray(row.inquiryInvolvedPeople)
      ? row.inquiryInvolvedPeople.filter((item): item is string => typeof item === "string")
      : undefined
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json().catch(() => ({})));

    const caseRow = await prisma.case.findUnique({
      where: { id: params.id },
      select: { id: true }
    });
    if (!caseRow) {
      return NextResponse.json({ error: "Caso nao encontrado." }, { status: 404 });
    }

    const evidence = body.evidenceId
      ? await prisma.evidence.findFirst({
          where: {
            id: body.evidenceId,
            caseId: params.id,
            extraction: { is: { sourceFormat: "UFDR" } }
          },
          include: { extraction: true }
        })
      : await prisma.evidence.findFirst({
          where: {
            caseId: params.id,
            extraction: { is: { sourceFormat: "UFDR" } }
          },
          include: { extraction: true },
          orderBy: { createdAt: "desc" }
        });

    if (!evidence?.extraction) {
      return NextResponse.json({ error: "Nao foi encontrada evidencia UFDR para este caso." }, { status: 404 });
    }

    const ufdrAbsolutePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", evidence.originalPath);
    const scan = await scanUfdrArchive(ufdrAbsolutePath);
    if (!scan.reportXmlPath) {
      return NextResponse.json({ error: "report.xml nao encontrado no arquivo UFDR." }, { status: 422 });
    }

    let normalized;
    if (scan.reportXmlContent) {
      normalized = parseUfdrReportXml(scan.reportXmlContent);
    } else {
      const tmpDir = path.resolve(
        process.env.STORAGE_ROOT ?? "./storage",
        "derived",
        params.id,
        evidence.id,
        "tmp"
      );
      await mkdir(tmpDir, { recursive: true });
      const reportTmpPath = path.resolve(tmpDir, `context-only-${evidence.extraction.id}-report.xml`);
      await extractArchiveEntryToFile({
        ufdrAbsolutePath,
        entryPath: scan.reportXmlPath,
        outputPath: reportTmpPath
      });
      try {
        normalized = await parseUfdrReportXmlStream(reportTmpPath);
      } finally {
        await rm(reportTmpPath, { force: true }).catch(() => undefined);
      }
    }

    const ufdrCaseContext = asUfdrCaseContext((normalized.rawMetadata as Record<string, unknown>)?.ufdrCaseContext);
    if (!ufdrCaseContext) {
      return NextResponse.json(
        { error: "UFDR lido, mas sem metadados de contexto suficientes para enriquecer o caso." },
        { status: 422 }
      );
    }

    const updatedCase = await enrichCaseContextFromUfdrMetadata({
      caseId: params.id,
      context: ufdrCaseContext
    });

    const session = await getSessionUser();
    await addCustodyEvent({
      caseId: params.id,
      evidenceId: evidence.id,
      actorId: session?.id,
      action: "UFDR_CONTEXT_PARSE_ONLY_COMPLETED",
      source: "api/cases/parse-ufdr-context",
      details: {
        evidenceId: evidence.id,
        extractionId: evidence.extraction.id,
        reportPath: scan.reportXmlPath
      }
    });

    return NextResponse.json({
      success: true,
      caseId: params.id,
      evidenceId: evidence.id,
      extractionId: evidence.extraction.id,
      reportPath: scan.reportXmlPath,
      ufdrCaseContext,
      updatedCase
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao parsear contexto UFDR do caso." },
      { status: 500 }
    );
  }
}

