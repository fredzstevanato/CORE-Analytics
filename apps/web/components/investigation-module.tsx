"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type CaseOption = { id: string; caseNumber: string; title: string };
type ExtractionOption = { id: string; caseId: string; evidenceId: string; fileName: string };

type Assessment = {
  chatId: string;
  label: string;
  sourceApp: string;
  messageCount: number;
  transcriptionCount: number;
  relevanceLevel: "alta" | "media" | "baixa";
  relevanceScore: number;
  rationale: string;
  excerpt: string;
};

type Correlation = {
  sourceChatId: string;
  targetChatId: string;
  score: number;
  rationale: string;
};

type TriagePayload = {
  generatedAt: string;
  inquiryContext: string;
  assessments: Assessment[];
  correlations: Correlation[];
  selectedChatIds?: string[];
  selectedChatIdsUpdatedAt?: string;
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

type TriageEnvelope = {
  insightId: string;
  payload: TriagePayload;
  summary?: string;
};

type JobStatusResponse = {
  id: string;
  state: string;
  progress: number;
  returnvalue?: any;
  failedReason?: string | null;
};

type InvestigationEstimate = {
  mode: "triage" | "report";
  aiEngine: "local" | "openai";
  model: string;
  workload: Record<string, number> & { maxChatsResolved?: number };
  tokens: {
    contextTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  estimate: {
    estimatedCostUsd: number | null;
    estimatedTimeSeconds: number;
    estimatedTimeMinutes: number;
  };
  notes?: string[];
};

type InvestigationChatModalPayload = {
  chatId: string;
  label: string;
  sourceApp: string;
  assessment?: {
    chatId: string;
    relevanceLevel: "alta" | "media" | "baixa";
    relevanceScore: number;
    rationale: string;
    matchedTerms: string[];
    positiveSignals: string[];
    negativeSignals: string[];
    excerpt: string;
  };
  relevantOnly?: boolean;
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
    attachments?: Array<{
      id: string;
      fileName: string | null;
      mimeType: string | null;
      archivePath: string | null;
      transcriptions: string[];
    }>;
    transcriptions: string[];
  }>;
};

type ChatReanalysisResponse = {
  approved: boolean;
  previousAssessment: Assessment;
  proposedAssessment: Assessment;
  assessments?: Assessment[];
  reanalysisStats?: {
    totalChatMessages: number;
    candidateItems: number;
    modelItems: number;
    transcriptionCount: number;
  };
};

function levelClass(level: Assessment["relevanceLevel"]) {
  if (level === "alta") return "bg-red-100 text-red-700";
  if (level === "media") return "bg-amber-100 text-amber-700";
  return "bg-zinc-100 text-zinc-700";
}

const POLL_MS = 1800;

function clampProgress(value: unknown) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function normalizeAttachmentValue(value?: string | null) {
  return (value ?? "").toLowerCase();
}

function isAudioAttachment(attachment: { fileName?: string | null; mimeType?: string | null; archivePath?: string | null }) {
  const mimeType = normalizeAttachmentValue(attachment.mimeType);
  const name = normalizeAttachmentValue(attachment.fileName ?? attachment.archivePath);
  return mimeType.startsWith("audio/") || mimeType === "audio" || /\.(aac|amr|flac|m4a|mp3|ogg|opus|wav|wma)$/i.test(name);
}

function audioContentTypeForAttachment(attachment: { fileName?: string | null; mimeType?: string | null; archivePath?: string | null }) {
  const mimeType = normalizeAttachmentValue(attachment.mimeType);
  if (mimeType.startsWith("audio/")) return mimeType;

  const name = normalizeAttachmentValue(attachment.fileName ?? attachment.archivePath);
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".aac")) return "audio/aac";
  if (name.endsWith(".flac")) return "audio/flac";
  if (name.endsWith(".amr")) return "audio/amr";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".wma")) return "audio/x-ms-wma";
  if (name.endsWith(".ogg") || name.endsWith(".opus")) return "audio/ogg";
  return undefined;
}

function resolveMaxChatsInput(value: string) {
  if (value === "all" || value === "dynamic") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed);
}

export function InvestigationModule({
  cases,
  extractions,
  initialCaseId,
  initialExtractionId
}: {
  cases: CaseOption[];
  extractions: ExtractionOption[];
  initialCaseId?: string;
  initialExtractionId?: string;
}) {
  const initialExtraction = initialExtractionId
    ? extractions.find((item) => item.id === initialExtractionId)
    : undefined;
  const [caseId, setCaseId] = useState(initialCaseId ?? initialExtraction?.caseId ?? cases[0]?.id ?? "");
  const [extractionId, setExtractionId] = useState(initialExtractionId ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [triage, setTriage] = useState<TriageEnvelope | null>(null);
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());
  const [analysisEngine, setAnalysisEngine] = useState<"local" | "openai">("openai");
  const [analysisModel, setAnalysisModel] = useState("gpt-5.4-mini");
  const [reportEngine, setReportEngine] = useState<"local" | "openai">("openai");
  const [reportModel, setReportModel] = useState("gpt-5.4");
  const [contextHint, setContextHint] = useState("");
  const [triageEstimate, setTriageEstimate] = useState<InvestigationEstimate | null>(null);
  const [reportEstimate, setReportEstimate] = useState<InvestigationEstimate | null>(null);
  const [triageMaxChats, setTriageMaxChats] = useState<string>("all");
  const [triageMaxChatsResolved, setTriageMaxChatsResolved] = useState<number | null>(null);
  const [activeChatModal, setActiveChatModal] = useState<InvestigationChatModalPayload | null>(null);
  const [chatModalBusy, setChatModalBusy] = useState(false);
  const [chatModalError, setChatModalError] = useState<string | null>(null);
  const [chatContextHint, setChatContextHint] = useState("");
  const [chatReanalysis, setChatReanalysis] = useState<ChatReanalysisResponse | null>(null);
  const [chatReanalysisBusy, setChatReanalysisBusy] = useState(false);
  const [triageSearch, setTriageSearch] = useState("");
  const [triageSourceFilter, setTriageSourceFilter] = useState("all");
  const [triageLevelFilter, setTriageLevelFilter] = useState<"all" | "alta" | "media" | "baixa">("all");
  const [triageMinMsgs, setTriageMinMsgs] = useState("");
  const [triageMinTranscriptions, setTriageMinTranscriptions] = useState("");
  const [triageSortKey, setTriageSortKey] = useState<
    "chat" | "source" | "messages" | "transcriptions" | "relevance"
  >("relevance");
  const [triageSortDir, setTriageSortDir] = useState<"asc" | "desc">("desc");
  const [selectionDirty, setSelectionDirty] = useState(false);

  const availableExtractions = useMemo(
    () => extractions.filter((item) => item.caseId === caseId),
    [extractions, caseId]
  );
  const selectedExtraction = useMemo(
    () => availableExtractions.find((item) => item.id === extractionId) ?? null,
    [availableExtractions, extractionId]
  );
  const selectedEvidenceId = selectedExtraction?.evidenceId;

  useEffect(() => {
    if (!availableExtractions.some((item) => item.id === extractionId)) {
      setExtractionId(availableExtractions[0]?.id ?? "");
    }
  }, [availableExtractions, extractionId]);

  useEffect(() => {
    if (analysisEngine === "local") {
      setAnalysisModel("local-heuristic-v1");
      return;
    }
    if (analysisModel === "local-heuristic-v1") {
      setAnalysisModel("gpt-5.4-mini");
    }
  }, [analysisEngine, analysisModel]);

  useEffect(() => {
    if (reportEngine === "local") {
      setReportModel("local-heuristic-v1");
      return;
    }
    if (reportModel === "local-heuristic-v1") {
      setReportModel("gpt-5.4");
    }
  }, [reportEngine, reportModel]);

  const grouped = useMemo(() => {
    const items = triage?.payload.assessments ?? [];
    return {
      alta: items.filter((item) => item.relevanceLevel === "alta").length,
      media: items.filter((item) => item.relevanceLevel === "media").length,
      baixa: items.filter((item) => item.relevanceLevel === "baixa").length
    };
  }, [triage]);

  const triageSourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of triage?.payload.assessments ?? []) {
      set.add((item.sourceApp || "OUTROS").trim() || "OUTROS");
    }
    return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [triage]);

  const filteredAssessments = useMemo(() => {
    const items = [...(triage?.payload.assessments ?? [])];
    const search = triageSearch.trim().toLowerCase();
    const minMsgs = triageMinMsgs.trim() ? Math.max(0, Number(triageMinMsgs) || 0) : 0;
    const minTranscriptions = triageMinTranscriptions.trim() ? Math.max(0, Number(triageMinTranscriptions) || 0) : 0;

    const filtered = items.filter((item) => {
      const source = (item.sourceApp || "OUTROS").trim() || "OUTROS";
      const chatMatches =
        search.length === 0 ||
        item.label.toLowerCase().includes(search) ||
        item.chatId.toLowerCase().includes(search) ||
        item.rationale.toLowerCase().includes(search);
      const sourceMatches = triageSourceFilter === "all" || source === triageSourceFilter;
      const levelMatches = triageLevelFilter === "all" || item.relevanceLevel === triageLevelFilter;
      const msgsMatches = item.messageCount >= minMsgs;
      const transcriptionsMatches = item.transcriptionCount >= minTranscriptions;
      return chatMatches && sourceMatches && levelMatches && msgsMatches && transcriptionsMatches;
    });

    const levelRank: Record<Assessment["relevanceLevel"], number> = { alta: 3, media: 2, baixa: 1 };
    filtered.sort((a, b) => {
      let value = 0;
      if (triageSortKey === "chat") {
        value = a.label.localeCompare(b.label, "pt-BR");
      } else if (triageSortKey === "source") {
        value = (a.sourceApp || "OUTROS").localeCompare(b.sourceApp || "OUTROS", "pt-BR");
      } else if (triageSortKey === "messages") {
        value = a.messageCount - b.messageCount;
      } else if (triageSortKey === "transcriptions") {
        value = a.transcriptionCount - b.transcriptionCount;
      } else {
        value = a.relevanceScore - b.relevanceScore;
        if (value === 0) value = levelRank[a.relevanceLevel] - levelRank[b.relevanceLevel];
      }
      return triageSortDir === "asc" ? value : -value;
    });

    return filtered;
  }, [triage, triageSearch, triageSourceFilter, triageLevelFilter, triageMinMsgs, triageMinTranscriptions, triageSortKey, triageSortDir]);

  function toggleTriageSort(key: "chat" | "source" | "messages" | "transcriptions" | "relevance") {
    setTriageSortKey((prevKey) => {
      if (prevKey === key) {
        setTriageSortDir((prevDir) => (prevDir === "asc" ? "desc" : "asc"));
        return prevKey;
      }
      setTriageSortDir("desc");
      return key;
    });
  }

  function sortAssessments(items: Assessment[]) {
    return [...items].sort((a, b) => b.relevanceScore - a.relevanceScore || a.label.localeCompare(b.label, "pt-BR"));
  }

  function toggleSelection(chatId: string) {
    setSelectedChats((prev) => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
    setSelectionDirty(true);
  }

  function getDefaultSelectedChatIds(payload: TriagePayload) {
    if (Array.isArray(payload.selectedChatIds)) {
      return payload.selectedChatIds.filter(Boolean);
    }
    return payload.assessments.filter((item) => item.relevanceLevel !== "baixa").map((item) => item.chatId);
  }

  async function sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollJob(type: "triage" | "report", jobId: string) {
    let visualProgress = Math.max(0, Math.min(95, progress || 0));
    let staleTicks = 0;
    let lastBackendProgress = -1;

    for (;;) {
      const response = await fetch(`/api/investigation/jobs/${jobId}?type=${type}`);
      const payload = (await response.json()) as JobStatusResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao consultar status do job.");
      }

      const backendProgress = clampProgress(payload.progress);
      const state = String(payload.state || "").toLowerCase();

      if (backendProgress !== lastBackendProgress) {
        staleTicks = 0;
        lastBackendProgress = backendProgress;
      } else {
        staleTicks += 1;
      }

      if (state === "waiting" || state === "delayed") {
        visualProgress = Math.max(visualProgress, Math.max(6, backendProgress));
      } else if (state === "active") {
        visualProgress = Math.max(visualProgress, Math.max(12, backendProgress));

        if (backendProgress <= visualProgress && visualProgress < 95 && staleTicks >= 2) {
          visualProgress = Math.min(95, visualProgress + 1);
        }
      } else {
        visualProgress = Math.max(visualProgress, backendProgress);
      }

      setProgress(visualProgress);

      if (state === "waiting" || state === "delayed") {
        setStatus(`${type === "triage" ? "Triagem" : "Relatorio"} em fila (job ${jobId})...`);
      } else if (state === "active") {
        setStatus(
          `${type === "triage" ? "Triagem" : "Relatorio"} em andamento (job ${jobId})... ${Math.round(visualProgress)}%`
        );
      }

      if (payload.state === "completed") return payload;
      if (payload.state === "failed") {
        throw new Error(payload.failedReason ?? "Job falhou.");
      }
      await sleep(POLL_MS);
    }
  }

  async function loadLatest() {
    if (!caseId) return;
    setBusy(true);
    setError(null);
    setStatus("Carregando ultima triagem...");
    setProgress(20);
    try {
      const response = await fetch(
        `/api/investigation/triage?caseId=${caseId}${extractionId ? `&extractionId=${encodeURIComponent(extractionId)}` : ""}`
      );
      const payload = (await response.json()) as { latest?: TriageEnvelope; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao carregar triagem.");
      setTriage(payload.latest ?? null);
      const preselected = payload.latest?.payload ? getDefaultSelectedChatIds(payload.latest.payload) : [];
      setSelectedChats(new Set(preselected));
      setSelectionDirty(false);
      setStatus(payload.latest ? "Triagem carregada." : "Sem triagem anterior para este caso.");
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar triagem.");
      setProgress(0);
    } finally {
      setBusy(false);
    }
  }

  async function runTriage() {
    if (!caseId) return;
    setBusy(true);
    setError(null);
    setStatus("Enfileirando triagem investigativa...");
    setProgress(5);
    try {
      const enqueueResponse = await fetch("/api/investigation/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          extractionId: extractionId || undefined,
          evidenceId: selectedEvidenceId || undefined,
          maxChats: resolveMaxChatsInput(triageMaxChats),
          contextHint: contextHint.trim() || undefined,
          aiEngine: analysisEngine,
          analysisModel
        })
      });
      const enqueuePayload = (await enqueueResponse.json()) as {
        jobId?: string;
        error?: string;
        maxChatsResolved?: number;
      };
      if (!enqueueResponse.ok || !enqueuePayload.jobId) {
        throw new Error(enqueuePayload.error ?? "Falha ao enfileirar triagem.");
      }
      setTriageMaxChatsResolved(enqueuePayload.maxChatsResolved ?? null);

      setStatus(`Triagem em andamento (job ${enqueuePayload.jobId})...`);
      const done = await pollJob("triage", enqueuePayload.jobId);
      const result = done.returnvalue as TriageEnvelope | undefined;
      if (!result?.payload) {
        throw new Error("Triagem concluida sem payload.");
      }

      setTriage(result);
      const preselected = getDefaultSelectedChatIds(result.payload);
      setSelectedChats(new Set(preselected));
      setSelectionDirty(false);
      setStatus(result.summary ?? "Triagem concluida.");
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao executar triagem.");
      setProgress(0);
    } finally {
      setBusy(false);
    }
  }

  async function estimateTriage() {
    if (!caseId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/investigation/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          extractionId: extractionId || undefined,
          evidenceId: selectedEvidenceId || undefined,
          mode: "triage",
          aiEngine: analysisEngine,
          model: analysisModel,
          maxChats: resolveMaxChatsInput(triageMaxChats)
        })
      });
      const payload = (await response.json()) as InvestigationEstimate & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao estimar triagem.");
      setTriageEstimate(payload);
      setTriageMaxChatsResolved(payload.workload?.maxChatsResolved ?? null);
      setStatus("Estimativa de triagem atualizada.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao estimar triagem.");
    } finally {
      setBusy(false);
    }
  }

  async function generateReport() {
    if (!caseId || !triage) return;
    setBusy(true);
    setError(null);
    setStatus("Enfileirando relatorio investigativo...");
    setProgress(5);
    try {
      const enqueueResponse = await fetch("/api/investigation/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          extractionId: extractionId || undefined,
          evidenceId: selectedEvidenceId || undefined,
          triageInsightId: triage.insightId,
          selectedChatIds: [...selectedChats],
          contextHint: contextHint.trim() || undefined,
          aiEngine: reportEngine,
          reportModel
        })
      });
      const enqueuePayload = (await enqueueResponse.json()) as { jobId?: string; error?: string };
      if (!enqueueResponse.ok || !enqueuePayload.jobId) {
        throw new Error(enqueuePayload.error ?? "Falha ao enfileirar relatorio.");
      }

      setStatus(`Relatorio em andamento (job ${enqueuePayload.jobId})...`);
      const done = await pollJob("report", enqueuePayload.jobId);
      const result = done.returnvalue as { reportId?: string; title?: string } | undefined;
      setStatus(`Relatorio gerado com sucesso. ID: ${result?.reportId ?? "N/D"}`);
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao gerar relatorio.");
      setProgress(0);
    } finally {
      setBusy(false);
    }
  }

  async function saveSelection() {
    if (!caseId || !triage) return;
    setBusy(true);
    setError(null);
    setStatus("Salvando selecao de chats...");
    try {
      const response = await fetch("/api/investigation/triage", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          extractionId: extractionId || undefined,
          evidenceId: selectedEvidenceId || undefined,
          triageInsightId: triage.insightId,
          selectedChatIds: [...selectedChats]
        })
      });
      const payload = (await response.json()) as { selectedChatIds?: string[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao salvar selecao.");
      }
      const saved = Array.isArray(payload.selectedChatIds) ? payload.selectedChatIds : [...selectedChats];
      setSelectedChats(new Set(saved));
      setTriage((prev) =>
        prev
          ? {
              ...prev,
              payload: {
                ...prev.payload,
                selectedChatIds: saved,
                selectedChatIdsUpdatedAt: new Date().toISOString()
              }
            }
          : prev
      );
      setSelectionDirty(false);
      setStatus("Selecao de chats salva com sucesso.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar selecao.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadSelectedMessagesPdf(relevantOnly = false) {
    if (!caseId || !triage) return;
    setBusy(true);
    setError(null);
    setStatus(relevantOnly ? "Gerando PDF das mensagens relevantes..." : "Gerando PDF das mensagens selecionadas...");
    setProgress(20);
    try {
      const response = await fetch("/api/investigation/selected-messages/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          extractionId: extractionId || undefined,
          evidenceId: selectedEvidenceId || undefined,
          triageInsightId: triage.insightId,
          selectedChatIds: [...selectedChats],
          relevantOnly
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? (relevantOnly ? "Falha ao gerar PDF das mensagens relevantes." : "Falha ao gerar PDF das mensagens selecionadas."));
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get("Content-Disposition") ?? "";
      const fileNameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const fileName = fileNameMatch?.[1] ?? "mensagens-selecionadas.pdf";

      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(objectUrl);

      setStatus(relevantOnly ? "PDF das mensagens relevantes gerado e baixado com sucesso." : "PDF das mensagens selecionadas gerado e baixado com sucesso.");
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : relevantOnly ? "Falha ao baixar PDF das mensagens relevantes." : "Falha ao baixar PDF das mensagens selecionadas.");
      setProgress(0);
    } finally {
      setBusy(false);
    }
  }

  async function estimateReport() {
    if (!caseId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/investigation/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          extractionId: extractionId || undefined,
          evidenceId: selectedEvidenceId || undefined,
          mode: "report",
          aiEngine: reportEngine,
          model: reportModel,
          triageInsightId: triage?.insightId,
          selectedChatIds: selectedChats.size > 0 ? [...selectedChats] : undefined
        })
      });
      const payload = (await response.json()) as InvestigationEstimate & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao estimar relatorio.");
      setReportEstimate(payload);
      setStatus("Estimativa de relatorio atualizada.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao estimar relatorio.");
    } finally {
      setBusy(false);
    }
  }

  async function openChatModal(chatId: string, options?: { relevantOnly?: boolean }) {
    if (!caseId) return;
    setChatModalBusy(true);
    setChatModalError(null);
    setChatReanalysis(null);
    setChatContextHint("");
    try {
      const query = new URLSearchParams({
        caseId,
        ...(extractionId ? { extractionId } : {}),
        ...(triage?.insightId ? { triageInsightId: triage.insightId } : {}),
        ...(options?.relevantOnly ? { relevantOnly: "1" } : {})
      });
      const response = await fetch(
        `/api/investigation/chats/${chatId}?${query.toString()}`
      );
      const payload = (await response.json()) as { chat?: InvestigationChatModalPayload; error?: string };
      if (!response.ok || !payload.chat) {
        throw new Error(payload.error ?? "Falha ao carregar mensagens do chat.");
      }
      setActiveChatModal(payload.chat);
    } catch (err) {
      setChatModalError(err instanceof Error ? err.message : "Falha ao carregar mensagens do chat.");
    } finally {
      setChatModalBusy(false);
    }
  }

  async function runSingleChatReanalysis(approve: boolean) {
    if (!caseId || !triage?.insightId || !activeChatModal?.chatId) return;
    if (!chatContextHint.trim()) {
      setChatModalError("Informe a contextualizacao do analista para reanalise deste chat.");
      return;
    }

    setChatReanalysisBusy(true);
    setChatModalError(null);
    try {
      const response = await fetch("/api/investigation/triage/reanalyze-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          extractionId: extractionId || undefined,
          triageInsightId: triage.insightId,
          chatId: activeChatModal.chatId,
          analystContext: chatContextHint.trim(),
          aiEngine: analysisEngine,
          analysisModel,
          approve
        })
      });
      const payload = (await response.json()) as ChatReanalysisResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao reanalisar chat.");
      }

      setChatReanalysis(payload);
      if (approve) {
        setTriage((prev) => {
          if (!prev) return prev;
          const nextAssessments = payload.assessments
            ? sortAssessments(payload.assessments)
            : sortAssessments(
                prev.payload.assessments.map((item) =>
                  item.chatId === payload.proposedAssessment.chatId ? payload.proposedAssessment : item
                )
              );
          return {
            ...prev,
            payload: {
              ...prev.payload,
              generatedAt: new Date().toISOString(),
              assessments: nextAssessments
            }
          };
        });
        setStatus("Reanalise aprovada e substituida na triagem atual.");
      }
    } catch (err) {
      setChatModalError(err instanceof Error ? err.message : "Falha ao reanalisar chat.");
    } finally {
      setChatReanalysisBusy(false);
    }
  }

  if (cases.length === 0) {
    return <p className="text-sm text-zinc-600">Nenhum caso cadastrado para analise investigativa.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_220px_220px_220px_220px]">
        <select
          value={caseId}
          onChange={(event) => setCaseId(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          {cases.map((item) => (
            <option key={item.id} value={item.id}>
              {item.caseNumber} - {item.title}
            </option>
          ))}
        </select>
        <select
          value={extractionId}
          onChange={(event) => setExtractionId(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          {availableExtractions.length === 0 ? <option value="">Sem extrações para o caso</option> : null}
          {availableExtractions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} - {item.fileName}
            </option>
          ))}
        </select>
        <select
          value={analysisEngine}
          onChange={(event) => setAnalysisEngine(event.target.value as "local" | "openai")}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="openai">Triagem: Online (OpenAI)</option>
          <option value="local">Triagem: Local</option>
        </select>
        <select
          value={analysisModel}
          onChange={(event) => setAnalysisModel(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          {analysisEngine === "local" ? (
            <option value="local-heuristic-v1">Analise: local-heuristic-v1</option>
          ) : null}
          {analysisEngine === "openai" ? (
            <>
          <option value="gpt-5.4-mini">Analise: gpt-5.4-mini</option>
          <option value="gpt-5.4">Analise: gpt-5.4</option>
          <option value="gpt-5.2">Analise: gpt-5.2</option>
          <option value="gpt-4.1-mini">Analise: gpt-4.1-mini</option>
          <option value="gpt-4.1-nano">Analise: gpt-4.1-nano</option>
          <option value="gpt-4.1">Analise: gpt-4.1</option>
          <option value="gpt-4o-mini">Analise: gpt-4o-mini</option>
            </>
          ) : null}
        </select>
        <select
          value={reportEngine}
          onChange={(event) => setReportEngine(event.target.value as "local" | "openai")}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="openai">Relatorio: Online (OpenAI)</option>
          <option value="local">Relatorio: Local</option>
        </select>
        <select
          value={reportModel}
          onChange={(event) => setReportModel(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          {reportEngine === "local" ? (
            <option value="local-heuristic-v1">Relatorio: local-heuristic-v1</option>
          ) : null}
          {reportEngine === "openai" ? (
            <>
          <option value="gpt-5.4">Relatorio: gpt-5.4</option>
          <option value="gpt-5.4-mini">Relatorio: gpt-5.4-mini</option>
          <option value="gpt-5.2">Relatorio: gpt-5.2</option>
          <option value="gpt-4.1">Relatorio: gpt-4.1</option>
          <option value="gpt-4.1-mini">Relatorio: gpt-4.1-mini</option>
          <option value="gpt-4.1-nano">Relatorio: gpt-4.1-nano</option>
          <option value="gpt-4o">Relatorio: gpt-4o</option>
            </>
          ) : null}
        </select>
      </div>

      <div className="space-y-2">
        <textarea
          value={contextHint}
          onChange={(event) => setContextHint(event.target.value)}
          placeholder="Contextualizacao manual (quando o caso ainda nao foi enriquecido por PDF): descreva o inquerito e o que procurar nos chats."
          className="min-h-[90px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        />
        <p className="text-xs text-zinc-600">
          A triagem e o relatorio exigem contextualizacao do inquerito. Use este campo quando ainda nao houver contexto preenchido no caso por PDF.
        </p>
      </div>

      <div className="grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
        <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          Chave OpenAI usada nesta tela: Configuracoes do sistema (banco).
        </div>
        <select
          value={triageMaxChats}
          onChange={(event) => setTriageMaxChats(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="all">Triagem max chats: Todos os chats</option>
          <option value="300">Triagem max chats: 300</option>
          <option value="500">Triagem max chats: 500</option>
          <option value="700">Triagem max chats: 700</option>
          <option value="900">Triagem max chats: 900</option>
        </select>
        <Button type="button" variant="outline" onClick={loadLatest} disabled={busy || !caseId}>
          Carregar Ultima
        </Button>
        <Button type="button" variant="outline" onClick={estimateTriage} disabled={busy || !caseId}>
          Estimar Triagem
        </Button>
        <Button type="button" onClick={runTriage} disabled={busy || !caseId}>
          Rodar Triagem
        </Button>
        <Button type="button" variant="outline" onClick={estimateReport} disabled={busy || !caseId}>
          Estimar Relatorio
        </Button>
        <Button type="button" variant="outline" onClick={saveSelection} disabled={busy || !triage || !selectionDirty}>
          Salvar Selecao
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => downloadSelectedMessagesPdf(false)}
          disabled={busy || !triage || selectedChats.size === 0}
        >
          Baixar PDF (Selecionadas)
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => downloadSelectedMessagesPdf(true)}
          disabled={busy || !triage || selectedChats.size === 0}
        >
          Baixar PDF (Relevantes)
        </Button>
        <Button type="button" variant="outline" onClick={generateReport} disabled={busy || !triage}>
          Gerar Relatorio
        </Button>
      </div>

      {triageEstimate || reportEstimate ? (
        <div className="grid gap-3 md:grid-cols-2">
          {triageEstimate ? (
            <div className="rounded border border-zinc-200 p-3 text-sm">
              <p className="font-semibold">Estimativa Triagem</p>
              <p>Engine/modelo: {triageEstimate.aiEngine} / {triageEstimate.model}</p>
              <p>Max chats resolvido: {triageEstimate.workload.maxChatsResolved ?? "N/D"}</p>
              <p>Tokens totais: {triageEstimate.tokens.totalTokens}</p>
              <p>
                Custo estimado:{" "}
                {typeof triageEstimate.estimate.estimatedCostUsd === "number"
                  ? `US$ ${triageEstimate.estimate.estimatedCostUsd.toFixed(4)}`
                  : "N/D"}
              </p>
              <p>Tempo estimado: {triageEstimate.estimate.estimatedTimeMinutes.toFixed(2)} min</p>
            </div>
          ) : null}
          {reportEstimate ? (
            <div className="rounded border border-zinc-200 p-3 text-sm">
              <p className="font-semibold">Estimativa Relatorio</p>
              <p>Engine/modelo: {reportEstimate.aiEngine} / {reportEstimate.model}</p>
              <p>Tokens totais: {reportEstimate.tokens.totalTokens}</p>
              <p>
                Custo estimado:{" "}
                {typeof reportEstimate.estimate.estimatedCostUsd === "number"
                  ? `US$ ${reportEstimate.estimate.estimatedCostUsd.toFixed(4)}`
                  : "N/D"}
              </p>
              <p>Tempo estimado: {reportEstimate.estimate.estimatedTimeMinutes.toFixed(2)} min</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {(busy || status) && (
        <div className="space-y-1 rounded border border-zinc-200 p-3">
          <p className="text-sm text-zinc-700">{status ?? "Processando..."}</p>
          <Progress value={progress} />
        </div>
      )}

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {triage ? (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded border border-zinc-200 p-3 text-sm">
            <p className="font-semibold">Resumo</p>
            <p>Gerado em: {new Date(triage.payload.generatedAt).toLocaleString("pt-BR")}</p>
            <p>Chats: {triage.payload.assessments.length}</p>
            <p>Alta: {grouped.alta}</p>
            <p>Media: {grouped.media}</p>
            <p>Baixa: {grouped.baixa}</p>
            <p>Selecionados: {selectedChats.size}</p>
            <p>Max chats usado: {triageMaxChatsResolved ?? "N/D"}</p>
          </div>
          <div className="rounded border border-zinc-200 p-3 text-sm md:col-span-2">
            <p className="font-semibold">Contexto do Caso</p>
            <p className="mt-1 whitespace-pre-wrap text-zinc-700">{triage.payload.inquiryContext || "Sem contexto."}</p>
          </div>
        </div>
      ) : null}

      {triage?.payload.diagnostics ? (
        <div className="rounded border border-zinc-200 p-3 text-sm">
          <p className="font-semibold">Diagnostico de Custo da Triagem</p>
          <p>Chats enviados para IA: {triage.payload.diagnostics.chatsSentToAi}</p>
          <p>Chats bloqueados pelo gate: {triage.payload.diagnostics.chatsSkippedByGate}</p>
          <p>Tokens estimados de entrada: {triage.payload.diagnostics.estimatedInputTokensTotal}</p>
          <p>Throttle events: {triage.payload.diagnostics.throttleEvents}</p>
          <p>Espera total por throttle: {(triage.payload.diagnostics.throttleWaitMsTotal / 1000).toFixed(1)}s</p>
          <p>
            Limite configurado: {triage.payload.diagnostics.targetTokensPerMinute} TPM | intervalo minimo {triage.payload.diagnostics.minCallIntervalMs}ms
          </p>
        </div>
      ) : null}

      {triage ? (
        <div className="rounded border border-zinc-200">
          <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
            <p>
              Exibindo {filteredAssessments.length} de {triage.payload.assessments.length} chats
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setTriageSearch("");
                setTriageSourceFilter("all");
                setTriageLevelFilter("all");
                setTriageMinMsgs("");
                setTriageMinTranscriptions("");
              }}
            >
              Limpar filtros
            </Button>
          </div>
          <div className="max-h-[520px] overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-left">
                <tr>
                  <th className="px-2 py-2">Incluir</th>
                  <th className="min-w-[280px] px-2 py-2">
                    <button type="button" className="font-semibold" onClick={() => toggleTriageSort("chat")}>Chat</button>
                    <input
                      value={triageSearch}
                      onChange={(event) => setTriageSearch(event.target.value)}
                      placeholder="Buscar chat/racional"
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                    />
                  </th>
                  <th className="min-w-[150px] px-2 py-2">
                    <button type="button" className="font-semibold" onClick={() => toggleTriageSort("source")}>Fonte</button>
                    <select
                      value={triageSourceFilter}
                      onChange={(event) => setTriageSourceFilter(event.target.value)}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                    >
                      <option value="all">Todas</option>
                      {triageSourceOptions.map((source) => (
                        <option key={source} value={source}>
                          {source}
                        </option>
                      ))}
                    </select>
                  </th>
                  <th className="min-w-[110px] px-2 py-2">
                    <button type="button" className="font-semibold" onClick={() => toggleTriageSort("messages")}>Msgs</button>
                    <input
                      value={triageMinMsgs}
                      onChange={(event) => setTriageMinMsgs(event.target.value)}
                      inputMode="numeric"
                      placeholder="Min"
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                    />
                  </th>
                  <th className="min-w-[130px] px-2 py-2">
                    <button type="button" className="font-semibold" onClick={() => toggleTriageSort("transcriptions")}>Transcricoes</button>
                    <input
                      value={triageMinTranscriptions}
                      onChange={(event) => setTriageMinTranscriptions(event.target.value)}
                      inputMode="numeric"
                      placeholder="Min"
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                    />
                  </th>
                  <th className="min-w-[130px] px-2 py-2">
                    <button type="button" className="font-semibold" onClick={() => toggleTriageSort("relevance")}>Relevancia</button>
                    <select
                      value={triageLevelFilter}
                      onChange={(event) => setTriageLevelFilter(event.target.value as "all" | "alta" | "media" | "baixa")}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                    >
                      <option value="all">Todas</option>
                      <option value="alta">Alta</option>
                      <option value="media">Media</option>
                      <option value="baixa">Baixa</option>
                    </select>
                  </th>
                  <th className="px-2 py-2">Racional</th>
                  <th className="px-2 py-2">Acoes</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssessments.map((item) => (
                  <tr key={item.chatId} className="border-t border-zinc-100 align-top">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={selectedChats.has(item.chatId)}
                        onChange={() => toggleSelection(item.chatId)}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <p className="font-medium">{item.label}</p>
                      <p className="text-xs text-zinc-500">{item.chatId}</p>
                    </td>
                    <td className="px-2 py-2">{item.sourceApp || "OUTROS"}</td>
                    <td className="px-2 py-2">{item.messageCount}</td>
                    <td className="px-2 py-2">{item.transcriptionCount}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded px-2 py-1 text-xs font-semibold ${levelClass(item.relevanceLevel)}`}>
                        {item.relevanceLevel.toUpperCase()} ({item.relevanceScore})
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <p className="text-zinc-700">{item.rationale}</p>
                      <p className="mt-1 text-xs text-zinc-500">{item.excerpt}</p>
                    </td>
                    <td className="space-y-2 px-2 py-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => openChatModal(item.chatId)}>
                        Ver mensagens
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => openChatModal(item.chatId, { relevantOnly: true })}
                      >
                        Ver mensagens relevantes
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {triage && triage.payload.correlations.length > 0 ? (
        <div className="rounded border border-zinc-200 p-3">
          <p className="mb-2 text-sm font-semibold">Correlacoes Principais</p>
          <div className="space-y-2 text-sm">
            {triage.payload.correlations.slice(0, 20).map((item, index) => (
              <div key={`${item.sourceChatId}-${item.targetChatId}-${index}`} className="rounded border border-zinc-100 p-2">
                <p className="font-medium">
                  score {item.score.toFixed(2)} | {item.sourceChatId} {"<->"} {item.targetChatId}
                </p>
                <p className="text-zinc-600">{item.rationale}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {activeChatModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <p className="text-sm font-semibold">{activeChatModal.label}</p>
                <p className="text-xs text-zinc-500">
                  {activeChatModal.sourceApp} | {activeChatModal.messages.length} mensagens
                  {activeChatModal.relevantOnly ? " relevantes" : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setActiveChatModal(null);
                  setChatReanalysis(null);
                  setChatContextHint("");
                  setChatModalError(null);
                }}
              >
                Fechar
              </Button>
            </div>

            <div className="grid flex-1 gap-0 overflow-hidden md:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-2 overflow-y-auto border-r p-4">
                {activeChatModal.messages.length === 0 ? (
                  <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    Nenhuma mensagem foi marcada como diretamente relevante para este chat pela triagem atual.
                  </div>
                ) : null}
                {activeChatModal.messages.map((message) => {
                  const outgoing = (message.direction ?? "").toUpperCase() === "OUTGOING";
                  return (
                    <div
                      key={message.id}
                      className={`rounded-xl border px-3 py-2 text-sm ${
                        outgoing ? "ml-10 border-zinc-200 bg-zinc-100" : "mr-10 border-zinc-200 bg-white"
                      }`}
                    >
                      <p className="mb-1 text-[11px] text-zinc-500">{message.senderId ?? "interlocutor"}</p>
                      <p className="whitespace-pre-wrap break-words text-zinc-800">
                        {message.body ?? "(mensagem sem texto)"}
                      </p>
                      {message.attachments && message.attachments.length > 0 ? (
                        <div className="mt-2 space-y-2 rounded border border-zinc-200 bg-zinc-50 p-2">
                          {message.attachments.map((attachment) => {
                            const isAudio = isAudioAttachment(attachment);
                            const label = attachment.fileName ?? attachment.archivePath ?? (isAudio ? "audio-sem-nome" : "anexo-sem-nome");
                            const source = `/api/attachments/${attachment.id}/content`;
                            const audioType = audioContentTypeForAttachment(attachment);
                            return (
                              <div key={attachment.id} className="space-y-1">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-[11px] font-medium text-zinc-600">{label}</p>
                                  <a
                                    href={`${source}?download=1`}
                                    className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-100"
                                  >
                                    {isAudio ? "Baixar audio" : "Baixar anexo"}
                                  </a>
                                </div>
                                {isAudio ? (
                                  <audio controls preload="metadata" className="w-full">
                                    <source src={source} type={audioType} />
                                    Seu navegador nao suporta audio.
                                  </audio>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                      {message.transcriptions.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {message.transcriptions.map((text, index) => (
                            <p key={`${message.id}-${index}`} className="text-xs italic text-zinc-600">
                              Transcricao: {text}
                            </p>
                          ))}
                        </div>
                      ) : null}
                      <p className="mt-1 text-[11px] text-zinc-400">
                        {message.timestamp ? new Date(message.timestamp).toLocaleString("pt-BR") : "Sem data"}
                      </p>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-3 overflow-y-auto p-4">
                {activeChatModal.assessment ? (
                  <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-sm">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <p className="font-semibold">Analise da IA neste chat</p>
                      <span className={`rounded px-2 py-1 text-xs font-semibold ${levelClass(activeChatModal.assessment.relevanceLevel)}`}>
                        {activeChatModal.assessment.relevanceLevel.toUpperCase()} ({activeChatModal.assessment.relevanceScore})
                      </span>
                    </div>
                    <p className="text-zinc-700">{activeChatModal.assessment.rationale}</p>
                    {activeChatModal.assessment.excerpt ? (
                      <p className="mt-2 rounded border border-zinc-200 bg-white p-2 text-xs italic text-zinc-600">
                        Trecho base: {activeChatModal.assessment.excerpt}
                      </p>
                    ) : null}
                    {activeChatModal.assessment.matchedTerms.length > 0 ? (
                      <p className="mt-2 text-xs text-zinc-500">
                        Termos: {activeChatModal.assessment.matchedTerms.slice(0, 20).join(", ")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-sm font-semibold">Reanalise deste chat completo</p>
                <textarea
                  value={chatContextHint}
                  onChange={(event) => setChatContextHint(event.target.value)}
                  placeholder="Ex.: Gabriel neste chat era convivente da interlocutora e nao a vitima do inquerito..."
                  className="min-h-[110px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
                />

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={chatReanalysisBusy}
                    onClick={() => runSingleChatReanalysis(false)}
                  >
                    Gerar reanalise
                  </Button>
                  <Button
                    type="button"
                    disabled={chatReanalysisBusy || !chatReanalysis || chatReanalysis.approved}
                    onClick={() => runSingleChatReanalysis(true)}
                  >
                    Aprovar e substituir
                  </Button>
                </div>

                {chatModalBusy ? <p className="text-xs text-zinc-500">Carregando chat...</p> : null}
                {chatModalError ? <p className="text-xs text-red-700">{chatModalError}</p> : null}
                {chatReanalysis?.reanalysisStats ? (
                  <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-700">
                    <p>Chat completo carregado: {chatReanalysis.reanalysisStats.totalChatMessages} mensagens.</p>
                    <p>
                      Itens enviados para reanalise: {chatReanalysis.reanalysisStats.modelItems} (de {chatReanalysis.reanalysisStats.candidateItems} itens candidatos, com {chatReanalysis.reanalysisStats.transcriptionCount} transcricoes).
                    </p>
                  </div>
                ) : null}

                {chatReanalysis ? (
                  <div className="space-y-2 rounded border border-zinc-200 p-3 text-sm">
                    <p className="font-semibold">Comparativo</p>
                    <p>
                      Atual: {chatReanalysis.previousAssessment.relevanceLevel.toUpperCase()} (
                      {chatReanalysis.previousAssessment.relevanceScore})
                    </p>
                    <p>
                      Proposta: {chatReanalysis.proposedAssessment.relevanceLevel.toUpperCase()} (
                      {chatReanalysis.proposedAssessment.relevanceScore})
                    </p>
                    <div className="rounded bg-zinc-50 p-2">
                      <p className="text-xs font-semibold text-zinc-600">Racional atual</p>
                      <p className="text-xs text-zinc-700">{chatReanalysis.previousAssessment.rationale}</p>
                    </div>
                    <div className="rounded bg-emerald-50 p-2">
                      <p className="text-xs font-semibold text-emerald-700">Racional proposto</p>
                      <p className="text-xs text-emerald-800">{chatReanalysis.proposedAssessment.rationale}</p>
                    </div>
                    {chatReanalysis.approved ? (
                      <p className="text-xs font-semibold text-emerald-700">Substituicao aplicada com sucesso.</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
