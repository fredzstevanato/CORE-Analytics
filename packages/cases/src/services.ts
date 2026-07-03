import { prisma, Prisma } from "@core/db";
import type { ExtractionStatus, NormalizedExtraction } from "@core/shared";
import { createHash } from "node:crypto";
import { sanitizeJsonForDatabase, sanitizeTextForDatabase } from "./report-sanitize";

function parseOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

const PERSIST_MAX_CHATS = parseOptionalPositiveIntEnv("UFDR_PERSIST_MAX_CHATS");
const PERSIST_MAX_PARTICIPANTS_PER_CHAT = parseOptionalPositiveIntEnv("UFDR_PERSIST_MAX_PARTICIPANTS_PER_CHAT");
const PERSIST_MAX_MESSAGES_PER_CHAT = parseOptionalPositiveIntEnv("UFDR_PERSIST_MAX_MESSAGES_PER_CHAT");
const PERSIST_MAX_CONTACTS = parseOptionalPositiveIntEnv("UFDR_PERSIST_MAX_CONTACTS");
const PERSIST_MAX_CALLS = parseOptionalPositiveIntEnv("UFDR_PERSIST_MAX_CALLS");
const PERSIST_MAX_FILES = parseOptionalPositiveIntEnv("UFDR_PERSIST_MAX_FILES");

function applyOptionalLimit<T>(items: T[], limit?: number) {
  return typeof limit === "number" ? items.slice(0, limit) : items;
}

function asRecord(value: Prisma.InputJsonValue | undefined): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readNumberField(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringField(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deriveHotProgressFields(processingDetails: Prisma.InputJsonValue | undefined) {
  const details = asRecord(processingDetails);

  return {
    processingPhase: readStringField(details, "phase"),
    processingProgress: readNumberField(details, "progress"),
    audioExtractedCount:
      readNumberField(details, "audioExtractionProcessed") ??
      readNumberField(details, "audioRecoveryExtractedCount") ??
      readNumberField(details, "audioExtractedCount"),
    audioExtractedTotal:
      readNumberField(details, "audioExtractionTotal") ??
      readNumberField(details, "audioHintsCount") ??
      readNumberField(details, "audioRecoveryTargetProcessedCount"),
    audioRatePerMin:
      readNumberField(details, "audioExtractionRatePerMin") ?? readNumberField(details, "audioRecoveryFilesPerMin"),
    audioEtaSec: readNumberField(details, "audioExtractionEtaSec") ?? readNumberField(details, "audioRecoveryEtaSec"),
    audioLastArchivePath: readStringField(details, "audioExtractionLastArchivePath")
  };
}

const AUDIO_MIME_RE = /^audio\//i;
const AUDIO_EXT_RE = /\.(aac|amr|flac|m4a|mp3|ogg|opus|wav|wma)$/i;
const PATH_SPLIT_RE = /[\\/]/;

function isAttachmentMessageIdForeignKeyError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2003") return false;

  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const fieldName =
    typeof meta.field_name === "string"
      ? meta.field_name
      : typeof meta.constraint === "string"
        ? meta.constraint
        : "";

  return fieldName.includes("Attachment_messageId_fkey") || error.message.includes("Attachment_messageId_fkey");
}

export async function ensureDefaultUserAndCase() {
  const email = process.env.MOCK_USER_EMAIL ?? "analista@core.local";

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Analista Padrão",
      role: "ADMIN"
    }
  });

  const shouldCreateDefaultCase =
    (process.env.CORE_CREATE_DEFAULT_CASE ?? "false").toLowerCase() === "true";

  const investigationCase = shouldCreateDefaultCase
    ? await prisma.case.upsert({
        where: { caseNumber: "CASE-0001" },
        update: {},
        create: {
          caseNumber: "CASE-0001",
          title: "Caso Inicial UFDR",
          description: "Caso inicial para ingestão de arquivos UFDR.",
          ownerId: user.id
        }
      })
    : null;

  return { user, investigationCase };
}

export async function authenticateUser(email: string, passwordHashVerifier: (storedHash: string) => boolean) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.passwordHash) return null;
  if (!passwordHashVerifier(user.passwordHash)) return null;
  return user;
}

export class UfdrDuplicateAnalysisError extends Error {
  constructor(
    message: string,
    readonly duplicate: {
      evidenceId: string;
      extractionId: string;
      status: ExtractionStatus;
      fileName: string;
      createdAt: Date;
    }
  ) {
    super(message);
    this.name = "UfdrDuplicateAnalysisError";
  }
}

export async function findExistingUfdrAnalysisBySha(input: { caseId: string; sha256: string }) {
  return prisma.evidence.findFirst({
    where: {
      caseId: input.caseId,
      sha256: input.sha256,
      extraction: {
        status: {
          in: ["PENDING", "PROCESSING", "INDEXING", "COMPLETED"]
        }
      }
    },
    select: {
      id: true,
      fileName: true,
      createdAt: true,
      extraction: {
        select: {
          id: true,
          status: true
        }
      }
    },
    orderBy: {
      createdAt: "desc"
    }
  });
}

export async function registerEvidenceAndExtraction(input: {
  caseId: string;
  uploadedById: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  storedRelativePath: string;
}) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.evidence.findFirst({
      where: {
        caseId: input.caseId,
        sha256: input.sha256,
        extraction: {
          status: {
            in: ["PENDING", "PROCESSING", "INDEXING", "COMPLETED"]
          }
        }
      },
      select: {
        id: true,
        fileName: true,
        createdAt: true,
        extraction: {
          select: {
            id: true,
            status: true
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    if (existing?.extraction) {
      throw new UfdrDuplicateAnalysisError(
        "UFDR ja inserido para este caso e com analise em andamento/concluida.",
        {
          evidenceId: existing.id,
          extractionId: existing.extraction.id,
          status: existing.extraction.status,
          fileName: existing.fileName,
          createdAt: existing.createdAt
        }
      );
    }

    const evidence = await tx.evidence.create({
      data: {
        caseId: input.caseId,
        label: `UFDR - ${input.fileName}`,
        fileName: input.fileName,
        mimeType: input.mimeType,
        source: "Cellebrite UFDR",
        originalPath: input.storedRelativePath,
        sizeBytes: BigInt(input.sizeBytes),
        sha256: input.sha256,
        uploadedById: input.uploadedById
      }
    });

    const extraction = await tx.extraction.create({
      data: {
        caseId: input.caseId,
        evidenceId: evidence.id,
        status: "PENDING",
        sourceFormat: "UFDR"
      }
    });

    await tx.custodyEvent.create({
      data: {
        caseId: input.caseId,
        evidenceId: evidence.id,
        actorId: input.uploadedById,
        action: "EVIDENCE_REGISTERED",
        source: "web-upload",
        currentHash: input.sha256,
        details: {
          fileName: input.fileName,
          sizeBytes: input.sizeBytes,
          storagePath: input.storedRelativePath
        }
      }
    });

    return { evidence, extraction };
  });
}

export async function updateExtractionStatus(
  extractionId: string,
  status: ExtractionStatus,
  options?: {
    reportFound?: boolean;
    reportPath?: string | null;
    reportError?: string | null;
    processingDetails?: Prisma.InputJsonValue;
    processingPhase?: string;
    processingProgress?: number;
    audioExtractedCount?: number;
    audioExtractedTotal?: number;
    audioRatePerMin?: number;
    audioEtaSec?: number;
    audioLastArchivePath?: string;
    startedAt?: Date;
    finishedAt?: Date | null;
  }
) {
  const hotFields = deriveHotProgressFields(options?.processingDetails);

  return prisma.extraction.update({
    where: { id: extractionId },
    data: {
      status,
      reportFound: options?.reportFound,
      reportPath: options?.reportPath,
      reportError: options?.reportError,
      processingDetails: options?.processingDetails,
      processingPhase: options?.processingPhase ?? hotFields.processingPhase,
      processingProgress: options?.processingProgress ?? hotFields.processingProgress,
      audioExtractedCount: options?.audioExtractedCount ?? hotFields.audioExtractedCount,
      audioExtractedTotal: options?.audioExtractedTotal ?? hotFields.audioExtractedTotal,
      audioRatePerMin: options?.audioRatePerMin ?? hotFields.audioRatePerMin,
      audioEtaSec: options?.audioEtaSec ?? hotFields.audioEtaSec,
      audioLastArchivePath: options?.audioLastArchivePath ?? hotFields.audioLastArchivePath,
      startedAt: options?.startedAt,
      finishedAt: options?.finishedAt
    }
  });
}

export async function saveExtractionDevice(input: {
  extractionId: string;
  manufacturer?: string;
  model?: string;
  osVersion?: string;
  imei?: string;
  serialNumber?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  const existing = await prisma.device.findFirst({
    where: { extractionId: input.extractionId }
  });
  if (existing) {
    return prisma.device.update({
      where: { id: existing.id },
      data: {
        manufacturer: input.manufacturer ?? existing.manufacturer,
        model: input.model ?? existing.model,
        osVersion: input.osVersion ?? existing.osVersion,
        imei: input.imei ?? existing.imei,
        serialNumber: input.serialNumber ?? existing.serialNumber,
        metadata: input.metadata ?? existing.metadata ?? undefined
      }
    });
  }
  return prisma.device.create({
    data: {
      extractionId: input.extractionId,
      manufacturer: input.manufacturer,
      model: input.model,
      osVersion: input.osVersion,
      imei: input.imei,
      serialNumber: input.serialNumber,
      metadata: input.metadata
    }
  });
}

export async function listCases() {
  return prisma.case.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      evidences: { select: { id: true } }
    }
  });
}

export async function createCase(input: {
  caseNumber: string;
  title: string;
  description?: string;
  ownerId?: string;
  sourceType?: "MANUAL" | "PDF_IMPORT" | "AI_INTAKE" | "UFDR_CONTEXT";
  operationalStatus?: "DRAFT" | "UNDER_REVIEW" | "ACTIVE" | "CLOSED" | "ARCHIVED";
  inquiryType?: string;
  inquiryNumber?: string;
  policeUnit?: string;
  inquiryLegalFraming?: string;
  inquiryInvolvedPeople?: Prisma.InputJsonValue;
  inquirySummaryText?: string;
  inquiryMainFacts?: string;
  inquiryInvestigativeFocus?: string;
  initialContextSource?: string;
  extractionReportSummary?: string;
  reviewedAt?: Date;
  reviewedById?: string;
}) {
  return prisma.case.create({
    data: {
      caseNumber: input.caseNumber,
      title: input.title,
      description: input.description,
      ownerId: input.ownerId,
      sourceType: input.sourceType,
      operationalStatus: input.operationalStatus,
      inquiryType: input.inquiryType,
      inquiryNumber: input.inquiryNumber,
      policeUnit: input.policeUnit,
      inquiryLegalFraming: input.inquiryLegalFraming,
      inquiryInvolvedPeople: input.inquiryInvolvedPeople,
      inquirySummaryText: input.inquirySummaryText,
      inquiryMainFacts: input.inquiryMainFacts,
      inquiryInvestigativeFocus: input.inquiryInvestigativeFocus,
      initialContextSource: input.initialContextSource,
      extractionReportSummary: input.extractionReportSummary,
      reviewedAt: input.reviewedAt,
      reviewedById: input.reviewedById
    }
  });
}

export async function createManualCase(input: {
  caseNumber: string;
  title: string;
  description?: string;
  ownerId?: string;
  inquiryType?: string;
  inquiryNumber?: string;
  policeUnit?: string;
  inquiryLegalFraming: string;
  inquiryInvolvedPeople?: Prisma.InputJsonValue;
  inquirySummaryText?: string;
  inquiryMainFacts?: string;
  inquiryInvestigativeFocus?: string;
  initialContextSource?: string;
}) {
  return createCase({
    ...input,
    sourceType: "MANUAL",
    operationalStatus: "ACTIVE"
  });
}

export async function createCaseDocument(input: {
  caseId?: string;
  type: "INQUIRY_PDF" | "EXPERT_REPORT_PDF" | "SUPPORTING_DOCUMENT" | "CASE_NOTE_ATTACHMENT";
  title: string;
  fileName: string;
  mimeType?: string;
  storagePath: string;
  sizeBytes: number | bigint;
  sha256: string;
  source?: string;
  uploadedById?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.caseDocument.create({
    data: {
      caseId: input.caseId,
      type: input.type,
      title: input.title,
      fileName: input.fileName,
      mimeType: input.mimeType,
      storagePath: input.storagePath,
      sizeBytes: typeof input.sizeBytes === "bigint" ? input.sizeBytes : BigInt(input.sizeBytes),
      sha256: input.sha256,
      source: input.source,
      uploadedById: input.uploadedById,
      metadata: input.metadata
    }
  });
}

export async function listCaseDocuments(caseId: string) {
  return prisma.caseDocument.findMany({
    where: { caseId },
    orderBy: { createdAt: "desc" }
  });
}

export async function getCaseDocumentById(id: string) {
  return prisma.caseDocument.findUnique({
    where: { id }
  });
}

export async function createCaseImportSession(input: {
  sourceType?: "MANUAL" | "PDF_IMPORT" | "AI_INTAKE" | "UFDR_CONTEXT";
  status?: "PENDING_ANALYSIS" | "READY_FOR_REVIEW" | "CONFIRMED" | "DISCARDED" | "FAILED";
  documentId?: string;
  createdById?: string;
  draftPayload?: Prisma.InputJsonValue;
  pipelineSummary?: Prisma.InputJsonValue;
  errorMessage?: string;
}) {
  return prisma.caseImportSession.create({
    data: {
      sourceType: input.sourceType ?? "PDF_IMPORT",
      status: input.status ?? "PENDING_ANALYSIS",
      documentId: input.documentId,
      createdById: input.createdById,
      draftPayload: input.draftPayload,
      pipelineSummary: input.pipelineSummary,
      errorMessage: input.errorMessage
    }
  });
}

export async function updateCaseImportSessionDraft(input: {
  sessionId: string;
  draftPayload: Prisma.InputJsonValue;
  pipelineSummary?: Prisma.InputJsonValue;
  documentId?: string;
  status?: "PENDING_ANALYSIS" | "READY_FOR_REVIEW" | "CONFIRMED" | "DISCARDED" | "FAILED";
  errorMessage?: string | null;
}) {
  return prisma.caseImportSession.update({
    where: { id: input.sessionId },
    data: {
      draftPayload: input.draftPayload,
      pipelineSummary: input.pipelineSummary,
      documentId: input.documentId,
      status: input.status,
      errorMessage: input.errorMessage ?? undefined
    }
  });
}

export async function markCaseImportSessionReady(input: {
  sessionId: string;
  draftPayload: Prisma.InputJsonValue;
  pipelineSummary?: Prisma.InputJsonValue;
  documentId?: string;
}) {
  return prisma.caseImportSession.update({
    where: { id: input.sessionId },
    data: {
      draftPayload: input.draftPayload,
      pipelineSummary: input.pipelineSummary,
      documentId: input.documentId,
      status: "READY_FOR_REVIEW",
      errorMessage: null
    }
  });
}

export async function markCaseImportSessionFailed(input: {
  sessionId: string;
  pipelineSummary?: Prisma.InputJsonValue;
  documentId?: string;
  errorMessage: string;
}) {
  return prisma.caseImportSession.update({
    where: { id: input.sessionId },
    data: {
      pipelineSummary: input.pipelineSummary,
      documentId: input.documentId,
      status: "FAILED",
      errorMessage: input.errorMessage
    }
  });
}

export async function discardCaseImportSession(input: { sessionId: string }) {
  return prisma.caseImportSession.update({
    where: { id: input.sessionId },
    data: {
      status: "DISCARDED"
    }
  });
}

export async function listCaseImportSessions(status?: "PENDING_ANALYSIS" | "READY_FOR_REVIEW" | "CONFIRMED" | "DISCARDED" | "FAILED") {
  return prisma.caseImportSession.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      document: true,
      createdCase: true
    }
  });
}

export async function getCaseImportSessionById(id: string) {
  return prisma.caseImportSession.findUnique({
    where: { id },
    include: {
      document: true,
      createdCase: true
    }
  });
}

function normalizeDraftCaseString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean || fallback;
}

function deriveCaseTitleFromIdentifiers(input: {
  caseNumber?: string | null;
  inquiryNumber?: string | null;
  inquiryType?: string | null;
  fallbackTitle?: string | null;
}) {
  const normalizedInquiryNumber = normalizeDraftCaseString(input.inquiryNumber);
  const normalizedCaseNumber = normalizeDraftCaseString(input.caseNumber);
  const normalizedInquiryType = normalizeDraftCaseString(input.inquiryType).toUpperCase();
  const normalizedFallback = normalizeDraftCaseString(input.fallbackTitle);

  const primary = normalizedInquiryNumber || normalizedCaseNumber;
  if (primary) return primary;

  const fallbackPatterns: RegExp[] = [];
  if (normalizedInquiryType.includes("TCO")) {
    fallbackPatterns.push(/\b(TCO[\s:/-]*[A-Z0-9./-]+)\b/i);
  }
  if (normalizedInquiryType.includes("BOC")) {
    fallbackPatterns.push(/\b(BOC[\s:/-]*[A-Z0-9./-]+)\b/i);
  }
  fallbackPatterns.push(/\b((?:IP|INQ(?:UERITO)?|INQU[ÉE]RITO|TCO|BOC)[\s:/-]*[A-Z0-9./-]+)\b/i);

  for (const regex of fallbackPatterns) {
    const match = normalizedFallback.match(regex)?.[1]?.trim();
    if (match) return match;
  }

  return normalizedFallback || "Caso importado por PDF";
}

function normalizeDraftPeople(value: unknown): Prisma.InputJsonValue | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return filtered.length > 0 ? (filtered as Prisma.InputJsonValue) : undefined;
}

export async function confirmCaseImportSession(input: {
  sessionId: string;
  caseData: {
    caseNumber: string;
    title: string;
    description?: string;
    ownerId?: string;
    inquiryType?: string;
    inquiryNumber?: string;
    policeUnit?: string;
    inquiryLegalFraming?: string;
    inquiryInvolvedPeople?: Prisma.InputJsonValue;
    inquirySummaryText?: string;
    inquiryMainFacts?: string;
    inquiryInvestigativeFocus?: string;
    initialContextSource?: string;
    extractionReportSummary?: string;
    reviewedById?: string;
  };
}) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const session = await tx.caseImportSession.findUnique({
      where: { id: input.sessionId },
      include: { document: true }
    });
    if (!session) {
      throw new Error("Sessao de importacao nao encontrada.");
    }
    if (session.status !== "READY_FOR_REVIEW") {
      throw new Error("Sessao de importacao nao esta pronta para confirmacao.");
    }
    if (session.createdCaseId) {
      throw new Error("Sessao de importacao ja confirmada.");
    }

    const createdCase = await tx.case.create({
      data: {
        caseNumber: normalizeDraftCaseString(input.caseData.caseNumber),
        title: deriveCaseTitleFromIdentifiers({
          caseNumber: input.caseData.caseNumber,
          inquiryNumber: input.caseData.inquiryNumber,
          inquiryType: input.caseData.inquiryType,
          fallbackTitle: input.caseData.title
        }),
        description: normalizeDraftCaseString(input.caseData.description) || undefined,
        ownerId: input.caseData.ownerId,
        sourceType: "PDF_IMPORT",
        operationalStatus: "UNDER_REVIEW",
        inquiryType: normalizeDraftCaseString(input.caseData.inquiryType) || undefined,
        inquiryNumber: normalizeDraftCaseString(input.caseData.inquiryNumber) || undefined,
        policeUnit: normalizeDraftCaseString(input.caseData.policeUnit) || undefined,
        inquiryLegalFraming: normalizeDraftCaseString(input.caseData.inquiryLegalFraming) || undefined,
        inquiryInvolvedPeople: input.caseData.inquiryInvolvedPeople ?? normalizeDraftPeople((session.draftPayload as Record<string, unknown> | null)?.involvedPeople),
        inquirySummaryText: normalizeDraftCaseString(input.caseData.inquirySummaryText) || undefined,
        inquiryMainFacts: normalizeDraftCaseString(input.caseData.inquiryMainFacts) || undefined,
        inquiryInvestigativeFocus: normalizeDraftCaseString(input.caseData.inquiryInvestigativeFocus) || undefined,
        initialContextSource: input.caseData.initialContextSource ?? "PDF_IMPORT_REVIEW",
        extractionReportSummary: normalizeDraftCaseString(input.caseData.extractionReportSummary) || undefined,
        reviewedAt: new Date(),
        reviewedById: input.caseData.reviewedById
      }
    });

    if (session.documentId) {
      await tx.caseDocument.update({
        where: { id: session.documentId },
        data: {
          caseId: createdCase.id
        }
      });
    }

    const updatedSession = await tx.caseImportSession.update({
      where: { id: session.id },
      data: {
        status: "CONFIRMED",
        createdCaseId: createdCase.id,
        errorMessage: null
      }
    });

    return { session: updatedSession, case: createdCase };
  });
}

type ParsedSeizedObjectDraft = {
  label: string;
  objectType?: string;
  manufacturer?: string;
  model?: string;
  imei?: string;
  imei2?: string;
  iccid1?: string;
  iccid2?: string;
  serialNumber?: string;
  custodyTag?: string;
  sourceReference?: string;
  metadata?: Prisma.InputJsonValue;
};

function firstRegexGroup(value: string, regexes: RegExp[]) {
  for (const regex of regexes) {
    const match = regex.exec(value);
    const captured = match?.[1]?.trim();
    if (captured) return captured;
  }
  return undefined;
}

function hasDigit(value: string) {
  return /\d/.test(value);
}

function normalizeReportNumberCandidate(value?: string) {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  // Evita falso positivo textual (ex.: "perici") e mantém formatos típicos com números.
  if (!hasDigit(clean)) return undefined;
  return clean;
}

function sourceLineFromIndex(text: string, index: number) {
  if (!Number.isFinite(index) || index < 0) return undefined;
  const start = text.lastIndexOf("\n", index);
  const end = text.indexOf("\n", index);
  const line = text.slice(start >= 0 ? start + 1 : 0, end >= 0 ? end : text.length).replace(/\s+/g, " ").trim();
  return line || undefined;
}

function firstRegexGroupWithSource(value: string, regexes: RegExp[]) {
  for (const regex of regexes) {
    const match = regex.exec(value);
    const captured = match?.[1]?.trim();
    if (!captured) continue;
    const sourceReference = typeof match?.index === "number" ? sourceLineFromIndex(value, match.index) : undefined;
    return { value: captured, sourceReference };
  }
  return { value: undefined, sourceReference: undefined };
}

function detectAgency(text: string) {
  const agencies = [
    "POLITEC",
    "Policia Tecnica",
    "Polícia Técnica",
    "Pericia Oficial",
    "Perícia Oficial",
    "Instituto de Criminalistica",
    "Instituto de Criminalística"
  ];
  return agencies.find((agency) => text.toLowerCase().includes(agency.toLowerCase()));
}

function collapseSpacedLetters(value: string) {
  return value.replace(/(?:\b[\p{L}]\b(?:\s+|$)){4,}/gu, (segment) => segment.replace(/\s+/g, ""));
}

function normalizeExpertReportText(raw: string) {
  const withoutNulls = raw.replace(/\u0000/g, "");
  const withoutLocaleNoise = withoutNulls.replace(/\b(?:pt|br|en|es)-(?:pt|br|en|es)\b/gi, " ");
  const withoutHeaders = stripRepeatedHeadersAndFooters(withoutLocaleNoise);
  const collapsedLetters = collapseSpacedLetters(withoutHeaders);
  const collapsedWhitespace = collapsedLetters.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  return collapsedWhitespace.trim();
}

function stripRepeatedHeadersAndFooters(text: string) {
  const headerFooterPatterns = [
    /^[ \t]*estado\s+de\s+\S[\s\S]*?$/gim,
    /^[ \t]*secret[aá]ria\s+de\s+estado\s+de\s+seguran[cç]a[\s\S]*?$/gim,
    /^[ \t]*per[ií]cia\s+oficial\s+e\s+identifica[cç][aã]o\s+t[eé]cnica[\s\S]*?$/gim,
    /^[ \t]*diretoria\s+(?:metropolitana|regional|geral)\s+de\s+criminal[ií]stica[\s\S]*?$/gim,
    /^[ \t]*ger[eê]ncia\s+(?:de\s+)?(?:per[ií]cias?|computa[cç][aã]o|inform[aá]tica)[\s\S]*?$/gim,
    /^[ \t]*politec[\s\-–]*(?:ger[eê]ncia|diretoria|superintend[eê]ncia)?[\s\S]*?$/gim,
    /^[ \t]*instituto\s+de\s+criminal[ií]stica[\s\S]*?$/gim,
    /^[ \t]*pol[ií]cia\s+(?:civil|cient[ií]fica|t[eé]cnico[\s-]cient[ií]fica)[\s\S]*?$/gim,
    /^[ \t]*superintend[eê]ncia\s+(?:de\s+)?(?:pol[ií]cia|per[ií]cia)[\s\S]*?$/gim,
    /^[ \t]*n[uú]cleo\s+(?:de\s+)?(?:per[ií]cia|inform[aá]tica|computa[cç][aã]o)[\s\S]*?$/gim,
    /^[ \t]*p[aá]gina\s+\d+\s+de\s+\d+\s*$/gim,
    /^[ \t]*\d+\s*\/\s*\d+\s*$/gim,
    /^[ \t]*[-–—_]{5,}\s*$/gim,
  ];
  let result = text;
  for (const pattern of headerFooterPatterns) {
    result = result.replace(pattern, "");
  }
  return result;
}

function buildExpertReportSummary(lines: string[]) {
  const prioritized = lines.filter((line) =>
    /(laudo|per[ií]cia|objeto|aparelho|celular|imei|iccid|serial|conclus[aã]o|resultado)/i.test(line)
  );
  const source = prioritized.length > 0 ? prioritized : lines;
  return source.slice(0, 5).join(" ").slice(0, 1200) || undefined;
}

function detectObjectType(line: string) {
  const lower = line.toLowerCase();
  if (lower.includes("celular") || lower.includes("smartphone") || lower.includes("iphone")) return "CELULAR";
  if (lower.includes("tablet")) return "TABLET";
  if (lower.includes("notebook") || lower.includes("laptop")) return "NOTEBOOK";
  if (lower.includes("chip") || lower.includes("sim")) return "SIM_CARD";
  if (lower.includes("hd") || lower.includes("ssd") || lower.includes("pendrive")) return "MIDIA";
  return "OBJETO_APREENDIDO";
}

function extractManufacturer(line: string) {
  const candidates = [
    "Apple",
    "Samsung",
    "Motorola",
    "Xiaomi",
    "LG",
    "Nokia",
    "Lenovo",
    "Dell",
    "Asus",
    "Acer",
    "Huawei"
  ];
  return candidates.find((candidate) => line.toLowerCase().includes(candidate.toLowerCase()));
}

function extractModel(line: string, manufacturer?: string) {
  const normalized = line.replace(/\s+/g, " ").trim();
  const explicitModel = firstRegexGroup(normalized, [
    /modelo\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9._\-/ ]*[A-Za-z0-9])/i,
    /m\s*o\s*d\s*e\s*l\s*o\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9._\-/ ]*[A-Za-z0-9])/i,
    /model\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9._\-/ ]*[A-Za-z0-9])/i
  ]);
  const cleaned = explicitModel
    ?.replace(/\s*(apresentando|cor\b|na\b|nas\b|de\b|com\b|sem\b|acompanhado|contendo|,).*/i, "")
    .replace(/[,;.\s]+$/, "")
    .trim();
  if (cleaned && cleaned.length >= 2 && cleaned.length <= 60) return cleaned;
  if (!manufacturer) return undefined;
  const regex = new RegExp(`${manufacturer}[,]?\\s+([A-Za-z0-9][A-Za-z0-9._\\-/ ]*[A-Za-z0-9])`, "i");
  const match = regex.exec(normalized)?.[1]
    ?.replace(/\s*(apresentando|cor\b|na\b|nas\b|de\b|com\b|sem\b|acompanhado|contendo|,).*/i, "")
    .replace(/[,;.\s]+$/, "")
    .trim();
  return match && match.length >= 2 && match.length <= 60 ? match : undefined;
}

function collectImeiValues(text: string) {
  const imeis = new Set<string>();
  const iccidValues = new Set<string>();
  for (const m of text.matchAll(/iccid(?:s)?\s*[:\-]?\s*([0-9]{15,25})/gi)) {
    const digits = (m[1] ?? "").replace(/\D/g, "");
    if (digits.length >= 15) iccidValues.add(digits);
  }
  const explicitMatches = text.matchAll(/imei(?:s)?\s*[:\-]?\s*([0-9]{14,17}(?:\s*e\s*[0-9]{14,17})*)/gi);
  for (const match of explicitMatches) {
    const group = match[1] ?? "";
    const values = group.match(/[0-9]{14,17}/g) ?? [];
    for (const value of values) {
      if (!isSubstringOfAny(value, iccidValues)) imeis.add(value);
    }
  }
  const spacedKeywordMatches = text.matchAll(/i\s*m\s*e\s*i(?:s)?\s*[:\-]?\s*([0-9\s]{14,80})/gi);
  for (const match of spacedKeywordMatches) {
    const group = match[1] ?? "";
    const values = group.match(/[0-9]{14,17}/g) ?? [];
    for (const value of values) {
      if (!isSubstringOfAny(value, iccidValues)) imeis.add(value);
    }
  }
  if (imeis.size === 0 && /imei/i.test(text)) {
    const fallback = text.match(/[0-9]{15}/g) ?? [];
    for (const value of fallback) {
      if (!isSubstringOfAny(value, iccidValues)) imeis.add(value);
    }
  }
  return [...imeis];
}

function isSubstringOfAny(value: string, candidates: Set<string>) {
  for (const candidate of candidates) {
    if (candidate.includes(value)) return true;
  }
  return false;
}

function collectIccidValues(text: string) {
  const iccids = new Set<string>();
  const explicitMatches = text.matchAll(/iccid(?:s)?\s*[:\-]?\s*([0-9]{15,25}(?:\s*e\s*[0-9]{15,25})*)/gi);
  for (const match of explicitMatches) {
    const group = match[1] ?? "";
    const values = group.match(/[0-9]{15,25}/g) ?? [];
    for (const value of values) iccids.add(value);
  }
  const spacedKeywordMatches = text.matchAll(/i\s*c\s*c\s*i\s*d(?:s)?\s*[:\-]?\s*([0-9\s]{15,100})/gi);
  for (const match of spacedKeywordMatches) {
    const group = match[1] ?? "";
    const values = group.match(/[0-9]{15,25}/g) ?? [];
    for (const value of values) iccids.add(value);
  }
  return [...iccids];
}

function collectExplicitObjetoBlocks(text: string) {
  const normalized = text.replace(/\r/g, "\n");
  const headerPattern = /(?:^|\n)\s*(?:objeto|o\s*b\s*j\s*e\s*t\s*o)\s*0?\d{1,2}\s*[:\-]/gi;
  const headers: Array<{ index: number }> = [];
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerPattern.exec(normalized)) !== null) {
    headers.push({ index: headerMatch.index });
  }
  if (headers.length === 0) return [];

  const blocks: string[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i]!.index;
    const end = i + 1 < headers.length ? headers[i + 1]!.index : Math.min(start + 1500, normalized.length);
    let raw = normalized.slice(start, end);
    const sectionBreak = raw.search(/\n\s*\d{1,2}\s*\.\s*(?:D[OA]S?\s|CONCLUS|HIST[OÓ]RICO|CONSIDERA|INTRODU[CÇ]|METOD|PROCEDIMENT)/i);
    if (sectionBreak > 0) raw = raw.slice(0, sectionBreak);
    raw = raw.replace(/\s+/g, " ").trim();
    if (raw.length >= 20) blocks.push(raw.slice(0, 1200));
  }

  return blocks
    .filter((block) => /(imei|iccid|serial|celular|aparelho|smartphone|modelo|marca|samsung|iphone|motorola|xiaomi|lg\b|nokia|huawei|lenovo)/i.test(block))
    .slice(0, 30);
}

function collectHashTokens(text: string) {
  const rows: Array<{ algorithm?: string; value: string }> = [];
  const seen = new Set<string>();
  const matches = text.matchAll(
    /\b(hash|sha-?256|sha-?1|md5)\b[^\S\r\n]*[:=]?[^\S\r\n]*([A-Za-z0-9._/-]{8,128})/gi
  );
  for (const match of matches) {
    const algorithm = (match[1] ?? "").toUpperCase().replace("-", "");
    const value = (match[2] ?? "").trim();
    const key = `${algorithm}|${value}`.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    rows.push({ algorithm, value });
  }

  const sequenceMatches = text.matchAll(/\bhash(?:es)?\b\s*[:\-]\s*([^\n]+)/gi);
  for (const match of sequenceMatches) {
    const tail = (match[1] ?? "").trim();
    if (!tail) continue;
    const values = tail.match(/[A-Fa-f0-9]{16,128}/g) ?? [];
    for (const value of values) {
      const key = `HASH|${value}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ algorithm: "HASH", value });
    }
  }
  return rows;
}

function isReportBoilerplate(block: string) {
  const trimmed = block.trim();
  if (/^\d{1,2}\s*\.\s*(d[oa]s?\s+exam|hist[oó]rico|conclus|considera[cç]|d[oa]s?\s+fatos|prelimin|introdu[cç]|metod|procediment)/i.test(trimmed)) return true;
  if (/^(secret[aá]ria\s+de\s+estado|pol[ií]cia\s+(civil|cient|t[eé]cnic)|estado\s+de\s+)/i.test(trimmed)) return true;
  if (/^p[aá]gina\s+\d+\s+de\s+\d+/i.test(trimmed)) return true;
  if (/^conforme\s+solicitado\s+pela\s+autoridade/i.test(trimmed)) return true;
  if (/^procedeu-se\s+(a|à)s?\s+tentativas?\s+de\s+extra[cç][aã]o/i.test(trimmed)) return true;
  if (!/(imei|iccid|serial|s\/n|celular|aparelho|smartphone|marca|modelo|tablet|notebook|chip)/i.test(block)) return true;
  return false;
}

function collectSeizedObjectParagraphCandidates(text: string) {
  const normalized = text.replace(/\r/g, "");
  const explicitObjetoBlocks = collectExplicitObjetoBlocks(normalized);
  if (explicitObjetoBlocks.length > 0) return explicitObjetoBlocks.filter((b) => !isReportBoilerplate(b));

  const explicitObjectRows = [
    ...normalized.matchAll(/(?:^|\n)\s*objeto\s*\d{1,2}\s*[:\-]\s*[\s\S]{0,520}(?=\n\s*objeto\s*\d{1,2}\s*[:\-]|$)/gim),
    ...normalized.matchAll(/objeto\s*\d{1,2}\s*[:\-]\s*[\s\S]{20,520}?(?=(?:objeto\s*\d{1,2}\s*[:\-])|$)/gim)
  ]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter((row) => /(imei|iccid|serial|celular|aparelho|smartphone|modelo|marca)/i.test(row))
    .filter((row) => !isReportBoilerplate(row));
  if (explicitObjectRows.length > 0) return explicitObjectRows.slice(0, 20);

  const numberedObjects = [...normalized.matchAll(/(?:^|\n)\s*\d{1,2}\s*\([^)]+\)\s*[\s\S]{0,420}(?=\n\s*\d{1,2}\s*\([^)]+\)|$)/gim)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter((block) => /(objeto|aparelho|celular|smartphone|iphone|tablet|notebook|imei|serial)/i.test(block))
    .filter((block) => !isReportBoilerplate(block));
  if (numberedObjects.length > 0) return numberedObjects.slice(0, 20);

  const blocks = normalized
    .split(/\n\s*\n/g)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const scopedBlocks = blocks.filter((block) =>
    /(objeto|aparelho|celular|smartphone|iphone|tablet|notebook|laptop|imei|serial|material apreendido)/i.test(block) &&
    !isReportBoilerplate(block)
  );
  if (scopedBlocks.length > 0) return scopedBlocks.slice(0, 20);

  const sentenceLike = normalized
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) =>
      /(objeto|aparelho|celular|smartphone|iphone|tablet|notebook|laptop|imei|serial|material apreendido)/i.test(line) &&
      !isReportBoilerplate(line)
    );
  return sentenceLike.slice(0, 30);
}

function dedupeSeizedObjects(items: ParsedSeizedObjectDraft[]) {
  const seen = new Set<string>();
  const rows: ParsedSeizedObjectDraft[] = [];
  for (const item of items) {
    const key = [item.label, item.imei, item.imei2, item.iccid1, item.iccid2, item.serialNumber, item.model]
      .map((value) => value ?? "")
      .join("|")
      .toLowerCase();
    if (!item.label.trim() || seen.has(key)) continue;
    seen.add(key);
    rows.push(item);
  }
  return rows;
}

function buildSeizedObjectLabel(line: string) {
  const headerMatch = line.match(/(?:objeto|o\s*b\s*j\s*e\s*t\s*o)\s*\d{1,2}\s*[:\-]\s*/i);
  if (headerMatch) {
    const afterHeader = line.slice((headerMatch.index ?? 0) + headerMatch[0].length).trim();
    if (afterHeader.length >= 10) return afterHeader.replace(/\s+/g, " ").trim().slice(0, 500);
  }
  const concise = firstRegexGroup(line, [
    /(?:objeto|o\s*b\s*j\s*e\s*t\s*o)\s*\d{1,2}\s*[:\-]\s*(.{10,500})/i,
    /objeto\s*\d{1,2}\s*[:\-]\s*(.{10,500})/i,
    /\d{1,2}\s*\([^)]+\)\s*(.{10,500})/i,
    /(objeto.{10,500})/i,
    /(aparelho.{10,500})/i,
    /(celular.{10,500})/i
  ]);
  const base = concise || line;
  return base.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function extractExpertReportContextFromText(input: { text: string }) {
  const text = normalizeExpertReportText(input.text).replace(/\r/g, "").trim();
  const lines = text
    .split("\n")
    .map((line) => collapseSpacedLetters(line))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const reportNumber = normalizeReportNumberCandidate(
    firstRegexGroup(text, [
      /n[uú]mero\s+do\s+laudo\s*[:\-]?\s*([A-Z0-9./-]+)/i,
    /laudo(?: pericial)?\s*(?:n[ºo°.]*)?\s*[:\-]?\s*([A-Z0-9./-]+)/i,
    /relat[oó]rio(?: pericial)?\s*(?:n[ºo°.]*)?\s*[:\-]?\s*([A-Z0-9./-]+)/i,
    /documento\s*(?:n[ºo°.]*)?\s*[:\-]?\s*([A-Z0-9./-]+)/i
    ])
  );

  const protocol = firstRegexGroupWithSource(text, [
    /n[uú]mero de protocolo\s*[:\-]?\s*([0-9./-]+)/i,
    /protocolo\s*[:\-]?\s*([0-9./-]{5,})/i
  ]);
  const authority = firstRegexGroupWithSource(text, [
    /autoridade\s+(?:solicitante|requisitante)\s*[:\-]?\s*([^\n]+)/i,
    /(?:solicitante|requisitante)\s*[:\-]?\s*([^\n]+)/i
  ]);
  const referenceIp = firstRegexGroupWithSource(text, [/refer[eê]ncias?\s*[:\-]?\s*([^\n]+)/i]);
  const nature = firstRegexGroupWithSource(text, [/natureza da per[ií]cia\s*[:\-]?\s*([^\n]+)/i]);
  const requestedAt = firstRegexGroupWithSource(text, [/data da solicita[cç][aã]o\s*[:\-]?\s*([^\n]+)/i]);
  const destination = firstRegexGroupWithSource(text, [/destino do laudo\s*[:\-]?\s*([^\n]+)/i]);

  const examinerName = firstRegexGroup(text, [
    /perito(?:\(a\))?(?: oficial)?\s*[:\-]\s*([^\n]+)/i,
    /examiner\s*[:\-]\s*([^\n]+)/i
  ]);

  const summary = buildExpertReportSummary(lines);
  const issuingAgency = detectAgency(text);
  const seizedCandidates = collectSeizedObjectParagraphCandidates(text);
  const hashes = collectHashTokens(text);

  const seizedObjects = dedupeSeizedObjects(
    seizedCandidates.slice(0, 30).map((line) => {
      const manufacturer = extractManufacturer(line);
      const imeis = collectImeiValues(line);
      const iccids = collectIccidValues(line);
      return {
        label: buildSeizedObjectLabel(line),
        objectType: detectObjectType(line),
        manufacturer,
        model: extractModel(line, manufacturer),
        imei: imeis[0],
        imei2: imeis[1],
        iccid1: iccids[0],
        iccid2: iccids[1],
        serialNumber: firstRegexGroup(line, [
          /(?:serial|s\/n|n[uú]mero\s+de\s+s[eé]rie)\s*[:\-]?\s*([A-Z0-9-]{4,})/i
        ]),
        custodyTag: firstRegexGroup(line, [
          /(?:lacre|etiqueta|tag)\s*(?:n[ºo°.]?)?\s*[:\-]?\s*([A-Z0-9./-]{3,})/i
        ]),
        sourceReference: line.slice(0, 240),
        metadata: {
          parsedFrom: "expert-report-text",
          sourceLine: line,
          imeis,
          iccids,
          hashes
        } as Prisma.InputJsonValue
      };
    })
  );

  const descriptiveNotes = [
    reportNumber ? `Laudo: ${reportNumber}` : null,
    protocol.value ? `Protocolo: ${protocol.value}` : null,
    authority.value ? `Autoridade solicitante: ${authority.value}` : null,
    referenceIp.value ? `Referencia/IP: ${referenceIp.value}` : null,
    nature.value ? `Natureza: ${nature.value}` : null,
    requestedAt.value ? `Data da solicitacao: ${requestedAt.value}` : null,
    destination.value ? `Destino: ${destination.value}` : null,
    issuingAgency ? `Orgao emissor: ${issuingAgency}` : null,
    examinerName ? `Perito: ${examinerName}` : null,
    hashes.length > 0
      ? `Hashes identificados: ${hashes
          .map((item) => (item.algorithm ? `${item.algorithm}=${item.value}` : item.value))
          .join(" | ")}`
      : "Hashes identificados: nenhum no texto",
    seizedObjects.length > 0 ? `Objetos apreendidos extraidos: ${seizedObjects.length}` : "Objetos apreendidos extraidos: nenhum"
  ].filter(Boolean) as string[];

  return {
    reportNumber,
    issuingAgency,
    examinerName,
    summary,
    seizedObjects,
    parsedPayload: {
      lineCount: lines.length,
      seizedObjectCount: seizedObjects.length,
      hashes,
      politec: {
        reportNumber,
        protocol: protocol.value,
        authority: authority.value,
        referenceIp: referenceIp.value,
        nature: nature.value,
        requestedAt: requestedAt.value,
        destination: destination.value,
        sourceReferences: {
          protocol: protocol.sourceReference,
          authority: authority.sourceReference,
          referenceIp: referenceIp.sourceReference,
          nature: nature.sourceReference,
          requestedAt: requestedAt.sourceReference,
          destination: destination.sourceReference
        }
      },
      descriptiveNotes
    } as Prisma.InputJsonValue
  };
}

export async function createExpertReport(input: {
  caseId: string;
  caseDocumentId?: string;
  uploadedById?: string;
  status?: "UPLOADED" | "PARSED" | "REVIEWED";
  title: string;
  reportNumber?: string;
  issuingAgency?: string;
  examinerName?: string;
  issuedAt?: Date;
  summary?: string;
  parsedPayload?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.expertReport.create({
    data: {
      caseId: input.caseId,
      caseDocumentId: input.caseDocumentId,
      uploadedById: input.uploadedById,
      status: input.status,
      title: input.title,
      reportNumber: input.reportNumber,
      issuingAgency: input.issuingAgency,
      examinerName: input.examinerName,
      issuedAt: input.issuedAt,
      summary: input.summary,
      parsedPayload: input.parsedPayload,
      metadata: input.metadata
    }
  });
}

export async function listCaseExpertReports(caseId: string) {
  return prisma.expertReport.findMany({
    where: { caseId },
    orderBy: { createdAt: "desc" },
    include: {
      caseDocument: true,
      seizedObjects: true,
      expertIdentifiers: true,
      deviceMatches: true
    }
  });
}

export async function createSeizedObject(input: {
  caseId: string;
  expertReportId?: string;
  label: string;
  objectType?: string;
  manufacturer?: string;
  model?: string;
  imei?: string;
  imei2?: string;
  iccid1?: string;
  iccid2?: string;
  serialNumber?: string;
  custodyTag?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.seizedObject.create({
    data: {
      caseId: input.caseId,
      expertReportId: input.expertReportId,
      label: input.label,
      objectType: input.objectType,
      manufacturer: input.manufacturer,
      model: input.model,
      imei: input.imei,
      imei2: input.imei2,
      iccid1: input.iccid1,
      iccid2: input.iccid2,
      serialNumber: input.serialNumber,
      custodyTag: input.custodyTag,
      metadata: input.metadata
    }
  });
}

export async function listCaseSeizedObjects(caseId: string) {
  return prisma.seizedObject.findMany({
    where: { caseId },
    orderBy: { createdAt: "desc" },
    include: {
      expertReport: true,
      matchedDevices: {
        include: {
          extraction: {
            include: {
              evidence: true
            }
          }
        }
      },
      deviceMatches: true,
      expertIdentifiers: true
    }
  });
}

function normalizeIdentifierValue(value?: string | null) {
  return (value ?? "").replace(/\s+/g, "").trim().toLowerCase();
}

function buildExpertReportIdentifierRows(input: {
  caseId: string;
  reportId: string;
  reportNumber?: string;
  protocol?: string;
  hashes?: Array<{ algorithm?: string; value?: string }>;
  seizedObjects: Array<{
    id: string;
    imei?: string | null;
    imei2?: string | null;
    iccid1?: string | null;
    iccid2?: string | null;
    serialNumber?: string | null;
    sourceReference?: string;
  }>;
}) {
  const rows: Array<{
    caseId: string;
    expertReportId: string;
    seizedObjectId?: string;
    kind: string;
    algorithm?: string;
    value: string;
    normalizedValue: string;
    sourceReference?: string;
    confidence?: number;
    metadata?: Prisma.InputJsonValue;
  }> = [];
  const seen = new Set<string>();
  const push = (row: {
    seizedObjectId?: string;
    kind: string;
    algorithm?: string;
    value?: string | null;
    sourceReference?: string;
    confidence?: number;
    metadata?: Prisma.InputJsonValue;
  }) => {
    const value = (row.value ?? "").trim();
    if (!value) return;
    const normalizedValue = normalizeIdentifierValue(value);
    const key = `${row.seizedObjectId ?? ""}|${row.kind}|${normalizedValue}|${row.algorithm ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      caseId: input.caseId,
      expertReportId: input.reportId,
      seizedObjectId: row.seizedObjectId,
      kind: row.kind,
      algorithm: row.algorithm,
      value,
      normalizedValue,
      sourceReference: row.sourceReference,
      confidence: row.confidence,
      metadata: row.metadata
    });
  };

  push({ kind: "REPORT_NUMBER", value: input.reportNumber, confidence: 0.95 });
  push({ kind: "PROTOCOL", value: input.protocol, confidence: 0.95 });
  for (const hash of input.hashes ?? []) {
    push({
      kind: "HASH",
      algorithm: hash.algorithm?.toUpperCase(),
      value: hash.value,
      confidence: 0.99
    });
  }
  for (const object of input.seizedObjects) {
    push({ seizedObjectId: object.id, kind: "IMEI", value: object.imei, sourceReference: object.sourceReference, confidence: 0.98 });
    push({ seizedObjectId: object.id, kind: "IMEI", value: object.imei2, sourceReference: object.sourceReference, confidence: 0.98 });
    push({ seizedObjectId: object.id, kind: "ICCID", value: object.iccid1, sourceReference: object.sourceReference, confidence: 0.97 });
    push({ seizedObjectId: object.id, kind: "ICCID", value: object.iccid2, sourceReference: object.sourceReference, confidence: 0.97 });
    push({ seizedObjectId: object.id, kind: "SERIAL", value: object.serialNumber, sourceReference: object.sourceReference, confidence: 0.97 });
  }
  return rows;
}

function scoreDeviceObjectMatch(input: {
  device: { manufacturer?: string | null; model?: string | null; imei?: string | null; serialNumber?: string | null };
  object: {
    manufacturer?: string | null;
    model?: string | null;
    imei?: string | null;
    imei2?: string | null;
    serialNumber?: string | null;
  };
}) {
  let score = 0;
  const reasons: string[] = [];
  const deviceImei = normalizeIdentifierValue(input.device.imei);
  const objectImeiA = normalizeIdentifierValue(input.object.imei);
  const objectImeiB = normalizeIdentifierValue(input.object.imei2);
  if (deviceImei && (deviceImei === objectImeiA || deviceImei === objectImeiB)) {
    score += 0.7;
    reasons.push("IMEI coincidente");
  }
  const deviceSerial = normalizeIdentifierValue(input.device.serialNumber);
  const objectSerial = normalizeIdentifierValue(input.object.serialNumber);
  if (deviceSerial && objectSerial && deviceSerial === objectSerial) {
    score += 0.45;
    reasons.push("Serial coincidente");
  }
  const deviceManufacturer = (input.device.manufacturer ?? "").trim().toLowerCase();
  const objectManufacturer = (input.object.manufacturer ?? "").trim().toLowerCase();
  if (deviceManufacturer && objectManufacturer && deviceManufacturer === objectManufacturer) {
    score += 0.15;
    reasons.push("Fabricante coincidente");
  }
  const deviceModel = (input.device.model ?? "").trim().toLowerCase();
  const objectModel = (input.object.model ?? "").trim().toLowerCase();
  if (deviceModel && objectModel && (deviceModel.includes(objectModel) || objectModel.includes(deviceModel))) {
    score += 0.2;
    reasons.push("Modelo compatível");
  }
  if (score > 1) score = 1;
  return { score, reasons };
}

export async function createExpertReportWithObjects(input: {
  caseId: string;
  caseDocumentId?: string;
  uploadedById?: string;
  title: string;
  reportNumber?: string;
  issuingAgency?: string;
  examinerName?: string;
  summary?: string;
  parsedPayload?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
  seizedObjects?: ParsedSeizedObjectDraft[];
}) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const report = await tx.expertReport.create({
      data: {
        caseId: input.caseId,
        caseDocumentId: input.caseDocumentId,
        uploadedById: input.uploadedById,
        title: input.title,
        reportNumber: input.reportNumber,
        issuingAgency: input.issuingAgency,
        examinerName: input.examinerName,
        summary: input.summary,
        parsedPayload: input.parsedPayload,
        metadata: input.metadata,
        status: input.seizedObjects && input.seizedObjects.length > 0 ? "PARSED" : "UPLOADED"
      }
    });

    let createdSeizedObjects: Array<{
      id: string;
      imei?: string | null;
      imei2?: string | null;
      iccid1?: string | null;
      iccid2?: string | null;
      serialNumber?: string | null;
      sourceReference?: string;
      manufacturer?: string | null;
      model?: string | null;
    }> = [];

    if (input.seizedObjects && input.seizedObjects.length > 0) {
      for (const item of input.seizedObjects) {
        const created = await tx.seizedObject.create({
          data: {
            caseId: input.caseId,
            expertReportId: report.id,
            label: item.label,
            objectType: item.objectType,
            manufacturer: item.manufacturer,
            model: item.model,
            imei: item.imei,
            imei2: item.imei2,
            iccid1: item.iccid1,
            iccid2: item.iccid2,
            serialNumber: item.serialNumber,
            custodyTag: item.custodyTag,
            metadata: item.metadata
          }
        });
        createdSeizedObjects.push({
          id: created.id,
          imei: created.imei,
          imei2: created.imei2,
          iccid1: created.iccid1,
          iccid2: created.iccid2,
          serialNumber: created.serialNumber,
          sourceReference: item.sourceReference,
          manufacturer: created.manufacturer,
          model: created.model
        });
      }
    }

    const parsedPayloadRecord =
      input.parsedPayload && typeof input.parsedPayload === "object"
        ? (input.parsedPayload as Record<string, unknown>)
        : undefined;
    const politecRecord =
      parsedPayloadRecord?.politec && typeof parsedPayloadRecord.politec === "object"
        ? (parsedPayloadRecord.politec as Record<string, unknown>)
        : undefined;
    const hashRows = Array.isArray(parsedPayloadRecord?.hashes)
      ? (parsedPayloadRecord?.hashes as Array<{ algorithm?: string; value?: string }>)
      : [];
    const identifierRows = buildExpertReportIdentifierRows({
      caseId: input.caseId,
      reportId: report.id,
      reportNumber: input.reportNumber,
      protocol: typeof politecRecord?.protocol === "string" ? politecRecord.protocol : undefined,
      hashes: hashRows,
      seizedObjects: createdSeizedObjects
    });
    if (identifierRows.length > 0) {
      await tx.expertReportIdentifier.createMany({
        data: identifierRows.map((row) => ({
          caseId: row.caseId,
          expertReportId: row.expertReportId,
          seizedObjectId: row.seizedObjectId,
          kind: row.kind,
          algorithm: row.algorithm,
          value: row.value,
          normalizedValue: row.normalizedValue,
          sourceReference: row.sourceReference,
          confidence: row.confidence,
          metadata: row.metadata
        }))
      });
    }

    if (createdSeizedObjects.length > 0) {
      const devices = await tx.device.findMany({
        where: {
          extraction: {
            evidence: {
              caseId: input.caseId
            }
          }
        }
      });
      for (const seizedObject of createdSeizedObjects) {
        let best: { deviceId: string; score: number; reasons: string[] } | null = null;
        for (const device of devices) {
          const scored = scoreDeviceObjectMatch({
            device,
            object: seizedObject
          });
          if (!best || scored.score > best.score) {
            best = { deviceId: device.id, score: scored.score, reasons: scored.reasons };
          }
        }
        if (!best || best.score < 0.45) continue;
        await tx.deviceMatch.upsert({
          where: {
            deviceId_seizedObjectId: {
              deviceId: best.deviceId,
              seizedObjectId: seizedObject.id
            }
          },
          create: {
            caseId: input.caseId,
            deviceId: best.deviceId,
            seizedObjectId: seizedObject.id,
            expertReportId: report.id,
            status: "SUGGESTED",
            confidence: Number(best.score.toFixed(3)),
            justification: best.reasons.join("; "),
            metadata: {
              source: "expert-report-auto-match",
              matchedFields: best.reasons
            } as Prisma.InputJsonValue
          },
          update: {
            expertReportId: report.id,
            status: "SUGGESTED",
            confidence: Number(best.score.toFixed(3)),
            justification: best.reasons.join("; "),
            metadata: {
              source: "expert-report-auto-match",
              matchedFields: best.reasons
            } as Prisma.InputJsonValue
          }
        });
      }
    }

    return tx.expertReport.findUniqueOrThrow({
      where: { id: report.id },
      include: {
        caseDocument: true,
        seizedObjects: true,
        expertIdentifiers: true,
        deviceMatches: true
      }
    });
  });
}

export async function listDeviceMatches(caseId?: string) {
  return prisma.deviceMatch.findMany({
    where: caseId ? { caseId } : undefined,
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    include: {
      device: {
        include: {
          extraction: {
            include: {
              evidence: {
                include: {
                  case: true
                }
              }
            }
          }
        }
      },
      seizedObject: true,
      expertReport: true,
      reviewedBy: true
    }
  });
}

export async function upsertDeviceMatch(input: {
  deviceId: string;
  seizedObjectId: string;
  expertReportId?: string;
  status?: "SUGGESTED" | "CONFIRMED" | "REJECTED";
  confidence?: number;
  justification?: string;
  metadata?: Prisma.InputJsonValue;
  reviewedById?: string;
}) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const device = await tx.device.findUnique({
      where: { id: input.deviceId },
      include: {
        extraction: {
          include: {
            evidence: {
              include: {
                case: true
              }
            }
          }
        }
      }
    });
    if (!device) {
      throw new Error("Dispositivo nao encontrado.");
    }

    const seizedObject = await tx.seizedObject.findUnique({
      where: { id: input.seizedObjectId }
    });
    if (!seizedObject) {
      throw new Error("Objeto apreendido nao encontrado.");
    }

    const caseId = device.extraction.evidence.caseId;
    if (seizedObject.caseId !== caseId) {
      throw new Error("O objeto apreendido pertence a outro caso.");
    }

    const status = input.status ?? "SUGGESTED";
    const reviewedAt = status === "CONFIRMED" || status === "REJECTED" ? new Date() : undefined;

    const match = await tx.deviceMatch.upsert({
      where: {
        deviceId_seizedObjectId: {
          deviceId: input.deviceId,
          seizedObjectId: input.seizedObjectId
        }
      },
      create: {
        caseId,
        deviceId: input.deviceId,
        seizedObjectId: input.seizedObjectId,
        expertReportId: input.expertReportId,
        status,
        confidence: input.confidence,
        justification: input.justification,
        metadata: input.metadata,
        reviewedById: input.reviewedById,
        reviewedAt
      },
      update: {
        expertReportId: input.expertReportId,
        status,
        confidence: input.confidence,
        justification: input.justification,
        metadata: input.metadata,
        reviewedById: input.reviewedById,
        reviewedAt
      }
    });

    if (status === "CONFIRMED") {
      await tx.device.update({
        where: { id: input.deviceId },
        data: {
          matchedSeizedObjectId: input.seizedObjectId
        }
      });
    } else if (status === "REJECTED" && device.matchedSeizedObjectId === input.seizedObjectId) {
      await tx.device.update({
        where: { id: input.deviceId },
        data: {
          matchedSeizedObjectId: null
        }
      });
    }

    return tx.deviceMatch.findUniqueOrThrow({
      where: { id: match.id },
      include: {
        device: true,
        seizedObject: true,
        expertReport: true
      }
    });
  });
}

function normalizeOptionalString(value: unknown, minLength = 1): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length >= minLength ? clean : undefined;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const item of value) {
    const clean = normalizeOptionalString(item, 2);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(clean);
  }
  return rows;
}

function keepCurrentOrIncoming(current: string | null | undefined, incoming: string | undefined) {
  const currentClean = normalizeOptionalString(current);
  if (currentClean) return current;
  return incoming ?? current ?? null;
}

export async function enrichCaseContextFromUfdrMetadata(input: {
  caseId: string;
  context?: {
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
}) {
  const context = input.context;
  if (!context) {
    return null;
  }

  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    select: {
      id: true,
      inquiryType: true,
      inquiryNumber: true,
      policeUnit: true,
      inquiryLegalFraming: true,
      inquirySummaryText: true,
      inquiryMainFacts: true,
      inquiryInvestigativeFocus: true,
      extractionReportSummary: true,
      inquiryInvolvedPeople: true
    }
  });
  if (!caseRow) return null;

  const incomingPeople = normalizeStringArray(context.inquiryInvolvedPeople);
  const currentPeople =
    Array.isArray(caseRow.inquiryInvolvedPeople) &&
    (caseRow.inquiryInvolvedPeople as unknown[]).every((item) => typeof item === "string")
      ? (caseRow.inquiryInvolvedPeople as string[])
      : [];

  const nextPeople = currentPeople.length > 0 ? currentPeople : incomingPeople;
  const data: Prisma.CaseUpdateInput = {
    inquiryType: keepCurrentOrIncoming(caseRow.inquiryType, normalizeOptionalString(context.inquiryType)),
    inquiryNumber: keepCurrentOrIncoming(caseRow.inquiryNumber, normalizeOptionalString(context.inquiryNumber)),
    policeUnit: keepCurrentOrIncoming(caseRow.policeUnit, normalizeOptionalString(context.policeUnit)),
    inquiryLegalFraming: keepCurrentOrIncoming(
      caseRow.inquiryLegalFraming,
      normalizeOptionalString(context.inquiryLegalFraming)
    ),
    inquirySummaryText: keepCurrentOrIncoming(
      caseRow.inquirySummaryText,
      normalizeOptionalString(context.inquirySummaryText, 12)
    ),
    inquiryMainFacts: keepCurrentOrIncoming(caseRow.inquiryMainFacts, normalizeOptionalString(context.inquiryMainFacts, 12)),
    inquiryInvestigativeFocus: keepCurrentOrIncoming(
      caseRow.inquiryInvestigativeFocus,
      normalizeOptionalString(context.inquiryInvestigativeFocus, 12)
    ),
    extractionReportSummary: keepCurrentOrIncoming(
      caseRow.extractionReportSummary,
      normalizeOptionalString(context.extractionReportSummary, 12)
    ),
    inquiryInvolvedPeople:
      nextPeople.length > 0
        ? (nextPeople as Prisma.InputJsonValue)
        : caseRow.inquiryInvolvedPeople ?? undefined
  };

  return prisma.case.update({
    where: { id: input.caseId },
    data,
    select: {
      id: true,
      inquiryType: true,
      inquiryNumber: true,
      policeUnit: true,
      inquirySummaryText: true
    }
  });
}

export async function listEvidences() {
  return prisma.evidence.findMany({
    orderBy: { createdAt: "desc" },
    include: { extraction: true, case: true }
  });
}

export async function listAudioTranscriptions(limit = 200) {
  return prisma.audioTranscription.findMany({
    take: limit,
    orderBy: { createdAt: "desc" },
    include: {
      evidence: true,
      attachment: true
    }
  });
}

export async function listCustodyEvents(caseId?: string, limit = 300, evidenceId?: string) {
  return prisma.custodyEvent.findMany({
    where: {
      ...(caseId ? { caseId } : {}),
      ...(evidenceId ? { evidenceId } : {})
    },
    take: limit,
    orderBy: { createdAt: "desc" },
    include: { actor: true, evidence: true }
  });
}

export async function addCustodyEvent(input: {
  caseId: string;
  evidenceId?: string;
  actorId?: string;
  action: string;
  source?: string;
  previousHash?: string;
  currentHash?: string;
  details?: Prisma.InputJsonValue;
}) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const last = await tx.custodyEvent.findFirst({
      where: {
        caseId: input.caseId,
        evidenceId: input.evidenceId ?? null
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { currentHash: true }
    });

    const previousHash = input.previousHash ?? last?.currentHash ?? undefined;
    const createdAt = new Date();
    const computedCurrentHash = createHash("sha256")
      .update(
        JSON.stringify({
          caseId: input.caseId,
          evidenceId: input.evidenceId ?? null,
          actorId: input.actorId ?? null,
          action: input.action,
          source: input.source ?? null,
          previousHash: previousHash ?? null,
          details: input.details ?? null,
          createdAt: createdAt.toISOString()
        })
      )
      .digest("hex");

    return tx.custodyEvent.create({
      data: {
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        actorId: input.actorId,
        action: input.action,
        source: input.source,
        previousHash,
        currentHash: input.currentHash ?? computedCurrentHash,
        details: input.details,
        createdAt
      }
    });
  });
}

export async function listGraphData(caseId: string) {
  const [entities, links] = await Promise.all([
    prisma.entity.findMany({ where: { caseId }, take: 2000 }),
    prisma.link.findMany({ where: { caseId }, take: 4000 })
  ]);
  return { entities, links };
}

export async function saveOcrDocument(input: {
  caseId: string;
  evidenceId: string;
  extractionId?: string;
  attachmentId?: string;
  sourcePath: string;
  text?: string;
  confidence?: number;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.ocrDocument.create({
    data: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      extractionId: input.extractionId,
      attachmentId: input.attachmentId,
      sourcePath: input.sourcePath,
      text: input.text,
      confidence: input.confidence,
      metadata: input.metadata
    }
  });
}

export async function createAiInsight(input: {
  caseId: string;
  evidenceId?: string;
  extractionId?: string;
  type: string;
  title: string;
  summary: string;
  score?: number;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.aiInsight.create({
    data: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      extractionId: input.extractionId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      score: input.score,
      metadata: input.metadata
    }
  });
}

export async function createGeneratedReport(input: {
  caseId: string;
  evidenceId?: string;
  authorId?: string;
  title: string;
  format: "MARKDOWN" | "JSON";
  content: string;
  metadata?: Prisma.InputJsonValue;
}) {
  const metadataRecord =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : {};
  const workflowUpdatedAt = new Date().toISOString();
  const metadata = sanitizeJsonForDatabase({
    ...metadataRecord,
    workflow: {
      status: "DRAFT",
      updatedAt: workflowUpdatedAt,
      updatedById: input.authorId ?? null,
      history: [
        {
          action: "CREATE",
          from: null,
          to: "DRAFT",
          at: workflowUpdatedAt,
          byId: input.authorId ?? null
        }
      ]
    }
  });

  return prisma.generatedReport.create({
    data: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      authorId: input.authorId,
      title: sanitizeTextForDatabase(input.title),
      format: input.format,
      content: sanitizeTextForDatabase(input.content),
      metadata: metadata as Prisma.InputJsonValue
    }
  });
}

export async function listReports(caseId?: string, limit = 200) {
  return prisma.generatedReport.findMany({
    where: caseId ? { caseId } : undefined,
    take: limit,
    orderBy: { createdAt: "desc" },
    include: { author: true, case: true, evidence: true }
  });
}

export async function getReportById(id: string) {
  return prisma.generatedReport.findUnique({
    where: { id },
    include: { author: true, case: true, evidence: true }
  });
}

export async function deleteGeneratedReport(input: {
  reportId: string;
  actorId?: string;
  actorName?: string;
}) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const report = await tx.generatedReport.findUnique({
      where: { id: input.reportId },
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        title: true,
        format: true
      }
    });

    if (!report) {
      throw new Error("Relatorio nao encontrado.");
    }

    await tx.aiInsight.deleteMany({
      where: {
        caseId: report.caseId,
        type: "INVESTIGATION_REPORT",
        metadata: { path: ["reportId"], equals: report.id }
      }
    });

    await tx.generatedReport.delete({ where: { id: report.id } });

    if (input.actorId) {
      await tx.custodyEvent.create({
        data: {
          caseId: report.caseId,
          evidenceId: report.evidenceId ?? undefined,
          actorId: input.actorId,
          action: "REPORT_DELETED",
          source: "services/deleteGeneratedReport",
          details: {
            reportId: report.id,
            reportTitle: report.title,
            reportFormat: report.format,
            actorName: input.actorName ?? null
          }
        }
      });
    }

    return report;
  });
}

export type ReportWorkflowStatus = "DRAFT" | "UNDER_REVIEW" | "APPROVED";
export type ReportWorkflowAction = "SUBMIT_REVIEW" | "APPROVE" | "REOPEN_REVIEW";

function readReportWorkflowStatus(metadata: Prisma.JsonValue | null | undefined): ReportWorkflowStatus {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "DRAFT";
  const workflow = (metadata as Record<string, unknown>).workflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return "DRAFT";
  const status = (workflow as Record<string, unknown>).status;
  if (status === "UNDER_REVIEW" || status === "APPROVED" || status === "DRAFT") return status;
  return "DRAFT";
}

function resolveNextWorkflowStatus(input: {
  current: ReportWorkflowStatus;
  action: ReportWorkflowAction;
}): ReportWorkflowStatus {
  if (input.action === "SUBMIT_REVIEW") {
    if (input.current !== "DRAFT") throw new Error("Apenas relatorio em DRAFT pode ser enviado para revisao.");
    return "UNDER_REVIEW";
  }
  if (input.action === "APPROVE") {
    if (input.current !== "UNDER_REVIEW") throw new Error("Aprovacao exige status UNDER_REVIEW.");
    return "APPROVED";
  }
  if (input.action === "REOPEN_REVIEW") {
    if (input.current !== "APPROVED") throw new Error("Reabertura exige status APPROVED.");
    return "UNDER_REVIEW";
  }
  throw new Error("Acao de workflow invalida.");
}

export async function getGeneratedReportWorkflowStatus(reportId: string): Promise<ReportWorkflowStatus | null> {
  const report = await prisma.generatedReport.findUnique({
    where: { id: reportId },
    select: { id: true, metadata: true }
  });
  if (!report) return null;
  return readReportWorkflowStatus(report.metadata);
}

export async function transitionGeneratedReportWorkflow(input: {
  reportId: string;
  action: ReportWorkflowAction;
  actorId: string;
  actorName?: string;
}) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const report = await tx.generatedReport.findUnique({
      where: { id: input.reportId },
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        metadata: true,
        title: true
      }
    });
    if (!report) throw new Error("Relatorio nao encontrado.");

    const metadataRecord =
      report.metadata && typeof report.metadata === "object" && !Array.isArray(report.metadata)
        ? (report.metadata as Record<string, unknown>)
        : {};
    const workflowRecord =
      metadataRecord.workflow && typeof metadataRecord.workflow === "object" && !Array.isArray(metadataRecord.workflow)
        ? (metadataRecord.workflow as Record<string, unknown>)
        : {};
    const history = Array.isArray(workflowRecord.history) ? [...workflowRecord.history] : [];

    const current = readReportWorkflowStatus(report.metadata);
    const next = resolveNextWorkflowStatus({ current, action: input.action });
    const event = {
      action: input.action,
      from: current,
      to: next,
      at: new Date().toISOString(),
      byId: input.actorId,
      byName: input.actorName ?? null
    };

    const updated = await tx.generatedReport.update({
      where: { id: report.id },
      data: {
        metadata: {
          ...metadataRecord,
          workflow: {
            ...workflowRecord,
            status: next,
            updatedAt: event.at,
            updatedById: input.actorId,
            updatedByName: input.actorName ?? null,
            history: [...history, event]
          }
        }
      },
      include: { case: true, evidence: true }
    });

    await tx.custodyEvent.create({
      data: {
        caseId: report.caseId,
        evidenceId: report.evidenceId ?? undefined,
        actorId: input.actorId,
        action: "REPORT_WORKFLOW_UPDATED",
        source: "services/transitionGeneratedReportWorkflow",
        details: {
          reportId: report.id,
          reportTitle: report.title,
          workflowAction: input.action,
          fromStatus: current,
          toStatus: next
        }
      }
    });

    return updated;
  });
}

export async function getEvidenceById(id: string) {
  return prisma.evidence.findUnique({
    where: { id },
    include: {
      case: true,
      extraction: { include: { devices: true, transcriptions: true } },
      transcriptions: true
    }
  });
}

export async function getExtractionById(id: string) {
  return prisma.extraction.findUnique({
    where: { id },
    include: { evidence: true, devices: true }
  });
}

export async function listExtractionOperationalAlertHistory(extractionId: string, limit = 100) {
  const extraction = await prisma.extraction.findUnique({
    where: { id: extractionId },
    select: { id: true, caseId: true, evidenceId: true }
  });
  if (!extraction) return [];

  const rows = await prisma.custodyEvent.findMany({
    where: {
      caseId: extraction.caseId,
      evidenceId: extraction.evidenceId,
      details: { path: ["extractionId"], equals: extractionId }
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });

  return rows
    .map((row) => {
      const details = (row.details ?? {}) as Record<string, unknown>;
      const snapshot =
        details.operationalAlertSnapshot && typeof details.operationalAlertSnapshot === "object"
          ? (details.operationalAlertSnapshot as Record<string, unknown>)
          : undefined;
      const alertsRaw = Array.isArray(snapshot?.alerts) ? snapshot?.alerts : [];
      const alerts = alertsRaw
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const data = item as Record<string, unknown>;
          const code = typeof data.code === "string" ? data.code : "UNKNOWN";
          const severity = typeof data.severity === "string" ? data.severity : "INFO";
          const message = typeof data.message === "string" ? data.message : "";
          if (!message) return null;
          return {
            code,
            severity: severity as "INFO" | "WARN" | "CRITICAL",
            message
          };
        })
        .filter(Boolean) as Array<{ code: string; severity: "INFO" | "WARN" | "CRITICAL"; message: string }>;

      const fallbackError = typeof details.error === "string" ? details.error : undefined;
      if (alerts.length === 0 && fallbackError) {
        alerts.push({
          code: "ERROR",
          severity: "CRITICAL",
          message: fallbackError
        });
      }
      if (alerts.length === 0) return null;

      return {
        id: row.id,
        createdAt: row.createdAt,
        action: row.action,
        source: row.source,
        highestSeverity:
          typeof snapshot?.highestSeverity === "string"
            ? (snapshot?.highestSeverity as "INFO" | "WARN" | "CRITICAL")
            : alerts.some((alert) => alert.severity === "CRITICAL")
              ? "CRITICAL"
              : alerts.some((alert) => alert.severity === "WARN")
                ? "WARN"
                : "INFO",
        alerts
      };
    })
    .filter(Boolean) as Array<{
    id: string;
    createdAt: Date;
    action: string;
    source: string | null;
    highestSeverity: "INFO" | "WARN" | "CRITICAL";
    alerts: Array<{ code: string; severity: "INFO" | "WARN" | "CRITICAL"; message: string }>;
  }>;
}

type AppBucketKey = "whatsapp" | "instagram" | "facebook" | "other";

function normalizeAppBucket(sourceApp?: string | null): AppBucketKey {
  const value = (sourceApp ?? "").toLowerCase();
  if (value.includes("whatsapp") || value.includes("wa")) return "whatsapp";
  if (value.includes("instagram") || value.includes("ig")) return "instagram";
  if (value.includes("facebook") || value.includes("messenger") || value.includes("fb")) return "facebook";
  return "other";
}

function createEmptyAppBuckets() {
  return {
    whatsapp: { chats: 0, messages: 0 },
    instagram: { chats: 0, messages: 0 },
    facebook: { chats: 0, messages: 0 },
    other: { chats: 0, messages: 0 }
  };
}

export async function getExtractionDiagnostics(extractionId: string) {
  const extraction = await prisma.extraction.findUnique({
    where: { id: extractionId },
    select: { id: true, caseId: true, evidenceId: true, status: true }
  });
  if (!extraction) return null;

  const evidenceId = extraction.evidenceId;

  const [
    chats,
    attachmentsTotal,
    audioAttachmentsTotal,
    attachmentsLinked,
    transcriptionsStats,
    transcriptionsLinkedCompleted,
    linkedMessageRows,
    aiClassificationCompleted,
    policyDiscardedTranscriptions
  ] =
    await Promise.all([
      prisma.chat.findMany({
        where: { evidenceId },
        select: {
          id: true,
          sourceApp: true,
          _count: { select: { messages: true } }
        }
      }),
      prisma.attachment.count({ where: { evidenceId } }),
      prisma.attachment
        .findMany({
          where: { evidenceId },
          select: { mimeType: true, fileName: true, archivePath: true }
        })
        .then((rows) =>
          rows.reduce((sum, row) => {
            const mime = row.mimeType ?? "";
            const ref = row.fileName ?? row.archivePath ?? "";
            const isAudio = AUDIO_MIME_RE.test(mime) || AUDIO_EXT_RE.test(ref);
            return isAudio ? sum + 1 : sum;
          }, 0)
        ),
      prisma.attachment.count({ where: { evidenceId, messageId: { not: null } } }),
      prisma.audioTranscription.groupBy({
        by: ["status"],
        where: { extractionId },
        _count: { _all: true }
      }),
      prisma.audioTranscription.count({
        where: {
          extractionId,
          status: "COMPLETED",
          attachment: { messageId: { not: null } }
        }
      }),
      prisma.attachment.findMany({
        where: {
          evidenceId,
          messageId: { not: null },
          transcriptions: { some: { status: "COMPLETED" } }
        },
        select: { messageId: true },
        distinct: ["messageId"]
      }),
      prisma.aiInsight.count({
        where: {
          extractionId,
          type: "TRANSCRIPTION"
        }
      }),
      prisma.audioTranscription.count({
        where: {
          extractionId,
          status: "FAILED",
          error: { startsWith: "Descartado pela politica" }
        }
      })
    ]);

  const appBuckets = createEmptyAppBuckets();
  for (const chat of chats) {
    const bucket = normalizeAppBucket(chat.sourceApp);
    appBuckets[bucket].chats += 1;
    appBuckets[bucket].messages += chat._count.messages;
  }

  const transcriptionCounters = {
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0
  };
  for (const row of transcriptionsStats) {
    const count = row._count._all;
    transcriptionCounters.total += count;
    if (row.status === "PENDING") transcriptionCounters.pending = count;
    if (row.status === "PROCESSING") transcriptionCounters.processing = count;
    if (row.status === "COMPLETED") transcriptionCounters.completed = count;
    if (row.status === "FAILED") transcriptionCounters.failed = count;
  }
  const realFailedTranscriptions = Math.max(0, transcriptionCounters.failed - policyDiscardedTranscriptions);

  return {
    extractionId,
    evidenceId,
    status: extraction.status,
    totals: {
      chats: chats.length,
      messages: chats.reduce((sum, row) => sum + row._count.messages, 0),
      audios: audioAttachmentsTotal,
      attachments: attachmentsTotal,
      attachmentsLinkedToMessage: attachmentsLinked,
      messagesWithCompletedTranscription: linkedMessageRows.length
    },
    perApp: appBuckets,
    transcriptions: {
      ...transcriptionCounters,
      policyDiscarded: policyDiscardedTranscriptions,
      realFailed: realFailedTranscriptions,
      eligible:
        transcriptionCounters.pending +
        transcriptionCounters.processing +
        transcriptionCounters.completed +
        realFailedTranscriptions,
      completedAndLinked: transcriptionsLinkedCompleted,
      aiClassificationCompleted
    }
  };
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function readStringFromRecord(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumberFromRecord(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function extractMessageAttachmentCandidates(metadata: unknown): Array<{
  externalId?: string;
  fileName?: string;
  mimeType?: string;
  archivePath?: string;
  sizeBytes?: number;
}> {
  if (!metadata || typeof metadata !== "object") return [];
  const row = metadata as Record<string, unknown>;
  const raw: Record<string, unknown>[] = [];

  if (Array.isArray(row.attachments)) {
    for (const item of row.attachments) {
      if (item && typeof item === "object") raw.push(item as Record<string, unknown>);
    }
  }

  if (row.attachment && typeof row.attachment === "object") {
    raw.push(row.attachment as Record<string, unknown>);
  }

  return raw.map((entry) => ({
    externalId: readStringFromRecord(entry, ["id", "externalId"]),
    fileName: readStringFromRecord(entry, ["name", "fileName", "filename"]),
    mimeType: readStringFromRecord(entry, ["mimeType", "mimetype", "type", "contentType"]),
    archivePath: readStringFromRecord(entry, ["path", "archivePath", "sourcePath", "fullPath"]),
    sizeBytes: readNumberFromRecord(entry, ["sizeBytes", "size", "fileSize"])
  }));
}

function collectAttachmentKeysFromMetadata(metadata: unknown) {
  const out = new Set<string>();
  for (const candidate of extractMessageAttachmentCandidates(metadata)) {
    const name = candidate.fileName?.trim().toLowerCase();
    const archivePath = candidate.archivePath?.trim().toLowerCase();
    if (name) out.add(name);
    if (archivePath) {
      out.add(archivePath);
      const slashLast = archivePath.split("/").pop();
      const backslashLast = archivePath.split("\\").pop();
      if (slashLast) out.add(slashLast);
      if (backslashLast) out.add(backslashLast);
    }
  }
  return [...out.values()];
}

export type EvidenceMessageLinkageContext = {
  chatExternalToId: Map<string, string>;
  messageExternalToId: Map<string, string>;
  messageTimeline: Array<{
    id: string;
    chatId?: string;
    chatExternalId?: string;
    externalId?: string;
    senderExternalId?: string;
    timestamp?: Date;
    attachmentKeys?: string[];
  }>;
};

export async function buildEvidenceMessageLinkageContext(input: {
  evidenceId: string;
  messageExternalIds?: string[];
  chatExternalIds?: string[];
}): Promise<EvidenceMessageLinkageContext> {
  const normalizedMessageExternalIds = [...new Set((input.messageExternalIds ?? []).map((value) => value.trim()).filter(Boolean))];
  const normalizedChatExternalIds = [...new Set((input.chatExternalIds ?? []).map((value) => value.trim()).filter(Boolean))];

  const chatExternalToId = new Map<string, string>();
  const messageExternalToId = new Map<string, string>();
  const messageTimeline: EvidenceMessageLinkageContext["messageTimeline"] = [];

  if (normalizedChatExternalIds.length > 0) {
    const chats = await prisma.chat.findMany({
      where: {
        evidenceId: input.evidenceId,
        externalId: { in: normalizedChatExternalIds }
      },
      select: {
        id: true,
        externalId: true
      }
    });
    for (const row of chats) {
      if (row.externalId) {
        chatExternalToId.set(row.externalId, row.id);
      }
    }
  }

  if (normalizedMessageExternalIds.length === 0) {
    return {
      chatExternalToId,
      messageExternalToId,
      messageTimeline
    };
  }

  const messages = await prisma.message.findMany({
    where: {
      evidenceId: input.evidenceId,
      externalId: { in: normalizedMessageExternalIds }
    },
    select: {
      id: true,
      chatId: true,
      externalId: true,
      senderId: true,
      timestamp: true,
      metadata: true,
      chat: {
        select: {
          externalId: true
        }
      }
    }
  });

  for (const row of messages) {
    if (row.externalId) {
      messageExternalToId.set(row.externalId, row.id);
    }
    if (row.chat?.externalId && row.chatId) {
      chatExternalToId.set(row.chat.externalId, row.chatId);
    }

    messageTimeline.push({
      id: row.id,
      chatId: row.chatId ?? undefined,
      chatExternalId: row.chat?.externalId ?? undefined,
      externalId: row.externalId ?? undefined,
      senderExternalId: row.senderId ?? undefined,
      timestamp: row.timestamp ?? undefined,
      attachmentKeys: collectAttachmentKeysFromMetadata(row.metadata)
    });
  }

  return {
    chatExternalToId,
    messageExternalToId,
    messageTimeline
  };
}

function chunkArray<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

function buildUfdrUserAccountArtifactRows(input: {
  caseId: string;
  evidenceId: string;
  userAccounts: NormalizedExtraction["userAccounts"];
}) {
  return input.userAccounts.map((account) => {
    const entryValues = Array.isArray(account.entries)
      ? account.entries
          .map((entry) => (typeof entry?.value === "string" ? entry.value.trim() : ""))
          .filter((value) => value.length > 0)
      : [];
    const title =
      account.name ??
      account.username ??
      account.serviceIdentifier ??
      entryValues[0] ??
      "Conta de usuario";

    return {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "ENTITY" as const,
      sourceApp: account.sourceApp ?? account.serviceType ?? "UFDR",
      externalId: account.externalId ?? account.serviceIdentifier ?? account.username,
      title,
      metadata: {
        source: "ufdr-user-account",
        serviceType: account.serviceType ?? null,
        serviceIdentifier: account.serviceIdentifier ?? null,
        username: account.username ?? null,
        name: account.name ?? null,
        entries: account.entries ?? [],
        raw: account.metadata ?? {}
      } as Prisma.InputJsonValue
    };
  });
}

async function syncUfdrUserAccountArtifacts(input: {
  caseId: string;
  evidenceId: string;
  userAccounts: NormalizedExtraction["userAccounts"];
}) {
  await prisma.artifact.deleteMany({
    where: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "ENTITY",
      metadata: { path: ["source"], equals: "ufdr-user-account" }
    }
  });

  if (input.userAccounts.length === 0) return 0;

  const rows = buildUfdrUserAccountArtifactRows(input);
  const dedup = new Set<string>();
  const uniqueRows = rows.filter((row) => {
    const key = `${row.sourceApp ?? ""}|${row.externalId ?? ""}|${row.title}`.toLowerCase().trim();
    if (dedup.has(key)) return false;
    dedup.add(key);
    return true;
  });

  for (const chunk of chunkArray(uniqueRows, 500)) {
    await prisma.artifact.createMany({ data: chunk });
  }
  return uniqueRows.length;
}

function parseCoordinateValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(",", ".").trim();
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickLabelFromRecord(record: Record<string, unknown>, fallback?: string) {
  return (
    readStringFromRecord(record, ["label", "name", "address", "placeName", "description", "title"]) ?? fallback
  );
}

function extractLocationCandidatesFromUnknown(input: {
  value: unknown;
  occurredAt?: Date;
  sourceType: string;
  titleFallback?: string;
}) {
  const rows: Array<{
    title: string;
    occurredAt?: Date;
    metadata: Prisma.InputJsonValue;
  }> = [];
  const visited = new Set<unknown>();

  const walk = (node: unknown, path: string[] = []) => {
    if (!node || visited.has(node)) return;
    if (Array.isArray(node)) {
      visited.add(node);
      for (const [index, item] of node.entries()) walk(item, [...path, String(index)]);
      return;
    }
    const record = toPlainRecord(node);
    if (!record) return;
    visited.add(record);

    const latitude =
      parseCoordinateValue(record.latitude) ??
      parseCoordinateValue(record.lat) ??
      parseCoordinateValue(record.Latitude) ??
      parseCoordinateValue(record.Lat);
    const longitude =
      parseCoordinateValue(record.longitude) ??
      parseCoordinateValue(record.lng) ??
      parseCoordinateValue(record.lon) ??
      parseCoordinateValue(record.Longitude) ??
      parseCoordinateValue(record.Lng) ??
      parseCoordinateValue(record.Lon);

    if (typeof latitude === "number" && typeof longitude === "number") {
      rows.push({
        title: pickLabelFromRecord(record, input.titleFallback) ?? "Localizacao extraida",
        occurredAt: input.occurredAt,
        metadata: {
          source: "sync:location-extraction",
          sourceType: input.sourceType,
          path,
          latitude,
          longitude,
          raw: record
        } as Prisma.InputJsonValue
      });
    }

    if (typeof record.coordinates === "string") {
      const match = record.coordinates.match(/(-?\d+(?:[.,]\d+)?)\s*[,;]\s*(-?\d+(?:[.,]\d+)?)/);
      if (match?.[1] && match?.[2]) {
        const fromStringLat = parseCoordinateValue(match[1]);
        const fromStringLng = parseCoordinateValue(match[2]);
        if (typeof fromStringLat === "number" && typeof fromStringLng === "number") {
          rows.push({
            title: input.titleFallback ?? "Localizacao extraida",
            occurredAt: input.occurredAt,
            metadata: {
              source: "sync:location-extraction",
              sourceType: input.sourceType,
              path,
              latitude: fromStringLat,
              longitude: fromStringLng,
              raw: record
            } as Prisma.InputJsonValue
          });
        }
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (value && typeof value === "object") {
        walk(value, [...path, key]);
      }
    }
  };

  walk(input.value);

  const dedup = new Set<string>();
  return rows.filter((row) => {
    const metadata = row.metadata as Record<string, unknown>;
    const key = `${String(metadata.latitude)}|${String(metadata.longitude)}|${row.title}`.toLowerCase();
    if (dedup.has(key)) return false;
    dedup.add(key);
    return true;
  });
}

function trimText(value: string | null | undefined, max = 220) {
  const clean = sanitizeTextForDatabase((value ?? "").replace(/\s+/g, " ").trim());
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function sanitizeTimelineCreateRow(row: Prisma.TimelineEventCreateManyInput): Prisma.TimelineEventCreateManyInput {
  return {
    ...row,
    title: sanitizeTextForDatabase(row.title),
    description: row.description ? sanitizeTextForDatabase(row.description) : row.description,
    metadata: (sanitizeJsonForDatabase(row.metadata ?? null) ?? null) as Prisma.InputJsonValue
  };
}

export async function syncEvidenceLocationArtifacts(input: {
  caseId: string;
  evidenceId: string;
}) {
  await prisma.artifact.deleteMany({
    where: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "LOCATION",
      metadata: {
        path: ["source"],
        equals: "sync:location-extraction"
      }
    }
  });

  const [messages, artifacts] = await Promise.all([
    prisma.message.findMany({
      where: { caseId: input.caseId, evidenceId: input.evidenceId },
      select: {
        id: true,
        body: true,
        timestamp: true,
        metadata: true
      }
    }),
    prisma.artifact.findMany({
      where: {
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        type: { in: ["CALL", "FILE", "CONTACT"] }
      },
      select: {
        id: true,
        type: true,
        title: true,
        metadata: true,
        occurredAt: true
      }
    })
  ]);

  const rows: Prisma.ArtifactCreateManyInput[] = [];

  for (const message of messages) {
    const candidates = extractLocationCandidatesFromUnknown({
      value: message.metadata,
      occurredAt: message.timestamp ?? undefined,
      sourceType: "MESSAGE_METADATA",
      titleFallback: trimText(message.body) ?? "Localizacao de mensagem"
    });
    for (const candidate of candidates) {
      rows.push({
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        type: "LOCATION",
        sourceApp: "UFDR",
        title: candidate.title,
        occurredAt: candidate.occurredAt,
        metadata: {
          ...(candidate.metadata as Record<string, unknown>),
          messageId: message.id
        } as Prisma.InputJsonValue
      });
    }
  }

  for (const artifact of artifacts) {
    const candidates = extractLocationCandidatesFromUnknown({
      value: artifact.metadata,
      occurredAt: artifact.occurredAt ?? undefined,
      sourceType: artifact.type,
      titleFallback: artifact.title ?? "Localizacao extraida"
    });
    for (const candidate of candidates) {
      rows.push({
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        type: "LOCATION",
        sourceApp: "UFDR",
        title: candidate.title,
        occurredAt: candidate.occurredAt,
        metadata: {
          ...(candidate.metadata as Record<string, unknown>),
          artifactId: artifact.id,
          parentArtifactType: artifact.type
        } as Prisma.InputJsonValue
      });
    }
  }

  const dedupedRows: Prisma.ArtifactCreateManyInput[] = [];
  const dedupKeys = new Set<string>();
  for (const row of rows) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const key = [
      row.title ?? "",
      String(metadata.latitude ?? ""),
      String(metadata.longitude ?? ""),
      String(metadata.messageId ?? metadata.artifactId ?? ""),
      row.occurredAt instanceof Date ? row.occurredAt.toISOString() : ""
    ]
      .join("|")
      .toLowerCase();
    if (dedupKeys.has(key)) continue;
    dedupKeys.add(key);
    dedupedRows.push(row);
  }

  for (const chunk of chunkArray(dedupedRows.slice(0, 1000), 200)) {
    await prisma.artifact.createMany({ data: chunk });
  }

  return { created: dedupedRows.slice(0, 1000).length };
}

export async function syncCaseTimeline(input: {
  caseId: string;
  evidenceId?: string;
}) {
  await prisma.timelineEvent.deleteMany({
    where: {
      caseId: input.caseId,
      evidenceId: input.evidenceId ?? undefined,
      metadata: {
        path: ["source"],
        equals: "sync:derived-timeline"
      }
    }
  });

  const [messages, custodyEvents, aiInsights, locationArtifacts, extractions] = await Promise.all([
    prisma.message.findMany({
      where: {
        caseId: input.caseId,
        evidenceId: input.evidenceId ?? undefined,
        timestamp: { not: null }
      },
      orderBy: { timestamp: "desc" },
      take: 250,
      select: {
        id: true,
        evidenceId: true,
        body: true,
        timestamp: true,
        chat: { select: { title: true, sourceApp: true } }
      }
    }),
    prisma.custodyEvent.findMany({
      where: {
        caseId: input.caseId,
        evidenceId: input.evidenceId ?? undefined
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { actor: true }
    }),
    prisma.aiInsight.findMany({
      where: {
        caseId: input.caseId,
        evidenceId: input.evidenceId ?? undefined
      },
      orderBy: { createdAt: "desc" },
      take: 100
    }),
    prisma.artifact.findMany({
      where: {
        caseId: input.caseId,
        evidenceId: input.evidenceId ?? undefined,
        type: "LOCATION"
      },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 150
    }),
    prisma.extraction.findMany({
      where: {
        caseId: input.caseId,
        evidenceId: input.evidenceId ?? undefined
      },
      include: { evidence: true },
      orderBy: { updatedAt: "desc" },
      take: 50
    })
  ]);

  const rows: Prisma.TimelineEventCreateManyInput[] = [];

  for (const message of messages) {
    rows.push({
      caseId: input.caseId,
      evidenceId: message.evidenceId,
      occurredAt: message.timestamp ?? undefined,
      category: "MESSAGE_ACTIVITY",
      title: message.chat?.title ? `Mensagem em ${message.chat.title}` : "Mensagem",
      description: trimText(message.body) ?? "Mensagem sem texto",
      metadata: {
        source: "sync:derived-timeline",
        messageId: message.id,
        sourceApp: message.chat?.sourceApp ?? null
      } as Prisma.InputJsonValue
    });
  }

  for (const event of custodyEvents) {
    rows.push({
      caseId: input.caseId,
      evidenceId: event.evidenceId ?? undefined,
      occurredAt: event.createdAt,
      category: "CUSTODY_EVENT",
      title: event.action,
      description: event.actor?.name ? `Responsavel: ${event.actor.name}` : undefined,
      metadata: {
        source: "sync:derived-timeline",
        custodyEventId: event.id,
        details: event.details
      } as Prisma.InputJsonValue
    });
  }

  for (const insight of aiInsights) {
    rows.push({
      caseId: input.caseId,
      evidenceId: insight.evidenceId ?? undefined,
      occurredAt: insight.createdAt,
      category: "AI_INSIGHT",
      title: insight.title,
      description: trimText(insight.summary, 320),
      metadata: {
        source: "sync:derived-timeline",
        insightId: insight.id,
        insightType: insight.type,
        score: insight.score ?? null
      } as Prisma.InputJsonValue
    });
  }

  for (const location of locationArtifacts) {
    rows.push({
      caseId: input.caseId,
      evidenceId: location.evidenceId,
      occurredAt: location.occurredAt ?? location.createdAt,
      category: "LOCATION_EVENT",
      title: location.title ?? "Localizacao extraida",
      metadata: {
        source: "sync:derived-timeline",
        artifactId: location.id,
        location: location.metadata
      } as Prisma.InputJsonValue
    });
  }

  for (const extraction of extractions) {
    if (extraction.startedAt) {
      rows.push({
        caseId: input.caseId,
        evidenceId: extraction.evidenceId,
        occurredAt: extraction.startedAt,
        category: "EXTRACTION_STATUS",
        title: "Extracao iniciada",
        description: extraction.evidence.fileName,
        metadata: {
          source: "sync:derived-timeline",
          extractionId: extraction.id,
          status: extraction.status
        } as Prisma.InputJsonValue
      });
    }
    if (extraction.finishedAt) {
      rows.push({
        caseId: input.caseId,
        evidenceId: extraction.evidenceId,
        occurredAt: extraction.finishedAt,
        category: "EXTRACTION_STATUS",
        title: "Extracao concluida",
        description: extraction.evidence.fileName,
        metadata: {
          source: "sync:derived-timeline",
          extractionId: extraction.id,
          status: extraction.status
        } as Prisma.InputJsonValue
      });
    }
  }

  const sanitizedRows = rows.map(sanitizeTimelineCreateRow);
  let created = 0;

  for (const chunk of chunkArray(sanitizedRows, 200)) {
    try {
      const result = await prisma.timelineEvent.createMany({ data: chunk });
      created += result.count;
    } catch (error) {
      // One malformed row should not abort the whole timeline sync.
      for (const row of chunk) {
        try {
          await prisma.timelineEvent.create({ data: row });
          created += 1;
        } catch (rowError) {
          console.warn("timelineEvent.create fallback skipped row", {
            caseId: row.caseId,
            evidenceId: row.evidenceId ?? null,
            category: row.category,
            title: row.title,
            error: rowError instanceof Error ? rowError.message : String(rowError),
            chunkError: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  return { created };
}

export async function persistNormalizedExtraction(input: {
  caseId: string;
  evidenceId: string;
  extractionId: string;
  normalized: NormalizedExtraction;
}) {
  const chatExternalToId = new Map<string, string>();
  const messageExternalToId = new Map<string, string>();
  const messageTimeline: Array<{
    id: string;
    chatId?: string;
    chatExternalId?: string;
    externalId?: string;
    senderExternalId?: string;
    timestamp?: Date;
    attachmentKeys?: string[];
  }> = [];
  const attachmentRows: Array<{
    caseId: string;
    evidenceId: string;
    messageId: string;
    externalId?: string;
    fileName?: string;
    mimeType?: string;
    sizeBytes?: bigint;
    archivePath?: string;
    metadata: Prisma.InputJsonValue;
  }> = [];
  const attachmentDedup = new Set<string>();

  const chats = applyOptionalLimit(input.normalized.chats, PERSIST_MAX_CHATS);
  for (const chatRow of chats) {
    const chat = await prisma.chat.create({
      data: {
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        sourceApp: chatRow.sourceApp,
        externalId: chatRow.externalId,
        title: chatRow.title,
        metadata: (chatRow.metadata ?? {}) as Prisma.InputJsonValue
      }
    });
    if (chatRow.externalId) {
      chatExternalToId.set(chatRow.externalId, chat.id);
    }

    if (chatRow.participants.length > 0) {
      const participantRows = applyOptionalLimit(chatRow.participants, PERSIST_MAX_PARTICIPANTS_PER_CHAT).map((participant) => ({
        chatId: chat.id,
        externalId: participant.externalId,
        name: participant.name,
        phone: participant.phone,
        email: participant.email,
        handle: participant.handle,
        metadata: (participant.metadata ?? {}) as Prisma.InputJsonValue
      }));
      for (const chunk of chunkArray(participantRows, 500)) {
        await prisma.participant.createMany({ data: chunk });
      }
    }

    if (chatRow.messages.length > 0) {
      for (const message of applyOptionalLimit(chatRow.messages, PERSIST_MAX_MESSAGES_PER_CHAT)) {
        const created = await prisma.message.create({
          data: {
            caseId: input.caseId,
            evidenceId: input.evidenceId,
            chatId: chat.id,
            externalId: message.externalId,
            senderId: message.senderExternalId,
            body: message.body,
            timestamp: parseDate(message.timestamp),
            direction: message.direction,
            metadata: (message.metadata ?? {}) as Prisma.InputJsonValue
          }
        });
        if (message.externalId) {
          messageExternalToId.set(message.externalId, created.id);
        }
        messageTimeline.push({
          id: created.id,
          chatId: chat.id,
          chatExternalId: chatRow.externalId,
          externalId: message.externalId,
          senderExternalId: message.senderExternalId,
          timestamp: created.timestamp ?? undefined,
          attachmentKeys: Array.isArray((message.metadata as any)?.attachments)
            ? ((message.metadata as any).attachments as Array<Record<string, unknown>>)
                .flatMap((row) => {
                  const keys: string[] = [];
                  const name = typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
                  const path = typeof row.path === "string" ? row.path.trim().toLowerCase() : "";
                  if (name) keys.push(name);
                  if (path) keys.push(path);
                  if (path.includes("/")) keys.push(path.split("/").pop() ?? "");
                  if (path.includes("\\")) keys.push(path.split("\\").pop() ?? "");
                  return keys.filter(Boolean);
                })
                .filter(Boolean)
            : []
        });

        const candidates = extractMessageAttachmentCandidates(message.metadata);
        for (const candidate of candidates) {
          const mime = candidate.mimeType ?? undefined;
          const fileName = candidate.fileName ?? undefined;
          const archivePath = candidate.archivePath ?? undefined;
          const isAudio = AUDIO_MIME_RE.test(mime ?? "") || AUDIO_EXT_RE.test(fileName ?? archivePath ?? "");
          if (isAudio) continue;

          const dedupKey = `${created.id}|${archivePath ?? ""}|${fileName ?? ""}|${candidate.externalId ?? ""}`;
          if (attachmentDedup.has(dedupKey)) continue;
          attachmentDedup.add(dedupKey);

          attachmentRows.push({
            caseId: input.caseId,
            evidenceId: input.evidenceId,
            messageId: created.id,
            externalId: candidate.externalId,
            fileName,
            mimeType: mime,
            sizeBytes:
              typeof candidate.sizeBytes === "number" && Number.isFinite(candidate.sizeBytes)
                ? BigInt(Math.max(0, Math.floor(candidate.sizeBytes)))
                : undefined,
            archivePath,
            metadata: {
              source: "message-metadata",
              linkedBy: "parser-attachments-array",
              messageExternalId: message.externalId ?? null
            } as Prisma.InputJsonValue
          });
        }
      }
    }
  }

  if (attachmentRows.length > 0) {
    for (const chunk of chunkArray(attachmentRows, 500)) {
      await prisma.attachment.createMany({
        data: chunk.map((row) => ({
          caseId: row.caseId,
          evidenceId: row.evidenceId,
          messageId: row.messageId,
          externalId: row.externalId,
          fileName: row.fileName,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          archivePath: row.archivePath,
          metadata: row.metadata
        }))
      });
    }
  }

  if (input.normalized.contacts.length > 0) {
    const rows = applyOptionalLimit(input.normalized.contacts, PERSIST_MAX_CONTACTS).map((contact) => ({
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "CONTACT" as const,
      sourceApp: "UFDR",
      externalId: contact.externalId,
      title: contact.name ?? contact.phone ?? contact.email ?? "Contato",
      metadata: contact as Prisma.InputJsonValue
    }));
    for (const chunk of chunkArray(rows, 1000)) {
      await prisma.artifact.createMany({ data: chunk });
    }
  }

  if (input.normalized.userAccounts.length > 0) {
    const rows = buildUfdrUserAccountArtifactRows({
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      userAccounts: input.normalized.userAccounts
    });
    const dedup = new Set<string>();
    const uniqueRows = rows.filter((row) => {
      const key = `${row.sourceApp ?? ""}|${row.externalId ?? ""}|${row.title}`.toLowerCase().trim();
      if (dedup.has(key)) return false;
      dedup.add(key);
      return true;
    });
    for (const chunk of chunkArray(uniqueRows, 1000)) {
      await prisma.artifact.createMany({ data: chunk });
    }
  }

  if (input.normalized.calls.length > 0) {
    const rows = applyOptionalLimit(input.normalized.calls, PERSIST_MAX_CALLS).map((call) => ({
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "CALL" as const,
      sourceApp: "UFDR",
      title: "Call",
      metadata: call as Prisma.InputJsonValue
    }));
    for (const chunk of chunkArray(rows, 1000)) {
      await prisma.artifact.createMany({ data: chunk });
    }
  }

  if (input.normalized.files.length > 0) {
    const rows = applyOptionalLimit(input.normalized.files, PERSIST_MAX_FILES).map((fileRow) => ({
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "FILE" as const,
      sourceApp: "UFDR",
      title: "File",
      metadata: fileRow as Prisma.InputJsonValue
    }));
    for (const chunk of chunkArray(rows, 1000)) {
      await prisma.artifact.createMany({ data: chunk });
    }
  }

  if (input.normalized.locations.length > 0) {
    const parseDate = (ts?: string) => {
      if (!ts) return undefined;
      const d = new Date(ts);
      return Number.isFinite(d.getTime()) ? d : undefined;
    };
    const locationRows = input.normalized.locations.slice(0, 5000).map((loc) => ({
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "LOCATION" as const,
      sourceApp: "UFDR",
      title: loc.label ?? "Localização extraída",
      occurredAt: parseDate(loc.timestamp),
      metadata: {
        source: "ufdr-model",
        category: loc.category ?? "LOCATION",
        latitude: loc.latitude,
        longitude: loc.longitude,
        ...(loc.metadata ?? {})
      } as Prisma.InputJsonValue
    }));
    const dedupKeys = new Set<string>();
    const uniqueLocations = locationRows.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      const key = `${String(meta.latitude)}|${String(meta.longitude)}|${row.title}`.toLowerCase();
      if (dedupKeys.has(key)) return false;
      dedupKeys.add(key);
      return true;
    });
    for (const chunk of chunkArray(uniqueLocations, 500)) {
      await prisma.artifact.createMany({ data: chunk });
    }
  }

  await syncEvidenceLocationArtifacts({
    caseId: input.caseId,
    evidenceId: input.evidenceId
  });

  await syncCaseTimeline({
    caseId: input.caseId,
    evidenceId: input.evidenceId
  });

  return { chatExternalToId, messageExternalToId, messageTimeline };
}

export async function clearDerivedDataByEvidence(evidenceId: string) {
  await prisma.$transaction([
    prisma.aiInsight.deleteMany({ where: { evidenceId } }),
    prisma.timelineEvent.deleteMany({ where: { evidenceId } }),
    prisma.audioTranscription.deleteMany({ where: { evidenceId } }),
    prisma.attachment.deleteMany({ where: { evidenceId } }),
    prisma.message.deleteMany({ where: { evidenceId } }),
    prisma.participant.deleteMany({ where: { chat: { evidenceId } } }),
    prisma.chat.deleteMany({ where: { evidenceId } }),
    prisma.artifact.deleteMany({ where: { evidenceId } })
  ]);
}

export async function enrichExtractionMetadata(input: {
  caseId: string;
  evidenceId: string;
  extractionId: string;
  normalized: NormalizedExtraction;
}) {
  const enriched = { deviceUpdated: false, userAccountsCreated: 0, locationsCreated: 0, timelineSynced: false };

  if (input.normalized.device) {
    const existingDevice = await prisma.device.findFirst({
      where: { extractionId: input.extractionId }
    });
    const deviceData = {
      manufacturer: input.normalized.device.manufacturer ?? undefined,
      model: input.normalized.device.model ?? undefined,
      osVersion: input.normalized.device.osVersion ?? undefined,
      imei: input.normalized.device.imei ?? undefined,
      serialNumber: input.normalized.device.serialNumber ?? undefined,
      metadata: {
        imei2: input.normalized.device.imei2 ?? null,
        iccid: input.normalized.device.iccid ?? null,
        msisdn: input.normalized.device.msisdn ?? null,
        macAddress: input.normalized.device.macAddress ?? null,
        bluetoothAddress: input.normalized.device.bluetoothAddress ?? null
      } as Prisma.InputJsonValue
    };
    if (existingDevice) {
      await prisma.device.update({
        where: { id: existingDevice.id },
        data: {
          manufacturer: deviceData.manufacturer ?? existingDevice.manufacturer,
          model: deviceData.model ?? existingDevice.model,
          osVersion: deviceData.osVersion ?? existingDevice.osVersion,
          imei: deviceData.imei ?? existingDevice.imei,
          serialNumber: deviceData.serialNumber ?? existingDevice.serialNumber,
          metadata: deviceData.metadata
        }
      });
    } else {
      await prisma.device.create({
        data: { extractionId: input.extractionId, ...deviceData }
      });
    }
    enriched.deviceUpdated = true;
  }

  if (input.normalized.locations.length > 0) {
    await prisma.artifact.deleteMany({
      where: {
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        type: "LOCATION",
        metadata: { path: ["source"], equals: "ufdr-model" }
      }
    });

    const parseDateStr = (ts?: string) => {
      if (!ts) return undefined;
      const d = new Date(ts);
      return Number.isFinite(d.getTime()) ? d : undefined;
    };
    const locationRows = input.normalized.locations.slice(0, 5000).map((loc) => ({
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "LOCATION" as const,
      sourceApp: "UFDR",
      title: loc.label ?? "Localização extraída",
      occurredAt: parseDateStr(loc.timestamp),
      metadata: {
        source: "ufdr-model",
        category: loc.category ?? "LOCATION",
        latitude: loc.latitude,
        longitude: loc.longitude,
        ...(loc.metadata ?? {})
      } as Prisma.InputJsonValue
    }));
    const dedupKeys = new Set<string>();
    const uniqueLocations = locationRows.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      const key = `${String(meta.latitude)}|${String(meta.longitude)}|${row.title}`.toLowerCase();
      if (dedupKeys.has(key)) return false;
      dedupKeys.add(key);
      return true;
    });
    for (const chunk of chunkArray(uniqueLocations, 500)) {
      await prisma.artifact.createMany({ data: chunk });
    }
    enriched.locationsCreated = uniqueLocations.length;
  }

  enriched.userAccountsCreated = await syncUfdrUserAccountArtifacts({
    caseId: input.caseId,
    evidenceId: input.evidenceId,
    userAccounts: input.normalized.userAccounts
  });

  await syncEvidenceLocationArtifacts({
    caseId: input.caseId,
    evidenceId: input.evidenceId
  });

  await syncCaseTimeline({
    caseId: input.caseId,
    evidenceId: input.evidenceId
  });
  enriched.timelineSynced = true;

  return enriched;
}

export async function persistAudioAttachments(input: {
  caseId: string;
  evidenceId: string;
  extractionId: string;
  items: Array<{
    archivePath: string;
    fileName: string;
    absolutePath: string;
    sizeBytes: number;
    chatExternalId?: string;
    messageExternalId?: string;
  }>;
  audioHints?: Array<{
    archivePath?: string;
    fileName?: string;
    timestamp?: string;
    chatExternalId?: string;
    messageExternalId?: string;
    senderExternalId?: string;
  }>;
  chatExternalToId: Map<string, string>;
  messageExternalToId: Map<string, string>;
  messageTimeline: Array<{
    id: string;
    chatId?: string;
    chatExternalId?: string;
    externalId?: string;
    senderExternalId?: string;
    timestamp?: Date;
    attachmentKeys?: string[];
  }>;
}) {
  function parseDate(value?: string) {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return undefined;
    return d;
  }

  function findHint(item: { archivePath: string; fileName: string }) {
    const hints = input.audioHints ?? [];
    const itemPath = item.archivePath.toLowerCase();
    const itemName = item.fileName.toLowerCase();
    return hints.find((h) => {
      const hPath = h.archivePath?.toLowerCase();
      const hName = h.fileName?.toLowerCase();
      return (hPath && hPath === itemPath) || (hName && hName === itemName);
    });
  }

  function pickMessageByHeuristic(item: {
    archivePath: string;
    fileName: string;
    chatExternalId?: string;
    messageExternalId?: string;
  }): {
    messageId?: string;
    strategy: "direct-id" | "hint-id" | "attachment-key" | "timestamp-nearest" | "chat-fallback" | "unlinked";
    score: number;
    candidateChatExternalId?: string;
    candidateTimestamp?: string;
  } {
    if (item.messageExternalId) {
      const direct = input.messageExternalToId.get(item.messageExternalId);
      if (direct) {
        return {
          messageId: direct,
          strategy: "direct-id",
          score: 1,
          candidateChatExternalId: item.chatExternalId
        };
      }
    }

    const hint = findHint(item);
    if (hint?.messageExternalId) {
      const hinted = input.messageExternalToId.get(hint.messageExternalId);
      if (hinted) {
        return {
          messageId: hinted,
          strategy: "hint-id",
          score: 0.95,
          candidateChatExternalId: hint.chatExternalId ?? item.chatExternalId,
          candidateTimestamp: hint.timestamp
        };
      }
    }

    const candidateChatExternal = item.chatExternalId ?? hint?.chatExternalId;
    const candidateTime = parseDate(hint?.timestamp);
    const candidateSenderExternal = hint?.senderExternalId;
    const itemName = item.fileName.toLowerCase();
    const itemPath = item.archivePath.toLowerCase();
    const timeline = input.messageTimeline.filter((row) =>
      candidateChatExternal ? row.chatExternalId === candidateChatExternal : true
    );
    if (timeline.length === 0) {
      return {
        strategy: "unlinked",
        score: 0,
        candidateChatExternalId: candidateChatExternal,
        candidateTimestamp: hint?.timestamp
      };
    }

    const keyedMatches = timeline.filter((row) =>
      (row.attachmentKeys ?? []).some((key) => key === itemName || key === itemPath || itemPath.endsWith(key))
    );
    const onlyMatch = keyedMatches[0];
    if (keyedMatches.length === 1 && onlyMatch) {
      return {
        messageId: onlyMatch.id,
        strategy: "attachment-key",
        score: 0.98,
        candidateChatExternalId: candidateChatExternal,
        candidateTimestamp: hint?.timestamp
      };
    }

    if (candidateTime) {
      const timelineWithTimestamp = timeline.filter((row) => row.timestamp);
      const sortedTimes = timelineWithTimestamp
        .map((row) => (row.timestamp as Date).getTime())
        .sort((a, b) => a - b);
      let adaptiveWindowMs = 1000 * 60 * 15;
      if (sortedTimes.length >= 3) {
        const deltas: number[] = [];
        for (let i = 1; i < sortedTimes.length; i += 1) {
          const current = sortedTimes[i];
          const previous = sortedTimes[i - 1];
          if (typeof current === "number" && typeof previous === "number") {
            deltas.push(current - previous);
          }
        }
        deltas.sort((a, b) => a - b);
        const medianDelta = deltas[Math.floor(deltas.length / 2)];
        if (typeof medianDelta === "number") {
          const bounded = Math.max(1000 * 60 * 2, Math.min(1000 * 60 * 60, medianDelta * 3));
          adaptiveWindowMs = bounded;
        }
      }

      const within = timeline
        .filter((row) => row.timestamp)
        .map((row) => ({
          id: row.id,
          delta: Math.abs((row.timestamp as Date).getTime() - candidateTime.getTime()),
          senderMatch: candidateSenderExternal ? row.senderExternalId === candidateSenderExternal : false
        }))
        .sort((a, b) => {
          if (a.senderMatch && !b.senderMatch) return -1;
          if (!a.senderMatch && b.senderMatch) return 1;
          return a.delta - b.delta;
        });
      const best = within[0];
      if (best && best.delta <= adaptiveWindowMs) {
        const maxWindow = adaptiveWindowMs;
        const normalized = 1 - best.delta / maxWindow;
        const senderBoost = best.senderMatch ? 0.07 : 0;
        return {
          messageId: best.id,
          strategy: "timestamp-nearest",
          score: Number(Math.max(0.6, Math.min(0.95, normalized + senderBoost)).toFixed(3)),
          candidateChatExternalId: candidateChatExternal,
          candidateTimestamp: hint?.timestamp
        };
      }
    }

    return {
      strategy: "unlinked",
      score: 0,
      candidateChatExternalId: candidateChatExternal,
      candidateTimestamp: hint?.timestamp
    };
  }

  const rows: Array<{
    attachmentId: string;
    transcriptionId: string;
    audioAbsolutePath: string;
    linkageStrategy: "direct-id" | "hint-id" | "attachment-key" | "timestamp-nearest" | "chat-fallback" | "unlinked";
    linkageScore: number;
  }> = [];
  const invalidMessageIds = new Set<string>();
  for (const item of input.items) {
    const linkage = pickMessageByHeuristic(item);
    let messageId = linkage.messageId;
    if (messageId && invalidMessageIds.has(messageId)) {
      messageId = undefined;
    }

    const createAttachment = async (linkedMessageId?: string, fallbackReason?: string) => {
      const data = {
          caseId: input.caseId,
          evidenceId: input.evidenceId,
          messageId: linkedMessageId,
          fileName: item.fileName,
          mimeType: "audio",
          sizeBytes: BigInt(item.sizeBytes),
          path: item.absolutePath,
          archivePath: item.archivePath,
          metadata: {
            chatExternalId: item.chatExternalId ?? null,
            messageExternalId: item.messageExternalId ?? null,
            linkedMessageId: linkedMessageId ?? null,
            linkage: {
              strategy: linkedMessageId ? linkage.strategy : "unlinked",
              score: linkedMessageId ? linkage.score : 0,
              candidateChatExternalId: linkage.candidateChatExternalId ?? null,
              candidateTimestamp: linkage.candidateTimestamp ?? null,
              linkedAt: new Date().toISOString(),
              ...(fallbackReason ? { fallbackReason } : {})
            }
          }
        } satisfies Prisma.AttachmentUncheckedCreateInput;

      const existing = await prisma.attachment.findFirst({
        where: {
          evidenceId: input.evidenceId,
          archivePath: item.archivePath
        },
        orderBy: { createdAt: "asc" }
      });

      if (existing) {
        return prisma.attachment.update({
          where: { id: existing.id },
          data
        });
      }

      return prisma.attachment.create({ data });
    };

    const attachment = await createAttachment(messageId).catch(async (error) => {
      if (!messageId || !isAttachmentMessageIdForeignKeyError(error)) {
        throw error;
      }
      invalidMessageIds.add(messageId);
      messageId = undefined;
      return createAttachment(undefined, "linked-message-not-found-at-attachment-create");
    });

    const existingTranscription = await prisma.audioTranscription.findFirst({
      where: {
        extractionId: input.extractionId,
        attachmentId: attachment.id
      },
      orderBy: { createdAt: "desc" }
    });

    const transcription = existingTranscription
      ? await prisma.audioTranscription.update({
          where: { id: existingTranscription.id },
          data: {
            status: existingTranscription.status === "COMPLETED" ? "COMPLETED" : "PENDING",
            sourceFilePath: item.absolutePath,
            error: null,
            startedAt: existingTranscription.status === "COMPLETED" ? existingTranscription.startedAt : null,
            finishedAt: existingTranscription.status === "COMPLETED" ? existingTranscription.finishedAt : null
          }
        })
      : await prisma.audioTranscription.create({
          data: {
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        extractionId: input.extractionId,
        attachmentId: attachment.id,
        status: "PENDING",
        sourceFilePath: item.absolutePath
          }
        });

    rows.push({
      attachmentId: attachment.id,
      transcriptionId: transcription.id,
      audioAbsolutePath: item.absolutePath,
      linkageStrategy: messageId ? linkage.strategy : "unlinked",
      linkageScore: messageId ? linkage.score : 0
    });
  }

  return rows;
}

export async function persistAudioArtifactsIndex(input: {
  caseId: string;
  evidenceId: string;
  items: Array<{
    archivePath?: string;
    fileName?: string;
    mimeType?: string;
    timestamp?: string;
    chatExternalId?: string;
    messageExternalId?: string;
    senderExternalId?: string;
    metadata?: Record<string, unknown>;
  }>;
  messageExternalToId: Map<string, string>;
  messageTimeline: Array<{
    id: string;
    chatId?: string;
    chatExternalId?: string;
    externalId?: string;
    senderExternalId?: string;
    timestamp?: Date;
    attachmentKeys?: string[];
  }>;
  onProgress?: (input: { processed: number; total: number }) => void;
}) {
  function parseDate(value?: string) {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return undefined;
    return d;
  }

  function pickMessageByHeuristic(item: {
    archivePath?: string;
    fileName?: string;
    chatExternalId?: string;
    messageExternalId?: string;
    timestamp?: string;
    senderExternalId?: string;
  }): {
    messageId?: string;
    strategy: "direct-id" | "attachment-key" | "timestamp-nearest" | "unlinked";
    score: number;
  } {
    if (item.messageExternalId) {
      const direct = input.messageExternalToId.get(item.messageExternalId);
      if (direct) {
        return { messageId: direct, strategy: "direct-id", score: 1 };
      }
    }

    const candidateChatExternal = item.chatExternalId;
    const candidateTime = parseDate(item.timestamp);
    const candidateSenderExternal = item.senderExternalId;
    const itemName = (item.fileName ?? "").toLowerCase();
    const itemPath = (item.archivePath ?? "").toLowerCase();
    const timeline = input.messageTimeline.filter((row) =>
      candidateChatExternal ? row.chatExternalId === candidateChatExternal : true
    );
    if (timeline.length === 0) {
      return { strategy: "unlinked", score: 0 };
    }

    if (itemName || itemPath) {
      const keyedMatches = timeline.filter((row) =>
        (row.attachmentKeys ?? []).some((key) => key === itemName || key === itemPath || (itemPath && itemPath.endsWith(key)))
      );
      const onlyMatch = keyedMatches[0];
      if (keyedMatches.length === 1 && onlyMatch) {
        return { messageId: onlyMatch.id, strategy: "attachment-key", score: 0.98 };
      }
    }

    if (candidateTime) {
      const timelineWithTimestamp = timeline.filter((row) => row.timestamp);
      const sortedTimes = timelineWithTimestamp
        .map((row) => (row.timestamp as Date).getTime())
        .sort((a, b) => a - b);
      let adaptiveWindowMs = 1000 * 60 * 15;
      if (sortedTimes.length >= 3) {
        const deltas: number[] = [];
        for (let i = 1; i < sortedTimes.length; i += 1) {
          const current = sortedTimes[i];
          const previous = sortedTimes[i - 1];
          if (typeof current === "number" && typeof previous === "number") {
            deltas.push(current - previous);
          }
        }
        deltas.sort((a, b) => a - b);
        const medianDelta = deltas[Math.floor(deltas.length / 2)];
        if (typeof medianDelta === "number") {
          const bounded = Math.max(1000 * 60 * 2, Math.min(1000 * 60 * 60, medianDelta * 3));
          adaptiveWindowMs = bounded;
        }
      }

      const within = timeline
        .filter((row) => row.timestamp)
        .map((row) => ({
          id: row.id,
          delta: Math.abs((row.timestamp as Date).getTime() - candidateTime.getTime()),
          senderMatch: candidateSenderExternal ? row.senderExternalId === candidateSenderExternal : false
        }))
        .sort((a, b) => {
          if (a.senderMatch && !b.senderMatch) return -1;
          if (!a.senderMatch && b.senderMatch) return 1;
          return a.delta - b.delta;
        });
      const best = within[0];
      if (best && best.delta <= adaptiveWindowMs) {
        const normalized = 1 - best.delta / adaptiveWindowMs;
        const senderBoost = best.senderMatch ? 0.07 : 0;
        return {
          messageId: best.id,
          strategy: "timestamp-nearest",
          score: Number(Math.max(0.6, Math.min(0.95, normalized + senderBoost)).toFixed(3))
        };
      }
    }

    return { strategy: "unlinked", score: 0 };
  }

  const dedup = new Set<string>();
  const invalidMessageIds = new Set<string>();
  let created = 0;
  let linked = 0;
  const linkageSummary: Record<string, number> = {};

  const total = input.items.length;
  for (const item of input.items) {
    const archivePath = item.archivePath?.trim();
    const fileName = item.fileName?.trim();
    if (!archivePath && !fileName) continue;

    const dedupKey = `${archivePath ?? ""}|${fileName ?? ""}|${item.messageExternalId ?? ""}`.toLowerCase();
    if (dedup.has(dedupKey)) continue;
    dedup.add(dedupKey);

    const linkage = pickMessageByHeuristic(item);
    let messageId = linkage.messageId;
    if (messageId && invalidMessageIds.has(messageId)) {
      messageId = undefined;
    }

    const createIndexedAttachment = (linkedMessageId?: string, fallbackReason?: string) =>
      prisma.attachment.create({
        data: {
          caseId: input.caseId,
          evidenceId: input.evidenceId,
          messageId: linkedMessageId,
          fileName:
            fileName ??
            (() => {
              const fallback = archivePath ?? "";
              const parts = fallback.split(PATH_SPLIT_RE);
              return parts[parts.length - 1] ?? fallback;
            })(),
          mimeType: item.mimeType ?? "audio",
          path: null,
          archivePath: archivePath ?? null,
          metadata: {
            source: "audio-artifact-index",
            chatExternalId: item.chatExternalId ?? null,
            messageExternalId: item.messageExternalId ?? null,
            senderExternalId: item.senderExternalId ?? null,
            timestamp: item.timestamp ?? null,
            linkedMessageId: linkedMessageId ?? null,
            linkage: {
              strategy: linkedMessageId ? linkage.strategy : "unlinked",
              score: linkedMessageId ? linkage.score : 0,
              linkedAt: new Date().toISOString(),
              ...(fallbackReason ? { fallbackReason } : {})
            },
            ...(item.metadata ?? {})
          } as Prisma.InputJsonValue
        }
      });

    await createIndexedAttachment(messageId).catch(async (error) => {
      if (!messageId || !isAttachmentMessageIdForeignKeyError(error)) {
        throw error;
      }
      invalidMessageIds.add(messageId);
      messageId = undefined;
      return createIndexedAttachment(undefined, "linked-message-not-found-at-attachment-create");
    });

    const effectiveStrategy = messageId ? linkage.strategy : "unlinked";
    if (messageId) linked += 1;
    linkageSummary[effectiveStrategy] = (linkageSummary[effectiveStrategy] ?? 0) + 1;

    created += 1;
    input.onProgress?.({ processed: created, total });
  }

  return { created, linked, linkageSummary };
}

export async function updateTranscriptionStatus(input: {
  transcriptionId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  fromStatuses?: Array<"PENDING" | "PROCESSING" | "COMPLETED" | "FAILED">;
  engine?: string;
  language?: string;
  text?: string;
  segments?: Prisma.InputJsonValue;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
}) {
  const result = await prisma.audioTranscription.updateMany({
    where: {
      id: input.transcriptionId,
      ...(input.fromStatuses && input.fromStatuses.length > 0 ? { status: { in: input.fromStatuses } } : {})
    },
    data: {
      status: input.status,
      engine: input.engine,
      language: input.language,
      text: input.text,
      segments: input.segments,
      error: input.error,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt
    }
  });
  return result.count > 0;
}

function normalizeAttachmentKey(value?: string | null) {
  return (value ?? "").trim().toLowerCase();
}

function basenameLike(value?: string | null) {
  const normalized = normalizeAttachmentKey(value);
  if (!normalized) return "";
  const parts = normalized.split(PATH_SPLIT_RE);
  return parts[parts.length - 1] ?? normalized;
}

export async function relinkAudioAttachmentsForEvidence(input: { evidenceId: string }) {
  const messages = await prisma.message.findMany({
    where: { evidenceId: input.evidenceId },
    select: {
      id: true,
      externalId: true,
      senderId: true,
      timestamp: true,
      metadata: true,
      chat: { select: { externalId: true } }
    }
  });

  const messageByExternalId = new Map<string, string>();
  const messageByAttachmentKey = new Map<string, string[]>();
  const timelineByChatExternalId = new Map<
    string,
    Array<{ messageId: string; timestamp?: Date; senderExternalId?: string }>
  >();
  const timelineGlobal: Array<{ messageId: string; timestamp?: Date; senderExternalId?: string }> = [];

  for (const message of messages) {
    if (message.externalId) {
      messageByExternalId.set(normalizeAttachmentKey(message.externalId), message.id);
    }
    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
    for (const entry of attachments) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const name = normalizeAttachmentKey(readStringFromRecord(row, ["name", "fileName", "filename"]));
      const path = normalizeAttachmentKey(readStringFromRecord(row, ["path", "archivePath", "sourcePath", "fullPath"]));
      const keys = [name, path, basenameLike(name), basenameLike(path)].filter(Boolean);
      for (const key of keys) {
        const list = messageByAttachmentKey.get(key) ?? [];
        list.push(message.id);
        messageByAttachmentKey.set(key, list);
      }
    }

    const timelineRow = {
      messageId: message.id,
      timestamp: message.timestamp ?? undefined,
      senderExternalId: message.senderId ?? undefined
    };
    timelineGlobal.push(timelineRow);
    const chatExternal = normalizeAttachmentKey(message.chat?.externalId);
    if (chatExternal) {
      const list = timelineByChatExternalId.get(chatExternal) ?? [];
      list.push(timelineRow);
      timelineByChatExternalId.set(chatExternal, list);
    }
  }

  const attachments = await prisma.attachment.findMany({
    where: { evidenceId: input.evidenceId },
    select: {
      id: true,
      messageId: true,
      fileName: true,
      mimeType: true,
      archivePath: true,
      metadata: true
    }
  });

  let scanned = 0;
  let relinked = 0;
  let unchanged = 0;
  let unlinked = 0;
  const strategies: Record<string, number> = {};

  const bump = (key: string) => {
    strategies[key] = (strategies[key] ?? 0) + 1;
  };

  for (const attachment of attachments) {
    const fileName = normalizeAttachmentKey(attachment.fileName);
    const archivePath = normalizeAttachmentKey(attachment.archivePath);
    const mimeType = normalizeAttachmentKey(attachment.mimeType);
    const isAudio = AUDIO_MIME_RE.test(mimeType) || AUDIO_EXT_RE.test(fileName || archivePath);
    if (!isAudio) continue;

    scanned += 1;
    const metadata = ((attachment.metadata ?? {}) as Record<string, unknown>) ?? {};
    const messageExternalId = normalizeAttachmentKey(
      typeof metadata.messageExternalId === "string" ? metadata.messageExternalId : undefined
    );
    const chatExternalId = normalizeAttachmentKey(
      typeof metadata.chatExternalId === "string" ? metadata.chatExternalId : undefined
    );
    const candidateTimestampRaw =
      typeof metadata?.linkage === "object" &&
      metadata.linkage &&
      typeof (metadata.linkage as Record<string, unknown>).candidateTimestamp === "string"
        ? ((metadata.linkage as Record<string, unknown>).candidateTimestamp as string)
        : undefined;
    const candidateSenderExternalId =
      typeof metadata.senderExternalId === "string" ? normalizeAttachmentKey(metadata.senderExternalId) : undefined;

    let targetMessageId: string | undefined;
    let strategy: "direct-id" | "attachment-key" | "timestamp-nearest" | "unlinked" = "unlinked";
    let score = 0;

    if (messageExternalId) {
      const direct = messageByExternalId.get(messageExternalId);
      if (direct) {
        targetMessageId = direct;
        strategy = "direct-id";
        score = 1;
      }
    }

    if (!targetMessageId) {
      const keyCandidates = new Set<string>();
      const keys = [fileName, archivePath, basenameLike(fileName), basenameLike(archivePath)].filter(Boolean);
      for (const key of keys) {
        const rows = messageByAttachmentKey.get(key) ?? [];
        for (const id of rows) keyCandidates.add(id);
      }
      if (keyCandidates.size === 1) {
        targetMessageId = [...keyCandidates][0];
        strategy = "attachment-key";
        score = 0.98;
      }
    }

    if (!targetMessageId && candidateTimestampRaw) {
      const candidateTimestamp = parseDate(candidateTimestampRaw);
      if (candidateTimestamp) {
        const scoped = chatExternalId ? (timelineByChatExternalId.get(chatExternalId) ?? []) : timelineGlobal;
        const ordered = scoped
          .filter((row) => row.timestamp)
          .map((row) => ({
            ...row,
            delta: Math.abs((row.timestamp as Date).getTime() - candidateTimestamp.getTime()),
            senderMatch: candidateSenderExternalId
              ? normalizeAttachmentKey(row.senderExternalId) === candidateSenderExternalId
              : false
          }))
          .sort((a, b) => {
            if (a.senderMatch && !b.senderMatch) return -1;
            if (!a.senderMatch && b.senderMatch) return 1;
            return a.delta - b.delta;
          });
        const best = ordered[0];
        if (best && best.delta <= 1000 * 60 * 60) {
          targetMessageId = best.messageId;
          strategy = "timestamp-nearest";
          score = 0.75;
        }
      }
    }

    if (!targetMessageId) {
      unlinked += 1;
      bump("unlinked");
      continue;
    }

    if (attachment.messageId === targetMessageId) {
      unchanged += 1;
      bump("unchanged");
      continue;
    }

    await prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        messageId: targetMessageId,
        metadata: {
          ...metadata,
          linkedMessageId: targetMessageId,
          linkage: {
            strategy,
            score,
            candidateChatExternalId: chatExternalId || null,
            candidateTimestamp: candidateTimestampRaw ?? null,
            linkedAt: new Date().toISOString()
          }
        }
      }
    });
    relinked += 1;
    bump(strategy);
  }

  return {
    scanned,
    relinked,
    unchanged,
    unlinked,
    strategies
  };
}
