import path from "node:path";
import { access } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  addCustodyEvent,
  enrichCaseContextFromUfdrMetadata,
  enrichExtractionMetadata,
  updateExtractionStatus
} from "@core/cases";
import { prisma } from "@core/db";
import {
  extractArchiveEntryToFile,
  parseUfdrReportXml,
  parseUfdrReportXmlStream,
  scanUfdrArchive
} from "@core/parsers";
import { requireApiSession } from "@/lib/api-auth";
import { mkdir, rm } from "node:fs/promises";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().uuid()
});

type OperationalAlertSeverity = "INFO" | "WARN" | "CRITICAL";
type OperationalAlert = { code: string; severity: OperationalAlertSeverity; message: string };

function severityRank(severity: OperationalAlertSeverity) {
  if (severity === "CRITICAL") return 3;
  if (severity === "WARN") return 2;
  return 1;
}

function buildEnrichmentAlertSnapshot(input: {
  parserDropped?: { chats?: number; messages?: number; audioFiles?: number };
  additionalAlerts?: OperationalAlert[];
}) {
  const alerts: OperationalAlert[] = [...(input.additionalAlerts ?? [])];
  const droppedChats = input.parserDropped?.chats ?? 0;
  const droppedMessages = input.parserDropped?.messages ?? 0;
  const droppedAudioFiles = input.parserDropped?.audioFiles ?? 0;

  if (droppedMessages > 0) {
    alerts.push({
      code: "PARSER_DROPPED_MESSAGES",
      severity: "CRITICAL",
      message: `Parser descartou ${droppedMessages} mensagens por limite configurado.`
    });
  }
  if (droppedChats > 0) {
    alerts.push({
      code: "PARSER_DROPPED_CHATS",
      severity: "CRITICAL",
      message: `Parser descartou ${droppedChats} chats por limite configurado.`
    });
  }
  if (droppedAudioFiles > 0) {
    alerts.push({
      code: "PARSER_DROPPED_AUDIO_FILES",
      severity: "WARN",
      message: `Parser descartou ${droppedAudioFiles} arquivos de Ã¡udio por limite configurado.`
    });
  }

  const highestSeverity = alerts.reduce<OperationalAlertSeverity | null>((current, alert) => {
    if (!current) return alert.severity;
    return severityRank(alert.severity) > severityRank(current) ? alert.severity : current;
  }, null);

  return {
    generatedAt: new Date().toISOString(),
    highestSeverity,
    alerts
  };
}

async function runEnrichment(
  extractionId: string,
  evidence: { id: string; caseId: string; originalPath: string; sha256: string | null; fileName: string },
  actorId: string,
  absoluteUfdrPath: string
) {
  try {
    await updateExtractionStatus(extractionId, "PROCESSING", {
      processingDetails: { phase: "enrich-abrindo-ufdr", progress: 5 },
      finishedAt: null
    });

    const scan = await scanUfdrArchive(absoluteUfdrPath);
    if (!scan.reportXmlPath) {
      const operationalAlertSnapshot = buildEnrichmentAlertSnapshot({
        additionalAlerts: [
          {
            code: "ENRICHMENT_REPORT_MISSING",
            severity: "CRITICAL",
            message: "report.xml não encontrado no UFDR para enriquecimento."
          }
        ]
      });
      await updateExtractionStatus(extractionId, "COMPLETED", {
        processingDetails: { phase: "enrich-falha", progress: 100, operationalAlertSnapshot },
        reportError: "report.xml nÃ£o encontrado no UFDR."
      });
      await addCustodyEvent({
        caseId: evidence.caseId,
        evidenceId: evidence.id,
        action: "ENRICHMENT_FAILED",
        source: "api/evidences/enrich",
        currentHash: evidence.sha256 ?? undefined,
        details: {
          extractionId,
          error: "report.xml não encontrado no UFDR.",
          operationalAlertSnapshot
        }
      });
      return;
    }

    await updateExtractionStatus(extractionId, "PROCESSING", {
      processingDetails: { phase: "enrich-parsing-xml", progress: 15 },
      finishedAt: null
    });

    let normalized;
    if (scan.reportXmlContent) {
      normalized = parseUfdrReportXml(scan.reportXmlContent);
    } else {
      const tmpDir = path.resolve(
        process.env.STORAGE_ROOT ?? "./storage",
        "tmp",
        "enrich",
        extractionId
      );
      await mkdir(tmpDir, { recursive: true });
      const reportTmpPath = path.resolve(tmpDir, "report.xml");
      await extractArchiveEntryToFile({
        ufdrAbsolutePath: absoluteUfdrPath,
        entryPath: scan.reportXmlPath,
        outputPath: reportTmpPath
      });
      try {
        normalized = await parseUfdrReportXmlStream(reportTmpPath);
      } finally {
        await rm(reportTmpPath, { force: true }).catch(() => undefined);
        await rm(tmpDir, { force: true, recursive: true }).catch(() => undefined);
      }
    }

    await updateExtractionStatus(extractionId, "PROCESSING", {
      processingDetails: { phase: "enrich-atualizando-dispositivo", progress: 40 },
      finishedAt: null
    });

    const rawMetadata = (normalized.rawMetadata ?? {}) as Record<string, unknown>;
    const parserDropped =
      rawMetadata.parserDropped && typeof rawMetadata.parserDropped === "object"
        ? (rawMetadata.parserDropped as { chats?: number; messages?: number; audioFiles?: number })
        : undefined;
    const operationalAlertSnapshot = buildEnrichmentAlertSnapshot({
      parserDropped
    });
    const ufdrCaseContext =
      rawMetadata.ufdrCaseContext && typeof rawMetadata.ufdrCaseContext === "object"
        ? (rawMetadata.ufdrCaseContext as {
            inquiryType?: string;
            inquiryNumber?: string;
            policeUnit?: string;
            inquiryLegalFraming?: string;
            inquirySummaryText?: string;
            inquiryMainFacts?: string;
            inquiryInvestigativeFocus?: string;
            extractionReportSummary?: string;
            inquiryInvolvedPeople?: string[];
          })
        : undefined;

    const caseContextUpdate = await enrichCaseContextFromUfdrMetadata({
      caseId: evidence.caseId,
      context: ufdrCaseContext
    });

    const result = await enrichExtractionMetadata({
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      extractionId,
      normalized
    });

    await updateExtractionStatus(extractionId, "PROCESSING", {
      processingDetails: { phase: "enrich-registrando-auditoria", progress: 90 },
      finishedAt: null
    });

    await addCustodyEvent({
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      actorId,
      action: "ENRICHMENT_COMPLETED",
      source: "api/evidences/enrich",
      currentHash: evidence.sha256 ?? undefined,
      details: {
        extractionId,
        deviceUpdated: result.deviceUpdated,
        userAccountsCreated: result.userAccountsCreated,
        locationsCreated: result.locationsCreated,
        timelineSynced: result.timelineSynced,
        ufdrCaseContextApplied: Boolean(caseContextUpdate),
        operationalAlertSnapshot
      }
    });

    await updateExtractionStatus(extractionId, "COMPLETED", {
      processingDetails: {
        phase: "enrich-concluido",
        progress: 100,
        enrichResult: {
          deviceUpdated: result.deviceUpdated,
          userAccountsCreated: result.userAccountsCreated,
          locationsCreated: result.locationsCreated,
          timelineSynced: result.timelineSynced,
          ufdrCaseContextApplied: Boolean(caseContextUpdate)
        },
        operationalAlertSnapshot
      },
      finishedAt: new Date()
    });
  } catch (error) {
    const operationalAlertSnapshot = buildEnrichmentAlertSnapshot({
      additionalAlerts: [
        {
          code: "ENRICHMENT_FAILED",
          severity: "CRITICAL",
          message: error instanceof Error ? error.message : "Falha desconhecida no enriquecimento."
        }
      ]
    });
    await updateExtractionStatus(extractionId, "COMPLETED", {
      processingDetails: {
        phase: "enrich-erro",
        progress: 100,
        enrichError: error instanceof Error ? error.message : "Falha desconhecida no enriquecimento.",
        operationalAlertSnapshot
      },
      finishedAt: new Date()
    }).catch(() => undefined);
    await addCustodyEvent({
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      action: "ENRICHMENT_FAILED",
      source: "api/evidences/enrich",
      currentHash: evidence.sha256 ?? undefined,
      details: {
        extractionId,
        error: error instanceof Error ? error.message : "Falha desconhecida no enriquecimento.",
        operationalAlertSnapshot
      }
    }).catch(() => undefined);
  }
}

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;

    const params = paramsSchema.parse(await context.params);
    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      include: { extraction: true }
    });
    if (!evidence) {
      return NextResponse.json({ error: "EvidÃªncia nÃ£o encontrada." }, { status: 404 });
    }

    const extraction = evidence.extraction;
    if (!extraction) {
      return NextResponse.json({ error: "ExtraÃ§Ã£o vinculada nÃ£o encontrada." }, { status: 409 });
    }
    if (extraction.status === "PROCESSING" || extraction.status === "INDEXING") {
      return NextResponse.json({ error: "ExtraÃ§Ã£o em andamento. Aguarde para enriquecer." }, { status: 409 });
    }

    const absoluteUfdrPath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", evidence.originalPath);
    try {
      await access(absoluteUfdrPath);
    } catch {
      return NextResponse.json({ error: "Arquivo da evidÃªncia nÃ£o encontrado no storage." }, { status: 404 });
    }

    // Set extraction to PROCESSING immediately so the SSE stream picks it up
    await updateExtractionStatus(extraction.id, "PROCESSING", {
      processingDetails: { phase: "enrich-iniciando", progress: 0 },
      finishedAt: null
    });

    // Fire and forget the enrichment â€” progress is tracked via extraction.processingDetails
    runEnrichment(extraction.id, {
      id: evidence.id,
      caseId: evidence.caseId,
      originalPath: evidence.originalPath,
      sha256: evidence.sha256,
      fileName: evidence.fileName
    }, auth.session.id, absoluteUfdrPath).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      extractionId: extraction.id
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao enriquecer metadados." },
      { status: 500 }
    );
  }
}

