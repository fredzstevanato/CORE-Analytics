import { prisma, Prisma } from "@core/db";
import { createHash } from "node:crypto";
import { getAppSettingValue } from "./settings";
import { sanitizeJsonForDatabase, sanitizeTextForDatabase } from "./report-sanitize";

export type InvestigativeLevel = "alta" | "media" | "baixa";

export type ChatAssessment = {
  chatId: string;
  label: string;
  sourceApp: string;
  messageCount: number;
  transcriptionCount: number;
  relevanceLevel: InvestigativeLevel;
  relevanceScore: number;
  rationale: string;
  matchedTerms: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  excerpt: string;
};

type ChatAssessmentSummary = Pick<
  ChatAssessment,
  | "chatId"
  | "relevanceLevel"
  | "relevanceScore"
  | "rationale"
  | "matchedTerms"
  | "positiveSignals"
  | "negativeSignals"
  | "excerpt"
>;

export type ChatCorrelation = {
  sourceChatId: string;
  targetChatId: string;
  score: number;
  rationale: string;
  sharedPhones: string[];
  sharedNames: string[];
  sharedTerms: string[];
};

export type InvestigationTriagePayload = {
  version: number;
  generatedAt: string;
  caseId: string;
  evidenceId?: string;
  inquiryContext: string;
  assessments: ChatAssessment[];
  correlations: ChatCorrelation[];
  diagnostics?: {
    inquiryContextTokens: number;
    chatsSentToAi: number;
    chatsSkippedByGate: number;
    estimatedInputTokensTotal: number;
    throttleWaitMsTotal: number;
    throttleEvents: number;
    targetTokensPerMinute: number;
    minCallIntervalMs: number;
    chats: Array<{
      chatId: string;
      label: string;
      gateScore: number;
      shouldSkipAi: boolean;
      skipReasons: string[];
      rawInformativeItems: number;
      selectedItemsForModel: number;
      droppedItemsByBudget: number;
      estimatedInputTokens: number;
      transcriptionCount: number;
      informativeCharCount: number;
      inquiryTermOverlap: number;
      throttleWaitMs: number;
    }>;
  };
};

type ProgressCallback = (progress: number) => void | Promise<void>;

type OpenAiChatAssessmentResult = {
  relevanceLevel: InvestigativeLevel;
  relevanceScore: number;
  rationale: string;
  matchedTerms: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  excerpt: string;
};

type ReportNarrativeSections = {
  identificacao: string;
  contextoFatico: string;
  contasRedesSociais: string;
  localizacoesExtraidas: string;
  consideracoesFinaisChats: string;
  conclusaoTecnica: string;
};

type ChatContentQuality = {
  informativeMessageCount: number;
  informativeCharCount: number;
  systemMessageCount: number;
  ignoredMessageCount: number;
  transcriptionCount: number;
  inquiryTermOverlapCount: number;
  localGateScore: number;
  shouldSkipAi: boolean;
  reasons: string[];
};

type CandidateModelMessage = {
  sender: string;
  text: string;
  tokens: number;
  overlapCount: number;
  isTranscription: boolean;
  position: number;
};

type CaseContextFromPdfResult = {
  caseNumber: string;
  title: string;
  description: string;
  inquiryType: string;
  inquiryNumber: string;
  policeUnit: string;
  inquirySummary: string;
  inquiryMainFacts: string;
  inquiryInvestigativeFocus: string;
  extractionSummary: string;
  involvedPeople: string[];
  involvedPeopleCategorized: Array<{
    name: string;
    category: "SUSPECT" | "VICTIM" | "WITNESS" | "OTHER";
    reason: string;
    evidenceExcerpt: string;
    sourceReference: string;
    confidence: "AUTO_EXTRACTED" | "REVIEW_RECOMMENDED";
  }>;
  legalFraming: string;
};

const MIN_CONTEXT_HINT_LENGTH = 20;
const MIN_MEANINGFUL_CONTEXT_TEXT_LENGTH = 24;
const TRIAGE_INQUIRY_CONTEXT_CHAR_LIMIT = 1700;
const TRIAGE_MESSAGES_TOKEN_BUDGET = 3200;
const TRIAGE_MESSAGES_MIN_KEEP = 8;
const REPORT_INQUIRY_CONTEXT_CHAR_LIMIT = 2200;
const REPORT_MAX_ASSESSMENTS = 90;
const REPORT_MAX_CORRELATIONS = 60;

const STOPWORDS = new Set([
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "em",
  "para",
  "por",
  "com",
  "sem",
  "a",
  "o",
  "as",
  "os",
  "um",
  "uma",
  "na",
  "no",
  "nas",
  "nos",
  "que",
  "ao",
  "aos",
  "ser",
  "foi",
  "sao",
  "sua",
  "seu",
  "chat",
  "conversa",
  "investigacao",
  "inquerito"
]);

function normalize(value: string) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function truncate(value: string, max = 900) {
  const clean = (value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}...`;
}

function normalizeOptionalText(value?: string | null) {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 0 ? clean : null;
}

function hasMeaningfulText(value?: string | null, minLength = MIN_MEANINGFUL_CONTEXT_TEXT_LENGTH) {
  const normalized = normalizeOptionalText(value);
  return normalized !== null && normalized.length >= minLength;
}

function hasCaseInquiryContext(caseRow: {
  inquiryType?: string | null;
  inquiryNumber?: string | null;
  policeUnit?: string | null;
  inquiryLegalFraming?: string | null;
  inquirySummaryText?: string | null;
  inquiryMainFacts?: string | null;
  inquiryInvestigativeFocus?: string | null;
  extractionReportSummary?: string | null;
  inquiryInvolvedPeople?: unknown;
}) {
  const detailedFields = [
    caseRow.inquiryType,
    caseRow.inquiryNumber,
    caseRow.policeUnit,
    caseRow.inquiryLegalFraming,
    caseRow.inquirySummaryText,
    caseRow.inquiryMainFacts,
    caseRow.inquiryInvestigativeFocus,
    caseRow.extractionReportSummary
  ];
  const hasDetailedField = detailedFields.some((field) => hasMeaningfulText(field));
  const hasInvolvedPeople = Array.isArray(caseRow.inquiryInvolvedPeople) && caseRow.inquiryInvolvedPeople.length > 0;
  return hasDetailedField || hasInvolvedPeople;
}

function appendContextHintToInquiryContext(baseContext: string, contextHint?: string) {
  const normalizedHint = normalizeOptionalText(contextHint);
  if (!normalizedHint) return baseContext;
  const merged = `${baseContext}\nContexto complementar informado manualmente: ${normalizedHint}.`.trim();
  return merged.length > 3200 ? merged.slice(0, 3200) : merged;
}

function tokenizeTerms(value: string) {
  return [...new Set((normalize(value).match(/[a-z0-9]{4,}/g) ?? []).filter((term) => !STOPWORDS.has(term)))];
}

const PHONE_CANDIDATE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizePhoneForRegistry(raw: string) {
  const digits = raw.replace(/\D+/g, "").trim();
  if (digits.length < 8 || digits.length > 16) return null;
  if (digits.startsWith("00") && digits.length > 2) return digits.slice(2);
  return digits;
}

function extractPhoneCandidatesFromText(text: string) {
  const matches = text.match(PHONE_CANDIDATE_RE) ?? [];
  return [...new Set(matches.map((item) => item.trim()).filter((item) => item.length > 0))];
}

type ChatAssessmentIndex = {
  relevanceLevel: string;
  relevanceScore: number;
  rationale: string;
  matchedTerms: string[];
  positiveSignals: string[];
  excerpt: string;
};

function getChatAssessmentIndex(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return new Map<string, ChatAssessmentIndex>();
  }

  const assessments = Array.isArray((metadata as Record<string, unknown>).assessments)
    ? ((metadata as Record<string, unknown>).assessments as unknown[])
    : [];
  const output = new Map<string, ChatAssessmentIndex>();

  for (const row of assessments) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const chatId = typeof record.chatId === "string" ? record.chatId : "";
    if (!chatId) continue;

    output.set(chatId, {
      relevanceLevel: typeof record.relevanceLevel === "string" ? record.relevanceLevel : "nao-classificada",
      relevanceScore: typeof record.relevanceScore === "number" ? record.relevanceScore : 0,
      rationale: typeof record.rationale === "string" ? record.rationale : "",
      matchedTerms: toStringArray(record.matchedTerms),
      positiveSignals: toStringArray(record.positiveSignals),
      excerpt: typeof record.excerpt === "string" ? record.excerpt : ""
    });
  }

  return output;
}

function resolveSelectedChatIdsFromTriageMetadata(input: { payloadSelectedChatIds?: string[]; triageMetadata: unknown }) {
  const selectedFromPayload = [...new Set((input.payloadSelectedChatIds ?? []).filter(Boolean))];
  if (selectedFromPayload.length > 0) return selectedFromPayload;

  if (input.triageMetadata && typeof input.triageMetadata === "object" && !Array.isArray(input.triageMetadata)) {
    const metadata = input.triageMetadata as Record<string, unknown>;
    const selectedFromMetadata = [...new Set(toStringArray(metadata.selectedChatIds))];
    if (selectedFromMetadata.length > 0) return selectedFromMetadata;

    const assessments = Array.isArray(metadata.assessments) ? metadata.assessments : [];
    const fallbackFromAssessment = assessments
      .filter((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return false;
        const record = row as Record<string, unknown>;
        return record.relevanceLevel === "alta" || record.relevanceLevel === "media";
      })
      .sort((a, b) => {
        const scoreA = typeof (a as Record<string, unknown>).relevanceScore === "number"
          ? ((a as Record<string, unknown>).relevanceScore as number)
          : 0;
        const scoreB = typeof (b as Record<string, unknown>).relevanceScore === "number"
          ? ((b as Record<string, unknown>).relevanceScore as number)
          : 0;
        return scoreB - scoreA;
      })
      .slice(0, 80)
      .map((row) => {
        const chatId = (row as Record<string, unknown>).chatId;
        return typeof chatId === "string" ? chatId : "";
      })
      .filter(Boolean);

    if (fallbackFromAssessment.length > 0) return [...new Set(fallbackFromAssessment)];
  }

  return [];
}

type PhoneRegistryMessageLike = {
  id: string;
  body: string | null;
  senderId: string | null;
  attachments: Array<{ id: string; transcriptions: Array<{ text: string | null }> }>;
};

function isRelevantMessageForRegistry(
  message: PhoneRegistryMessageLike,
  assessment?: ChatAssessmentIndex
) {
  if (!assessment) return false;

  const contentParts = [
    message.body ?? "",
    ...message.attachments.flatMap((attachment) => attachment.transcriptions.map((row) => row.text ?? ""))
  ].filter((value) => value.trim().length > 0);
  if (contentParts.length === 0) return false;
  if (contentParts.every((part) => isLikelySystemMessage(part))) return false;

  const content = contentParts.join("\n");
  if (assessment.excerpt && hasExcerptOverlap(content, assessment.excerpt)) return true;

  const primaryTerms = new Set([
    ...assessment.matchedTerms.map((term) => normalize(term)).filter((term) => term.length >= 4 && !STOPWORDS.has(term)),
    ...tokenizeTerms(assessment.excerpt)
  ]);
  const secondaryTerms = new Set([
    ...tokenizeTerms(assessment.rationale),
    ...tokenizeTerms(assessment.positiveSignals.join(" "))
  ]);
  const textTerms = new Set(tokenizeTerms(content));

  const primaryMatches = [...primaryTerms].filter((term) => textTerms.has(term)).length;
  if (primaryMatches >= 2) return true;
  if (primaryMatches >= 1 && assessment.excerpt.length < 30) return true;

  const secondaryMatches = [...secondaryTerms].filter((term) => textTerms.has(term)).length;
  return secondaryMatches >= 3 && primaryMatches >= 1;
}

function selectRelevantMessagesForRegistry(
  messages: PhoneRegistryMessageLike[],
  assessment?: ChatAssessmentIndex
) {
  if (!assessment) return [];

  const directRelevantIndexes = messages
    .map((message, index) => (isRelevantMessageForRegistry(message, assessment) ? index : -1))
    .filter((index) => index >= 0);

  if (directRelevantIndexes.length === 0) return [];

  const include = new Set<number>();
  const contextRadius = 2;
  const bridgeGap = 8;

  for (const index of directRelevantIndexes) {
    for (let cursor = Math.max(0, index - contextRadius); cursor <= Math.min(messages.length - 1, index + contextRadius); cursor += 1) {
      include.add(cursor);
    }
  }

  for (let i = 0; i < directRelevantIndexes.length - 1; i += 1) {
    const current = directRelevantIndexes[i];
    const next = directRelevantIndexes[i + 1];
    if (current === undefined || next === undefined) continue;
    if (next - current <= bridgeGap) {
      for (let cursor = current; cursor <= next; cursor += 1) {
        include.add(cursor);
      }
    }
  }

  return [...include]
    .sort((a, b) => a - b)
    .map((index) => messages[index])
    .filter((message): message is PhoneRegistryMessageLike => Boolean(message));
}

function estimateTextTokens(value: string) {
  const clean = (value ?? "").trim();
  if (!clean) return 0;
  return Math.max(1, Math.ceil(clean.length / 4));
}

function parsePositiveIntOrFallback(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function wait(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createTokenRateLimiter(input: { targetTokensPerMinute: number; minCallIntervalMs: number }) {
  let windowStartAt = Date.now();
  let usedTokens = 0;
  let lastCallAt = 0;

  return {
    async consume(estimatedTokens: number) {
      const target = Math.max(1, input.targetTokensPerMinute);
      const minInterval = Math.max(0, input.minCallIntervalMs);
      let waitedMs = 0;

      const now = Date.now();
      if (now - windowStartAt >= 60_000) {
        windowStartAt = now;
        usedTokens = 0;
      }

      const sinceLastCall = now - lastCallAt;
      if (sinceLastCall < minInterval) {
        const delay = minInterval - sinceLastCall;
        await wait(delay);
        waitedMs += delay;
      }

      const afterIntervalNow = Date.now();
      if (afterIntervalNow - windowStartAt >= 60_000) {
        windowStartAt = afterIntervalNow;
        usedTokens = 0;
      }

      const nextTokens = Math.max(1, Math.floor(estimatedTokens));
      if (usedTokens + nextTokens > target) {
        const waitForWindow = Math.max(0, 60_000 - (afterIntervalNow - windowStartAt) + 25);
        if (waitForWindow > 0) {
          await wait(waitForWindow);
          waitedMs += waitForWindow;
        }
        windowStartAt = Date.now();
        usedTokens = 0;
      }

      usedTokens += nextTokens;
      lastCallAt = Date.now();
      return waitedMs;
    }
  };
}

function countOverlapTerms(value: string, contextTerms: Set<string>) {
  if (contextTerms.size === 0) return 0;
  const terms = tokenizeTerms(value);
  let matches = 0;
  for (const term of terms) {
    if (contextTerms.has(term)) matches += 1;
  }
  return matches;
}

function buildCompactInquiryContext(value: string) {
  const clean = (value ?? "").trim();
  if (clean.length <= TRIAGE_INQUIRY_CONTEXT_CHAR_LIMIT) return clean;
  return `${clean.slice(0, TRIAGE_INQUIRY_CONTEXT_CHAR_LIMIT)}...`;
}

function buildCompactReportInquiryContext(value: string) {
  const clean = (value ?? "").trim();
  if (clean.length <= REPORT_INQUIRY_CONTEXT_CHAR_LIMIT) return clean;
  return `${clean.slice(0, REPORT_INQUIRY_CONTEXT_CHAR_LIMIT)}...`;
}

function compressPdfTextForContextExtraction(value: string) {
  const clean = (value ?? "").replace(/\r/g, "").trim();
  const maxChars = 70000;
  if (clean.length <= maxChars) return clean;

  const head = clean.slice(0, 16000);
  const tail = clean.slice(-9000);
  const keywords = [
    "inquerito",
    "inquérito",
    "fato",
    "fatos",
    "investig",
    "suspeit",
    "vitim",
    "testemunh",
    "enquadramento",
    "art.",
    "lei",
    "indiciado",
    "autoria"
  ];

  const prioritized: string[] = [];
  for (const line of clean.split("\n")) {
    const compact = line.trim();
    if (!compact) continue;
    const norm = normalize(compact);
    if (
      compact.startsWith("[Page ") ||
      keywords.some((term) => norm.includes(term)) ||
      (compact.length >= 80 && compact.length <= 420)
    ) {
      prioritized.push(compact);
    }
  }

  const middle = truncate(prioritized.join("\n"), 42000);
  const merged = `${head}\n\n${middle}\n\n${tail}`.trim();
  return merged.length <= maxChars ? merged : merged.slice(0, maxChars);
}

function buildReportRequestPayload(input: {
  inquiryContext: string;
  assessments: ChatAssessment[];
  correlations: ChatCorrelation[];
  reportMeta: {
    caseNumber?: string | null;
    inquiryType?: string | null;
    inquiryNumber?: string | null;
    policeUnit?: string | null;
    totalEvidences: number;
    totalDevices: number;
    totalChats: number;
    totalMessages: number;
    totalTranscriptions: number;
    totalCustodyHashes: number;
    extractionStatus?: string | null;
    evidenceFileName?: string | null;
    evidenceSha256?: string | null;
    locationsDetected: number;
    sourceAppChatCounts: Array<{ sourceApp: string; chats: number }>;
  };
}) {
  const assessments = input.assessments.slice(0, REPORT_MAX_ASSESSMENTS).map((item) => ({
    chatId: item.chatId,
    label: truncate(item.label, 120),
    sourceApp: item.sourceApp,
    messageCount: item.messageCount,
    transcriptionCount: item.transcriptionCount,
    relevanceLevel: item.relevanceLevel,
    relevanceScore: item.relevanceScore,
    rationale: truncate(item.rationale, 320),
    matchedTerms: item.matchedTerms.slice(0, 8),
    positiveSignals: item.positiveSignals.slice(0, 4),
    negativeSignals: item.negativeSignals.slice(0, 4),
    excerpt: truncate(item.excerpt, 220)
  }));

  const correlations = input.correlations.slice(0, REPORT_MAX_CORRELATIONS).map((item) => ({
    sourceChatId: item.sourceChatId,
    targetChatId: item.targetChatId,
    score: Number(item.score.toFixed(3)),
    rationale: truncate(item.rationale, 240),
    sharedPhones: item.sharedPhones.slice(0, 4),
    sharedNames: item.sharedNames.slice(0, 4),
    sharedTerms: item.sharedTerms.slice(0, 8)
  }));

  return {
    inquiryContext: buildCompactReportInquiryContext(input.inquiryContext),
    reportMeta: input.reportMeta,
    assessments,
    correlations
  };
}

function compactParagraph(value: string, fallback: string) {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 0 ? clean : fallback;
}

function buildInvestigativeReportContent(input: {
  caseNumber?: string | null;
  inquiryType?: string | null;
  inquiryNumber?: string | null;
  policeUnit?: string | null;
  narrative: ReportNarrativeSections;
  technical: {
    totalEvidences: number;
    totalDevices: number;
    totalMessages: number;
    totalTranscriptions: number;
    totalCustodyHashes: number;
    extractionStatus?: string | null;
    evidenceFileName?: string | null;
    evidenceSha256?: string | null;
  };
  chatsSection: string;
  unlinkedAudioSection: string;
}) {
  const dateLabel = new Date().toLocaleDateString("pt-BR");
  const headerLine = [
    input.inquiryType ? `${input.inquiryType}` : "Inquerito Policial",
    input.inquiryNumber ? `nº ${input.inquiryNumber}` : null,
    input.caseNumber ? `| Caso nº ${input.caseNumber}` : null,
    input.policeUnit ? `| ${input.policeUnit}` : null,
    `| Data: ${dateLabel}`
  ]
    .filter(Boolean)
    .join(" ");

  const evidenceDescriptor = [
    input.technical.evidenceFileName ? `Arquivo "${input.technical.evidenceFileName}"` : null,
    input.technical.evidenceSha256 ? `hash SHA256 ${input.technical.evidenceSha256}` : null
  ]
    .filter(Boolean)
    .join(", ");

  return [
    "# RELATORIO CONSOLIDADO INVESTIGATIVO",
    "",
    headerLine,
    "",
    "## 1. IDENTIFICACAO",
    "",
    compactParagraph(
      input.narrative.identificacao,
      "Relatorio tecnico consolidado com base em evidencias digitais extraidas no procedimento investigativo."
    ),
    "",
    "## 2. CONTEXTO FATICO E DINAMICA DELITIVA",
    "",
    compactParagraph(
      input.narrative.contextoFatico,
      "Contexto fatico indisponivel para consolidacao automatica. Recomenda-se revisao manual."
    ),
    "",
    "## 3. DADOS TECNICOS DA EXTRACAO",
    "",
    "A analise pericial foi realizada a partir de extracao digital UFDR, com os seguintes indicadores:",
    "",
    `- Total de evidencias analisadas: ${input.technical.totalEvidences}`,
    `- Total de aparelhos detectados: ${input.technical.totalDevices}`,
    `- Mensagens processadas: ${input.technical.totalMessages}`,
    `- Transcricoes de audio processadas: ${input.technical.totalTranscriptions}`,
    `- Registros de cadeia de custodia com hash: ${input.technical.totalCustodyHashes}`,
    `- Situacao da extracao: ${input.technical.extractionStatus ?? "nao informado"}`,
    evidenceDescriptor ? `- Identificacao da evidencia: ${evidenceDescriptor}` : "- Identificacao da evidencia: nao informada",
    "",
    "## 4. CONTAS DAS REDES SOCIAIS (LEITURA SIMPLIFICADA - ORGANIZADA)",
    "",
    compactParagraph(
      input.narrative.contasRedesSociais,
      "Nao houve elementos suficientes para consolidar titulacao de contas com seguranca nesta execucao."
    ),
    "",
    "## 5. LOCALIZACOES EXTRAIDAS",
    "",
    compactParagraph(
      input.narrative.localizacoesExtraidas,
      "Nao houve elementos suficientes para consolidar padroes de localizacao nesta execucao."
    ),
    "",
    input.chatsSection.trim(),
    "",
    input.unlinkedAudioSection.trim(),
    "",
    "## 8. CONCLUSAO TECNICA",
    "",
    compactParagraph(
      input.narrative.conclusaoTecnica,
      "A consolidacao automatica indica necessidade de validacao manual complementar antes do encaminhamento final."
    ),
    ""
  ]
    .join("\n")
    .trim();
}

function buildReportReuseSignature(input: {
  caseId: string;
  evidenceId?: string;
  provider: string;
  reportModel: string;
  triageGeneratedAt: string;
  selectedChatIds: string[];
  selectedUnlinkedAudioIds?: string[];
  contextHint?: string | null;
}) {
  const serialized = JSON.stringify({
    reportStructureVersion: 3,
    caseId: input.caseId,
    evidenceId: input.evidenceId ?? null,
    provider: input.provider,
    reportModel: input.reportModel,
    triageGeneratedAt: input.triageGeneratedAt,
    selectedChatIds: [...input.selectedChatIds].sort(),
    selectedUnlinkedAudioIds: [...(input.selectedUnlinkedAudioIds ?? [])].sort(),
    contextHint: normalizeOptionalText(input.contextHint) ?? null
  });
  return createHash("sha256").update(serialized).digest("hex").slice(0, 24);
}

function selectMessagesForModel(input: {
  messages: CandidateModelMessage[];
  tokenBudget: number;
  minKeep: number;
}) {
  const tokenBudget = Math.max(300, input.tokenBudget);
  const minKeep = Math.max(1, input.minKeep);

  const dedupMap = new Map<string, CandidateModelMessage>();
  for (const candidate of input.messages) {
    const key = normalize(candidate.text);
    const existing = dedupMap.get(key);
    if (!existing || candidate.position > existing.position) {
      dedupMap.set(key, candidate);
    }
  }

  const uniqueMessages = [...dedupMap.values()];
  const maxPosition = Math.max(1, uniqueMessages.length - 1);
  const scored = uniqueMessages
    .map((candidate) => {
      const recencyBoost = candidate.position / maxPosition;
      const overlapBoost = Math.min(4, candidate.overlapCount * 0.8);
      const transcriptionBoost = candidate.isTranscription ? 1.2 : 0;
      const lengthBoost = Math.min(1.2, candidate.tokens / 60);
      const score = overlapBoost + transcriptionBoost + recencyBoost + lengthBoost;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score || b.candidate.position - a.candidate.position);

  const selected: CandidateModelMessage[] = [];
  let usedTokens = 0;

  for (const item of scored) {
    if (selected.length >= 350) break;
    if (usedTokens + item.candidate.tokens > tokenBudget && selected.length >= minKeep) continue;
    selected.push(item.candidate);
    usedTokens += item.candidate.tokens;
  }

  if (selected.length === 0 && scored.length > 0) {
    const first = scored[0];
    if (first) {
      selected.push(first.candidate);
      usedTokens = first.candidate.tokens;
    }
  }

  selected.sort((a, b) => a.position - b.position);

  return {
    selected,
    selectedTokens: usedTokens,
    dedupedCount: uniqueMessages.length,
    droppedByBudget: Math.max(0, uniqueMessages.length - selected.length)
  };
}

function isLikelySystemMessage(text: string) {
  const normalized = normalize(text).replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  const patterns = [
    "mensagens e chamadas sao protegidas com criptografia de ponta a ponta",
    "messages and calls are end-to-end encrypted",
    "no one outside of this chat, not even whatsapp, can read or listen to them",
    "tap to learn more",
    "security code",
    "this message was deleted",
    "you deleted this message",
    "missed voice call",
    "missed video call",
    "voice call",
    "video call",
    "codigo de seguranca",
    "mudou para este numero",
    "entrou usando o link de convite",
    "adicionou",
    "removeu",
    "apagou esta mensagem",
    "mensagem apagada",
    "sticker omitido",
    "imagem omitida",
    "video omitido",
    "audio omitido",
    "documento omitido",
    "ligacao de voz",
    "ligacao de video",
    "chamada perdida",
    "agora e um contato",
    "saiu do grupo",
    "criou o grupo"
  ];
  return patterns.some((term) => normalized.includes(term));
}

function isInformativeText(text: string) {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return false;
  if (isLikelySystemMessage(compact)) return false;

  const alnum = normalize(compact).replace(/[^a-z0-9]/g, "");
  if (alnum.length < 6) return false;
  if (/^[0-9 .,+\-_/()]+$/.test(compact)) return false;
  return compact.length >= 10;
}

function evaluateChatContentQuality(input: {
  informativeMessageCount: number;
  informativeCharCount: number;
  systemMessageCount: number;
  ignoredMessageCount: number;
  transcriptionCount: number;
  inquiryTermOverlapCount: number;
}) {
  const reasons: string[] = [];
  const isSystemOnlyChat =
    input.transcriptionCount === 0 && input.informativeMessageCount === 0 && input.systemMessageCount > 0;

  if (isSystemOnlyChat) {
    reasons.push(
      "Chat descartado: contém apenas mensagens automáticas/sistema (sem conteúdo conversacional útil)."
    );
    reasons.push("Classificado como irrelevante na mesma categoria de chat sem mensagem útil.");
  }

  if (input.transcriptionCount === 0 && input.informativeMessageCount === 0) {
    reasons.push("Sem mensagens com conteúdo útil e sem transcrições.");
  } else if (input.transcriptionCount === 0 && input.informativeCharCount < 50 && input.informativeMessageCount < 2) {
    reasons.push("Conteúdo textual insuficiente para inferência confiável.");
  }

  if (
    input.transcriptionCount === 0 &&
    input.inquiryTermOverlapCount === 0 &&
    input.informativeCharCount < 200 &&
    input.informativeMessageCount < 3
  ) {
    reasons.push("Baixa densidade de contexto e sem termos do inquérito no chat.");
  }

  const gateScore = Number(
    (
      Math.min(6, input.inquiryTermOverlapCount * 1.4) +
      Math.min(3.5, input.informativeMessageCount / 3) +
      Math.min(3, input.informativeCharCount / 320) +
      Math.min(3.5, input.transcriptionCount * 1.2)
    ).toFixed(2)
  );

  if (input.transcriptionCount === 0 && input.inquiryTermOverlapCount === 0 && gateScore < 3.8) {
    reasons.push("Gate local: escore baixo sem evidência semântica mínima para envio à IA.");
  }

  const shouldSkipAi = reasons.length > 0;
  return {
    ...input,
    inquiryTermOverlapCount: input.inquiryTermOverlapCount,
    localGateScore: gateScore,
    shouldSkipAi,
    reasons
  } as ChatContentQuality;
}

function lowEvidenceAssessmentFallback(quality: ChatContentQuality): OpenAiChatAssessmentResult {
  return {
    relevanceLevel: "baixa",
    relevanceScore: 0,
    rationale: `Chat não qualificado para análise contextual: ${quality.reasons.join(" ")}`,
    matchedTerms: [],
    positiveSignals: quality.transcriptionCount > 0 ? ["Há transcrição, mas sem contexto textual suficiente no chat."] : [],
    negativeSignals: [
      "Conteúdo insuficiente para correlação investigativa confiável.",
      ...quality.reasons
    ].slice(0, 8),
    excerpt: ""
  };
}

function applyAssessmentGuards(
  assessment: OpenAiChatAssessmentResult,
  quality: ChatContentQuality
): OpenAiChatAssessmentResult {
  if (quality.shouldSkipAi) {
    return lowEvidenceAssessmentFallback(quality);
  }

  const weakEvidenceWithoutTranscript =
    quality.transcriptionCount === 0 &&
    quality.informativeCharCount < 120 &&
    quality.informativeMessageCount < 3 &&
    assessment.matchedTerms.length === 0;

  if (weakEvidenceWithoutTranscript && assessment.relevanceLevel !== "baixa") {
    return {
      ...assessment,
      relevanceLevel: "baixa",
      relevanceScore: Math.min(assessment.relevanceScore, 3),
      rationale:
        "Resultado rebaixado automaticamente: conteúdo do chat insuficiente e sem termos-chave compatíveis com o inquérito.",
      negativeSignals: [
        ...assessment.negativeSignals,
        "Rebaixado por baixa densidade de evidência textual."
      ].slice(0, 8)
    };
  }

  return assessment;
}

function buildCorrelations(assessments: ChatAssessment[], byChatId: Map<string, { phones: string[]; names: string[]; text: string }>) {
  const relevant = assessments.filter((item) => item.relevanceLevel !== "baixa").slice(0, 120);
  const output: ChatCorrelation[] = [];
  for (let i = 0; i < relevant.length; i += 1) {
    for (let j = i + 1; j < relevant.length; j += 1) {
      const a = relevant[i];
      const b = relevant[j];
      if (!a || !b) continue;
      const metaA = byChatId.get(a.chatId);
      const metaB = byChatId.get(b.chatId);
      if (!metaA || !metaB) continue;

      const sharedPhones = metaA.phones.filter((value) => metaB.phones.includes(value)).slice(0, 6);
      const sharedNames = metaA.names.filter((value) => metaB.names.includes(value)).slice(0, 6);
      const termsA = tokenizeTerms(metaA.text);
      const termsBSet = new Set(tokenizeTerms(metaB.text));
      const sharedTerms = termsA.filter((value) => termsBSet.has(value)).slice(0, 12);

      let score = 0;
      if (sharedPhones.length > 0) score += 0.5;
      if (sharedNames.length > 0) score += Math.min(sharedNames.length * 0.15, 0.3);
      if (sharedTerms.length > 0) score += Math.min(sharedTerms.length * 0.03, 0.2);
      if (score <= 0) continue;

      const rationaleParts: string[] = [];
      if (sharedPhones.length > 0) rationaleParts.push(`telefones em comum (${sharedPhones.join(", ")})`);
      if (sharedNames.length > 0) rationaleParts.push(`nomes recorrentes (${sharedNames.join(", ")})`);
      if (sharedTerms.length > 0) rationaleParts.push(`termos recorrentes (${sharedTerms.join(", ")})`);

      output.push({
        sourceChatId: a.chatId,
        targetChatId: b.chatId,
        score,
        rationale: `Coincidencias relevantes identificadas: ${rationaleParts.join("; ")}.`,
        sharedPhones,
        sharedNames,
        sharedTerms
      });
    }
  }
  return output.sort((x, y) => y.score - x.score).slice(0, 300);
}

function buildInquiryContext(input: {
  title: string;
  description?: string | null;
  inquiryType?: string | null;
  inquiryNumber?: string | null;
  policeUnit?: string | null;
  inquiryLegalFraming?: string | null;
  inquirySummaryText?: string | null;
  inquiryMainFacts?: string | null;
  inquiryInvestigativeFocus?: string | null;
  extractionReportSummary?: string | null;
  notes?: string[];
}) {
  const joined = [
    `Titulo do caso: ${input.title}.`,
    input.description ? `Descricao: ${input.description}.` : "",
    input.inquiryType ? `Tipo de inquerito: ${input.inquiryType}.` : "",
    input.inquiryNumber ? `Numero do inquerito: ${input.inquiryNumber}.` : "",
    input.policeUnit ? `Unidade policial: ${input.policeUnit}.` : "",
    input.inquiryLegalFraming ? `Enquadramento legal: ${input.inquiryLegalFraming}.` : "",
    input.inquirySummaryText ? `Resumo do inquerito: ${input.inquirySummaryText}.` : "",
    input.inquiryMainFacts ? `Fatos principais: ${input.inquiryMainFacts}.` : "",
    input.inquiryInvestigativeFocus ? `Foco investigativo: ${input.inquiryInvestigativeFocus}.` : "",
    input.extractionReportSummary ? `Resumo do relatorio da extracao: ${input.extractionReportSummary}.` : "",
    input.notes && input.notes.length > 0 ? `Notas analiticas: ${input.notes.join(" ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  return joined.length > 2400 ? joined.slice(0, 2400) : joined;
}

async function resolveOpenAiApiKey(runtimeKey?: string) {
  const runtime = runtimeKey?.trim();
  if (runtime) return runtime;

  const settingValue = (await getAppSettingValue("OPENAI_API_KEY"))?.trim();
  const key = settingValue || process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY ausente. Configure em Configuracoes > OPENAI_API_KEY.");
  }
  return key;
}

async function callOpenAiChatAssessment(input: {
  apiKey: string;
  model: string;
  inquiryContext: string;
  chatLabel: string;
  sourceApp: string;
  messages: Array<{ sender: string; text: string }>;
}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Voce e um analista forense. Classifique relevancia de chat para inquerito em alta/media/baixa com score 0-15. Use somente evidencias do chat/transcricoes; nao inferir relevancia apenas pelo contexto do caso. Mensagens de sistema/administrativas sem conteudo factual devem ser baixa. Responda apenas JSON valido no schema solicitado."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                inquiryContext: input.inquiryContext,
                chatLabel: input.chatLabel,
                sourceApp: input.sourceApp,
                messages: input.messages
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "investigation_chat_assessment",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              relevanceLevel: { type: "string", enum: ["alta", "media", "baixa"] },
              relevanceScore: { type: "number" },
              rationale: { type: "string" },
              matchedTerms: { type: "array", items: { type: "string" } },
              positiveSignals: { type: "array", items: { type: "string" } },
              negativeSignals: { type: "array", items: { type: "string" } },
              excerpt: { type: "string" }
            },
            required: [
              "relevanceLevel",
              "relevanceScore",
              "rationale",
              "matchedTerms",
              "positiveSignals",
              "negativeSignals",
              "excerpt"
            ]
          }
        }
      }
    })
  });

  const raw = await response.text();
  let parsedRaw: any = null;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    parsedRaw = null;
  }

  if (!response.ok) {
    const message = parsedRaw?.error?.message ?? raw ?? `OpenAI error ${response.status}`;
    throw new Error(message);
  }

  const outputText =
    parsedRaw?.output_text ??
    parsedRaw?.output?.[0]?.content?.find((item: any) => item?.type === "output_text")?.text ??
    "";

  if (!outputText) {
    throw new Error("OpenAI nao retornou assessment do chat.");
  }

  const parsed = JSON.parse(outputText) as OpenAiChatAssessmentResult;

  return {
    relevanceLevel: parsed.relevanceLevel,
    relevanceScore: Math.max(0, Math.min(15, Number(parsed.relevanceScore) || 0)),
    rationale: truncate(parsed.rationale || "Sem racional.", 1200),
    matchedTerms: (parsed.matchedTerms ?? []).slice(0, 12),
    positiveSignals: (parsed.positiveSignals ?? []).slice(0, 8),
    negativeSignals: (parsed.negativeSignals ?? []).slice(0, 8),
    excerpt: truncate(parsed.excerpt || "", 500)
  } as OpenAiChatAssessmentResult;
}

function runLocalChatAssessment(input: {
  inquiryContext: string;
  chatLabel: string;
  sourceApp: string;
  messages: Array<{ sender: string; text: string }>;
}): OpenAiChatAssessmentResult {
  const contextTerms = tokenizeTerms(input.inquiryContext).slice(0, 80);
  const contextSet = new Set(contextTerms);
  const merged = input.messages
    .map((row) => `${row.sender}: ${row.text}`)
    .join("\n")
    .slice(0, 30000);
  const mergedTerms = tokenizeTerms(merged);
  const matchedTerms = mergedTerms.filter((term) => contextSet.has(term)).slice(0, 12);

  const transcriptionSignals = /\[transcricao-audio\]/i.test(merged) ? 2 : 0;
  const matchedScore = matchedTerms.length * 1.6;
  const volumeScore = Math.min(4, input.messages.length / 25);
  const relevanceScoreRaw = Math.min(15, Number((matchedScore + transcriptionSignals + volumeScore).toFixed(2)));
  const relevanceScore = Math.max(0, relevanceScoreRaw);

  const relevanceLevel: InvestigativeLevel =
    relevanceScore >= 8 ? "alta" : relevanceScore >= 4 ? "media" : "baixa";
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];
  if (matchedTerms.length > 0) positiveSignals.push(`Termos do inquerito encontrados: ${matchedTerms.join(", ")}`);
  if (transcriptionSignals > 0) positiveSignals.push("Chat com transcricao de audio indexada.");
  if (matchedTerms.length === 0) negativeSignals.push("Sem termos-chave do inquerito no chat.");

  return {
    relevanceLevel,
    relevanceScore,
    rationale:
      matchedTerms.length > 0
        ? `Classificacao local por sobreposicao de contexto (${matchedTerms.length} termos correlatos).`
        : "Classificacao local com baixa correlacao textual ao contexto do inquerito.",
    matchedTerms,
    positiveSignals: positiveSignals.slice(0, 8),
    negativeSignals: negativeSignals.slice(0, 8),
    excerpt: truncate(merged, 500)
  };
}

export async function runCaseInvestigativeTriage(input: {
  caseId: string;
  evidenceId?: string;
  maxChats?: number;
  contextHint?: string;
  aiEngine?: "local" | "openai";
  analysisModel: string;
  openaiApiKey?: string;
  onProgress?: ProgressCallback;
}) {
  const aiEngine = input.aiEngine ?? "openai";
  const apiKey = aiEngine === "openai" ? await resolveOpenAiApiKey(input.openaiApiKey) : undefined;
  const maxChats =
    typeof input.maxChats === "number" && Number.isFinite(input.maxChats)
      ? Math.max(1, Math.round(input.maxChats))
      : undefined;
  const normalizedContextHint = normalizeOptionalText(input.contextHint);

  const [caseRow, chats, notes] = await Promise.all([
    prisma.case.findUnique({ where: { id: input.caseId } }),
    prisma.chat.findMany({
      where: {
        caseId: input.caseId,
        ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
      },
      include: {
        participants: true,
        messages: {
          orderBy: { timestamp: "asc" },
          take: 1200,
          include: {
            attachments: {
              include: {
                transcriptions: {
                  where: { status: "COMPLETED" },
                  orderBy: { createdAt: "desc" },
                  take: 1
                }
              }
            }
          }
        }
      },
      take: maxChats,
      orderBy: { updatedAt: "desc" }
    }),
    prisma.analystNote.findMany({
      where: { caseId: input.caseId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { title: true, content: true }
    })
  ]);

  if (!caseRow) {
    throw new Error("Caso nao encontrado.");
  }
  if (!hasCaseInquiryContext(caseRow) && !hasMeaningfulText(normalizedContextHint, MIN_CONTEXT_HINT_LENGTH)) {
    throw new Error(
      "Contextualizacao obrigatoria: anexe o PDF do inquerito (ou contextualize o caso) ou informe um resumo manual com pelo menos 20 caracteres do que procurar."
    );
  }

  const noteTexts = notes.map((item) => `${item.title ?? "nota"}: ${truncate(item.content, 240)}`);
  const inquiryContextBase = buildInquiryContext({
    title: caseRow.title,
    description: caseRow.description,
    inquiryType: caseRow.inquiryType,
    inquiryNumber: caseRow.inquiryNumber,
    policeUnit: caseRow.policeUnit,
    inquiryLegalFraming: caseRow.inquiryLegalFraming,
    inquirySummaryText: caseRow.inquirySummaryText,
    inquiryMainFacts: caseRow.inquiryMainFacts,
    inquiryInvestigativeFocus: caseRow.inquiryInvestigativeFocus,
    extractionReportSummary: caseRow.extractionReportSummary,
    notes: noteTexts
  });
  const inquiryContext = appendContextHintToInquiryContext(inquiryContextBase, normalizedContextHint ?? undefined);
  const compactInquiryContext = buildCompactInquiryContext(inquiryContext);
  const inquiryContextTokens = estimateTextTokens(compactInquiryContext);
  const inquiryTerms = new Set(tokenizeTerms(compactInquiryContext).slice(0, 120));
  const targetTokensPerMinute = parsePositiveIntOrFallback(process.env.INVESTIGATION_TRIAGE_TARGET_TPM, 45000);
  const minCallIntervalMs = parsePositiveIntOrFallback(process.env.INVESTIGATION_TRIAGE_MIN_CALL_INTERVAL_MS, 180);
  const triageRateLimiter =
    aiEngine === "openai"
      ? createTokenRateLimiter({
          targetTokensPerMinute,
          minCallIntervalMs
        })
      : null;

  const assessments: ChatAssessment[] = [];
  const metaByChat = new Map<string, { phones: string[]; names: string[]; text: string }>();
  const diagnostics: NonNullable<InvestigationTriagePayload["diagnostics"]> = {
    inquiryContextTokens,
    chatsSentToAi: 0,
    chatsSkippedByGate: 0,
    estimatedInputTokensTotal: 0,
    throttleWaitMsTotal: 0,
    throttleEvents: 0,
    targetTokensPerMinute,
    minCallIntervalMs,
    chats: []
  };

  if (input.onProgress) await input.onProgress(5);

  for (let index = 0; index < chats.length; index += 1) {
    const chat = chats[index];
    if (!chat) continue;

    const label = chat.title ?? chat.externalId ?? chat.id;
    const candidateMessages: CandidateModelMessage[] = [];
    const linesForCorrelation: string[] = [];
    let transcriptionCount = 0;
    let informativeMessageCount = 0;
    let informativeCharCount = 0;
    let systemMessageCount = 0;
    let ignoredMessageCount = 0;
    let inquiryTermOverlapCount = 0;
    let candidatePosition = 0;

    for (const message of chat.messages) {
      const sender = message.senderId ?? "interlocutor";
      const body = truncate(message.body ?? "", 800);
      if (body) {
        if (isLikelySystemMessage(body)) {
          systemMessageCount += 1;
        } else if (isInformativeText(body)) {
          const overlapCount = countOverlapTerms(body, inquiryTerms);
          informativeMessageCount += 1;
          informativeCharCount += body.length;
          inquiryTermOverlapCount += overlapCount;
          candidateMessages.push({
            sender,
            text: body,
            tokens: estimateTextTokens(body),
            overlapCount,
            isTranscription: false,
            position: candidatePosition
          });
          candidatePosition += 1;
          linesForCorrelation.push(`${sender}: ${body}`);
        } else {
          ignoredMessageCount += 1;
        }
      }

      for (const attachment of message.attachments) {
        const transcription = attachment.transcriptions[0];
        if (!transcription?.text) continue;
        transcriptionCount += 1;
        const line = truncate(transcription.text, 800);
        if (isInformativeText(line)) {
          const overlapCount = countOverlapTerms(line, inquiryTerms);
          informativeMessageCount += 1;
          informativeCharCount += line.length;
          inquiryTermOverlapCount += overlapCount;
          const transcriptionText = `[transcricao-audio] ${line}`;
          candidateMessages.push({
            sender,
            text: transcriptionText,
            tokens: estimateTextTokens(transcriptionText),
            overlapCount,
            isTranscription: true,
            position: candidatePosition
          });
          candidatePosition += 1;
          linesForCorrelation.push(`${sender} [transcricao-audio]: ${line}`);
        } else {
          ignoredMessageCount += 1;
        }
      }
    }

    const contentQuality = evaluateChatContentQuality({
      informativeMessageCount,
      informativeCharCount,
      systemMessageCount,
      ignoredMessageCount,
      transcriptionCount,
      inquiryTermOverlapCount
    });

    const selection = selectMessagesForModel({
      messages: candidateMessages,
      tokenBudget: TRIAGE_MESSAGES_TOKEN_BUDGET,
      minKeep: TRIAGE_MESSAGES_MIN_KEEP
    });
    const messagesForModel = selection.selected.map((row) => ({ sender: row.sender, text: row.text }));
    const estimatedInputTokens = inquiryContextTokens + selection.selectedTokens + 160;
    let throttleWaitMs = 0;
    if (!contentQuality.shouldSkipAi && aiEngine === "openai" && apiKey && triageRateLimiter) {
      throttleWaitMs = await triageRateLimiter.consume(estimatedInputTokens);
      if (throttleWaitMs > 0) {
        diagnostics.throttleEvents += 1;
        diagnostics.throttleWaitMsTotal += throttleWaitMs;
      }
    }

    diagnostics.estimatedInputTokensTotal += estimatedInputTokens;
    if (contentQuality.shouldSkipAi) diagnostics.chatsSkippedByGate += 1;
    else diagnostics.chatsSentToAi += 1;
    diagnostics.chats.push({
      chatId: chat.id,
      label,
      gateScore: contentQuality.localGateScore,
      shouldSkipAi: contentQuality.shouldSkipAi,
      skipReasons: contentQuality.reasons,
      rawInformativeItems: candidateMessages.length,
      selectedItemsForModel: selection.selected.length,
      droppedItemsByBudget: selection.droppedByBudget,
      estimatedInputTokens,
      transcriptionCount,
      informativeCharCount,
      inquiryTermOverlap: inquiryTermOverlapCount,
      throttleWaitMs
    });

    const baseAssessment = contentQuality.shouldSkipAi
      ? lowEvidenceAssessmentFallback(contentQuality)
      : aiEngine === "openai" && apiKey
        ? await callOpenAiChatAssessment({
            apiKey,
            model: input.analysisModel,
            inquiryContext: compactInquiryContext,
            chatLabel: label,
            sourceApp: chat.sourceApp ?? "OUTROS",
            messages: messagesForModel
          })
        : runLocalChatAssessment({
          inquiryContext: compactInquiryContext,
            chatLabel: label,
            sourceApp: chat.sourceApp ?? "OUTROS",
            messages: messagesForModel
          });
    const assessment = applyAssessmentGuards(baseAssessment, contentQuality);

    assessments.push({
      chatId: chat.id,
      label,
      sourceApp: chat.sourceApp ?? "OUTROS",
      messageCount: chat.messages.length,
      transcriptionCount,
      relevanceLevel: assessment.relevanceLevel,
      relevanceScore: assessment.relevanceScore,
      rationale: assessment.rationale,
      matchedTerms: assessment.matchedTerms,
      positiveSignals: assessment.positiveSignals,
      negativeSignals: assessment.negativeSignals,
      excerpt: assessment.excerpt
    });

    const phones = chat.participants.map((p) => p.phone).filter((value): value is string => Boolean(value));
    const names = chat.participants
      .map((p) => p.name ?? p.handle)
      .filter((value): value is string => Boolean(value))
      .map((value) => normalize(value));

    metaByChat.set(chat.id, {
      phones: [...new Set(phones)],
      names: [...new Set(names)],
      text: truncate(linesForCorrelation.join("\n"), 20000)
    });

    if (input.onProgress) {
      const pct = 10 + Math.round(((index + 1) / Math.max(1, chats.length)) * 75);
      await input.onProgress(Math.min(90, pct));
    }
  }

  assessments.sort((a, b) => b.relevanceScore - a.relevanceScore || a.label.localeCompare(b.label, "pt-BR"));
  const correlations = buildCorrelations(assessments, metaByChat);

  const payload: InvestigationTriagePayload = {
    version: 3,
    generatedAt: new Date().toISOString(),
    caseId: input.caseId,
    evidenceId: input.evidenceId,
    inquiryContext,
    assessments,
    correlations,
    diagnostics
  };

  const highCount = assessments.filter((item) => item.relevanceLevel === "alta").length;
  const mediumCount = assessments.filter((item) => item.relevanceLevel === "media").length;

  const insight = await prisma.aiInsight.create({
    data: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "INVESTIGATION_TRIAGE",
      title: sanitizeTextForDatabase(`Triagem investigativa (${new Date().toLocaleString("pt-BR")})`),
      summary: sanitizeTextForDatabase(`Chats avaliados: ${assessments.length}. Alta: ${highCount}. Media: ${mediumCount}.`),
      score: highCount + mediumCount / 2,
      metadata: sanitizeJsonForDatabase({
        ...payload,
        analysisModel: input.analysisModel,
        provider: aiEngine,
        contextHint: normalizedContextHint
      }) as Prisma.InputJsonValue
    }
  });

  if (input.onProgress) await input.onProgress(100);
  return { insightId: insight.id, payload, summary: insight.summary };
}

export async function getLatestCaseInvestigativeTriage(input: { caseId: string; evidenceId?: string }) {
  const insight = await prisma.aiInsight.findFirst({
    where: {
      caseId: input.caseId,
      type: "INVESTIGATION_TRIAGE",
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
    },
    orderBy: { createdAt: "desc" }
  });

  if (!insight) return null;
  const metadata = insight.metadata as InvestigationTriagePayload | null;
  return {
    insightId: insight.id,
    createdAt: insight.createdAt,
    summary: insight.summary,
    payload: metadata
  };
}

export type InvestigationChatModalPayload = {
  chatId: string;
  label: string;
  sourceApp: string;
  participants: Array<{
    id: string;
    name: string | null;
    handle: string | null;
    phone: string | null;
    email: string | null;
  }>;
  messages: Array<{
    id: string;
    senderId: string | null;
    direction: string | null;
    body: string | null;
    timestamp: string | null;
    createdAt: string;
    attachments: Array<{
      id: string;
      fileName: string | null;
      mimeType: string | null;
      archivePath: string | null;
      transcriptions: string[];
    }>;
    transcriptions: string[];
  }>;
  assessment?: ChatAssessmentSummary;
  relevantOnly?: boolean;
};

function normalizeAssessmentSummary(assessments: ChatAssessment[]) {
  const highCount = assessments.filter((item) => item.relevanceLevel === "alta").length;
  const mediumCount = assessments.filter((item) => item.relevanceLevel === "media").length;
  return {
    highCount,
    mediumCount,
    summary: `Chats avaliados: ${assessments.length}. Alta: ${highCount}. Media: ${mediumCount}.`,
    score: highCount + mediumCount / 2
  };
}

async function resolveEvidenceIdFromExtraction(input: { caseId: string; extractionId?: string }) {
  if (!input.extractionId) return undefined;
  const extraction = await prisma.extraction.findFirst({
    where: {
      id: input.extractionId,
      caseId: input.caseId
    },
    select: {
      evidenceId: true
    }
  });
  if (!extraction) {
    throw new Error("Extracao nao encontrada para o caso informado.");
  }
  return extraction.evidenceId;
}

async function loadChatForInvestigation(input: { caseId: string; chatId: string; evidenceId?: string }) {
  return prisma.chat.findFirst({
    where: {
      id: input.chatId,
      caseId: input.caseId,
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
    },
    include: {
      participants: {
        select: { id: true, name: true, handle: true, phone: true, email: true }
      },
      messages: {
        orderBy: [{ timestamp: "asc" }, { createdAt: "asc" }],
        include: {
          attachments: {
            include: {
              transcriptions: {
                where: { status: "COMPLETED" },
                orderBy: { createdAt: "desc" },
                take: 1
              }
            }
          }
        }
      }
    }
  });
}

async function loadTriageAssessmentForChat(input: {
  caseId: string;
  chatId: string;
  evidenceId?: string;
  triageInsightId?: string;
}) {
  if (!input.triageInsightId) return null;

  const insight = await prisma.aiInsight.findFirst({
    where: {
      id: input.triageInsightId,
      caseId: input.caseId,
      type: "INVESTIGATION_TRIAGE",
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
    },
    select: { metadata: true }
  });

  const metadata = (insight?.metadata as InvestigationTriagePayload | null) ?? null;
  return metadata?.assessments?.find((item) => item.chatId === input.chatId) ?? null;
}

function hasExcerptOverlap(text: string, excerpt: string) {
  const normalizedText = normalize(text).replace(/\s+/g, " ").trim();
  const normalizedExcerpt = normalize(excerpt).replace(/\s+/g, " ").trim();
  if (!normalizedText || !normalizedExcerpt) return false;

  if (normalizedText.length >= 24 && normalizedExcerpt.includes(normalizedText.slice(0, 120))) return true;
  if (normalizedExcerpt.length >= 24 && normalizedText.includes(normalizedExcerpt.slice(0, 120))) return true;

  const textTerms = new Set(tokenizeTerms(normalizedText));
  const excerptTerms = tokenizeTerms(normalizedExcerpt);
  if (excerptTerms.length === 0) return false;
  const overlap = excerptTerms.filter((term) => textTerms.has(term)).length;
  return overlap >= Math.min(4, Math.max(2, Math.ceil(excerptTerms.length * 0.35)));
}

function isRelevantMessageForAssessment(
  message: NonNullable<Awaited<ReturnType<typeof loadChatForInvestigation>>>["messages"][number],
  assessment?: ChatAssessmentSummary | null
) {
  if (!assessment) return false;

  const contentParts = [
    message.body ?? "",
    ...message.attachments.flatMap((attachment) => attachment.transcriptions.map((row) => row.text ?? ""))
  ].filter((value) => value.trim().length > 0);
  if (contentParts.length === 0) return false;
  if (contentParts.every((part) => isLikelySystemMessage(part))) return false;

  const content = contentParts.join("\n");
  if (assessment.excerpt && hasExcerptOverlap(content, assessment.excerpt)) return true;

  const primaryTerms = new Set([
    ...assessment.matchedTerms.map((term) => normalize(term)).filter((term) => term.length >= 4 && !STOPWORDS.has(term)),
    ...tokenizeTerms(assessment.excerpt)
  ]);
  const secondaryTerms = new Set([
    ...tokenizeTerms(assessment.rationale),
    ...tokenizeTerms(assessment.positiveSignals.join(" "))
  ]);
  const textTerms = new Set(tokenizeTerms(content));

  const primaryMatches = [...primaryTerms].filter((term) => textTerms.has(term)).length;
  if (primaryMatches >= 2) return true;
  if (primaryMatches >= 1 && assessment.excerpt.length < 30) return true;

  const secondaryMatches = [...secondaryTerms].filter((term) => textTerms.has(term)).length;
  return secondaryMatches >= 3 && primaryMatches >= 1;
}

function selectRelevantMessagesWithContext(
  messages: NonNullable<Awaited<ReturnType<typeof loadChatForInvestigation>>>["messages"],
  assessment?: ChatAssessmentSummary | null
) {
  if (!assessment) return [];

  const directRelevantIndexes = messages
    .map((message, index) => (isRelevantMessageForAssessment(message, assessment) ? index : -1))
    .filter((index) => index >= 0);

  if (directRelevantIndexes.length === 0) return [];

  const include = new Set<number>();
  const contextRadius = 2;
  const bridgeGap = 8;

  for (const index of directRelevantIndexes) {
    for (let cursor = Math.max(0, index - contextRadius); cursor <= Math.min(messages.length - 1, index + contextRadius); cursor += 1) {
      include.add(cursor);
    }
  }

  for (let i = 0; i < directRelevantIndexes.length - 1; i += 1) {
    const current = directRelevantIndexes[i];
    const next = directRelevantIndexes[i + 1];
    if (current === undefined || next === undefined) continue;
    if (next - current <= bridgeGap) {
      for (let cursor = current; cursor <= next; cursor += 1) {
        include.add(cursor);
      }
    }
  }

  return [...include]
    .sort((a, b) => a - b)
    .map((index) => messages[index])
    .filter((message): message is (typeof messages)[number] => Boolean(message));
}

function buildCandidateMessagesForChat(input: { chat: Awaited<ReturnType<typeof loadChatForInvestigation>>; inquiryTerms: Set<string> }) {
  const chat = input.chat;
  if (!chat) {
    return {
      candidateMessages: [] as CandidateModelMessage[],
      transcriptionCount: 0,
      informativeMessageCount: 0,
      informativeCharCount: 0,
      systemMessageCount: 0,
      ignoredMessageCount: 0,
      inquiryTermOverlapCount: 0
    };
  }

  const candidateMessages: CandidateModelMessage[] = [];
  let transcriptionCount = 0;
  let informativeMessageCount = 0;
  let informativeCharCount = 0;
  let systemMessageCount = 0;
  let ignoredMessageCount = 0;
  let inquiryTermOverlapCount = 0;
  let candidatePosition = 0;

  for (const message of chat.messages) {
    const sender = message.senderId ?? "interlocutor";
    const body = truncate(message.body ?? "", 800);
    if (body) {
      if (isLikelySystemMessage(body)) {
        systemMessageCount += 1;
      } else if (isInformativeText(body)) {
        const overlapCount = countOverlapTerms(body, input.inquiryTerms);
        informativeMessageCount += 1;
        informativeCharCount += body.length;
        inquiryTermOverlapCount += overlapCount;
        candidateMessages.push({
          sender,
          text: body,
          tokens: estimateTextTokens(body),
          overlapCount,
          isTranscription: false,
          position: candidatePosition
        });
        candidatePosition += 1;
      } else {
        ignoredMessageCount += 1;
      }
    }

    for (const attachment of message.attachments) {
      const transcription = attachment.transcriptions[0];
      if (!transcription?.text) continue;
      transcriptionCount += 1;
      const line = truncate(transcription.text, 800);
      if (isInformativeText(line)) {
        const overlapCount = countOverlapTerms(line, input.inquiryTerms);
        informativeMessageCount += 1;
        informativeCharCount += line.length;
        inquiryTermOverlapCount += overlapCount;
        const transcriptionText = `[transcricao-audio] ${line}`;
        candidateMessages.push({
          sender,
          text: transcriptionText,
          tokens: estimateTextTokens(transcriptionText),
          overlapCount,
          isTranscription: true,
          position: candidatePosition
        });
        candidatePosition += 1;
      } else {
        ignoredMessageCount += 1;
      }
    }
  }

  return {
    candidateMessages,
    transcriptionCount,
    informativeMessageCount,
    informativeCharCount,
    systemMessageCount,
    ignoredMessageCount,
    inquiryTermOverlapCount
  };
}

export async function getInvestigationChatModalPayload(input: {
  caseId: string;
  chatId: string;
  extractionId?: string;
  evidenceId?: string;
  triageInsightId?: string;
  relevantOnly?: boolean;
}) {
  const resolvedEvidenceId =
    input.evidenceId ?? (await resolveEvidenceIdFromExtraction({ caseId: input.caseId, extractionId: input.extractionId }));
  const chat = await loadChatForInvestigation({
    caseId: input.caseId,
    chatId: input.chatId,
    evidenceId: resolvedEvidenceId
  });
  if (!chat) {
    throw new Error("Chat nao encontrado para o caso informado.");
  }
  const assessment = await loadTriageAssessmentForChat({
    caseId: input.caseId,
    chatId: input.chatId,
    evidenceId: resolvedEvidenceId,
    triageInsightId: input.triageInsightId
  });
  const messages = input.relevantOnly
    ? selectRelevantMessagesWithContext(chat.messages, assessment)
    : chat.messages;

  return {
    chatId: chat.id,
    label: chat.title ?? chat.externalId ?? chat.id,
    sourceApp: chat.sourceApp ?? "OUTROS",
    participants: chat.participants,
    assessment: assessment
      ? {
          chatId: assessment.chatId,
          relevanceLevel: assessment.relevanceLevel,
          relevanceScore: assessment.relevanceScore,
          rationale: assessment.rationale,
          matchedTerms: assessment.matchedTerms,
          positiveSignals: assessment.positiveSignals,
          negativeSignals: assessment.negativeSignals,
          excerpt: assessment.excerpt
        }
      : undefined,
    relevantOnly: Boolean(input.relevantOnly),
    messages: messages.map((message) => ({
      id: message.id,
      senderId: message.senderId,
      direction: message.direction,
      body: message.body,
      timestamp: message.timestamp ? message.timestamp.toISOString() : null,
      createdAt: message.createdAt.toISOString(),
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        archivePath: attachment.archivePath,
        transcriptions: attachment.transcriptions.map((row) => row.text).filter((value): value is string => Boolean(value))
      })),
      transcriptions: message.attachments
        .flatMap((attachment) => attachment.transcriptions)
        .map((row) => row.text)
        .filter((value): value is string => Boolean(value))
    }))
  } as InvestigationChatModalPayload;
}

export async function reanalyzeInvestigativeChat(input: {
  caseId: string;
  extractionId?: string;
  evidenceId?: string;
  triageInsightId: string;
  chatId: string;
  analystContext: string;
  aiEngine?: "local" | "openai";
  analysisModel: string;
  openaiApiKey?: string;
  approve?: boolean;
}) {
  const normalizedAnalystContext = normalizeOptionalText(input.analystContext);
  if (!normalizedAnalystContext || normalizedAnalystContext.length < 8) {
    throw new Error("Contextualizacao do analista muito curta. Informe ao menos 8 caracteres.");
  }
  const resolvedEvidenceId =
    input.evidenceId ?? (await resolveEvidenceIdFromExtraction({ caseId: input.caseId, extractionId: input.extractionId }));

  const triageInsight = await prisma.aiInsight.findFirst({
    where: {
      id: input.triageInsightId,
      caseId: input.caseId,
      type: "INVESTIGATION_TRIAGE",
      ...(resolvedEvidenceId ? { evidenceId: resolvedEvidenceId } : {})
    }
  });
  if (!triageInsight) {
    throw new Error("Triagem investigativa nao encontrada.");
  }

  const metadata = (triageInsight.metadata as InvestigationTriagePayload | null) ?? null;
  if (!metadata?.assessments?.length) {
    throw new Error("Triagem sem assessments para reanalise.");
  }

  const previousAssessment = metadata.assessments.find((item) => item.chatId === input.chatId);
  if (!previousAssessment) {
    throw new Error("Chat nao encontrado na triagem selecionada.");
  }

  const chat = await loadChatForInvestigation({
    caseId: input.caseId,
    chatId: input.chatId,
    evidenceId: resolvedEvidenceId
  });
  if (!chat) {
    throw new Error("Chat nao encontrado no caso para reanalise.");
  }

  const provider = input.aiEngine ?? "openai";
  const model = input.analysisModel;
  const apiKey = provider === "openai" ? await resolveOpenAiApiKey(input.openaiApiKey) : undefined;
  const inquiryContextScoped = appendContextHintToInquiryContext(
    metadata.inquiryContext || "",
    `Contextualizacao especifica do analista para este chat: ${normalizedAnalystContext}`
  );
  const compactInquiryContext = buildCompactInquiryContext(inquiryContextScoped);
  const inquiryTerms = new Set(tokenizeTerms(compactInquiryContext).slice(0, 120));

  const prepared = buildCandidateMessagesForChat({ chat, inquiryTerms });
  const contentQuality = evaluateChatContentQuality({
    informativeMessageCount: prepared.informativeMessageCount,
    informativeCharCount: prepared.informativeCharCount,
    systemMessageCount: prepared.systemMessageCount,
    ignoredMessageCount: prepared.ignoredMessageCount,
    transcriptionCount: prepared.transcriptionCount,
    inquiryTermOverlapCount: prepared.inquiryTermOverlapCount
  });

  const messagesForModel = prepared.candidateMessages
    .sort((a, b) => a.position - b.position)
    .map((row) => ({ sender: row.sender, text: row.text }));
  const reanalysisStats = {
    totalChatMessages: chat.messages.length,
    candidateItems: prepared.candidateMessages.length,
    modelItems: messagesForModel.length,
    transcriptionCount: prepared.transcriptionCount
  };

  const baseAssessment = contentQuality.shouldSkipAi
    ? lowEvidenceAssessmentFallback(contentQuality)
    : provider === "openai" && apiKey
      ? await callOpenAiChatAssessment({
          apiKey,
          model,
          inquiryContext: compactInquiryContext,
          chatLabel: chat.title ?? chat.externalId ?? chat.id,
          sourceApp: chat.sourceApp ?? "OUTROS",
          messages: messagesForModel
        })
      : runLocalChatAssessment({
          inquiryContext: compactInquiryContext,
          chatLabel: chat.title ?? chat.externalId ?? chat.id,
          sourceApp: chat.sourceApp ?? "OUTROS",
          messages: messagesForModel
        });

  const guardedAssessment = applyAssessmentGuards(baseAssessment, contentQuality);
  const proposedAssessment: ChatAssessment = {
    chatId: chat.id,
    label: chat.title ?? chat.externalId ?? chat.id,
    sourceApp: chat.sourceApp ?? "OUTROS",
    messageCount: chat.messages.length,
    transcriptionCount: prepared.transcriptionCount,
    relevanceLevel: guardedAssessment.relevanceLevel,
    relevanceScore: guardedAssessment.relevanceScore,
    rationale: guardedAssessment.rationale,
    matchedTerms: guardedAssessment.matchedTerms,
    positiveSignals: guardedAssessment.positiveSignals,
    negativeSignals: guardedAssessment.negativeSignals,
    excerpt: guardedAssessment.excerpt
  };

  if (!input.approve) {
    return {
      approved: false,
      previousAssessment,
      proposedAssessment,
      reanalysisStats
    };
  }

  const nextAssessments = metadata.assessments
    .map((item) => (item.chatId === chat.id ? proposedAssessment : item))
    .sort((a, b) => b.relevanceScore - a.relevanceScore || a.label.localeCompare(b.label, "pt-BR"));
  const summaryData = normalizeAssessmentSummary(nextAssessments);

  const nextMetadata = {
    ...metadata,
    generatedAt: new Date().toISOString(),
    assessments: nextAssessments,
    reanalysis: {
      ...(typeof metadata === "object" && metadata ? (metadata as any).reanalysis : {}),
      lastUpdatedAt: new Date().toISOString(),
      lastUpdatedChatId: chat.id,
      lastAnalystContext: normalizedAnalystContext,
      provider,
      analysisModel: model
    }
  };

  await prisma.aiInsight.update({
    where: { id: triageInsight.id },
    data: {
      summary: summaryData.summary,
      score: summaryData.score,
      metadata: nextMetadata as Prisma.InputJsonValue
    }
  });

  return {
    approved: true,
    insightId: triageInsight.id,
    summary: summaryData.summary,
    previousAssessment,
    proposedAssessment,
    assessments: nextAssessments,
    reanalysisStats
  };
}

function formatSection(title: string, lines: string[]) {
  return [title, "", ...(lines.length > 0 ? lines : ["Sem itens."]), ""].join("\n");
}

function formatMessageTimestamp(value?: Date | null) {
  if (!value) return "sem horario";
  return value.toLocaleString("pt-BR", { hour12: false });
}

function resolveChatParticipantLabels(chat: NonNullable<Awaited<ReturnType<typeof loadChatForInvestigation>>>) {
  const labels = chat.participants
    .map((participant) => {
      const options = [participant.name, participant.handle, participant.phone, participant.email]
        .map((value) => (value ?? "").trim())
        .filter(Boolean);
      return options[0] ?? null;
    })
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set(labels)];
  return unique.length > 0 ? unique : ["interlocutor nao identificado"];
}

function buildSelectedChatEvidenceSection(input: {
  inquiryContext: string;
  assessments: ChatAssessment[];
  chats: Array<NonNullable<Awaited<ReturnType<typeof loadChatForInvestigation>>>>;
  introSummary: string;
  consideracoesFinais: string;
}) {
  if (input.assessments.length === 0) {
    return [
      "## 6. ANALISE DOS CHATS EXTRAIDOS (VERSAO COMPLETA E INTEGRAL)",
      "",
      input.introSummary,
      "",
      "### 6.1 CONSIDERACOES ANALITICAS FINAIS DOS CHATS",
      "",
      input.consideracoesFinais,
      ""
    ].join("\n");
  }

  const chatsById = new Map(input.chats.map((chat) => [chat.id, chat]));
  const lines: string[] = [
    "## 6. ANALISE DOS CHATS EXTRAIDOS (VERSAO COMPLETA E INTEGRAL)",
    "",
    input.introSummary,
    ""
  ];

  const inquiryTerms = new Set(tokenizeTerms(input.inquiryContext));

  input.assessments.forEach((assessment, index) => {
    const chat = chatsById.get(assessment.chatId);
    lines.push(`### 6.${index + 1} Chat ID: ${assessment.chatId}`);
    lines.push("");
    lines.push(`Interlocutores: ${chat ? resolveChatParticipantLabels(chat).join(" | ") : "nao disponiveis"}`);
    lines.push(
      `Analise sintetica: ${assessment.rationale} Relevancia ${assessment.relevanceLevel.toUpperCase()} (${assessment.relevanceScore}). Origem ${assessment.sourceApp}.`
    );

    if (!chat) {
      lines.push(`Trecho base: ${assessment.excerpt || "sem trecho disponivel."}`);
      lines.push("");
      return;
    }

    const matchedTerms = new Set(
      assessment.matchedTerms
        .map((term) => normalize(term))
        .filter((term) => term.length >= 4)
    );
    const excerptTokens = new Set(
      tokenizeTerms(assessment.excerpt || "")
        .map((term) => normalize(term))
        .filter((term) => term.length >= 4)
    );

    const evidenceCandidates: Array<{ score: number; timestamp: Date | null; sender: string; text: string }> = [];
    for (const message of chat.messages) {
      const sender = (message.senderId ?? "interlocutor").trim() || "interlocutor";
      const body = truncate(message.body ?? "", 300);
      const normalizedBody = normalize(body);
      if (body && !isLikelySystemMessage(body) && isInformativeText(body)) {
        let score = 0;
        for (const term of matchedTerms) {
          if (normalizedBody.includes(term)) score += 3;
        }
        for (const term of excerptTokens) {
          if (normalizedBody.includes(term)) score += 1;
        }
        const overlap = countOverlapTerms(body, inquiryTerms);
        score += overlap;
        if (score > 0) {
          evidenceCandidates.push({
            score,
            timestamp: message.timestamp,
            sender,
            text: body
          });
        }
      }

      const transcription = message.attachments
        .flatMap((attachment) => attachment.transcriptions)
        .find((row) => Boolean(row.text));
      if (!transcription?.text) continue;
      const transcriptionText = truncate(`[transcricao-audio] ${transcription.text}`, 300);
      const normalizedTranscription = normalize(transcriptionText);
      let transcriptionScore = 0;
      for (const term of matchedTerms) {
        if (normalizedTranscription.includes(term)) transcriptionScore += 3;
      }
      for (const term of excerptTokens) {
        if (normalizedTranscription.includes(term)) transcriptionScore += 1;
      }
      transcriptionScore += countOverlapTerms(transcriptionText, inquiryTerms);
      if (transcriptionScore > 0) {
        evidenceCandidates.push({
          score: transcriptionScore,
          timestamp: message.timestamp,
          sender,
          text: transcriptionText
        });
      }
    }

    const evidenceLines = evidenceCandidates
      .sort((a, b) => b.score - a.score || (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0))
      .slice(0, 5)
      .map((item, evidenceIndex) => {
        const when = formatMessageTimestamp(item.timestamp);
        return `${evidenceIndex + 1}. [${when}] ${item.sender}: ${item.text}`;
      });

    if (evidenceLines.length > 0) {
      lines.push("Transcricoes/Trechos relevantes:");
      lines.push(...evidenceLines);
    } else if (assessment.excerpt) {
      lines.push("Transcricoes/Trechos relevantes:");
      lines.push(`1. ${assessment.excerpt}`);
    } else {
      lines.push("Transcricoes/Trechos relevantes:");
      lines.push("1. Sem trecho objetivo identificado automaticamente.");
    }

    lines.push("");
  });

  lines.push(`### 6.${input.assessments.length + 1} CONSIDERACOES ANALITICAS FINAIS DOS CHATS`);
  lines.push("");
  lines.push(input.consideracoesFinais);
  lines.push("");

  return lines.join("\n");
}

function readSelectedAttachmentIdsFromAudioSelection(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>).selectedAttachmentIds;
  return [...new Set(toStringArray(raw))];
}

function readInsightTags(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return toStringArray((metadata as Record<string, unknown>).tags);
}

function buildUnlinkedAudioEvidenceSection(input: {
  selectedAttachmentIds: string[];
  audios: Array<{
    id: string;
    fileName: string | null;
    archivePath: string | null;
    transcriptions: Array<{
      id: string;
      text: string | null;
      engine: string;
      createdAt: Date;
      finishedAt: Date | null;
    }>;
  }>;
  insightByTranscriptionId: Map<
    string,
    {
      title: string;
      summary: string;
      score: number | null;
      metadata: Prisma.JsonValue | null;
    }
  >;
}) {
  const lines: string[] = [
    "## 7. AUDIOS SEM VINCULO COM CHAT SELECIONADOS PARA ANALISE",
    "",
    "Esta secao consolida audios .opus sem vinculacao com chat que foram selecionados pelo analista para constar no relatorio final.",
    ""
  ];

  if (input.selectedAttachmentIds.length === 0) {
    lines.push("Nenhum audio sem vinculo com chat foi selecionado para este relatorio.");
    lines.push("");
    return lines.join("\n");
  }

  const audioById = new Map(input.audios.map((audio) => [audio.id, audio]));
  input.selectedAttachmentIds.forEach((attachmentId, index) => {
    const audio = audioById.get(attachmentId);
    const label = audio?.fileName?.trim() || audio?.archivePath?.split(/[\\/]/).pop() || attachmentId;
    const transcription = audio?.transcriptions.find((item) => item.text?.trim());
    const insight = transcription ? input.insightByTranscriptionId.get(transcription.id) : undefined;
    const tags = readInsightTags(insight?.metadata);

    lines.push(`### 7.${index + 1} Audio selecionado: ${label}`);
    lines.push("");
    lines.push(`- Attachment ID: ${attachmentId}`);
    if (audio?.archivePath) lines.push(`- Caminho no arquivo: ${audio.archivePath}`);
    if (transcription) {
      lines.push(`- Transcricao: ${transcription.engine}${transcription.finishedAt ? ` em ${formatMessageTimestamp(transcription.finishedAt)}` : ""}`);
    } else {
      lines.push("- Transcricao: nao localizada ou nao concluida.");
    }
    if (insight) {
      lines.push(`- Analise automatica da IA: ${insight.title}`);
      lines.push(`- Score IA: ${typeof insight.score === "number" ? insight.score.toFixed(2) : "N/D"}`);
      if (tags.length > 0) lines.push(`- Sinais classificados: ${tags.join(", ")}`);
    } else {
      lines.push("- Analise automatica da IA: nao localizada.");
    }
    lines.push("");
    lines.push("Transcricao integral:");
    lines.push("");
    lines.push(transcription?.text?.trim() ? truncate(transcription.text, 1800) : "Sem texto de transcricao disponivel.");
    if (insight?.summary?.trim()) {
      lines.push("");
      lines.push("Resumo/trecho classificado pela IA:");
      lines.push("");
      lines.push(truncate(insight.summary, 900));
    }
    lines.push("");
  });

  return lines.join("\n");
}

async function callOpenAiReportConsolidation(input: {
  apiKey: string;
  model: string;
  inquiryContext: string;
  assessments: ChatAssessment[];
  correlations: ChatCorrelation[];
  reportMeta: {
    caseNumber?: string | null;
    inquiryType?: string | null;
    inquiryNumber?: string | null;
    policeUnit?: string | null;
    totalEvidences: number;
    totalDevices: number;
    totalChats: number;
    totalMessages: number;
    totalTranscriptions: number;
    totalCustodyHashes: number;
    extractionStatus?: string | null;
    evidenceFileName?: string | null;
    evidenceSha256?: string | null;
    locationsDetected: number;
    sourceAppChatCounts: Array<{ sourceApp: string; chats: number }>;
  };
}) {
  const compactPayload = buildReportRequestPayload({
    inquiryContext: input.inquiryContext,
    assessments: input.assessments,
    correlations: input.correlations,
    reportMeta: input.reportMeta
  });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Voce e analista investigativo. Produza APENAS JSON valido conforme schema, sem markdown. Linguagem tecnica, objetiva e sem inventar fatos."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(compactPayload)
            }
          ]
        }
      ]
      ,
      text: {
        format: {
          type: "json_schema",
          name: "investigative_report_sections_v3",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              identificacao: { type: "string" },
              contextoFatico: { type: "string" },
              contasRedesSociais: { type: "string" },
              localizacoesExtraidas: { type: "string" },
              consideracoesFinaisChats: { type: "string" },
              conclusaoTecnica: { type: "string" }
            },
            required: [
              "identificacao",
              "contextoFatico",
              "contasRedesSociais",
              "localizacoesExtraidas",
              "consideracoesFinaisChats",
              "conclusaoTecnica"
            ]
          }
        }
      }
    })
  });

  const raw = await response.text();
  let parsedRaw: any = null;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    parsedRaw = null;
  }

  if (!response.ok) {
    const message = parsedRaw?.error?.message ?? raw ?? `OpenAI error ${response.status}`;
    throw new Error(message);
  }

  const outputText =
    parsedRaw?.output_text ??
    parsedRaw?.output?.[0]?.content?.find((item: any) => item?.type === "output_text")?.text ??
    "";

  if (!outputText || !outputText.trim()) {
    throw new Error("OpenAI nao retornou secoes estruturadas do relatorio.");
  }

  let parsedSections: ReportNarrativeSections;
  try {
    parsedSections = JSON.parse(outputText) as ReportNarrativeSections;
  } catch {
    throw new Error("OpenAI retornou resposta fora do JSON esperado para secoes do relatorio.");
  }

  return parsedSections;
}

async function callOpenAiCaseContextFromPdf(input: {
  apiKey: string;
  model: string;
  caseContext: string;
  pdfText: string;
}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Extraia e consolide contexto de inquerito a partir de PDF. Responda APENAS JSON valido no schema."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                caseContext: input.caseContext,
                pdfText: input.pdfText
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "case_context_pdf_enrichment",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              caseNumber: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              inquiryType: { type: "string" },
              inquiryNumber: { type: "string" },
              policeUnit: { type: "string" },
              inquirySummary: { type: "string" },
              inquiryMainFacts: { type: "string" },
              inquiryInvestigativeFocus: { type: "string" },
              extractionSummary: { type: "string" },
              involvedPeople: { type: "array", items: { type: "string" } },
              involvedPeopleCategorized: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    category: { type: "string", enum: ["SUSPECT", "VICTIM", "WITNESS", "OTHER"] },
                    reason: { type: "string" },
                    evidenceExcerpt: { type: "string" },
                    sourceReference: { type: "string" },
                    confidence: { type: "string", enum: ["AUTO_EXTRACTED", "REVIEW_RECOMMENDED"] }
                  },
                  required: [
                    "name",
                    "category",
                    "reason",
                    "evidenceExcerpt",
                    "sourceReference",
                    "confidence"
                  ]
                }
              },
              legalFraming: { type: "string" }
            },
            required: [
              "caseNumber",
              "title",
              "description",
              "inquiryType",
              "inquiryNumber",
              "policeUnit",
              "inquirySummary",
              "inquiryMainFacts",
              "inquiryInvestigativeFocus",
              "extractionSummary",
              "involvedPeople",
              "involvedPeopleCategorized",
              "legalFraming"
            ]
          }
        }
      }
    })
  });

  const raw = await response.text();
  let parsedRaw: any = null;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    parsedRaw = null;
  }

  if (!response.ok) {
    const message = parsedRaw?.error?.message ?? raw ?? `OpenAI error ${response.status}`;
    throw new Error(message);
  }

  const outputText =
    parsedRaw?.output_text ??
    parsedRaw?.output?.[0]?.content?.find((item: any) => item?.type === "output_text")?.text ??
    "";

  if (!outputText) {
    throw new Error("OpenAI nao retornou dados para enriquecimento de caso via PDF.");
  }

  return JSON.parse(outputText) as CaseContextFromPdfResult;
}

function normalizeInvolvedPeopleCategorized(
  value: unknown,
  fallbackNames: string[],
  sourceDocument?: { documentId?: string; fileName?: string }
) {
  const rows: Array<{
    name: string;
    category: "SUSPECT" | "VICTIM" | "WITNESS" | "OTHER";
    reason: string;
    evidenceExcerpt: string;
    sourceReference: string;
    confidence: "AUTO_EXTRACTED" | "REVIEW_RECOMMENDED";
    sourceDocuments: Array<{ documentId?: string; fileName: string }>;
  }> = [];
  const seen = new Set<string>();
  const pushRow = (row: {
    name: string;
    category: "SUSPECT" | "VICTIM" | "WITNESS" | "OTHER";
    reason: string;
    evidenceExcerpt: string;
    sourceReference: string;
    confidence: "AUTO_EXTRACTED" | "REVIEW_RECOMMENDED";
  }) => {
    const key = `${row.name}|${row.category}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      ...row,
      sourceDocuments:
        sourceDocument?.fileName
          ? [
              {
                documentId: sourceDocument.documentId,
                fileName: sourceDocument.fileName
              }
            ]
          : []
    });
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!name) continue;
      const categoryRaw = typeof row.category === "string" ? row.category.toUpperCase() : "OTHER";
      const category =
        categoryRaw === "SUSPECT" || categoryRaw === "VICTIM" || categoryRaw === "WITNESS" || categoryRaw === "OTHER"
          ? (categoryRaw as "SUSPECT" | "VICTIM" | "WITNESS" | "OTHER")
          : "OTHER";
      const confidenceRaw = typeof row.confidence === "string" ? row.confidence.toUpperCase() : "REVIEW_RECOMMENDED";
      const confidence = confidenceRaw === "AUTO_EXTRACTED" ? "AUTO_EXTRACTED" : "REVIEW_RECOMMENDED";
      pushRow({
        name,
        category,
        reason:
          typeof row.reason === "string" && row.reason.trim().length > 0
            ? row.reason.trim()
            : "Classificação gerada a partir do contexto do documento.",
        evidenceExcerpt:
          typeof row.evidenceExcerpt === "string" && row.evidenceExcerpt.trim().length > 0
            ? row.evidenceExcerpt.trim()
            : "",
        sourceReference:
          typeof row.sourceReference === "string" && row.sourceReference.trim().length > 0
            ? row.sourceReference.trim()
            : sourceDocument?.fileName ?? "Documento de inquérito",
        confidence
      });
    }
  }

  if (rows.length === 0) {
    for (const raw of fallbackNames) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) continue;
      pushRow({
        name,
        category: "OTHER",
        reason: "Citado no documento, sem marcador categórico explícito.",
        evidenceExcerpt: "",
        sourceReference: sourceDocument?.fileName ?? "Documento de inquérito",
        confidence: "REVIEW_RECOMMENDED"
      });
    }
  }

  return rows;
}

export async function extractCaseContextFromPdfText(input: {
  currentCaseContext?: string;
  model: string;
  openaiApiKey?: string;
  pdfText: string;
}) {
  const apiKey = await resolveOpenAiApiKey(input.openaiApiKey);
  return callOpenAiCaseContextFromPdf({
    apiKey,
    model: input.model,
    caseContext: input.currentCaseContext ?? "",
    pdfText: compressPdfTextForContextExtraction(input.pdfText)
  });
}

function deriveCaseTitleFromIdentifiers(input: {
  caseNumber?: string | null;
  inquiryNumber?: string | null;
  inquiryType?: string | null;
  fallbackTitle?: string | null;
}) {
  const normalize = (value?: string | null) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
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

  return fallbackTitle;
}

export async function enrichCaseContextFromPdf(input: {
  caseId: string;
  evidenceId?: string;
  model: string;
  openaiApiKey?: string;
  pdfText: string;
  overwriteExisting?: boolean;
  source?: string;
  sourceDocument?: { documentId?: string; fileName?: string };
}) {
  const apiKey = await resolveOpenAiApiKey(input.openaiApiKey);
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) {
    throw new Error("Caso nao encontrado.");
  }

  const currentContext = buildInquiryContext({
    title: caseRow.title,
    description: caseRow.description,
    inquiryType: caseRow.inquiryType,
    inquiryNumber: caseRow.inquiryNumber,
    policeUnit: caseRow.policeUnit,
    inquiryLegalFraming: caseRow.inquiryLegalFraming,
    inquirySummaryText: caseRow.inquirySummaryText,
    inquiryMainFacts: caseRow.inquiryMainFacts,
    inquiryInvestigativeFocus: caseRow.inquiryInvestigativeFocus,
    extractionReportSummary: caseRow.extractionReportSummary
  });

  const parsed = await extractCaseContextFromPdfText({
    currentCaseContext: currentContext,
    model: input.model,
    openaiApiKey: apiKey,
    pdfText: input.pdfText
  });

  const overwrite = input.overwriteExisting === true;
  const keepOrReplace = (current: string | null | undefined, incoming: string): string | null | undefined => {
    const normalizedIncoming = incoming.trim();
    if (!normalizedIncoming) return current ?? null;
    if (overwrite) return normalizedIncoming;
    return current && current.trim().length > 0 ? current : normalizedIncoming;
  };
  const parsedTitle = deriveCaseTitleFromIdentifiers({
    caseNumber: parsed.caseNumber,
    inquiryNumber: parsed.inquiryNumber,
    inquiryType: parsed.inquiryType,
    fallbackTitle: parsed.title
  });
  const parsedInvolvedCategorized = normalizeInvolvedPeopleCategorized(
    parsed.involvedPeopleCategorized,
    parsed.involvedPeople,
    input.sourceDocument
  );
  const parsedInvolvedPayload: Prisma.InputJsonValue = {
    involvedPeopleCategorized: parsedInvolvedCategorized,
    people: parsedInvolvedCategorized.map((item) => item.name)
  } as Prisma.InputJsonValue;
  const currentInvolvedHasData =
    Array.isArray(caseRow.inquiryInvolvedPeople)
      ? caseRow.inquiryInvolvedPeople.length > 0
      : !!(caseRow.inquiryInvolvedPeople && typeof caseRow.inquiryInvolvedPeople === "object");

  const updated = await prisma.case.update({
    where: { id: input.caseId },
    data: {
      title: keepOrReplace(caseRow.title, parsedTitle) ?? caseRow.title,
      description: keepOrReplace(caseRow.description, parsed.description),
      inquiryType: keepOrReplace(caseRow.inquiryType, parsed.inquiryType),
      inquiryNumber: keepOrReplace(caseRow.inquiryNumber, parsed.inquiryNumber),
      policeUnit: keepOrReplace(caseRow.policeUnit, parsed.policeUnit),
      inquiryLegalFraming: keepOrReplace(caseRow.inquiryLegalFraming, parsed.legalFraming),
      inquirySummaryText: keepOrReplace(caseRow.inquirySummaryText, parsed.inquirySummary),
      inquiryMainFacts: keepOrReplace(caseRow.inquiryMainFacts, parsed.inquiryMainFacts),
      inquiryInvestigativeFocus: keepOrReplace(caseRow.inquiryInvestigativeFocus, parsed.inquiryInvestigativeFocus),
      extractionReportSummary: keepOrReplace(caseRow.extractionReportSummary, parsed.extractionSummary),
      inquiryInvolvedPeople:
        overwrite || !currentInvolvedHasData
          ? parsedInvolvedPayload
          : (caseRow.inquiryInvolvedPeople ?? Prisma.JsonNull)
    }
  });

  const insight = await prisma.aiInsight.create({
    data: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "CASE_CONTEXT_PDF",
      title: `Contextualizacao por PDF (${new Date().toLocaleString("pt-BR")})`,
      summary: parsed.inquirySummary || "Contextualizacao de caso atualizada por PDF.",
      metadata: {
        source: input.source ?? "case-pdf-enrichment",
        model: input.model,
        overwrite,
        parsed
      } as Prisma.InputJsonValue
    }
  });

  return {
    caseId: updated.id,
    insightId: insight.id,
    updatedFields: {
      title: updated.title,
      inquiryType: updated.inquiryType,
      inquiryNumber: updated.inquiryNumber,
      policeUnit: updated.policeUnit,
      inquirySummaryText: updated.inquirySummaryText,
      inquiryMainFacts: updated.inquiryMainFacts,
      inquiryInvestigativeFocus: updated.inquiryInvestigativeFocus,
      extractionReportSummary: updated.extractionReportSummary,
      inquiryLegalFraming: updated.inquiryLegalFraming,
      inquiryInvolvedPeople: updated.inquiryInvolvedPeople
    }
  };
}

export async function generateInvestigativeReport(input: {
  caseId: string;
  evidenceId?: string;
  triageInsightId?: string;
  selectedChatIds?: string[];
  contextHint?: string;
  authorId?: string;
  aiEngine?: "local" | "openai";
  reportModel: string;
  openaiApiKey?: string;
  onProgress?: ProgressCallback;
}) {
  const aiEngine = input.aiEngine ?? "openai";
  const apiKey = aiEngine === "openai" ? await resolveOpenAiApiKey(input.openaiApiKey) : undefined;
  const normalizedContextHint = normalizeOptionalText(input.contextHint);
  let triage: InvestigationTriagePayload | null = null;
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    select: {
      caseNumber: true,
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

  if (!caseRow) {
    throw new Error("Caso nao encontrado.");
  }

  if (input.triageInsightId) {
    const insight = await prisma.aiInsight.findFirst({
      where: { id: input.triageInsightId, caseId: input.caseId, type: "INVESTIGATION_TRIAGE" }
    });
    triage = (insight?.metadata as InvestigationTriagePayload | null) ?? null;
  }

  if (!triage) {
    const latest = await getLatestCaseInvestigativeTriage({ caseId: input.caseId, evidenceId: input.evidenceId });
    triage = latest?.payload ?? null;
  }

  if (!triage) {
    throw new Error("Nao existe triagem investigativa para gerar relatorio.");
  }
  if (!hasCaseInquiryContext(caseRow) && !hasMeaningfulText(normalizedContextHint, MIN_CONTEXT_HINT_LENGTH)) {
    throw new Error(
      "Contextualizacao obrigatoria: anexe o PDF do inquerito (ou contextualize o caso) ou informe um resumo manual com pelo menos 20 caracteres do que procurar."
    );
  }
  const inquiryContext = appendContextHintToInquiryContext(triage.inquiryContext || "", normalizedContextHint ?? undefined);

  if (input.onProgress) await input.onProgress(20);

  const selectedSet = new Set((input.selectedChatIds ?? []).filter(Boolean));
  const selected = selectedSet.size
    ? triage.assessments.filter((item) => selectedSet.has(item.chatId))
    : triage.assessments
        .filter((item) => item.relevanceLevel === "alta" || item.relevanceLevel === "media")
        .slice(0, REPORT_MAX_ASSESSMENTS);

  const relevantCorrelations = triage.correlations
    .filter((item) => selected.some((row) => row.chatId === item.sourceChatId || row.chatId === item.targetChatId))
    .slice(0, REPORT_MAX_CORRELATIONS);

  const latestUnlinkedAudioSelection = await prisma.aiInsight.findFirst({
    where: {
      caseId: input.caseId,
      type: "AUDIO_UNLINKED_SELECTION",
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true }
  });
  const selectedUnlinkedAudioIds = readSelectedAttachmentIdsFromAudioSelection(latestUnlinkedAudioSelection?.metadata);

  const reportSignature = buildReportReuseSignature({
    caseId: input.caseId,
    evidenceId: input.evidenceId,
    provider: aiEngine,
    reportModel: input.reportModel,
    triageGeneratedAt: triage.generatedAt,
    selectedChatIds: selected.map((item) => item.chatId),
    selectedUnlinkedAudioIds,
    contextHint: normalizedContextHint
  });

  const recentReports = await prisma.generatedReport.findMany({
    where: {
      caseId: input.caseId,
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: {
      id: true,
      title: true,
      content: true,
      metadata: true,
      createdAt: true,
      caseId: true,
      evidenceId: true,
      authorId: true,
      format: true
    }
  });

  const reusable = recentReports.find((item) => {
    const metadata = item.metadata as Record<string, unknown> | null;
    return metadata?.module === "investigation" && metadata?.reportSignature === reportSignature;
  });

  if (reusable) {
    if (input.onProgress) await input.onProgress(100);
    return reusable;
  }

  if (input.onProgress) await input.onProgress(55);

  const selectedChatsRaw = await Promise.all(
    selected.slice(0, 40).map((item) => loadChatForInvestigation({ caseId: input.caseId, chatId: item.chatId }))
  );
  const selectedChats = selectedChatsRaw.filter((chat): chat is NonNullable<typeof chat> => Boolean(chat));

  const selectedUnlinkedAudios =
    selectedUnlinkedAudioIds.length > 0
      ? await prisma.attachment.findMany({
          where: {
            id: { in: selectedUnlinkedAudioIds },
            caseId: input.caseId,
            ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
            messageId: null,
            OR: [
              { fileName: { endsWith: ".opus", mode: "insensitive" } },
              { archivePath: { endsWith: ".opus", mode: "insensitive" } }
            ]
          },
          select: {
            id: true,
            fileName: true,
            archivePath: true,
            transcriptions: {
              where: {
                status: "COMPLETED",
                text: { not: null }
              },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: {
                id: true,
                text: true,
                engine: true,
                createdAt: true,
                finishedAt: true
              }
            }
          }
        })
      : [];

  const selectedUnlinkedTranscriptionIds = selectedUnlinkedAudios.flatMap((audio) =>
    audio.transcriptions.map((transcription) => transcription.id)
  );
  const unlinkedAudioInsights =
    selectedUnlinkedTranscriptionIds.length > 0
      ? await prisma.aiInsight.findMany({
          where: {
            type: "TRANSCRIPTION",
            OR: selectedUnlinkedTranscriptionIds.map((id) => ({
              metadata: {
                path: ["sourceId"],
                equals: id
              }
            }))
          },
          orderBy: { createdAt: "desc" },
          take: selectedUnlinkedTranscriptionIds.length * 3,
          select: {
            title: true,
            summary: true,
            score: true,
            metadata: true
          }
        })
      : [];
  const unlinkedAudioInsightByTranscriptionId = new Map<string, (typeof unlinkedAudioInsights)[number]>();
  for (const insight of unlinkedAudioInsights) {
    const metadata = insight.metadata && typeof insight.metadata === "object" && !Array.isArray(insight.metadata)
      ? (insight.metadata as Record<string, unknown>)
      : {};
    const sourceId = metadata.sourceId;
    if (typeof sourceId === "string" && !unlinkedAudioInsightByTranscriptionId.has(sourceId)) {
      unlinkedAudioInsightByTranscriptionId.set(sourceId, insight);
    }
  }

  const [
    totalEvidences,
    totalDevices,
    totalChats,
    totalMessages,
    totalTranscriptions,
    totalCustodyHashes,
    totalLocations,
    sourceAppGroup
  ] = await Promise.all([
    prisma.evidence.count({ where: { caseId: input.caseId, ...(input.evidenceId ? { id: input.evidenceId } : {}) } }),
    prisma.device.count({
      where: {
        extraction: {
          caseId: input.caseId,
          ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
        }
      }
    }),
    prisma.chat.count({ where: { caseId: input.caseId, ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}) } }),
    prisma.message.count({ where: { caseId: input.caseId, ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}) } }),
    prisma.audioTranscription.count({
      where: {
        caseId: input.caseId,
        ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
        status: "COMPLETED"
      }
    }),
    prisma.custodyEvent.count({
      where: {
        caseId: input.caseId,
        ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
        currentHash: { not: null }
      }
    }),
    prisma.artifact.count({
      where: {
        caseId: input.caseId,
        ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
        type: "LOCATION"
      }
    }),
    prisma.chat.groupBy({
      by: ["sourceApp"],
      where: { caseId: input.caseId, ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}) },
      _count: { _all: true }
    })
  ]);

  const extractionRow = await prisma.extraction.findFirst({
    where: {
      caseId: input.caseId,
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
    },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      evidence: {
        select: {
          fileName: true,
          sha256: true
        }
      }
    }
  });

  const reportMeta = {
    caseNumber: caseRow.caseNumber ?? null,
    inquiryType: caseRow.inquiryType ?? null,
    inquiryNumber: caseRow.inquiryNumber ?? null,
    policeUnit: caseRow.policeUnit ?? null,
    totalEvidences,
    totalDevices,
    totalChats,
    totalMessages,
    totalTranscriptions,
    totalCustodyHashes,
    extractionStatus: extractionRow?.status ?? null,
    evidenceFileName: extractionRow?.evidence?.fileName ?? null,
    evidenceSha256: extractionRow?.evidence?.sha256 ?? null,
    locationsDetected: totalLocations,
    sourceAppChatCounts: sourceAppGroup
      .map((row) => ({ sourceApp: row.sourceApp ?? "Desconhecido", chats: row._count._all }))
      .sort((a, b) => b.chats - a.chats)
      .slice(0, 8)
  };

  const narrativeSections =
    aiEngine === "openai" && apiKey
      ? await callOpenAiReportConsolidation({
          apiKey,
          model: input.reportModel,
          inquiryContext,
          assessments: selected,
          correlations: relevantCorrelations,
          reportMeta
        })
      : {
          identificacao:
            "Relatorio tecnico consolidado a partir de triagem investigativa, com foco em rastreabilidade de evidencias digitais e coerencia com o contexto do inquerito.",
          contextoFatico: compactParagraph(
            inquiryContext,
            "Contexto do caso indisponivel para consolidacao local. Recomenda-se validacao manual."
          ),
          contasRedesSociais:
            "Consolidacao local: revisar manualmente contas, aliases e vinculacoes entre perfis, priorizando dados de identificadores recorrentes.",
          localizacoesExtraidas:
            totalLocations > 0
              ? `Foram detectados ${totalLocations} registros de localizacao associados ao recorte analisado.`
              : "Nao foram identificados registros de localizacao no recorte analisado.",
          consideracoesFinaisChats:
            "A avaliacao local indica priorizacao por relevancia textual e contexto investigativo. Recomenda-se validacao humana dos trechos criticos.",
          conclusaoTecnica:
            "Relatorio consolidado em modo local heuristico. Recomenda-se revisao final por analista antes da emissao oficial."
        };

  if (input.onProgress) await input.onProgress(85);

  const chatIntroSummary = `Foram consolidados ${selected.length} chats selecionados para suporte investigativo, extraidos de um universo de ${totalMessages} mensagens e ${totalTranscriptions} transcricoes de audio vinculadas ao recorte analisado.`;
  const selectedChatEvidenceSection = buildSelectedChatEvidenceSection({
    inquiryContext,
    assessments: selected,
    chats: selectedChats,
    introSummary: chatIntroSummary,
    consideracoesFinais: narrativeSections.consideracoesFinaisChats
  });
  const unlinkedAudioSection = buildUnlinkedAudioEvidenceSection({
    selectedAttachmentIds: selectedUnlinkedAudioIds,
    audios: selectedUnlinkedAudios,
    insightByTranscriptionId: unlinkedAudioInsightByTranscriptionId
  });

  const content = buildInvestigativeReportContent({
    caseNumber: caseRow.caseNumber,
    inquiryType: caseRow.inquiryType,
    inquiryNumber: caseRow.inquiryNumber,
    policeUnit: caseRow.policeUnit,
    narrative: narrativeSections,
    technical: {
      totalEvidences,
      totalDevices,
      totalMessages,
      totalTranscriptions,
      totalCustodyHashes,
      extractionStatus: extractionRow?.status,
      evidenceFileName: extractionRow?.evidence?.fileName,
      evidenceSha256: extractionRow?.evidence?.sha256
    },
    chatsSection: selectedChatEvidenceSection,
    unlinkedAudioSection
  });

  const report = await prisma.generatedReport.create({
    data: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      authorId: input.authorId,
      format: "MARKDOWN",
      title: sanitizeTextForDatabase(`Relatorio Investigativo - ${new Date().toLocaleString("pt-BR")}`),
      content: sanitizeTextForDatabase(content),
      metadata: sanitizeJsonForDatabase({
        module: "investigation",
        provider: aiEngine,
        reportModel: input.reportModel,
        triageGeneratedAt: triage.generatedAt,
        triageInsightId: input.triageInsightId ?? null,
        selectedChatIds: selected.map((item) => item.chatId),
        selectedUnlinkedAudioIds,
        contextHint: normalizedContextHint,
        reportSignature,
        workflow: {
          status: "DRAFT",
          updatedAt: new Date().toISOString(),
          updatedById: input.authorId ?? null,
          history: [
            {
              action: "CREATE",
              from: null,
              to: "DRAFT",
              at: new Date().toISOString(),
              byId: input.authorId ?? null
            }
          ]
        }
      }) as Prisma.InputJsonValue
    }
  });

  await prisma.aiInsight.create({
    data: {
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      type: "INVESTIGATION_REPORT",
      title: report.title,
      summary: `Relatorio consolidado com ${selected.length} chats (${aiEngine === "openai" ? "OpenAI" : "local"}).`,
      score: selected.length,
      metadata: {
        reportId: report.id,
        provider: aiEngine,
        reportModel: input.reportModel,
        selectedChatIds: selected.map((item) => item.chatId),
        selectedUnlinkedAudioIds
      } as Prisma.InputJsonValue
    }
  });

  if (input.onProgress) await input.onProgress(100);
  return report;
}

export async function registerInvestigationSelectedMessagePhones(input: {
  caseId: string;
  evidenceId?: string;
  triageInsightId?: string;
  selectedChatIds?: string[];
  relevantOnly?: boolean;
}) {
  const triageInsight = input.triageInsightId
    ? await prisma.aiInsight.findFirst({
        where: {
          id: input.triageInsightId,
          caseId: input.caseId,
          type: "INVESTIGATION_TRIAGE",
          ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
        }
      })
    : await (async () => {
        const latest = await getLatestCaseInvestigativeTriage({ caseId: input.caseId, evidenceId: input.evidenceId });
        if (!latest?.insightId) return null;
        return prisma.aiInsight.findFirst({
          where: {
            id: latest.insightId,
            caseId: input.caseId,
            type: "INVESTIGATION_TRIAGE",
            ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
          }
        });
      })();

  if (!triageInsight) {
    throw new Error("Triagem investigativa nao encontrada para registrar telefones.");
  }

  const selectedChatIds = resolveSelectedChatIdsFromTriageMetadata({
    payloadSelectedChatIds: input.selectedChatIds,
    triageMetadata: triageInsight.metadata
  });

  if (selectedChatIds.length === 0) {
    return {
      triageInsightId: triageInsight.id,
      selectedChats: 0,
      selectedMessages: 0,
      phonesFound: 0,
      phoneEntitiesUpserted: 0,
      relationEntitiesCreated: 0,
      phones: [] as string[]
    };
  }

  const chats = await prisma.chat.findMany({
    where: {
      caseId: input.caseId,
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
      id: { in: selectedChatIds }
    },
    include: {
      participants: {
        select: { id: true, phone: true, handle: true }
      },
      messages: {
        orderBy: [{ timestamp: "asc" }, { createdAt: "asc" }],
        include: {
          attachments: {
            include: {
              transcriptions: {
                where: { status: "COMPLETED" },
                orderBy: { createdAt: "desc" },
                take: 2
              }
            }
          }
        },
        take: 1200
      }
    }
  });

  const assessmentIndex = getChatAssessmentIndex(triageInsight.metadata);
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const orderedChats = selectedChatIds.map((chatId) => chatById.get(chatId)).filter((chat): chat is NonNullable<typeof chat> => Boolean(chat));
  const nowIso = new Date().toISOString();

  const phoneAggregate = new Map<
    string,
    {
      rawSamples: Set<string>;
      evidenceIds: Set<string>;
      chatIds: Set<string>;
      messageIds: Set<string>;
      participantIds: Set<string>;
      sourceCounts: Record<string, number>;
      relationRows: Array<{ value: string; metadata: Record<string, unknown> }>;
    }
  >();
  const relationValueSet = new Set<string>();

  const addPhoneOccurrence = (entry: {
    normalizedPhone: string;
    rawPhone: string;
    evidenceId: string;
    chatId: string;
    source: "participant-phone" | "participant-handle" | "sender-id" | "message-body" | "transcription";
    messageId?: string;
    participantId?: string;
    attachmentId?: string;
  }) => {
    const aggregate =
      phoneAggregate.get(entry.normalizedPhone) ?? {
        rawSamples: new Set<string>(),
        evidenceIds: new Set<string>(),
        chatIds: new Set<string>(),
        messageIds: new Set<string>(),
        participantIds: new Set<string>(),
        sourceCounts: {},
        relationRows: [] as Array<{ value: string; metadata: Record<string, unknown> }>
      };

    aggregate.rawSamples.add(entry.rawPhone);
    aggregate.evidenceIds.add(entry.evidenceId);
    aggregate.chatIds.add(entry.chatId);
    if (entry.messageId) aggregate.messageIds.add(entry.messageId);
    if (entry.participantId) aggregate.participantIds.add(entry.participantId);
    aggregate.sourceCounts[entry.source] = (aggregate.sourceCounts[entry.source] ?? 0) + 1;

    const relationDiscriminator =
      entry.source === "participant-phone" || entry.source === "participant-handle"
        ? `participant:${entry.participantId ?? "unknown"}`
        : entry.source === "sender-id" || entry.source === "message-body"
          ? `message:${entry.messageId ?? "unknown"}`
          : `attachment:${entry.attachmentId ?? "unknown"}`;

    const relationValue = `${entry.normalizedPhone}|${entry.source}|${relationDiscriminator}`;
    if (!relationValueSet.has(relationValue)) {
      relationValueSet.add(relationValue);
      aggregate.relationRows.push({
        value: relationValue,
        metadata: {
          module: "investigation-phone-registry",
          normalizedPhone: entry.normalizedPhone,
          rawPhone: entry.rawPhone,
          source: entry.source,
          caseId: input.caseId,
          evidenceId: entry.evidenceId,
          chatId: entry.chatId,
          messageId: entry.messageId ?? null,
          participantId: entry.participantId ?? null,
          attachmentId: entry.attachmentId ?? null,
          triageInsightId: triageInsight.id,
          relevantOnly: Boolean(input.relevantOnly),
          registeredAt: nowIso
        }
      });
    }

    phoneAggregate.set(entry.normalizedPhone, aggregate);
  };

  let selectedMessageCount = 0;

  for (const chat of orderedChats) {
    for (const participant of chat.participants) {
      const participantCandidates = [
        { raw: participant.phone ?? "", source: "participant-phone" as const },
        { raw: participant.handle ?? "", source: "participant-handle" as const }
      ];

      for (const candidate of participantCandidates) {
        if (!candidate.raw || !candidate.raw.trim()) continue;
        const normalizedPhone = normalizePhoneForRegistry(candidate.raw);
        if (!normalizedPhone) continue;
        addPhoneOccurrence({
          normalizedPhone,
          rawPhone: candidate.raw,
          evidenceId: chat.evidenceId,
          chatId: chat.id,
          source: candidate.source,
          participantId: participant.id
        });
      }
    }

    const assessment = assessmentIndex.get(chat.id);
    const selectedMessages = input.relevantOnly
      ? selectRelevantMessagesForRegistry(chat.messages as unknown as PhoneRegistryMessageLike[], assessment)
      : (chat.messages as unknown as PhoneRegistryMessageLike[]);

    selectedMessageCount += selectedMessages.length;

    for (const message of selectedMessages) {
      const senderCandidate = (message.senderId ?? "").trim();
      if (senderCandidate) {
        const normalizedPhone = normalizePhoneForRegistry(senderCandidate);
        if (normalizedPhone) {
          addPhoneOccurrence({
            normalizedPhone,
            rawPhone: senderCandidate,
            evidenceId: chat.evidenceId,
            chatId: chat.id,
            source: "sender-id",
            messageId: message.id
          });
        }
      }

      const bodyCandidates = extractPhoneCandidatesFromText(message.body ?? "");
      for (const candidate of bodyCandidates) {
        const normalizedPhone = normalizePhoneForRegistry(candidate);
        if (!normalizedPhone) continue;
        addPhoneOccurrence({
          normalizedPhone,
          rawPhone: candidate,
          evidenceId: chat.evidenceId,
          chatId: chat.id,
          source: "message-body",
          messageId: message.id
        });
      }

      for (const attachment of message.attachments) {
        for (const transcription of attachment.transcriptions) {
          const transcriptionCandidates = extractPhoneCandidatesFromText(transcription.text ?? "");
          for (const candidate of transcriptionCandidates) {
            const normalizedPhone = normalizePhoneForRegistry(candidate);
            if (!normalizedPhone) continue;
            addPhoneOccurrence({
              normalizedPhone,
              rawPhone: candidate,
              evidenceId: chat.evidenceId,
              chatId: chat.id,
              source: "transcription",
              messageId: message.id,
              attachmentId: attachment.id
            });
          }
        }
      }
    }
  }

  const phoneEntries = [...phoneAggregate.entries()];

  for (const [normalizedPhone, aggregate] of phoneEntries) {
    const existingRows = await prisma.entity.findMany({
      where: {
        caseId: input.caseId,
        type: "PHONE",
        value: normalizedPhone
      },
      orderBy: { createdAt: "asc" },
      take: 1,
      select: { id: true, metadata: true }
    });
    const existing = existingRows[0];

    const previousMetadata =
      existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    const mergedRawSamples = [...new Set([...toStringArray(previousMetadata.rawSamples), ...aggregate.rawSamples])].slice(0, 25);
    const mergedEvidenceIds = [...new Set([...toStringArray(previousMetadata.evidenceIds), ...aggregate.evidenceIds])].slice(0, 300);
    const mergedChatIds = [...new Set([...toStringArray(previousMetadata.chatIds), ...aggregate.chatIds])].slice(0, 1500);
    const mergedMessageIds = [...new Set([...toStringArray(previousMetadata.messageIds), ...aggregate.messageIds])].slice(0, 5000);
    const mergedParticipantIds = [...new Set([...toStringArray(previousMetadata.participantIds), ...aggregate.participantIds])].slice(0, 5000);
    const previousSourceCounts =
      previousMetadata.sourceCounts && typeof previousMetadata.sourceCounts === "object" && !Array.isArray(previousMetadata.sourceCounts)
        ? (previousMetadata.sourceCounts as Record<string, unknown>)
        : {};

    const mergedSourceCounts = {
      "participant-phone": Number(previousSourceCounts["participant-phone"] ?? 0) + (aggregate.sourceCounts["participant-phone"] ?? 0),
      "participant-handle": Number(previousSourceCounts["participant-handle"] ?? 0) + (aggregate.sourceCounts["participant-handle"] ?? 0),
      "sender-id": Number(previousSourceCounts["sender-id"] ?? 0) + (aggregate.sourceCounts["sender-id"] ?? 0),
      "message-body": Number(previousSourceCounts["message-body"] ?? 0) + (aggregate.sourceCounts["message-body"] ?? 0),
      transcription: Number(previousSourceCounts.transcription ?? 0) + (aggregate.sourceCounts.transcription ?? 0)
    };

    const nextMetadata = sanitizeJsonForDatabase({
      module: "investigation-phone-registry",
      normalizedPhone,
      rawSamples: mergedRawSamples,
      evidenceIds: mergedEvidenceIds,
      chatIds: mergedChatIds,
      messageIds: mergedMessageIds,
      participantIds: mergedParticipantIds,
      sourceCounts: mergedSourceCounts,
      triageInsightId: triageInsight.id,
      relevantOnly: Boolean(input.relevantOnly),
      updatedAt: nowIso
    }) as Prisma.InputJsonValue;

    if (existing?.id) {
      await prisma.entity.update({
        where: { id: existing.id },
        data: {
          confidence: 1,
          metadata: nextMetadata
        }
      });
    } else {
      await prisma.entity.create({
        data: {
          caseId: input.caseId,
          type: "PHONE",
          value: normalizedPhone,
          confidence: 1,
          metadata: nextMetadata
        }
      });
    }
  }

  const relationRows = phoneEntries.flatMap(([normalizedPhone, aggregate]) =>
    aggregate.relationRows.map((relation) => ({
      caseId: input.caseId,
      type: "PHONE_RELATION",
      value: relation.value,
      confidence: 1,
      metadata: sanitizeJsonForDatabase({
        ...relation.metadata,
        normalizedPhone
      }) as Prisma.InputJsonValue
    }))
  );

  const existingRelationValues = relationRows.length
    ? new Set(
        (
          await prisma.entity.findMany({
            where: {
              caseId: input.caseId,
              type: "PHONE_RELATION",
              value: { in: relationRows.map((row) => row.value) }
            },
            select: { value: true }
          })
        ).map((row) => row.value)
      )
    : new Set<string>();

  const relationRowsToCreate = relationRows.filter((row) => !existingRelationValues.has(row.value));

  if (relationRowsToCreate.length > 0) {
    await prisma.entity.createMany({
      data: relationRowsToCreate
    });
  }

  return {
    triageInsightId: triageInsight.id,
    selectedChats: orderedChats.length,
    selectedMessages: selectedMessageCount,
    phonesFound: phoneEntries.length,
    phoneEntitiesUpserted: phoneEntries.length,
    relationEntitiesCreated: relationRowsToCreate.length,
    phones: phoneEntries.map(([normalizedPhone]) => normalizedPhone)
  };
}

export async function listCasePhoneRegistry(input: { caseId: string }) {
  const phones = await prisma.entity.findMany({
    where: {
      caseId: input.caseId,
      type: "PHONE"
    },
    orderBy: [{ value: "asc" }],
    select: {
      id: true,
      value: true,
      confidence: true,
      metadata: true,
      createdAt: true
    }
  });

  return phones.map((row) => ({
    id: row.id,
    normalizedPhone: row.value,
    confidence: row.confidence,
    createdAt: row.createdAt,
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null
  }));
}
