import { createHash } from "node:crypto";
import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { prisma, Prisma } from "@core/db";
import { addCustodyEvent } from "./services";

type ExportPhoneAggregate = {
  originalValues: Set<string>;
  firstSeenAt: Date;
  lastSeenAt: Date;
  messageCount: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  sourceApp?: string;
  handle?: string;
  chatRef?: string;
  participantRef?: string;
};

type ExportPayload = {
  schemaVersion: string;
  exportedAt: string;
  sourceSystem: "CORE_ANALYSE";
  extractionId: string;
  evidenceId: string;
  caseId: string;
  idempotencyKey: string;
  payloadHash: string;
  entities: {
    chats: Array<Record<string, unknown>>;
    participants: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
    transcriptionsText: string[];
    ocrText: string[];
    insights: string[];
    reports: string[];
  };
  identitySummary: {
    phones: Array<{
      normalizedPhone: string;
      originalValues: string[];
      firstSeenAt: string;
      lastSeenAt: string;
      messageCount: number;
      confidence: "HIGH" | "MEDIUM" | "LOW";
      sourceApp?: string;
      handle?: string;
      chatRef?: string;
      participantRef?: string;
    }>;
  };
};

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function purgeUfdrAfterCoreHubSync(input: {
  caseId: string;
  evidenceId: string;
  extractionId: string;
  actorId?: string;
  source?: string;
}) {
  const enabled = parseBoolean(process.env.CORE_HUB_DELETE_UFDR_AFTER_SYNC, false);
  if (!enabled) return { skipped: true, reason: "CORE_HUB_DELETE_UFDR_AFTER_SYNC=false" as const };

  const evidence = await prisma.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, fileName: true, originalPath: true, sha256: true }
  });
  if (!evidence?.originalPath) return { skipped: true, reason: "EVIDENCE_PATH_EMPTY" as const };

  const absolutePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", evidence.originalPath);
  const info = await stat(absolutePath).catch(() => null);
  if (!info) return { skipped: true, reason: "UFDR_PATH_NOT_FOUND" as const, absolutePath };

  await rm(absolutePath, { recursive: true, force: true });

  await addCustodyEvent({
    caseId: input.caseId,
    evidenceId: input.evidenceId,
    actorId: input.actorId,
    action: "CORE_HUB_UFDR_PURGED",
    source: input.source ?? "core-hub-export",
    currentHash: evidence.sha256,
    details: {
      extractionId: input.extractionId,
      fileName: evidence.fileName,
      originalPath: evidence.originalPath,
      absolutePath
    } as Prisma.InputJsonValue
  });

  return { skipped: false, absolutePath };
}

function computePayloadHash(payloadWithoutHash: Omit<ExportPayload, "payloadHash">) {
  return createHash("sha256").update(JSON.stringify(payloadWithoutHash)).digest("hex");
}

function normalizePhone(input: string) {
  const raw = input.trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("00") && digits.length >= 10) {
    return { normalizedPhone: `+${digits.slice(2)}`, confidence: "MEDIUM" as const };
  }

  if (hasPlus) {
    return {
      normalizedPhone: `+${digits}`,
      confidence: digits.length >= 10 && digits.length <= 15 ? ("HIGH" as const) : ("MEDIUM" as const)
    };
  }

  if (digits.length >= 10 && digits.length <= 15) {
    return { normalizedPhone: digits, confidence: "MEDIUM" as const };
  }

  return { normalizedPhone: digits, confidence: "LOW" as const };
}

function mergeConfidence(current: "HIGH" | "MEDIUM" | "LOW", incoming: "HIGH" | "MEDIUM" | "LOW") {
  const rank = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  return rank[incoming] > rank[current] ? incoming : current;
}

function extractPhonesFromText(text: string) {
  const matches = text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? [];
  return matches.map((value) => value.trim());
}

async function buildPayload(extractionId: string): Promise<ExportPayload> {
  const extraction = await prisma.extraction.findUnique({
    where: { id: extractionId },
    include: {
      evidence: true
    }
  });

  if (!extraction) {
    throw new Error("Extracao nao encontrada para exportacao CORE HUB.");
  }

  const [chats, messages, transcriptions, ocrDocuments, insights, reports] = await Promise.all([
    prisma.chat.findMany({
      where: { evidenceId: extraction.evidenceId },
      include: { participants: true }
    }),
    prisma.message.findMany({
      where: { evidenceId: extraction.evidenceId },
      include: {
        chat: { select: { externalId: true, sourceApp: true } }
      },
      orderBy: { timestamp: "asc" }
    }),
    prisma.audioTranscription.findMany({
      where: { extractionId, text: { not: null } },
      select: { text: true }
    }),
    prisma.ocrDocument.findMany({
      where: { extractionId, text: { not: null } },
      select: { text: true }
    }),
    prisma.aiInsight.findMany({
      where: { extractionId },
      select: { title: true, summary: true }
    }),
    prisma.generatedReport.findMany({
      where: { evidenceId: extraction.evidenceId },
      select: { title: true, content: true }
    })
  ]);

  const phoneMap = new Map<string, ExportPhoneAggregate>();

  for (const chat of chats) {
    for (const participant of chat.participants) {
      const phoneCandidates = [participant.phone, participant.handle]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => extractPhonesFromText(value));

      for (const original of phoneCandidates) {
        const normalized = normalizePhone(original);
        if (!normalized) continue;

        const existing = phoneMap.get(normalized.normalizedPhone);
        const baseDate = extraction.finishedAt ?? extraction.updatedAt ?? extraction.createdAt;
        if (!existing) {
          phoneMap.set(normalized.normalizedPhone, {
            originalValues: new Set([original]),
            firstSeenAt: baseDate,
            lastSeenAt: baseDate,
            messageCount: 0,
            confidence: normalized.confidence,
            sourceApp: chat.sourceApp ?? undefined,
            handle: participant.handle ?? undefined,
            chatRef: chat.externalId ?? chat.id,
            participantRef: participant.externalId ?? participant.id
          });
        } else {
          existing.originalValues.add(original);
          existing.confidence = mergeConfidence(existing.confidence, normalized.confidence);
          existing.sourceApp = existing.sourceApp ?? chat.sourceApp ?? undefined;
          existing.handle = existing.handle ?? participant.handle ?? undefined;
          existing.chatRef = existing.chatRef ?? chat.externalId ?? chat.id;
          existing.participantRef = existing.participantRef ?? participant.externalId ?? participant.id;
        }
      }
    }
  }

  for (const message of messages) {
    const content = message.body ?? "";
    const candidates = extractPhonesFromText(content);
    const timestamp = message.timestamp ?? extraction.updatedAt ?? extraction.createdAt;

    for (const original of candidates) {
      const normalized = normalizePhone(original);
      if (!normalized) continue;

      const existing = phoneMap.get(normalized.normalizedPhone);
      if (!existing) {
        phoneMap.set(normalized.normalizedPhone, {
          originalValues: new Set([original]),
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          messageCount: 1,
          confidence: normalized.confidence,
          sourceApp: message.chat?.sourceApp ?? undefined,
          chatRef: message.chat?.externalId ?? message.chatId ?? undefined,
          participantRef: message.senderId ?? undefined
        });
      } else {
        existing.originalValues.add(original);
        if (timestamp < existing.firstSeenAt) existing.firstSeenAt = timestamp;
        if (timestamp > existing.lastSeenAt) existing.lastSeenAt = timestamp;
        existing.messageCount += 1;
        existing.confidence = mergeConfidence(existing.confidence, normalized.confidence);
        existing.sourceApp = existing.sourceApp ?? message.chat?.sourceApp ?? undefined;
        existing.chatRef = existing.chatRef ?? message.chat?.externalId ?? message.chatId ?? undefined;
        existing.participantRef = existing.participantRef ?? message.senderId ?? undefined;
      }
    }
  }

  const payloadWithoutHash: Omit<ExportPayload, "payloadHash"> = {
    schemaVersion: "core-hub.v1",
    exportedAt: new Date().toISOString(),
    sourceSystem: "CORE_ANALYSE",
    extractionId: extraction.id,
    evidenceId: extraction.evidenceId,
    caseId: extraction.caseId,
    idempotencyKey: "",
    entities: {
      chats: chats.map((chat) => ({
        id: chat.id,
        externalId: chat.externalId,
        sourceApp: chat.sourceApp,
        title: chat.title,
        metadata: chat.metadata ?? null
      })),
      participants: chats.flatMap((chat) =>
        chat.participants.map((participant) => ({
          id: participant.id,
          chatId: chat.id,
          externalId: participant.externalId,
          name: participant.name,
          phone: participant.phone,
          email: participant.email,
          handle: participant.handle,
          metadata: participant.metadata ?? null
        }))
      ),
      messages: messages.map((message) => ({
        id: message.id,
        chatId: message.chatId,
        externalId: message.externalId,
        senderId: message.senderId,
        body: message.body,
        timestamp: message.timestamp?.toISOString() ?? null,
        direction: message.direction,
        sourceApp: message.chat?.sourceApp ?? null,
        metadata: message.metadata ?? null
      })),
      transcriptionsText: transcriptions.map((row) => row.text ?? "").filter((value) => value.trim().length > 0),
      ocrText: ocrDocuments.map((row) => row.text ?? "").filter((value) => value.trim().length > 0),
      insights: insights.map((row) => `${row.title}: ${row.summary}`),
      reports: reports.map((row) => `${row.title}\n${row.content}`)
    },
    identitySummary: {
      phones: [...phoneMap.entries()].map(([normalizedPhone, aggregate]) => ({
        normalizedPhone,
        originalValues: [...aggregate.originalValues],
        firstSeenAt: aggregate.firstSeenAt.toISOString(),
        lastSeenAt: aggregate.lastSeenAt.toISOString(),
        messageCount: aggregate.messageCount,
        confidence: aggregate.confidence,
        sourceApp: aggregate.sourceApp,
        handle: aggregate.handle,
        chatRef: aggregate.chatRef,
        participantRef: aggregate.participantRef
      }))
    }
  };

  const payloadHash = computePayloadHash(payloadWithoutHash);
  return {
    ...payloadWithoutHash,
    idempotencyKey: `${extraction.id}:${payloadHash}`,
    payloadHash
  };
}

async function postWithRetry(url: string, token: string, body: ExportPayload) {
  const timeoutMs = parsePositiveInt(process.env.CORE_HUB_EXPORT_TIMEOUT_MS, 15000);
  const retryMax = parsePositiveInt(process.env.CORE_HUB_EXPORT_RETRY_MAX, 3);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retryMax; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`CORE HUB export HTTP ${response.status}: ${errorBody}`);
      }

      return response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= retryMax) break;
      const delayMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("Falha desconhecida no export para CORE HUB.");
}

export async function exportExtractionToCoreHub(input: {
  extractionId: string;
  actorId?: string;
  source?: string;
  force?: boolean;
}) {
  if (!input.force) {
    return {
      skipped: true,
      reason: "CORE_HUB_EXPORT_MANUAL_REQUIRED"
    };
  }

  const baseUrl = process.env.CORE_HUB_BASE_URL?.trim();
  const apiToken = process.env.CORE_HUB_API_TOKEN?.trim();
  if (!baseUrl || !apiToken) {
    throw new Error("CORE_HUB_BASE_URL ou CORE_HUB_API_TOKEN nao configurado.");
  }

  const payload = await buildPayload(input.extractionId);

  await addCustodyEvent({
    caseId: payload.caseId,
    evidenceId: payload.evidenceId,
    actorId: input.actorId,
    action: "CORE_HUB_EXPORT_STARTED",
    source: input.source ?? "core-hub-export",
    details: {
      extractionId: payload.extractionId,
      idempotencyKey: payload.idempotencyKey,
      payloadHash: payload.payloadHash
    } as Prisma.InputJsonValue
  });

  try {
    const response = await postWithRetry(`${baseUrl.replace(/\/$/, "")}/ingestions/extractions`, apiToken, payload);

    await addCustodyEvent({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      actorId: input.actorId,
      action: "CORE_HUB_EXPORT_COMPLETED",
      source: input.source ?? "core-hub-export",
      details: {
        extractionId: payload.extractionId,
        idempotencyKey: payload.idempotencyKey,
        payloadHash: payload.payloadHash,
        response
      } as Prisma.InputJsonValue
    });

    await purgeUfdrAfterCoreHubSync({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      extractionId: payload.extractionId,
      actorId: input.actorId,
      source: input.source
    });

    return {
      skipped: false,
      payload,
      response
    };
  } catch (error) {
    await addCustodyEvent({
      caseId: payload.caseId,
      evidenceId: payload.evidenceId,
      actorId: input.actorId,
      action: "CORE_HUB_EXPORT_FAILED",
      source: input.source ?? "core-hub-export",
      details: {
        extractionId: payload.extractionId,
        idempotencyKey: payload.idempotencyKey,
        payloadHash: payload.payloadHash,
        error: error instanceof Error ? error.message : String(error)
      } as Prisma.InputJsonValue
    });

    throw error;
  }
}
