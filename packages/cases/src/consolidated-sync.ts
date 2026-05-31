import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma, Prisma } from "@core/db";

export type AppNodeRole = "STANDALONE" | "NODE" | "CENTRALIZER";

const SCHEMA_VERSION = "core-consolidated-sync.v1";
const PACKAGE_TYPE = "CONSOLIDATED_SELECTION";
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type ConsolidatedSyncSelection = {
  caseId: string;
  evidenceId?: string;
  extractionId?: string;
  selectedChatIds?: string[];
  selectedMessageIds?: string[];
  selectedAttachmentIds?: string[];
  includeTranscriptions?: boolean;
  includeOcr?: boolean;
  includeInsights?: boolean;
  includeMediaFiles?: boolean;
  maxFileBytes?: number;
};

export type ConsolidatedSyncPackage = {
  schemaVersion: typeof SCHEMA_VERSION;
  packageType: typeof PACKAGE_TYPE;
  packageId: string;
  exportedAt: string;
  sourceNode: {
    nodeId: string;
    displayName?: string;
    role: AppNodeRole;
  };
  manifest: {
    containsRawUfdr: false;
    rawUfdrIncluded: false;
    forbiddenRawInputs: string[];
    scope: {
      caseId: string;
      evidenceId?: string;
      extractionId?: string;
      selectedChatIds: string[];
      selectedMessageIds: string[];
      selectedAttachmentIds: string[];
    };
    counts: {
      chats: number;
      participants: number;
      messages: number;
      attachments: number;
      files: number;
      transcriptions: number;
      ocrDocuments: number;
      aiInsights: number;
    };
  };
  case: {
    id: string;
    caseNumber: string;
    title: string;
    description?: string | null;
    inquiryType?: string | null;
    inquiryNumber?: string | null;
    policeUnit?: string | null;
    inquiryLegalFraming?: string | null;
    inquirySummaryText?: string | null;
    inquiryMainFacts?: string | null;
    inquiryInvestigativeFocus?: string | null;
  };
  evidence?: {
    id: string;
    label: string;
    source?: string | null;
    mimeType?: string | null;
    fileName: string;
    sizeBytes: string;
    sha256: string;
    createdAt: string;
  };
  extraction?: {
    id: string;
    status: string;
    sourceFormat: string;
    processingPhase?: string | null;
    processingProgress?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    createdAt: string;
  };
  entities: {
    chats: ConsolidatedChat[];
    participants: ConsolidatedParticipant[];
    messages: ConsolidatedMessage[];
    attachments: ConsolidatedAttachment[];
    transcriptions: ConsolidatedTranscription[];
    ocrDocuments: ConsolidatedOcrDocument[];
    aiInsights: ConsolidatedAiInsight[];
  };
  files: ConsolidatedFile[];
  payloadHash: string;
};

type ConsolidatedChat = {
  id: string;
  externalId?: string | null;
  sourceApp?: string | null;
  title?: string | null;
  metadata?: unknown;
  createdAt: string;
};

type ConsolidatedParticipant = {
  id: string;
  chatId: string;
  externalId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  handle?: string | null;
  metadata?: unknown;
  createdAt: string;
};

type ConsolidatedMessage = {
  id: string;
  chatId?: string | null;
  externalId?: string | null;
  senderId?: string | null;
  body?: string | null;
  timestamp?: string | null;
  direction?: string | null;
  metadata?: unknown;
  createdAt: string;
};

type ConsolidatedAttachment = {
  id: string;
  messageId?: string | null;
  externalId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: string | null;
  metadata?: unknown;
  createdAt: string;
  selectedForFileTransfer: boolean;
  fileHash?: string | null;
  fileUnavailableReason?: string | null;
};

type ConsolidatedTranscription = {
  id: string;
  attachmentId: string;
  engine: string;
  language?: string | null;
  status: string;
  text?: string | null;
  segments?: unknown;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ConsolidatedOcrDocument = {
  id: string;
  attachmentId?: string | null;
  sourcePath?: string | null;
  language?: string | null;
  engine: string;
  text?: string | null;
  confidence?: number | null;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
};

type ConsolidatedAiInsight = {
  id: string;
  evidenceId?: string | null;
  extractionId?: string | null;
  type: string;
  title: string;
  summary: string;
  score?: number | null;
  metadata?: unknown;
  createdAt: string;
};

type ConsolidatedFile = {
  attachmentId: string;
  fileName: string;
  mimeType?: string | null;
  sizeBytes: string;
  sha256: string;
  contentBase64: string;
};

type ImportLogEntry = {
  level?: "INFO" | "WARN" | "ERROR";
  entityType?: string;
  sourceEntityId?: string;
  localEntityId?: string;
  action: string;
  message?: string;
  metadata?: JsonRecord;
};

type ImportCounters = {
  casesCreated: number;
  casesReused: number;
  evidencesCreated: number;
  evidencesReused: number;
  extractionsCreated: number;
  extractionsReused: number;
  chatsCreated: number;
  chatsReused: number;
  participantsCreated: number;
  participantsReused: number;
  messagesCreated: number;
  messagesReused: number;
  attachmentsCreated: number;
  attachmentsReused: number;
  filesStored: number;
  transcriptionsCreated: number;
  transcriptionsReused: number;
  ocrDocumentsCreated: number;
  ocrDocumentsReused: number;
  aiInsightsCreated: number;
  aiInsightsReused: number;
};

function parseNodeRole(value?: string): AppNodeRole {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "NODE" || normalized === "CENTRALIZER" || normalized === "STANDALONE") return normalized;
  return "STANDALONE";
}

export function getAppNodeRole(): AppNodeRole {
  return parseNodeRole(process.env.APP_NODE_ROLE ?? process.env.CORE_NODE_ROLE);
}

export function getConsolidatedSyncConfig() {
  const role = getAppNodeRole();
  const nodeId = (process.env.SYNC_NODE_ID ?? process.env.CORE_NODE_ID ?? os.hostname()).trim();
  const displayName = (process.env.SYNC_NODE_NAME ?? process.env.CORE_NODE_NAME ?? os.hostname()).trim();
  const centralizerUrl = process.env.CENTRALIZER_URL?.trim() || process.env.CORE_CENTRALIZER_URL?.trim() || "";
  return {
    role,
    nodeId,
    displayName,
    centralizerUrl,
    canReceiveExternalPackages: role === "CENTRALIZER",
    canSendExternalPackages: role === "NODE" || role === "CENTRALIZER"
  };
}

function uniqueStrings(values?: string[]) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function payloadHash(payloadWithoutHash: Omit<ConsolidatedSyncPackage, "payloadHash">) {
  return createHash("sha256").update(JSON.stringify(payloadWithoutHash)).digest("hex");
}

function hashBuffer(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "arquivo";
}

function storageRoot() {
  return path.resolve(process.env.STORAGE_ROOT ?? "./storage");
}

function sanitizeForPackage(value: unknown): unknown {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForPackage(item));

  const blockedKeys = new Set([
    "absolutePath",
    "archivePath",
    "fullPath",
    "originalPath",
    "path",
    "sourcePath",
    "ufdrPath",
    "ufdrAbsolutePath"
  ]);
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (blockedKeys.has(key)) continue;
    out[key] = sanitizeForPackage(child);
  }
  return out;
}

function jsonForDb(value: unknown): Prisma.InputJsonValue {
  return sanitizeForPackage(value ?? {}) as Prisma.InputJsonValue;
}

function stripUndefined<T extends JsonRecord>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

async function recordSyncPackage(input: {
  package: ConsolidatedSyncPackage;
  direction: "OUTBOUND" | "INBOUND";
  status: string;
  caseId?: string | null;
  evidenceId?: string | null;
  extractionId?: string | null;
  errorMessage?: string | null;
}) {
  const now = new Date();
  const pkg = input.package;
  await prisma.$executeRaw`
    INSERT INTO "SyncPackage" (
      "id", "packageId", "direction", "status", "schemaVersion", "sourceNodeId", "sourceNodeName",
      "caseId", "evidenceId", "extractionId", "caseNumber", "payloadHash", "itemCounts", "errorMessage",
      "exportedAt", "receivedAt", "importedAt", "createdAt", "updatedAt"
    )
    VALUES (
      ${randomUUID()}, ${pkg.packageId}, ${input.direction}, ${input.status}, ${pkg.schemaVersion},
      ${pkg.sourceNode.nodeId}, ${pkg.sourceNode.displayName ?? null}, ${input.caseId ?? null},
      ${input.evidenceId ?? null}, ${input.extractionId ?? null}, ${pkg.case.caseNumber}, ${pkg.payloadHash},
      ${JSON.stringify(pkg.manifest.counts)}::jsonb, ${input.errorMessage ?? null},
      ${new Date(pkg.exportedAt)}, ${input.direction === "INBOUND" ? now : null},
      ${input.status === "IMPORTED" ? now : null}, ${now}, ${now}
    )
    ON CONFLICT ("packageId") DO UPDATE SET
      "status" = EXCLUDED."status",
      "caseId" = COALESCE(EXCLUDED."caseId", "SyncPackage"."caseId"),
      "evidenceId" = COALESCE(EXCLUDED."evidenceId", "SyncPackage"."evidenceId"),
      "extractionId" = COALESCE(EXCLUDED."extractionId", "SyncPackage"."extractionId"),
      "errorMessage" = EXCLUDED."errorMessage",
      "itemCounts" = EXCLUDED."itemCounts",
      "receivedAt" = COALESCE("SyncPackage"."receivedAt", EXCLUDED."receivedAt"),
      "importedAt" = CASE WHEN EXCLUDED."status" = 'IMPORTED' THEN ${now} ELSE "SyncPackage"."importedAt" END,
      "updatedAt" = ${now}
  `;
}

async function recordSyncNode(pkg: ConsolidatedSyncPackage) {
  const now = new Date();
  await prisma.$executeRaw`
    INSERT INTO "SyncNode" ("id", "nodeId", "displayName", "role", "metadata", "lastSeenAt", "createdAt", "updatedAt")
    VALUES (
      ${randomUUID()}, ${pkg.sourceNode.nodeId}, ${pkg.sourceNode.displayName ?? null}, ${pkg.sourceNode.role},
      ${JSON.stringify({ schemaVersion: pkg.schemaVersion })}::jsonb, ${now}, ${now}, ${now}
    )
    ON CONFLICT ("nodeId") DO UPDATE SET
      "displayName" = EXCLUDED."displayName",
      "role" = EXCLUDED."role",
      "lastSeenAt" = ${now},
      "updatedAt" = ${now}
  `;
}

async function insertImportLog(tx: Prisma.TransactionClient, packageId: string, entry: ImportLogEntry) {
  await tx.$executeRaw`
    INSERT INTO "SyncImportLog" (
      "id", "packageId", "level", "entityType", "sourceEntityId", "localEntityId", "action", "message", "metadata", "createdAt"
    )
    VALUES (
      ${randomUUID()}, ${packageId}, ${entry.level ?? "INFO"}, ${entry.entityType ?? null},
      ${entry.sourceEntityId ?? null}, ${entry.localEntityId ?? null}, ${entry.action}, ${entry.message ?? null},
      ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb, ${new Date()}
    )
  `;
}

async function findMappedEntity(
  tx: Prisma.TransactionClient,
  input: {
    sourceNodeId: string;
    entityType: string;
    sourceEntityId: string;
  }
) {
  const rows = await tx.$queryRaw<Array<{ localEntityId: string }>>`
    SELECT "localEntityId"
    FROM "ExternalEntityMap"
    WHERE "sourceNodeId" = ${input.sourceNodeId}
      AND "entityType" = ${input.entityType}
      AND "sourceEntityId" = ${input.sourceEntityId}
    LIMIT 1
  `;
  return rows[0]?.localEntityId;
}

async function upsertEntityMap(
  tx: Prisma.TransactionClient,
  input: {
    sourceNodeId: string;
    entityType: string;
    sourceEntityId: string;
    localEntityType: string;
    localEntityId: string;
    packageId: string;
    contentHash?: string | null;
  }
) {
  const now = new Date();
  await tx.$executeRaw`
    INSERT INTO "ExternalEntityMap" (
      "id", "sourceNodeId", "entityType", "sourceEntityId", "localEntityType", "localEntityId",
      "packageId", "contentHash", "createdAt", "updatedAt"
    )
    VALUES (
      ${randomUUID()}, ${input.sourceNodeId}, ${input.entityType}, ${input.sourceEntityId}, ${input.localEntityType},
      ${input.localEntityId}, ${input.packageId}, ${input.contentHash ?? null}, ${now}, ${now}
    )
    ON CONFLICT ("sourceNodeId", "entityType", "sourceEntityId") DO UPDATE SET
      "localEntityType" = EXCLUDED."localEntityType",
      "localEntityId" = EXCLUDED."localEntityId",
      "packageId" = EXCLUDED."packageId",
      "contentHash" = EXCLUDED."contentHash",
      "updatedAt" = ${now}
  `;
}

async function maybeReadAttachmentFile(input: {
  attachmentId: string;
  fileName?: string | null;
  mimeType?: string | null;
  path?: string | null;
  selected: boolean;
  maxFileBytes: number;
}): Promise<ConsolidatedFile | { unavailable: string }> {
  if (!input.selected) return { unavailable: "NOT_SELECTED_FOR_FILE_TRANSFER" };
  if (!input.path) return { unavailable: "LOCAL_RECOVERED_FILE_NOT_AVAILABLE" };

  const absolutePath = path.resolve(input.path);
  const info = await stat(absolutePath).catch(() => null);
  if (!info?.isFile()) return { unavailable: "LOCAL_RECOVERED_FILE_NOT_FOUND" };
  if (info.size > input.maxFileBytes) return { unavailable: "FILE_EXCEEDS_SYNC_LIMIT" };

  const bytes = await readFile(absolutePath);
  const sha256 = hashBuffer(bytes);
  return {
    attachmentId: input.attachmentId,
    fileName: input.fileName ?? path.basename(absolutePath),
    mimeType: input.mimeType ?? null,
    sizeBytes: String(info.size),
    sha256,
    contentBase64: bytes.toString("base64")
  };
}

export async function buildConsolidatedSyncPackage(input: ConsolidatedSyncSelection): Promise<ConsolidatedSyncPackage> {
  const selectedChatIds = uniqueStrings(input.selectedChatIds);
  const selectedMessageIds = uniqueStrings(input.selectedMessageIds);
  const selectedAttachmentIds = uniqueStrings(input.selectedAttachmentIds);

  if (selectedChatIds.length + selectedMessageIds.length + selectedAttachmentIds.length === 0) {
    throw new Error("Selecione pelo menos um chat, mensagem ou arquivo para gerar pacote consolidado.");
  }

  const [caseRow, extractionFromInput, evidenceFromInput] = await Promise.all([
    prisma.case.findUnique({ where: { id: input.caseId } }),
    input.extractionId
      ? prisma.extraction.findFirst({
          where: { id: input.extractionId, caseId: input.caseId },
          include: { evidence: true }
        })
      : null,
    input.evidenceId ? prisma.evidence.findFirst({ where: { id: input.evidenceId, caseId: input.caseId } }) : null
  ]);

  if (!caseRow) throw new Error("Caso nao encontrado para gerar pacote consolidado.");
  const evidenceRow = extractionFromInput?.evidence ?? evidenceFromInput ?? null;
  if (input.extractionId && !extractionFromInput) throw new Error("Extracao nao encontrada para este caso.");
  if (input.evidenceId && !evidenceRow) throw new Error("Evidencia nao encontrada para este caso.");

  const chatWhere: Prisma.ChatWhereInput = {
    caseId: input.caseId,
    ...(evidenceRow ? { evidenceId: evidenceRow.id } : {}),
    id: { in: selectedChatIds.length > 0 ? selectedChatIds : ["__none__"] }
  };

  const chats = await prisma.chat.findMany({
    where: chatWhere,
    include: { participants: true },
    orderBy: { createdAt: "asc" }
  });

  const effectiveChatIds = chats.map((chat) => chat.id);
  const messageWhere: Prisma.MessageWhereInput = {
    caseId: input.caseId,
    ...(evidenceRow ? { evidenceId: evidenceRow.id } : {}),
    OR: [
      effectiveChatIds.length > 0 ? { chatId: { in: effectiveChatIds } } : undefined,
      selectedMessageIds.length > 0 ? { id: { in: selectedMessageIds } } : undefined
    ].filter(Boolean) as Prisma.MessageWhereInput[]
  };

  const messages = await prisma.message.findMany({
    where: messageWhere.OR && messageWhere.OR.length > 0 ? messageWhere : { id: { in: ["__none__"] } },
    orderBy: { timestamp: "asc" }
  });

  const messageIds = messages.map((message) => message.id);
  const attachments = await prisma.attachment.findMany({
    where: {
      caseId: input.caseId,
      ...(evidenceRow ? { evidenceId: evidenceRow.id } : {}),
      OR: [
        messageIds.length > 0 ? { messageId: { in: messageIds } } : undefined,
        selectedAttachmentIds.length > 0 ? { id: { in: selectedAttachmentIds } } : undefined
      ].filter(Boolean) as Prisma.AttachmentWhereInput[]
    },
    orderBy: { createdAt: "asc" }
  });

  const attachmentIds = attachments.map((attachment) => attachment.id);
  const [transcriptions, ocrDocuments, aiInsights] = await Promise.all([
    input.includeTranscriptions ?? true
      ? prisma.audioTranscription.findMany({
          where: { caseId: input.caseId, attachmentId: { in: attachmentIds.length > 0 ? attachmentIds : ["__none__"] } },
          orderBy: { createdAt: "asc" }
        })
      : [],
    input.includeOcr ?? true
      ? prisma.ocrDocument.findMany({
          where: { caseId: input.caseId, attachmentId: { in: attachmentIds.length > 0 ? attachmentIds : ["__none__"] } },
          orderBy: { createdAt: "asc" }
        })
      : [],
    input.includeInsights ?? true
      ? prisma.aiInsight.findMany({
          where: {
            caseId: input.caseId,
            ...(evidenceRow ? { evidenceId: evidenceRow.id } : {}),
            ...(extractionFromInput ? { extractionId: extractionFromInput.id } : {})
          },
          orderBy: { createdAt: "asc" },
          take: 200
        })
      : []
  ]);

  const selectedAttachmentSet = new Set(selectedAttachmentIds);
  const maxFileBytes = input.maxFileBytes ?? Number(process.env.SYNC_PACKAGE_MAX_FILE_BYTES ?? DEFAULT_MAX_FILE_BYTES);
  const files: ConsolidatedFile[] = [];
  const fileStatus = new Map<string, { hash?: string; unavailable?: string }>();

  if (input.includeMediaFiles ?? true) {
    for (const attachment of attachments) {
      const file = await maybeReadAttachmentFile({
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        path: attachment.path,
        selected: selectedAttachmentSet.has(attachment.id),
        maxFileBytes
      });
      if ("contentBase64" in file) {
        files.push(file);
        fileStatus.set(attachment.id, { hash: file.sha256 });
      } else {
        fileStatus.set(attachment.id, { unavailable: file.unavailable });
      }
    }
  }

  const config = getConsolidatedSyncConfig();
  const packageId = randomUUID();
  const exportedAt = new Date().toISOString();

  const participants = chats.flatMap((chat) => chat.participants);
  const payloadWithoutHash: Omit<ConsolidatedSyncPackage, "payloadHash"> = {
    schemaVersion: SCHEMA_VERSION,
    packageType: PACKAGE_TYPE,
    packageId,
    exportedAt,
    sourceNode: {
      nodeId: config.nodeId,
      displayName: config.displayName,
      role: config.role
    },
    manifest: {
      containsRawUfdr: false,
      rawUfdrIncluded: false,
      forbiddenRawInputs: ["UFDR", "RAW_EXTRACTION_DIRECTORY", "UNSELECTED_ATTACHMENTS"],
      scope: {
        caseId: input.caseId,
        evidenceId: evidenceRow?.id,
        extractionId: extractionFromInput?.id,
        selectedChatIds,
        selectedMessageIds,
        selectedAttachmentIds
      },
      counts: {
        chats: chats.length,
        participants: participants.length,
        messages: messages.length,
        attachments: attachments.length,
        files: files.length,
        transcriptions: transcriptions.length,
        ocrDocuments: ocrDocuments.length,
        aiInsights: aiInsights.length
      }
    },
    case: stripUndefined({
      id: caseRow.id,
      caseNumber: caseRow.caseNumber,
      title: caseRow.title,
      description: caseRow.description,
      inquiryType: caseRow.inquiryType,
      inquiryNumber: caseRow.inquiryNumber,
      policeUnit: caseRow.policeUnit,
      inquiryLegalFraming: caseRow.inquiryLegalFraming,
      inquirySummaryText: caseRow.inquirySummaryText,
      inquiryMainFacts: caseRow.inquiryMainFacts,
      inquiryInvestigativeFocus: caseRow.inquiryInvestigativeFocus
    }),
    evidence: evidenceRow
      ? {
          id: evidenceRow.id,
          label: evidenceRow.label,
          source: evidenceRow.source,
          mimeType: evidenceRow.mimeType,
          fileName: evidenceRow.fileName,
          sizeBytes: String(evidenceRow.sizeBytes),
          sha256: evidenceRow.sha256,
          createdAt: evidenceRow.createdAt.toISOString()
        }
      : undefined,
    extraction: extractionFromInput
      ? {
          id: extractionFromInput.id,
          status: extractionFromInput.status,
          sourceFormat: extractionFromInput.sourceFormat,
          processingPhase: extractionFromInput.processingPhase,
          processingProgress: extractionFromInput.processingProgress,
          startedAt: extractionFromInput.startedAt?.toISOString() ?? null,
          finishedAt: extractionFromInput.finishedAt?.toISOString() ?? null,
          createdAt: extractionFromInput.createdAt.toISOString()
        }
      : undefined,
    entities: {
      chats: chats.map((chat) => ({
        id: chat.id,
        externalId: chat.externalId,
        sourceApp: chat.sourceApp,
        title: chat.title,
        metadata: sanitizeForPackage(chat.metadata),
        createdAt: chat.createdAt.toISOString()
      })),
      participants: participants.map((participant) => ({
        id: participant.id,
        chatId: participant.chatId,
        externalId: participant.externalId,
        name: participant.name,
        phone: participant.phone,
        email: participant.email,
        handle: participant.handle,
        metadata: sanitizeForPackage(participant.metadata),
        createdAt: participant.createdAt.toISOString()
      })),
      messages: messages.map((message) => ({
        id: message.id,
        chatId: message.chatId,
        externalId: message.externalId,
        senderId: message.senderId,
        body: message.body,
        timestamp: message.timestamp?.toISOString() ?? null,
        direction: message.direction,
        metadata: sanitizeForPackage(message.metadata),
        createdAt: message.createdAt.toISOString()
      })),
      attachments: attachments.map((attachment) => {
        const status = fileStatus.get(attachment.id);
        return {
          id: attachment.id,
          messageId: attachment.messageId,
          externalId: attachment.externalId,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes == null ? null : String(attachment.sizeBytes),
          metadata: sanitizeForPackage(attachment.metadata),
          createdAt: attachment.createdAt.toISOString(),
          selectedForFileTransfer: selectedAttachmentSet.has(attachment.id),
          fileHash: status?.hash ?? null,
          fileUnavailableReason: status?.unavailable ?? null
        };
      }),
      transcriptions: transcriptions.map((row) => ({
        id: row.id,
        attachmentId: row.attachmentId,
        engine: row.engine,
        language: row.language,
        status: row.status,
        text: row.text,
        segments: sanitizeForPackage(row.segments),
        error: row.error,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString()
      })),
      ocrDocuments: ocrDocuments.map((row) => ({
        id: row.id,
        attachmentId: row.attachmentId,
        sourcePath: row.sourcePath ? path.basename(row.sourcePath) : null,
        language: row.language,
        engine: row.engine,
        text: row.text,
        confidence: row.confidence,
        metadata: sanitizeForPackage(row.metadata),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString()
      })),
      aiInsights: aiInsights.map((row) => ({
        id: row.id,
        evidenceId: row.evidenceId,
        extractionId: row.extractionId,
        type: row.type,
        title: row.title,
        summary: row.summary,
        score: row.score,
        metadata: sanitizeForPackage(row.metadata),
        createdAt: row.createdAt.toISOString()
      }))
    },
    files
  };

  const pkg: ConsolidatedSyncPackage = {
    ...payloadWithoutHash,
    payloadHash: payloadHash(payloadWithoutHash)
  };

  await recordSyncPackage({
    package: pkg,
    direction: "OUTBOUND",
    status: "EXPORTED",
    caseId: caseRow.id,
    evidenceId: evidenceRow?.id,
    extractionId: extractionFromInput?.id
  });

  return pkg;
}

function assertValidPackage(pkg: ConsolidatedSyncPackage) {
  if (pkg.schemaVersion !== SCHEMA_VERSION) throw new Error(`Versao de pacote nao suportada: ${pkg.schemaVersion}`);
  if (pkg.packageType !== PACKAGE_TYPE) throw new Error("Tipo de pacote consolidado invalido.");
  if (pkg.manifest.containsRawUfdr || pkg.manifest.rawUfdrIncluded) {
    throw new Error("Pacote rejeitado: UFDR bruto nao pode ser importado pelo centralizador.");
  }
  const { payloadHash: receivedHash, ...withoutHash } = pkg;
  const computed = payloadHash(withoutHash);
  if (computed !== receivedHash) throw new Error("Hash do pacote consolidado nao confere.");
}

async function writeImportedFile(input: {
  caseId: string;
  packageId: string;
  file: ConsolidatedFile;
}) {
  const bytes = Buffer.from(input.file.contentBase64, "base64");
  const computed = hashBuffer(bytes);
  if (computed !== input.file.sha256) {
    throw new Error(`Hash invalido para arquivo selecionado ${input.file.fileName}.`);
  }
  const relativePath = path.join(
    "external-sync",
    input.caseId,
    input.packageId,
    "files",
    `${input.file.sha256}-${safeFileName(input.file.fileName)}`
  );
  const absolutePath = path.resolve(storageRoot(), relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  return absolutePath;
}

function parseOptionalDate(value?: string | null) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function makeExternalSourceLabel(pkg: ConsolidatedSyncPackage) {
  return `SYNC:${pkg.sourceNode.nodeId}`;
}

export async function importConsolidatedSyncPackage(pkg: ConsolidatedSyncPackage, input?: { actorId?: string }) {
  assertValidPackage(pkg);

  const role = getAppNodeRole();
  if (role !== "CENTRALIZER") {
    throw new Error("Esta instancia nao esta configurada como CENTRALIZER para receber pacotes externos.");
  }

  await recordSyncNode(pkg);
  await recordSyncPackage({ package: pkg, direction: "INBOUND", status: "RECEIVED" });

  const filesByAttachmentId = new Map(pkg.files.map((file) => [file.attachmentId, file]));
  const filePathsByAttachmentId = new Map<string, string>();
  const counters: ImportCounters = {
    casesCreated: 0,
    casesReused: 0,
    evidencesCreated: 0,
    evidencesReused: 0,
    extractionsCreated: 0,
    extractionsReused: 0,
    chatsCreated: 0,
    chatsReused: 0,
    participantsCreated: 0,
    participantsReused: 0,
    messagesCreated: 0,
    messagesReused: 0,
    attachmentsCreated: 0,
    attachmentsReused: 0,
    filesStored: 0,
    transcriptionsCreated: 0,
    transcriptionsReused: 0,
    ocrDocumentsCreated: 0,
    ocrDocumentsReused: 0,
    aiInsightsCreated: 0,
    aiInsightsReused: 0
  };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingCase = await tx.case.findUnique({ where: { caseNumber: pkg.case.caseNumber } });
      const caseRow =
        existingCase ??
        (await tx.case.create({
          data: {
            caseNumber: pkg.case.caseNumber,
            title: pkg.case.title,
            description: pkg.case.description ?? undefined,
            sourceType: "AI_INTAKE",
            inquiryType: pkg.case.inquiryType ?? undefined,
            inquiryNumber: pkg.case.inquiryNumber ?? undefined,
            policeUnit: pkg.case.policeUnit ?? undefined,
            inquiryLegalFraming: pkg.case.inquiryLegalFraming ?? undefined,
            inquirySummaryText: pkg.case.inquirySummaryText ?? undefined,
            inquiryMainFacts: pkg.case.inquiryMainFacts ?? undefined,
            inquiryInvestigativeFocus: pkg.case.inquiryInvestigativeFocus ?? undefined,
            initialContextSource: makeExternalSourceLabel(pkg)
          }
        }));

      if (existingCase) counters.casesReused += 1;
      else counters.casesCreated += 1;

      await upsertEntityMap(tx, {
        sourceNodeId: pkg.sourceNode.nodeId,
        entityType: "CASE",
        sourceEntityId: pkg.case.id,
        localEntityType: "CASE",
        localEntityId: caseRow.id,
        packageId: pkg.packageId,
        contentHash: pkg.payloadHash
      });

      let evidenceId: string | undefined;
      if (pkg.evidence) {
        const mappedEvidenceId = await findMappedEntity(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "EVIDENCE",
          sourceEntityId: pkg.evidence.id
        });
        if (mappedEvidenceId) {
          evidenceId = mappedEvidenceId;
          counters.evidencesReused += 1;
        } else {
          const evidence = await tx.evidence.create({
            data: {
              caseId: caseRow.id,
              label: `[Externo] ${pkg.evidence.label}`,
              source: makeExternalSourceLabel(pkg),
              mimeType: "application/vnd.core.consolidated-sync+json",
              fileName: `pacote-consolidado-${pkg.packageId}.json`,
              originalPath: path.join("external-sync", caseRow.id, pkg.packageId, "manifest.json"),
              sizeBytes: BigInt(Buffer.byteLength(JSON.stringify(pkg), "utf8")),
              sha256: pkg.payloadHash,
              uploadedById: input?.actorId
            }
          });
          evidenceId = evidence.id;
          counters.evidencesCreated += 1;
          await upsertEntityMap(tx, {
            sourceNodeId: pkg.sourceNode.nodeId,
            entityType: "EVIDENCE",
            sourceEntityId: pkg.evidence.id,
            localEntityType: "EVIDENCE",
            localEntityId: evidence.id,
            packageId: pkg.packageId,
            contentHash: pkg.evidence.sha256
          });
        }
      }

      let extractionId: string | undefined;
      if (pkg.extraction && evidenceId) {
        const mappedExtractionId = await findMappedEntity(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "EXTRACTION",
          sourceEntityId: pkg.extraction.id
        });
        if (mappedExtractionId) {
          extractionId = mappedExtractionId;
          counters.extractionsReused += 1;
        } else {
          const extraction = await tx.extraction.create({
            data: {
              caseId: caseRow.id,
              evidenceId,
              status: "COMPLETED",
              sourceFormat: "CONSOLIDATED_SYNC",
              processingDetails: jsonForDb({
                packageId: pkg.packageId,
                sourceNodeId: pkg.sourceNode.nodeId,
                sourceExtractionId: pkg.extraction.id,
                selectedOnly: true,
                containsRawUfdr: false
              }),
              processingPhase: "external-consolidated-import",
              processingProgress: 100,
              startedAt: parseOptionalDate(pkg.extraction.startedAt) ?? new Date(pkg.exportedAt),
              finishedAt: parseOptionalDate(pkg.extraction.finishedAt) ?? new Date()
            }
          });
          extractionId = extraction.id;
          counters.extractionsCreated += 1;
          await upsertEntityMap(tx, {
            sourceNodeId: pkg.sourceNode.nodeId,
            entityType: "EXTRACTION",
            sourceEntityId: pkg.extraction.id,
            localEntityType: "EXTRACTION",
            localEntityId: extraction.id,
            packageId: pkg.packageId,
            contentHash: pkg.payloadHash
          });
        }
      }

      const localChatIds = new Map<string, string>();
      for (const chat of pkg.entities.chats) {
        const mapped = await findMappedEntity(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "CHAT",
          sourceEntityId: chat.id
        });
        if (mapped) {
          localChatIds.set(chat.id, mapped);
          counters.chatsReused += 1;
          continue;
        }
        if (!evidenceId) continue;
        const created = await tx.chat.create({
          data: {
            caseId: caseRow.id,
            evidenceId,
            sourceApp: chat.sourceApp ?? undefined,
            externalId: chat.externalId ?? `${pkg.sourceNode.nodeId}:${chat.id}`,
            title: chat.title ?? "Chat externo selecionado",
            metadata: jsonForDb({
              ...((chat.metadata && typeof chat.metadata === "object" && !Array.isArray(chat.metadata)
                ? (chat.metadata as JsonRecord)
                : {}) as JsonRecord),
              sourceNodeId: pkg.sourceNode.nodeId,
              sourcePackageId: pkg.packageId,
              sourceChatId: chat.id
            })
          }
        });
        localChatIds.set(chat.id, created.id);
        counters.chatsCreated += 1;
        await upsertEntityMap(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "CHAT",
          sourceEntityId: chat.id,
          localEntityType: "CHAT",
          localEntityId: created.id,
          packageId: pkg.packageId
        });
      }

      const localParticipantIds = new Map<string, string>();
      for (const participant of pkg.entities.participants) {
        const mapped = await findMappedEntity(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "PARTICIPANT",
          sourceEntityId: participant.id
        });
        if (mapped) {
          localParticipantIds.set(participant.id, mapped);
          counters.participantsReused += 1;
          continue;
        }
        const localChatId = localChatIds.get(participant.chatId);
        if (!localChatId) continue;
        const created = await tx.participant.create({
          data: {
            chatId: localChatId,
            externalId: participant.externalId ?? `${pkg.sourceNode.nodeId}:${participant.id}`,
            name: participant.name ?? undefined,
            phone: participant.phone ?? undefined,
            email: participant.email ?? undefined,
            handle: participant.handle ?? undefined,
            metadata: jsonForDb({
              ...((participant.metadata && typeof participant.metadata === "object" && !Array.isArray(participant.metadata)
                ? (participant.metadata as JsonRecord)
                : {}) as JsonRecord),
              sourceNodeId: pkg.sourceNode.nodeId,
              sourcePackageId: pkg.packageId,
              sourceParticipantId: participant.id
            })
          }
        });
        localParticipantIds.set(participant.id, created.id);
        counters.participantsCreated += 1;
        await upsertEntityMap(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "PARTICIPANT",
          sourceEntityId: participant.id,
          localEntityType: "PARTICIPANT",
          localEntityId: created.id,
          packageId: pkg.packageId
        });
      }

      const localMessageIds = new Map<string, string>();
      for (const message of pkg.entities.messages) {
        const mapped = await findMappedEntity(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "MESSAGE",
          sourceEntityId: message.id
        });
        if (mapped) {
          localMessageIds.set(message.id, mapped);
          counters.messagesReused += 1;
          continue;
        }
        if (!evidenceId) continue;
        const localChatId = message.chatId ? localChatIds.get(message.chatId) : undefined;
        const created = await tx.message.create({
          data: {
            caseId: caseRow.id,
            evidenceId,
            chatId: localChatId,
            externalId: message.externalId ?? `${pkg.sourceNode.nodeId}:${message.id}`,
            senderId: message.senderId ? (localParticipantIds.get(message.senderId) ?? message.senderId) : undefined,
            body: message.body ?? undefined,
            timestamp: parseOptionalDate(message.timestamp),
            direction: message.direction ?? undefined,
            metadata: jsonForDb({
              ...((message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
                ? (message.metadata as JsonRecord)
                : {}) as JsonRecord),
              sourceNodeId: pkg.sourceNode.nodeId,
              sourcePackageId: pkg.packageId,
              sourceMessageId: message.id
            })
          }
        });
        localMessageIds.set(message.id, created.id);
        counters.messagesCreated += 1;
        await upsertEntityMap(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "MESSAGE",
          sourceEntityId: message.id,
          localEntityType: "MESSAGE",
          localEntityId: created.id,
          packageId: pkg.packageId
        });
      }

      for (const file of pkg.files) {
        const stored = await writeImportedFile({ caseId: caseRow.id, packageId: pkg.packageId, file });
        filePathsByAttachmentId.set(file.attachmentId, stored);
        counters.filesStored += 1;
      }

      const localAttachmentIds = new Map<string, string>();
      for (const attachment of pkg.entities.attachments) {
        const mapped = await findMappedEntity(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "ATTACHMENT",
          sourceEntityId: attachment.id
        });
        if (mapped) {
          localAttachmentIds.set(attachment.id, mapped);
          counters.attachmentsReused += 1;
          continue;
        }
        if (!evidenceId) continue;
        const file = filesByAttachmentId.get(attachment.id);
        const storedPath = filePathsByAttachmentId.get(attachment.id);
        const created = await tx.attachment.create({
          data: {
            caseId: caseRow.id,
            evidenceId,
            messageId: attachment.messageId ? localMessageIds.get(attachment.messageId) : undefined,
            externalId: attachment.externalId ?? `${pkg.sourceNode.nodeId}:${attachment.id}`,
            fileName: attachment.fileName ?? file?.fileName,
            mimeType: attachment.mimeType ?? file?.mimeType ?? undefined,
            sizeBytes: attachment.sizeBytes ? BigInt(attachment.sizeBytes) : file ? BigInt(file.sizeBytes) : undefined,
            path: storedPath,
            archivePath: null,
            metadata: jsonForDb({
              ...((attachment.metadata && typeof attachment.metadata === "object" && !Array.isArray(attachment.metadata)
                ? (attachment.metadata as JsonRecord)
                : {}) as JsonRecord),
              sourceNodeId: pkg.sourceNode.nodeId,
              sourcePackageId: pkg.packageId,
              sourceAttachmentId: attachment.id,
              selectedForFileTransfer: attachment.selectedForFileTransfer,
              fileHash: attachment.fileHash ?? file?.sha256 ?? null,
              fileUnavailableReason: attachment.fileUnavailableReason ?? null
            })
          }
        });
        localAttachmentIds.set(attachment.id, created.id);
        counters.attachmentsCreated += 1;
        await upsertEntityMap(tx, {
          sourceNodeId: pkg.sourceNode.nodeId,
          entityType: "ATTACHMENT",
          sourceEntityId: attachment.id,
          localEntityType: "ATTACHMENT",
          localEntityId: created.id,
          packageId: pkg.packageId,
          contentHash: attachment.fileHash ?? file?.sha256 ?? null
        });
      }

      if (extractionId) {
        for (const transcription of pkg.entities.transcriptions) {
          const mapped = await findMappedEntity(tx, {
            sourceNodeId: pkg.sourceNode.nodeId,
            entityType: "AUDIO_TRANSCRIPTION",
            sourceEntityId: transcription.id
          });
          if (mapped) {
            counters.transcriptionsReused += 1;
            continue;
          }
          const localAttachmentId = localAttachmentIds.get(transcription.attachmentId);
          if (!localAttachmentId || !evidenceId) continue;
          const sourceFilePath =
            filePathsByAttachmentId.get(transcription.attachmentId) ??
            `external-sync://${pkg.sourceNode.nodeId}/${pkg.packageId}/${transcription.attachmentId}`;
          const created = await tx.audioTranscription.create({
            data: {
              caseId: caseRow.id,
              evidenceId,
              extractionId,
              attachmentId: localAttachmentId,
              engine: transcription.engine,
              language: transcription.language ?? undefined,
              status: transcription.status as "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED",
              sourceFilePath,
              text: transcription.text ?? undefined,
              segments: jsonForDb(transcription.segments ?? {}),
              error: transcription.error ?? undefined,
              startedAt: parseOptionalDate(transcription.startedAt),
              finishedAt: parseOptionalDate(transcription.finishedAt)
            }
          });
          counters.transcriptionsCreated += 1;
          await upsertEntityMap(tx, {
            sourceNodeId: pkg.sourceNode.nodeId,
            entityType: "AUDIO_TRANSCRIPTION",
            sourceEntityId: transcription.id,
            localEntityType: "AUDIO_TRANSCRIPTION",
            localEntityId: created.id,
            packageId: pkg.packageId
          });
        }

        for (const ocr of pkg.entities.ocrDocuments) {
          const mapped = await findMappedEntity(tx, {
            sourceNodeId: pkg.sourceNode.nodeId,
            entityType: "OCR_DOCUMENT",
            sourceEntityId: ocr.id
          });
          if (mapped) {
            counters.ocrDocumentsReused += 1;
            continue;
          }
          const localAttachmentId = ocr.attachmentId ? localAttachmentIds.get(ocr.attachmentId) : undefined;
          if (!evidenceId) continue;
          const sourcePath =
            (ocr.attachmentId ? filePathsByAttachmentId.get(ocr.attachmentId) : undefined) ??
            ocr.sourcePath ??
            `external-sync://${pkg.sourceNode.nodeId}/${pkg.packageId}/${ocr.id}`;
          const created = await tx.ocrDocument.create({
            data: {
              caseId: caseRow.id,
              evidenceId,
              extractionId,
              attachmentId: localAttachmentId,
              sourcePath,
              language: ocr.language ?? undefined,
              engine: ocr.engine,
              text: ocr.text ?? undefined,
              confidence: ocr.confidence ?? undefined,
              metadata: jsonForDb({
                ...((ocr.metadata && typeof ocr.metadata === "object" && !Array.isArray(ocr.metadata)
                  ? (ocr.metadata as JsonRecord)
                  : {}) as JsonRecord),
                sourceNodeId: pkg.sourceNode.nodeId,
                sourcePackageId: pkg.packageId,
                sourceOcrDocumentId: ocr.id
              })
            }
          });
          counters.ocrDocumentsCreated += 1;
          await upsertEntityMap(tx, {
            sourceNodeId: pkg.sourceNode.nodeId,
            entityType: "OCR_DOCUMENT",
            sourceEntityId: ocr.id,
            localEntityType: "OCR_DOCUMENT",
            localEntityId: created.id,
            packageId: pkg.packageId
          });
        }

        for (const insight of pkg.entities.aiInsights) {
          const mapped = await findMappedEntity(tx, {
            sourceNodeId: pkg.sourceNode.nodeId,
            entityType: "AI_INSIGHT",
            sourceEntityId: insight.id
          });
          if (mapped) {
            counters.aiInsightsReused += 1;
            continue;
          }
          const created = await tx.aiInsight.create({
            data: {
              caseId: caseRow.id,
              evidenceId,
              extractionId,
              type: insight.type,
              title: insight.title,
              summary: insight.summary,
              score: insight.score ?? undefined,
              metadata: jsonForDb({
                ...((insight.metadata && typeof insight.metadata === "object" && !Array.isArray(insight.metadata)
                  ? (insight.metadata as JsonRecord)
                  : {}) as JsonRecord),
                sourceNodeId: pkg.sourceNode.nodeId,
                sourcePackageId: pkg.packageId,
                sourceAiInsightId: insight.id
              })
            }
          });
          counters.aiInsightsCreated += 1;
          await upsertEntityMap(tx, {
            sourceNodeId: pkg.sourceNode.nodeId,
            entityType: "AI_INSIGHT",
            sourceEntityId: insight.id,
            localEntityType: "AI_INSIGHT",
            localEntityId: created.id,
            packageId: pkg.packageId
          });
        }
      }

      await insertImportLog(tx, pkg.packageId, {
        action: "PACKAGE_IMPORTED",
        localEntityId: caseRow.id,
        entityType: "PACKAGE",
        message: "Pacote consolidado importado.",
        metadata: counters
      });

      await tx.custodyEvent.create({
        data: {
          caseId: caseRow.id,
          evidenceId,
          actorId: input?.actorId,
          action: "CONSOLIDATED_SYNC_IMPORTED",
          source: "consolidated-sync",
          currentHash: pkg.payloadHash,
          details: jsonForDb({
            packageId: pkg.packageId,
            sourceNodeId: pkg.sourceNode.nodeId,
            containsRawUfdr: false,
            counters
          })
        }
      });

      return { caseId: caseRow.id, evidenceId, extractionId };
    });

    await recordSyncPackage({
      package: pkg,
      direction: "INBOUND",
      status: "IMPORTED",
      caseId: result.caseId,
      evidenceId: result.evidenceId,
      extractionId: result.extractionId
    });

    return {
      ok: true,
      packageId: pkg.packageId,
      ...result,
      counters
    };
  } catch (error) {
    await recordSyncPackage({
      package: pkg,
      direction: "INBOUND",
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function sendConsolidatedSyncPackage(pkg: ConsolidatedSyncPackage) {
  const url = process.env.CENTRALIZER_URL?.trim() || process.env.CORE_CENTRALIZER_URL?.trim();
  const token = process.env.SYNC_API_TOKEN?.trim() || process.env.CORE_SYNC_API_TOKEN?.trim();
  if (!url || !token) throw new Error("CENTRALIZER_URL ou SYNC_API_TOKEN nao configurado.");

  const response = await fetch(`${url.replace(/\/$/, "")}/api/sync/packages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(pkg)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    await recordSyncPackage({
      package: pkg,
      direction: "OUTBOUND",
      status: "FAILED",
      caseId: pkg.manifest.scope.caseId,
      evidenceId: pkg.manifest.scope.evidenceId,
      extractionId: pkg.manifest.scope.extractionId,
      errorMessage: typeof body?.error === "string" ? body.error : `HTTP ${response.status}`
    });
    throw new Error(typeof body?.error === "string" ? body.error : `Falha HTTP ${response.status} ao enviar pacote.`);
  }

  await recordSyncPackage({
    package: pkg,
    direction: "OUTBOUND",
    status: "SENT",
    caseId: pkg.manifest.scope.caseId,
    evidenceId: pkg.manifest.scope.evidenceId,
    extractionId: pkg.manifest.scope.extractionId
  });

  return body;
}

export async function listConsolidatedSyncPackages(limit = 50) {
  const take = Math.min(Math.max(Math.floor(limit), 1), 100);
  return prisma.$queryRaw<
    Array<{
      packageId: string;
      direction: string;
      status: string;
      schemaVersion: string;
      sourceNodeId: string;
      sourceNodeName: string | null;
      caseId: string | null;
      evidenceId: string | null;
      extractionId: string | null;
      caseNumber: string | null;
      payloadHash: string;
      itemCounts: unknown;
      errorMessage: string | null;
      exportedAt: Date | null;
      receivedAt: Date | null;
      importedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT "packageId", "direction", "status", "schemaVersion", "sourceNodeId", "sourceNodeName",
      "caseId", "evidenceId", "extractionId", "caseNumber", "payloadHash", "itemCounts", "errorMessage",
      "exportedAt", "receivedAt", "importedAt", "createdAt", "updatedAt"
    FROM "SyncPackage"
    ORDER BY "createdAt" DESC
    LIMIT ${take}
  `;
}
