import { Prisma, prisma } from "@core/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PhoneOverlapGraph } from "@/components/phone-overlap-graph";

export const dynamic = "force-dynamic";

type GraphPageProps = {
  searchParams?: Promise<{
    caseId?: string;
    limit?: string;
  }>;
};

type PhoneCategory = "GREEN" | "YELLOW" | "RED";

const DEFAULT_GRAPH_CASE_ID = "91bfe849-e7cc-4dec-810f-663ac3263f85";

type GraphPhoneNode = {
  phone: string;
  evidenceIds: string[];
  evidenceCount: number;
  hasCalls: boolean;
  hasMessages: boolean;
  category: PhoneCategory;
  triageSelected: boolean;
  triageChats: Array<{
    chatId: string;
    label: string;
    sourceApp: string;
    rationale: string;
    excerpt: string;
    relevanceLevel: string;
    relevanceScore: number;
  }>;
  callSummaries: Array<{
    evidenceId: string;
    evidenceLabel: string;
    summary: string;
  }>;
  sourceCounts: {
    participantPhone: number;
    participantHandle: number;
    senderId: number;
    messageBody: number;
    transcription: number;
  };
};

type GraphPhoneLink = {
  id: string;
  evidenceId: string;
  targetKind: "PHONE" | "GROUP";
  targetId: string;
  triageSelected: boolean;
  category: PhoneCategory;
};

type GraphGroupNode = {
  id: string;
  label: string;
  sourceApp: string;
  evidenceId: string;
  participantPhones: string[];
  messageCount: number;
  triageSelected: boolean;
};

type GraphEvidenceNode = {
  id: string;
  label: string;
};

type GraphCaseOption = {
  id: string;
  label: string;
};

type TriageAssessmentLite = {
  chatId: string;
  label: string;
  sourceApp: string;
  rationale: string;
  excerpt: string;
  relevanceLevel: string;
  relevanceScore: number;
};

const PHONE_RE = /(?:[+]?[0-9][0-9\s().-]{6,}[0-9])/g;

function normalizePhone(raw: string) {
  const digits = raw.replace(/[^0-9]+/g, "").trim();
  if (digits.length < 8 || digits.length > 16) return null;
  if (digits.startsWith("00") && digits.length > 2) return digits.slice(2);
  return digits;
}

function walkUnknown(value: unknown, callback: (chunk: string) => void) {
  if (typeof value === "string") {
    callback(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkUnknown(item, callback);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) walkUnknown(item, callback);
  }
}

function readMetadataObject(metadata: Prisma.JsonValue | null | undefined) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") return null;
  return metadata as Record<string, unknown>;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractPhonesFromUnknown(value: unknown) {
  const results = new Set<string>();
  walkUnknown(value, (chunk) => {
    const matches = chunk.match(PHONE_RE) ?? [];
    for (const candidate of matches) {
      const normalized = normalizePhone(candidate);
      if (normalized) results.add(normalized);
    }
  });
  return results;
}

function safePositiveInt(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function parseSelectedChatIds(metadata: Prisma.JsonValue | null | undefined) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>).selectedChatIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function parseTriageAssessments(metadata: Prisma.JsonValue | null | undefined) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>).assessments;
  if (!Array.isArray(raw)) return [];

  const parsed: TriageAssessmentLite[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const chatId = typeof row.chatId === "string" ? row.chatId : "";
    if (!chatId) continue;
    parsed.push({
      chatId,
      label: typeof row.label === "string" ? row.label : "Chat",
      sourceApp: typeof row.sourceApp === "string" ? row.sourceApp : "origem-indefinida",
      rationale: typeof row.rationale === "string" ? row.rationale : "Sem justificativa registrada.",
      excerpt: typeof row.excerpt === "string" ? row.excerpt : "",
      relevanceLevel: typeof row.relevanceLevel === "string" ? row.relevanceLevel : "nao-classificada",
      relevanceScore: Number(row.relevanceScore ?? 0)
    });
  }
  return parsed;
}

function addPhoneOccurrence(input: {
  aggregate: Map<
    string,
    {
      evidenceIds: Set<string>;
      sourceCounts: {
        participantPhone: number;
        participantHandle: number;
        senderId: number;
        messageBody: number;
        transcription: number;
      };
    }
  >;
  rawValue: string | null | undefined;
  evidenceId: string;
  source: "participantPhone" | "participantHandle" | "senderId" | "messageBody" | "transcription";
}) {
  if (!input.rawValue) return;
  const normalized = normalizePhone(input.rawValue);
  if (!normalized) return;

  const current =
    input.aggregate.get(normalized) ?? {
      evidenceIds: new Set<string>(),
      sourceCounts: {
        participantPhone: 0,
        participantHandle: 0,
        senderId: 0,
        messageBody: 0,
        transcription: 0
      }
    };

  current.evidenceIds.add(input.evidenceId);
  current.sourceCounts[input.source] += 1;
  input.aggregate.set(normalized, current);
}

async function buildBroadPhoneOverlaps(caseId: string) {
  const aggregate = new Map<
    string,
    {
      evidenceIds: Set<string>;
      sourceCounts: {
        participantPhone: number;
        participantHandle: number;
        senderId: number;
        messageBody: number;
        transcription: number;
      };
    }
  >();

  const participants = await prisma.participant.findMany({
    where: { chat: { caseId } },
    select: {
      phone: true,
      handle: true,
      chat: { select: { evidenceId: true } }
    }
  });

  for (const participant of participants) {
    addPhoneOccurrence({
      aggregate,
      rawValue: participant.phone,
      evidenceId: participant.chat.evidenceId,
      source: "participantPhone"
    });
    addPhoneOccurrence({
      aggregate,
      rawValue: participant.handle,
      evidenceId: participant.chat.evidenceId,
      source: "participantHandle"
    });
  }

  const pageSize = 4000;
  let messageCursor: string | undefined;
  while (true) {
    const rows = await prisma.message.findMany({
      where: { caseId },
      select: {
        id: true,
        evidenceId: true,
        senderId: true,
        body: true
      },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(messageCursor ? { skip: 1, cursor: { id: messageCursor } } : {})
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      addPhoneOccurrence({
        aggregate,
        rawValue: row.senderId,
        evidenceId: row.evidenceId,
        source: "senderId"
      });
      const bodyCandidates = row.body?.match(PHONE_RE) ?? [];
      for (const candidate of bodyCandidates) {
        addPhoneOccurrence({
          aggregate,
          rawValue: candidate,
          evidenceId: row.evidenceId,
          source: "messageBody"
        });
      }
    }

    messageCursor = rows[rows.length - 1]?.id;
    if (rows.length < pageSize) break;
  }

  let transcriptionCursor: string | undefined;
  while (true) {
    const rows = await prisma.audioTranscription.findMany({
      where: { caseId, status: "COMPLETED" },
      select: {
        id: true,
        evidenceId: true,
        text: true
      },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(transcriptionCursor ? { skip: 1, cursor: { id: transcriptionCursor } } : {})
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const candidates = row.text?.match(PHONE_RE) ?? [];
      for (const candidate of candidates) {
        addPhoneOccurrence({
          aggregate,
          rawValue: candidate,
          evidenceId: row.evidenceId,
          source: "transcription"
        });
      }
    }

    transcriptionCursor = rows[rows.length - 1]?.id;
    if (rows.length < pageSize) break;
  }

  return [...aggregate.entries()]
    .map<GraphPhoneNode | null>(([phone, entry]) => {
      const evidenceIds = [...entry.evidenceIds].sort();
      if (evidenceIds.length < 1) return null;
      const sourceCounts = entry.sourceCounts;
      return {
        phone,
        evidenceIds,
        evidenceCount: evidenceIds.length,
        hasCalls: false,
        hasMessages: sourceCounts.senderId + sourceCounts.messageBody + sourceCounts.transcription > 0,
        category: "GREEN",
        triageSelected: false,
        triageChats: [],
        callSummaries: [],
        sourceCounts
      };
    })
    .filter((row): row is GraphPhoneNode => Boolean(row));
}

export default async function GraphPage({ searchParams }: GraphPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const limit = safePositiveInt(resolvedSearchParams.limit, 140);

  const caseOptions = (
    await prisma.case.findMany({
      orderBy: { updatedAt: "desc" },
      select: { id: true, caseNumber: true, title: true },
      take: 120
    })
  ).map<GraphCaseOption>((item) => ({
    id: item.id,
    label: `${item.caseNumber} - ${item.title}`
  }));

  const targetCase = resolvedSearchParams.caseId
    ? await prisma.case.findUnique({
        where: { id: resolvedSearchParams.caseId },
        select: { id: true, caseNumber: true, title: true }
      })
    :
      (await prisma.case.findFirst({
        where: {
          id: DEFAULT_GRAPH_CASE_ID,
          entities: {
            some: { type: "PHONE" }
          }
        },
        select: { id: true, caseNumber: true, title: true }
      })) ??
      (await prisma.case.findFirst({
        where: {
          entities: {
            some: { type: "PHONE" }
          }
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, caseNumber: true, title: true }
      }));

  if (!targetCase) {
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-bold">Grafo de Telefones por UFDR</h2>
        <Card>
          <CardHeader>
            <CardTitle>Sem dados</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-zinc-600">
            Nenhum caso com registros PHONE no banco. Gere o registro de telefones primeiro.
          </CardContent>
        </Card>
      </section>
    );
  }

  const phoneEntities = await prisma.entity.findMany({
    where: {
      caseId: targetCase.id,
      type: "PHONE"
    },
    select: {
      value: true,
      metadata: true
    }
  });

  let parsedPhones = phoneEntities
    .map<GraphPhoneNode | null>((entity) => {
      const metadata = readMetadataObject(entity.metadata);
      if (!metadata) return null;

      const evidenceIds = [...new Set(readStringArray(metadata.evidenceIds))].sort();
      if (evidenceIds.length < 1) return null;

      const sourceCountsRaw =
        metadata.sourceCounts && typeof metadata.sourceCounts === "object" && !Array.isArray(metadata.sourceCounts)
          ? (metadata.sourceCounts as Record<string, unknown>)
          : {};

      const sourceCounts = {
        participantPhone: readNumber(sourceCountsRaw["participant-phone"]),
        participantHandle: readNumber(sourceCountsRaw["participant-handle"]),
        senderId: readNumber(sourceCountsRaw["sender-id"]),
        messageBody: readNumber(sourceCountsRaw["message-body"]),
        transcription: readNumber(sourceCountsRaw.transcription)
      };

      const hasMessages = sourceCounts.senderId + sourceCounts.messageBody + sourceCounts.transcription > 0;

      return {
        phone: entity.value,
        evidenceIds,
        evidenceCount: evidenceIds.length,
        hasCalls: false,
        hasMessages,
        category: "GREEN",
        triageSelected: false,
        triageChats: [],
        callSummaries: [],
        sourceCounts
      };
    })
    .filter((row): row is GraphPhoneNode => Boolean(row));

  const usedBroadFallback = parsedPhones.length === 0;
  if (usedBroadFallback) {
    parsedPhones = await buildBroadPhoneOverlaps(targetCase.id);
  }

  const latestTriage = await prisma.aiInsight.findFirst({
    where: {
      caseId: targetCase.id,
      type: "INVESTIGATION_TRIAGE"
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, metadata: true }
  });

  const triageSelectedChatIds = parseSelectedChatIds(latestTriage?.metadata ?? null);
  const triageAssessments = parseTriageAssessments(latestTriage?.metadata ?? null);
  const triageAssessmentByChatId = new Map(triageAssessments.map((item) => [item.chatId, item]));

  const phoneToSelectedChats = new Map<string, Set<string>>();
  if (triageSelectedChatIds.length > 0) {
    const selectedChats = await prisma.chat.findMany({
      where: {
        caseId: targetCase.id,
        id: { in: triageSelectedChatIds }
      },
      select: {
        id: true,
        participants: {
          select: { phone: true, handle: true }
        },
        messages: {
          take: 900,
          orderBy: [{ timestamp: "asc" }, { createdAt: "asc" }],
          select: {
            senderId: true,
            body: true
          }
        }
      }
    });

    const addSelectedPhoneChat = (rawPhone: string | null | undefined, chatId: string) => {
      if (!rawPhone) return;
      const normalized = normalizePhone(rawPhone);
      if (!normalized) return;
      const set = phoneToSelectedChats.get(normalized) ?? new Set<string>();
      set.add(chatId);
      phoneToSelectedChats.set(normalized, set);
    };

    for (const chat of selectedChats) {
      for (const participant of chat.participants) {
        addSelectedPhoneChat(participant.phone, chat.id);
        addSelectedPhoneChat(participant.handle, chat.id);
      }

      for (const message of chat.messages) {
        addSelectedPhoneChat(message.senderId, chat.id);
        const bodyPhones = message.body?.match(PHONE_RE) ?? [];
        for (const phoneCandidate of bodyPhones) {
          addSelectedPhoneChat(phoneCandidate, chat.id);
        }
      }
    }
  }

  const allEvidenceIds = [...new Set(parsedPhones.flatMap((phone) => phone.evidenceIds))];

  const [chatsForGraph, callArtifacts] = await Promise.all([
    prisma.chat.findMany({
      where: { caseId: targetCase.id },
      select: {
        id: true,
        title: true,
        sourceApp: true,
        evidenceId: true,
        participants: {
          select: {
            phone: true,
            handle: true
          }
        },
        _count: {
          select: { messages: true }
        }
      },
      take: 800
    }),
    prisma.artifact.findMany({
      where: {
        caseId: targetCase.id,
        type: "CALL",
        evidenceId: { in: allEvidenceIds }
      },
      select: {
        evidenceId: true,
        title: true
      },
      take: 3000
    })
  ]);

  const phonesFromChats = new Map<
    string,
    {
      evidenceIds: Set<string>;
      participantHits: number;
      hasMessages: boolean;
    }
  >();

  for (const chat of chatsForGraph) {
    if (!chat.evidenceId) continue;
    const participants = new Set<string>();
    for (const participant of chat.participants) {
      const phoneA = normalizePhone(participant.phone ?? "");
      const phoneB = normalizePhone(participant.handle ?? "");
      if (phoneA) participants.add(phoneA);
      if (phoneB) participants.add(phoneB);
    }

    for (const phone of participants) {
      const current =
        phonesFromChats.get(phone) ?? {
          evidenceIds: new Set<string>(),
          participantHits: 0,
          hasMessages: false
        };
      current.evidenceIds.add(chat.evidenceId);
      current.participantHits += 1;
      current.hasMessages = current.hasMessages || chat._count.messages > 0;
      phonesFromChats.set(phone, current);
    }
  }

  const parsedByPhone = new Map(parsedPhones.map((item) => [item.phone, item]));
  for (const [phone, found] of phonesFromChats.entries()) {
    const existing = parsedByPhone.get(phone);
    if (existing) {
      const mergedEvidenceIds = [...new Set([...existing.evidenceIds, ...found.evidenceIds])].sort();
      parsedByPhone.set(phone, {
        ...existing,
        evidenceIds: mergedEvidenceIds,
        evidenceCount: mergedEvidenceIds.length,
        hasMessages: existing.hasMessages || found.hasMessages,
        sourceCounts: {
          ...existing.sourceCounts,
          participantPhone: existing.sourceCounts.participantPhone + found.participantHits
        }
      });
      continue;
    }

    const evidenceIds = [...found.evidenceIds].sort();
    parsedByPhone.set(phone, {
      phone,
      evidenceIds,
      evidenceCount: evidenceIds.length,
      hasCalls: false,
      hasMessages: found.hasMessages,
      category: "GREEN",
      triageSelected: false,
      triageChats: [],
      callSummaries: [],
      sourceCounts: {
        participantPhone: found.participantHits,
        participantHandle: 0,
        senderId: 0,
        messageBody: 0,
        transcription: 0
      }
    });
  }
  parsedPhones = [...parsedByPhone.values()];

  const evidenceWithCalls = new Set<string>();
  const callSummariesByEvidence = new Map<string, string[]>();
  for (const call of callArtifacts) {
    evidenceWithCalls.add(call.evidenceId);

    const summarySource =
      typeof call.title === "string" && call.title.trim().length > 0
        ? call.title.trim()
        : "Ligacao registrada no artefato";
    const list = callSummariesByEvidence.get(call.evidenceId) ?? [];
    list.push(summarySource);
    callSummariesByEvidence.set(call.evidenceId, list);
  }

  const evidenceMap = new Map(
    (
      await prisma.evidence.findMany({
        where: { id: { in: allEvidenceIds } },
        select: { id: true, fileName: true, label: true }
      })
    ).map((item) => [item.id, item])
  );

  const triageSelectedChatSet = new Set(triageSelectedChatIds);

  const graphGroups: GraphGroupNode[] = [];

  for (const chat of chatsForGraph) {
    const participantPhones = new Set<string>();
    for (const participant of chat.participants) {
      const phoneA = normalizePhone(participant.phone ?? "");
      const phoneB = normalizePhone(participant.handle ?? "");
      if (phoneA) participantPhones.add(phoneA);
      if (phoneB) participantPhones.add(phoneB);
    }

    const participants = [...participantPhones].sort();
    if (participants.length < 3) continue;
    if (!chat.evidenceId) continue;

    graphGroups.push({
      id: chat.id,
      label: chat.title?.trim() || `Grupo ${chat.id.slice(0, 8)}`,
      sourceApp: chat.sourceApp ?? "origem-indefinida",
      evidenceId: chat.evidenceId,
      participantPhones: participants,
      messageCount: chat._count.messages,
      triageSelected: triageSelectedChatSet.has(chat.id)
    });
  }

  const graphPhonesRaw = parsedPhones
    .map((phone): GraphPhoneNode => {
      const hasCalls = phone.evidenceIds.some((evidenceId) => evidenceWithCalls.has(evidenceId));
      const triageChatIds = [...(phoneToSelectedChats.get(phone.phone) ?? new Set<string>())];
      const triageChats = triageChatIds.map((chatId) => {
        const assessment = triageAssessmentByChatId.get(chatId);
        return {
          chatId,
          label: assessment?.label ?? `Chat ${chatId.slice(0, 8)}`,
          sourceApp: assessment?.sourceApp ?? "origem-indefinida",
          rationale: assessment?.rationale ?? "Selecionado na triagem sem justificativa estruturada.",
          excerpt: assessment?.excerpt ?? "",
          relevanceLevel: assessment?.relevanceLevel ?? "nao-classificada",
          relevanceScore: assessment?.relevanceScore ?? 0
        };
      });

      const callSummaries = phone.evidenceIds
        .flatMap((evidenceId) =>
          (callSummariesByEvidence.get(evidenceId) ?? []).map((summary) => ({
            evidenceId,
            evidenceLabel: evidenceMap.get(evidenceId)?.label || evidenceMap.get(evidenceId)?.fileName || evidenceId.slice(0, 8),
            summary
          }))
        )
        .slice(0, 12);

      return {
        ...phone,
        hasCalls,
        category: hasCalls && phone.hasMessages ? "RED" : hasCalls ? "YELLOW" : "GREEN",
        triageSelected: triageChats.length > 0,
        triageChats,
        callSummaries
      };
    });

  const graphPhones = graphPhonesRaw
    .sort((a, b) => b.evidenceCount - a.evidenceCount || a.phone.localeCompare(b.phone))
    .slice(0, limit);

  const selectedPhoneSet = new Set(graphPhones.map((item) => item.phone));

  const graphGroupsFiltered = graphGroups
    .map((group) => ({
      ...group,
      participantPhones: group.participantPhones.filter((phone) => selectedPhoneSet.has(phone))
    }))
    .filter((group) => group.participantPhones.length >= 2)
    .sort((a, b) => b.participantPhones.length - a.participantPhones.length || a.label.localeCompare(b.label));

  const graphPhonesWithCategory = graphPhones.map((phone) => ({
    ...phone,
    callSummaries: phone.callSummaries.map((item) => ({
      ...item,
      evidenceLabel: evidenceMap.get(item.evidenceId)?.label || evidenceMap.get(item.evidenceId)?.fileName || item.evidenceId.slice(0, 8)
    }))
  }));

  const ufdrEvidenceIds = new Set<string>();
  for (const phone of graphPhonesWithCategory) {
    for (const evidenceId of phone.evidenceIds) ufdrEvidenceIds.add(evidenceId);
  }
  for (const group of graphGroupsFiltered) {
    ufdrEvidenceIds.add(group.evidenceId);
  }

  const evidenceNodes: GraphEvidenceNode[] = [...ufdrEvidenceIds]
    .map((id) => ({
      id,
      label: evidenceMap.get(id)?.label || evidenceMap.get(id)?.fileName || id.slice(0, 8)
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const phoneUfdrLinks: GraphPhoneLink[] = graphPhonesWithCategory.flatMap((phone) =>
    phone.evidenceIds.map((evidenceId) => ({
      id: `E_${evidenceId}__P_${phone.phone}`,
      evidenceId,
      targetKind: "PHONE" as const,
      targetId: phone.phone,
      triageSelected: phone.triageSelected,
      category: phone.category
    }))
  );

  const groupUfdrLinks: GraphPhoneLink[] = graphGroupsFiltered.map((group) => ({
    id: `E_${group.evidenceId}__G_${group.id}`,
    evidenceId: group.evidenceId,
    targetKind: "GROUP",
    targetId: group.id,
    triageSelected: group.triageSelected,
    category: "GREEN"
  }));

  const graphLinks: GraphPhoneLink[] = [...phoneUfdrLinks, ...groupUfdrLinks].filter((link) => ufdrEvidenceIds.has(link.evidenceId));

  const counters = {
    totalPhones: graphPhonesWithCategory.length,
    green: graphPhonesWithCategory.filter((item) => item.category === "GREEN").length,
    yellow: graphPhonesWithCategory.filter((item) => item.category === "YELLOW").length,
    red: graphPhonesWithCategory.filter((item) => item.category === "RED").length,
    totalLinks: graphLinks.length,
    totalUfdrs: evidenceNodes.length,
    totalGroups: graphGroupsFiltered.length
  };

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Grafo de Vinculos Telefonicos</h2>
      <Card>
        <CardHeader>
          <CardTitle>
            Caso {targetCase.caseNumber} - {targetCase.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Telefones no grafo: <strong>{counters.totalPhones}</strong> (limite atual: {limit}) | UFDRs: <strong>{counters.totalUfdrs}</strong> | Vinculos UFDR-entidade: <strong>{counters.totalLinks}</strong> | Grupos: <strong>{counters.totalGroups}</strong>
          </p>
          {parsedPhones.length === 0 ? (
            <p className="text-zinc-600">
              Este caso nao tem telefones compartilhados entre mais de uma UFDR no registro atual.
            </p>
          ) : null}
          {usedBroadFallback && parsedPhones.length > 0 ? (
            <p className="text-zinc-600">
              Exibindo vinculos em modo amplo (participantes, mensagens e transcricoes) por falta de registros consolidados no PHONE_REGISTRY.
            </p>
          ) : null}
          <p className="text-zinc-600">
            Verde: vinculo sem indicio de ligacao ou mensagem | Amarelo: vinculo com ligacoes | Vermelho: vinculo com ligacoes e mensagens.
          </p>
          <p className="text-zinc-600">
            Distribuicao: {counters.green} verdes, {counters.yellow} amarelos, {counters.red} vermelhos.
          </p>
        </CardContent>
      </Card>

      <PhoneOverlapGraph
        caseId={targetCase.id}
        caseOptions={caseOptions}
        currentLimit={limit}
        triageInsightId={latestTriage?.id ?? null}
        phones={graphPhonesWithCategory}
        evidences={evidenceNodes}
        links={graphLinks}
        groups={graphGroupsFiltered}
      />
    </section>
  );
}
