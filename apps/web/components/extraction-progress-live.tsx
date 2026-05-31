"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAutomatedChain } from "@/components/hooks/use-automated-chain";

type ExtractionProgress = {
  status: string;
  phase: string;
  progress: number;
  reportError?: string | null;
  transcriptionRuntime?: {
    enabled?: boolean;
    engine?: TranscriptionEngine;
    model?: string;
    language?: string | null;
  };
  alerts?: string[];
  operationalAlerts?: Array<{
    code: string;
    severity: "INFO" | "WARN" | "CRITICAL";
    message: string;
  }>;
  diagnostics?: {
    elapsedMs?: number;
    parserMode?: string;
    filesScanned?: number;
    parserDropped?: {
      chats?: number;
      messages?: number;
      audioFiles?: number;
    };
    ingestTimingsMs?: {
      total?: number;
    };
    audio?: {
      hintsCount?: number;
      extractedCount?: number;
      maxFiles?: number;
      capReached?: boolean;
      transcriptionJobs?: number;
      etaSec?: number;
      ratePerMin?: number;
      recovery?: {
        async?: boolean;
        batchTotal?: number;
        batchProcessed?: number;
        extractedCount?: number;
        skippedTimeoutCount?: number;
        skippedErrorCount?: number;
        skippedMissingFileCount?: number;
        skippedPolicyCount?: number;
      };
    };
  };
  stats?: {
    attachments?: number;
    transcriptions?: {
      total: number;
      pending: number;
      processing: number;
      completed: number;
      failed: number;
      policyDiscarded?: number;
      realFailed?: number;
      eligible?: number;
    };
    aiClassification?: {
      expectedFromCompletedTranscriptions: number;
      completed: number;
    };
  };
};

type TranscriptionEngine = "local" | "openai" | "assemblyai";
type AiEngine = "local" | "openai";
type TranscriptionProviderAvailability = {
  local: boolean;
  openai: boolean;
  assemblyai: boolean;
};
type ActionStep = "reprocess" | "enrich" | "indexpaths" | "relink" | "retranscribe";
type ManualAction = "reprocess" | "retranscribe" | "relink" | "indexpaths" | "enrich" | "resume";

type EstimateResponse = {
  error?: string;
  audioIndexing?: { attachmentCount: number; totalDurationMin: number };
  estimate?: { estimatedOutputTokens: number; estimatedTimeMinutes: number; estimatedCostUsd: number | null };
  aiEstimate?: {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedTotalTokens: number;
    estimatedTimeMinutes: number;
    estimatedCostUsd: number | null;
  };
};

const LOCAL_TRANSCRIPTION_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
const OPENAI_TRANSCRIPTION_MODELS = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"];
const ASSEMBLYAI_TRANSCRIPTION_MODELS = ["best", "nano"];
const OPENAI_CHAT_MODELS = [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.1-mini",
  "gpt-5.2",
  "gpt-5.2-mini",
  "gpt-5.3",
  "gpt-5.3-mini",
  "gpt-5.3-codex"
];

const AUTO_CHAIN_STEPS: ActionStep[] = ["reprocess", "enrich", "indexpaths", "relink", "retranscribe"];
const AUTO_CHAIN_STEP_LABEL: Record<ActionStep, string> = {
  reprocess: "1. Reprocessar Completo",
  enrich: "2. Enriquecer Metadados",
  indexpaths: "3. Indexar Caminhos de Anexos",
  relink: "4. Recalcular Vinculos",
  retranscribe: "5. Transcrever Audios"
};

function formatUsd(value: number | null | undefined) {
  return typeof value === "number" ? `US$ ${value.toFixed(4)}` : "N/D";
}

function isTerminalStatus(status: string) {
  return status === "COMPLETED" || status === "FAILED";
}

function hasActiveBackgroundWork(payload: ExtractionProgress) {
  const transcriptionsPending = payload.stats?.transcriptions?.pending ?? 0;
  const transcriptionsProcessing = payload.stats?.transcriptions?.processing ?? 0;
  return transcriptionsPending > 0 || transcriptionsProcessing > 0;
}

function formatElapsedMs(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "N/D";
  const totalSec = Math.round(value / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatEtaSec(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "N/D";
  const totalSec = Math.round(value);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function clampProgress(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function humanizePhase(phase: string) {
  if (!phase) return "aguardando";
  return phase
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ExtractionProgressLive(props: {
  extractionId: string;
  evidenceId?: string;
  initial: ExtractionProgress;
}) {
  const router = useRouter();
  const [state, setState] = useState<ExtractionProgress>(props.initial);
  const [busyAction, setBusyAction] = useState<ManualAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [coreHubExporting, setCoreHubExporting] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const [streamEnabled, setStreamEnabled] = useState(true);

  const [transcriptionEngine, setTranscriptionEngine] = useState<TranscriptionEngine>("local");
  const [transcriptionModel, setTranscriptionModel] = useState("base");
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("");
  const [providerAvailability, setProviderAvailability] = useState<TranscriptionProviderAvailability>({
    local: true,
    openai: false,
    assemblyai: false
  });

  const [aiEngine, setAiEngine] = useState<AiEngine>("local");
  const [aiModel, setAiModel] = useState("local-heuristic-v1");
  const [operationDurationMs, setOperationDurationMs] = useState<
    Partial<Record<ManualAction, number>>
  >({});
  const [indexPathsProgress, setIndexPathsProgress] = useState<{ total: number; processed: number } | null>(null);
  const showReprocessControls = false;

  useEffect(() => {
    const runtime = state.transcriptionRuntime;
    if (!runtime?.engine) return;
    setTranscriptionEngine(runtime.engine);
    if (runtime.model) setTranscriptionModel(runtime.model);
    setTranscriptionLanguage(runtime.language ?? "");
  }, [state.transcriptionRuntime?.engine, state.transcriptionRuntime?.model, state.transcriptionRuntime?.language]);

  useEffect(() => {
    if (transcriptionEngine === "openai") {
      setTranscriptionModel("gpt-4o-mini-transcribe");
      return;
    }
    if (transcriptionEngine === "assemblyai") {
      setTranscriptionModel("best");
      return;
    }
    setTranscriptionModel("base");
  }, [transcriptionEngine]);

  useEffect(() => {
    setAiModel(aiEngine === "openai" ? "gpt-4.1-mini" : "local-heuristic-v1");
  }, [aiEngine]);

  useEffect(() => {
    let cancelled = false;
    async function loadAvailability() {
      try {
        const response = await fetch("/api/settings/providers/availability", { cache: "no-store" });
        const payload = (await response.json()) as {
          transcriptionProviders?: TranscriptionProviderAvailability;
        };
        if (!response.ok || !payload.transcriptionProviders || cancelled) return;
        setProviderAvailability(payload.transcriptionProviders);
      } catch {
        // Keep safe defaults when availability fetch fails.
      }
    }
    void loadAvailability();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (transcriptionEngine === "openai" && !providerAvailability.openai) {
      setTranscriptionEngine("local");
      return;
    }
    if (transcriptionEngine === "assemblyai" && !providerAvailability.assemblyai) {
      setTranscriptionEngine("local");
    }
  }, [transcriptionEngine, providerAvailability]);

  useEffect(() => {
    if (aiEngine === "openai" && !providerAvailability.openai) {
      setAiEngine("local");
    }
  }, [aiEngine, providerAvailability.openai]);

  useEffect(() => {
    setState(props.initial);
    if (!isTerminalStatus(props.initial.status)) {
      setStreamEnabled(true);
    }
  }, [props.extractionId, props.initial]);

  async function waitForExtractionIdle(maxMs = 30 * 60 * 1000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxMs) {
      const response = await fetch(`/api/extractions/${props.extractionId}/status`, { cache: "no-store" });
      const payload = (await response.json()) as ExtractionProgress & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao consultar status da extracao.");
      }
      setState(payload);
      if (isTerminalStatus(payload.status) && !hasActiveBackgroundWork(payload)) {
        return;
      }
      await delay(2000);
    }
    throw new Error("Timeout aguardando conclusao da etapa automatizada.");
  }

  async function runAutomatedStep(step: ActionStep) {
    if (!props.evidenceId) throw new Error("Evidencia ausente para automacao.");
    const startedAt = Date.now();
    setBusyAction(step);
    setActionError(null);

    try {
      if (step === "reprocess") {
        setStreamEnabled(true);
        setState((prev) => ({ ...prev, phase: "requeued", progress: 0, status: "PENDING" }));
        const response = await fetch(`/api/evidences/${props.evidenceId}/reprocess`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcriptionRuntime: {
              enabled: true,
              engine: transcriptionEngine,
              model: transcriptionModel,
              language: transcriptionLanguage.trim() || undefined
            },
            aiRuntime: {
              engine: aiEngine,
              model: aiModel
            }
          })
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Falha ao reprocessar.");
        await waitForExtractionIdle();
      }

      if (step === "enrich") {
        setStreamEnabled(true);
        setState((prev) => ({ ...prev, phase: "enrich-iniciando", progress: 0, status: "PROCESSING" }));
        const response = await fetch(`/api/evidences/${props.evidenceId}/enrich`, { method: "POST" });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Falha ao enriquecer.");
        await waitForExtractionIdle();
      }

      if (step === "indexpaths") {
        setState((prev) => ({ ...prev, phase: "indexpaths-executando", progress: 20 }));
        const response = await fetch(`/api/evidences/${props.evidenceId}/index-attachment-paths`, { method: "POST" });
        const payload = (await response.json()) as {
          error?: string;
          processed?: number;
          totalPending?: number;
          totalAttachments?: number;
        };
        if (!response.ok) throw new Error(payload.error ?? "Falha ao indexar caminhos.");
        const total = payload.totalAttachments ?? state.stats?.attachments ?? payload.totalPending ?? 0;
        const processed = Math.min(total, payload.processed ?? 0);
        setIndexPathsProgress({ total, processed });
        setState((prev) => ({ ...prev, phase: "indexpaths-concluido", progress: 100 }));
      }

      if (step === "relink") {
        setState((prev) => ({ ...prev, phase: "relink-executando", progress: 20 }));
        const response = await fetch(`/api/evidences/${props.evidenceId}/relink`, { method: "POST" });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Falha ao recalcular vinculos.");
        setState((prev) => ({ ...prev, phase: "relink-concluido", progress: 100 }));
      }

      if (step === "retranscribe") {
        const done = state.stats?.transcriptions;
        if (
          done &&
          done.total > 0 &&
          done.completed >= done.total &&
          done.pending === 0 &&
          done.processing === 0
        ) {
          return;
        }
        setStreamEnabled(true);
        setState((prev) => ({ ...prev, phase: "retranscription-queued", progress: prev.progress || 100 }));
        const response = await fetch(`/api/evidences/${props.evidenceId}/retranscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            engine: transcriptionEngine,
            model: transcriptionModel,
            language: transcriptionLanguage.trim() || undefined
          })
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Falha ao retranscrever.");
        await waitForExtractionIdle();
      }
    } finally {
      setOperationDurationMs((prev) => ({
        ...prev,
        [step]: Date.now() - startedAt
      }));
      setBusyAction(null);
    }
  }

  const { autoChainRunning, autoChainCompleted, autoChainCurrentStep, autoChainFailedStep, runAutomatedChain } =
    useAutomatedChain<ActionStep>({
      evidenceId: props.evidenceId,
      steps: AUTO_CHAIN_STEPS,
      shouldAutoStart: false,
      runStep: runAutomatedStep,
      onStepError: (step, error) => {
        setActionError(
          error instanceof Error
            ? `Fluxo automatizado falhou em ${AUTO_CHAIN_STEP_LABEL[step]}: ${error.message}`
            : `Fluxo automatizado falhou em ${AUTO_CHAIN_STEP_LABEL[step]}.`
        );
      },
      onCompleted: () => {
        setActionError(null);
        router.refresh();
      }
    });

  async function fetchTranscriptionEstimate() {
    if (!props.evidenceId) return null;
    const response = await fetch(`/api/evidences/${props.evidenceId}/transcription-estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: transcriptionEngine,
        model: transcriptionModel,
        aiEngine,
        aiModel
      })
    });
    const payload = (await response.json()) as EstimateResponse;
    if (!response.ok) throw new Error(payload.error ?? "Falha ao estimar processamento.");
    setEstimate(payload);
    return payload;
  }

  async function onEstimate() {
    setEstimating(true);
    setActionError(null);
    try {
      await fetchTranscriptionEstimate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao estimar.");
    } finally {
      setEstimating(false);
    }
  }

  async function onSendToCoreHub() {
    const confirmed = window.confirm("Enviar esta extração para o CORE HUB agora?");
    if (!confirmed) return;

    setCoreHubExporting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/extractions/${props.extractionId}/core-hub-export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true })
      });
      const payload = (await response.json()) as { error?: string; skipped?: boolean; reason?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao enviar para CORE HUB.");

      if (payload.skipped) {
        window.alert(`Exportação para CORE HUB ignorada: ${payload.reason ?? "motivo não informado"}.`);
      } else {
        window.alert("Extração enviada para o CORE HUB com sucesso.");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao enviar para CORE HUB.");
    } finally {
      setCoreHubExporting(false);
    }
  }

  async function onReprocess() {
    if (!props.evidenceId) return;
    try {
      const currentEstimate = estimate ?? (await fetchTranscriptionEstimate());
      const confirmed = window.confirm(
        [
          "Reprocessar COMPLETO esta evidencia?",
          `Transcricao: ${transcriptionEngine}/${transcriptionModel}`,
          `IA: ${aiEngine}/${aiModel}`,
          `Audios indexados: ${currentEstimate?.audioIndexing?.attachmentCount ?? 0}`,
          `Duracao total audio: ${currentEstimate?.audioIndexing?.totalDurationMin?.toFixed(2) ?? "0.00"} min`,
          `Custo transcricao: ${formatUsd(currentEstimate?.estimate?.estimatedCostUsd)}`,
          `Custo IA: ${formatUsd(currentEstimate?.aiEstimate?.estimatedCostUsd)}`
        ].join("\n")
      );
      if (!confirmed) return;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao estimar.");
      return;
    }

    setBusyAction("reprocess");
    const startedAt = Date.now();
    setActionError(null);
    setStreamEnabled(true);
    setState((prev) => ({ ...prev, phase: "requeued", progress: 0, status: "PENDING" }));
    try {
      const response = await fetch(`/api/evidences/${props.evidenceId}/reprocess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcriptionRuntime: {
            enabled: true,
            engine: transcriptionEngine,
            model: transcriptionModel,
            language: transcriptionLanguage.trim() || undefined
          },
          aiRuntime: {
            engine: aiEngine,
            model: aiModel
          }
        })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao reprocessar.");
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao reprocessar.");
    } finally {
      setOperationDurationMs((prev) => ({ ...prev, reprocess: Date.now() - startedAt }));
      setBusyAction(null);
    }
  }

  async function onRetranscribe() {
    if (!props.evidenceId) return;
    const confirmed = window.confirm(
      [
        "Reprocessar apenas transcricoes de audio desta evidencia?",
        `Transcricao: ${transcriptionEngine}/${transcriptionModel}`,
        estimate?.audioIndexing ? `Audios indexados: ${estimate.audioIndexing.attachmentCount}` : "Audios indexados: calculo sob demanda",
        estimate?.audioIndexing
          ? `Duracao total: ${estimate.audioIndexing.totalDurationMin.toFixed(2)} min`
          : "Duracao total: use 'Atualizar estimativa de custo' para calcular",
        estimate ? `Custo transcricao: ${formatUsd(estimate?.estimate?.estimatedCostUsd)}` : "Custo: estimativa opcional"
      ].join("\n")
    );
    if (!confirmed) return;

    setBusyAction("retranscribe");
    const startedAt = Date.now();
    setActionError(null);
    setStreamEnabled(true);
    setState((prev) => ({ ...prev, phase: "retranscription-queued", progress: prev.progress || 100 }));
    try {
      const response = await fetch(`/api/evidences/${props.evidenceId}/retranscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: transcriptionEngine,
          model: transcriptionModel,
          language: transcriptionLanguage.trim() || undefined
        })
      });
      const payload = (await response.json()) as {
        error?: string;
        jobsQueued?: number;
        preservedCompleted?: number;
        preservedProcessing?: number;
        resetFailedOrPending?: number;
        createdNew?: number;
        transcriptionRuntime?: { engine?: string; model?: string };
      };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao retranscrever.");
      window.alert(
        [
          "Transcricao reenfileirada.",
          `Runtime: ${payload.transcriptionRuntime?.engine ?? transcriptionEngine}/${payload.transcriptionRuntime?.model ?? transcriptionModel}`,
          `Jobs enfileirados: ${payload.jobsQueued ?? 0}`,
          `Concluidos preservados: ${payload.preservedCompleted ?? 0}`,
          `Em processamento preservados: ${payload.preservedProcessing ?? 0}`,
          `Reset pendente/falha: ${payload.resetFailedOrPending ?? 0}`,
          `Novos criados: ${payload.createdNew ?? 0}`
        ].join("\n")
      );
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao retranscrever.");
    } finally {
      setOperationDurationMs((prev) => ({
        ...prev,
        retranscribe: Date.now() - startedAt
      }));
      setBusyAction(null);
    }
  }

  async function onResume() {
    if (!props.evidenceId) return;
    const confirmed = window.confirm(
      "Retomar processamento desta evidencia a partir do ponto salvo? Use isto quando o HD/Windows desconectou ou o worker caiu."
    );
    if (!confirmed) return;

    setBusyAction("resume");
    const startedAt = Date.now();
    setActionError(null);
    setStreamEnabled(true);
    setState((prev) => ({ ...prev, phase: "resume-queued", progress: prev.progress || 0, status: "PROCESSING" }));
    try {
      const response = await fetch(`/api/evidences/${props.evidenceId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "audio-recovery" })
      });
      const payload = (await response.json()) as {
        error?: string;
        extractionId?: string;
        queuedBatches?: number;
        queued?: boolean;
      };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao retomar processamento.");
      window.alert(
        payload.queuedBatches
          ? `Resume iniciado. Batches reenfileirados: ${payload.queuedBatches}.`
          : payload.queued
            ? "Resume iniciado. Ingestao reenfileirada."
            : "Resume solicitado."
      );
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao retomar processamento.");
    } finally {
      setOperationDurationMs((prev) => ({ ...prev, resume: Date.now() - startedAt }));
      setBusyAction(null);
    }
  }

  async function onEnrich() {
    if (!props.evidenceId) return;
    const confirmed = window.confirm(
      "Enriquecer metadados? Atualiza dispositivo/contas/localizacoes/timeline sem alterar chats e transcricoes."
    );
    if (!confirmed) return;
    setBusyAction("enrich");
    const startedAt = Date.now();
    setActionError(null);
    setStreamEnabled(true);
    setState((prev) => ({ ...prev, phase: "enrich-iniciando", progress: 0, status: "PROCESSING" }));
    try {
      const response = await fetch(`/api/evidences/${props.evidenceId}/enrich`, { method: "POST" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao enriquecer.");
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao enriquecer.");
    } finally {
      setOperationDurationMs((prev) => ({ ...prev, enrich: Date.now() - startedAt }));
      setBusyAction(null);
    }
  }

  async function onRelink() {
    if (!props.evidenceId) return;
    const confirmed = window.confirm("Recalcular vinculos de audio para mensagens?");
    if (!confirmed) return;
    setBusyAction("relink");
    const startedAt = Date.now();
    setActionError(null);
    setState((prev) => ({ ...prev, phase: "relink-executando", progress: 20 }));
    try {
      const response = await fetch(`/api/evidences/${props.evidenceId}/relink`, { method: "POST" });
      const payload = (await response.json()) as { error?: string; scanned?: number; relinked?: number; unchanged?: number; unlinked?: number };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao recalcular vinculos.");
      setState((prev) => ({ ...prev, phase: "relink-concluido", progress: 100 }));
      window.alert(
        `Recalculo concluido. Audios analisados: ${payload.scanned ?? 0} | Relinkados: ${payload.relinked ?? 0} | Sem alteracao: ${payload.unchanged ?? 0} | Sem match: ${payload.unlinked ?? 0}`
      );
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao recalcular vinculos.");
    } finally {
      setOperationDurationMs((prev) => ({ ...prev, relink: Date.now() - startedAt }));
      setBusyAction(null);
    }
  }

  async function onIndexAttachmentPaths() {
    if (!props.evidenceId) return;
    const confirmed = window.confirm("Indexar caminhos de anexos no UFDR?");
    if (!confirmed) return;
    setBusyAction("indexpaths");
    const startedAt = Date.now();
    setActionError(null);
    setState((prev) => ({ ...prev, phase: "indexpaths-executando", progress: 20 }));
    try {
      const response = await fetch(`/api/evidences/${props.evidenceId}/index-attachment-paths`, { method: "POST" });
      const payload = (await response.json()) as {
        error?: string;
        processed?: number;
        totalPending?: number;
        totalAttachments?: number;
        indexed?: number;
        unresolved?: number;
      };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao indexar caminhos.");
      const total = payload.totalAttachments ?? state.stats?.attachments ?? payload.totalPending ?? 0;
      const processed = Math.min(total, payload.processed ?? 0);
      setIndexPathsProgress({ total, processed });
      setState((prev) => ({ ...prev, phase: "indexpaths-concluido", progress: 100 }));
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao indexar caminhos.");
    } finally {
      setOperationDurationMs((prev) => ({
        ...prev,
        indexpaths: Date.now() - startedAt
      }));
      setBusyAction(null);
    }
  }

  useEffect(() => {
    if (!streamEnabled) return;
    const source = new EventSource(`/api/extractions/${props.extractionId}/stream`);
    sourceRef.current = source;

    const onProgress = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as ExtractionProgress;
      setState(payload);
      if (isTerminalStatus(payload.status) && !hasActiveBackgroundWork(payload)) {
        setStreamEnabled(false);
        source.close();
      }
    };

    source.addEventListener("progress", onProgress);
    source.addEventListener("done", onProgress);
    source.onerror = () => {
      source.close();
      setStreamEnabled(false);
    };

    return () => source.close();
  }, [props.extractionId, streamEnabled]);

  useEffect(() => {
    if (streamEnabled) return;
    let cancelled = false;

    const pollUntilResumeVisible = async () => {
      try {
        const response = await fetch(`/api/extractions/${props.extractionId}/status`, { cache: "no-store" });
        const payload = (await response.json()) as ExtractionProgress & { error?: string };
        if (!response.ok || cancelled) return;
        setState(payload);

        // If resume/reprocess happened outside this tab, restart live stream automatically.
        if (!isTerminalStatus(payload.status) || hasActiveBackgroundWork(payload)) {
          setStreamEnabled(true);
        }
      } catch {
        // Keep polling; transient network/route errors should self-heal.
      }
    };

    void pollUntilResumeVisible();
    const interval = setInterval(() => {
      void pollUntilResumeVisible();
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [props.extractionId, streamEnabled]);

  const transcriptionPending = state.stats?.transcriptions?.pending ?? 0;
  const transcriptionProcessing = state.stats?.transcriptions?.processing ?? 0;
  const transcriptionCompleted = state.stats?.transcriptions?.completed ?? 0;
  const transcriptionFailed = state.stats?.transcriptions?.failed ?? 0;
  const transcriptionTotal = state.stats?.transcriptions?.total ?? 0;
  const transcriptionPolicyDiscarded = state.stats?.transcriptions?.policyDiscarded ?? 0;
  const transcriptionRealFailed = state.stats?.transcriptions?.realFailed ?? transcriptionFailed;
  const transcriptionEligible = state.stats?.transcriptions?.eligible ?? transcriptionTotal;
  const transcriptionProcessed = transcriptionCompleted + transcriptionRealFailed;
  const transcriptionProgress =
    transcriptionTotal > 0
      ? (Math.min(transcriptionProcessed, transcriptionTotal) / transcriptionTotal) * 100
      : isTerminalStatus(state.status)
        ? 100
        : 0;

  const aiExpected = state.stats?.aiClassification?.expectedFromCompletedTranscriptions ?? 0;
  const aiCompleted = state.stats?.aiClassification?.completed ?? 0;
  const aiProgress =
    aiExpected > 0 ? (Math.min(aiCompleted, aiExpected) / aiExpected) * 100 : isTerminalStatus(state.status) ? 100 : 0;

  const indexTotalAttachments = indexPathsProgress?.total ?? state.stats?.attachments ?? 0;
  const indexProcessedAttachments =
    indexPathsProgress?.processed ?? (state.phase === "indexpaths-concluido" ? indexTotalAttachments : 0);
  const indexAttachmentsProgress =
    indexTotalAttachments > 0 ? (Math.min(indexProcessedAttachments, indexTotalAttachments) / indexTotalAttachments) * 100 : 0;

  const processingIsIdle = transcriptionPending === 0 && transcriptionProcessing === 0;
  const audioExtractedLive = state.diagnostics?.audio?.extractedCount;
  const audioTotalLive = state.diagnostics?.audio?.maxFiles;
  const audioEtaLive = state.diagnostics?.audio?.etaSec;
  const audioRateLive = state.diagnostics?.audio?.ratePerMin;
  const totalProgress =
    isTerminalStatus(state.status) && processingIsIdle
      ? 100
      : clampProgress(state.progress * 0.55 + transcriptionProgress * 0.3 + aiProgress * 0.15);

  const busyLabel: Record<ManualAction, string> = {
    reprocess: "Reprocessamento completo",
    enrich: "Enriquecimento de metadados",
    indexpaths: "Indexacao de caminhos de anexos",
    relink: "Recalculo de vinculos",
    retranscribe: "Transcricao de audios",
    resume: "Retomada de processamento"
  };

  let currentProcessLabel = "Concluido";
  let currentProcessProgress = 100;

  if (busyAction) {
    currentProcessLabel = busyLabel[busyAction];
    if (busyAction === "indexpaths") {
      currentProcessProgress = clampProgress(Math.max(2, indexAttachmentsProgress));
    } else if (busyAction === "retranscribe") {
      currentProcessProgress = clampProgress(transcriptionProgress);
    } else if (busyAction === "relink") {
      currentProcessProgress = clampProgress(state.phase === "relink-concluido" ? 100 : Math.max(10, state.progress));
    } else {
      currentProcessProgress = clampProgress(state.progress);
    }
  } else if (!isTerminalStatus(state.status)) {
    currentProcessLabel = humanizePhase(state.phase);
    currentProcessProgress = clampProgress(state.progress);
  } else if (transcriptionPending > 0 || transcriptionProcessing > 0) {
    currentProcessLabel = "Transcricao de audios";
    currentProcessProgress = clampProgress(transcriptionProgress);
  }

  const hasCriticalAlert = Boolean(state.operationalAlerts?.some((alert) => alert.severity === "CRITICAL"));
  const hasWarningAlert = Boolean(state.operationalAlerts?.some((alert) => alert.severity === "WARN"));

  const totalProgressIndicatorClass =
    state.status === "FAILED" || hasCriticalAlert
      ? "bg-red-600"
      : totalProgress >= 100
        ? "bg-emerald-600"
        : hasWarningAlert || transcriptionFailed > 0
          ? "bg-amber-500"
          : "bg-blue-700";

  const currentProgressIndicatorClass =
    currentProcessLabel === "Concluido"
      ? "bg-emerald-600"
      : state.status === "FAILED" || hasCriticalAlert
        ? "bg-red-600"
        : hasWarningAlert
          ? "bg-amber-500"
          : "bg-blue-700";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span>Processamento total</span>
        <span>{Math.round(totalProgress)}%</span>
      </div>
      <Progress value={totalProgress} indicatorClassName={totalProgressIndicatorClass} />
      <div className="space-y-1 pt-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span>Processo atual: {currentProcessLabel}</span>
          <span>{Math.round(currentProcessProgress)}%</span>
        </div>
        <Progress value={currentProcessProgress} indicatorClassName={currentProgressIndicatorClass} />
      </div>
      {typeof audioExtractedLive === "number" || typeof audioTotalLive === "number" ? (
        <p className="pt-1 text-xs text-zinc-700">
          Extracao de audio: {audioExtractedLive ?? 0}/{audioTotalLive ?? 0}
          {typeof audioRateLive === "number" ? ` | taxa: ${audioRateLive.toFixed(2)}/min` : ""}
          {typeof audioEtaLive === "number" ? ` | ETA: ${formatEtaSec(audioEtaLive)}` : ""}
        </p>
      ) : null}
      {state.stats?.transcriptions ? (
        <p className="pt-1 text-xs text-zinc-600">
          Transcricoes elegiveis: {transcriptionProcessed}/{transcriptionEligible} processadas ({transcriptionCompleted} concluidas, {transcriptionRealFailed} falhas reais, {transcriptionPending} pendentes, {transcriptionProcessing} em execucao)
          {transcriptionPolicyDiscarded > 0 ? ` | descartadas por politica: ${transcriptionPolicyDiscarded}` : ""}
        </p>
      ) : null}
      {state.stats?.aiClassification ? (
        <p className="text-xs text-zinc-600">
          Classificacao IA: {aiCompleted}/{aiExpected} ({Math.round(aiProgress)}%)
        </p>
      ) : null}
      {state.reportError ? <p className="text-xs text-red-700">{state.reportError}</p> : null}
      {state.operationalAlerts && state.operationalAlerts.length > 0 ? (
        <div className="space-y-1 pt-1">
          {state.operationalAlerts.map((alert) => (
            <div key={alert.code} className="flex items-center gap-2 text-xs">
              <span
                className={
                  alert.severity === "CRITICAL"
                    ? "rounded bg-red-100 px-1.5 py-0.5 text-red-800"
                    : alert.severity === "WARN"
                      ? "rounded bg-amber-100 px-1.5 py-0.5 text-amber-800"
                      : "rounded bg-blue-100 px-1.5 py-0.5 text-blue-800"
                }
              >
                {alert.severity}
              </span>
              <span
                className={
                  alert.severity === "CRITICAL"
                    ? "text-red-700"
                    : alert.severity === "WARN"
                      ? "text-amber-700"
                      : "text-blue-700"
                }
              >
                {alert.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {state.diagnostics ? (
        <div className="pt-1 text-xs text-zinc-600">
          {typeof state.diagnostics.filesScanned === "number" ? <p>Arquivos no UFDR: {state.diagnostics.filesScanned}</p> : null}
          {state.diagnostics.parserMode ? <p>Parser: {state.diagnostics.parserMode}</p> : null}
          {typeof state.diagnostics.ingestTimingsMs?.total === "number" ? (
            <p>Tempo ingestao: {(state.diagnostics.ingestTimingsMs.total / 1000).toFixed(1)}s</p>
          ) : null}
          {state.diagnostics.audio ? (
            <>
              <p>
                Audios: {state.diagnostics.audio.extractedCount ?? 0}/{state.diagnostics.audio.maxFiles ?? 0}
                {state.diagnostics.audio.capReached ? " (limite atingido)" : ""}
              </p>
              {state.diagnostics.audio.recovery?.async ? (
                <p>
                  Recovery: {state.diagnostics.audio.recovery.batchProcessed ?? 0}/
                  {state.diagnostics.audio.recovery.batchTotal ?? 0} lotes | recuperados{" "}
                  {state.diagnostics.audio.recovery.extractedCount ?? 0} | jobs transcricao{" "}
                  {state.diagnostics.audio.transcriptionJobs ?? 0}
                </p>
              ) : null}
            </>
          ) : null}
          {state.diagnostics.parserDropped &&
          ((state.diagnostics.parserDropped.messages ?? 0) > 0 ||
            (state.diagnostics.parserDropped.chats ?? 0) > 0 ||
            (state.diagnostics.parserDropped.audioFiles ?? 0) > 0) ? (
            <p>
              Parser descartou: chats {state.diagnostics.parserDropped.chats ?? 0}, mensagens{" "}
              {state.diagnostics.parserDropped.messages ?? 0}, audios {state.diagnostics.parserDropped.audioFiles ?? 0}
            </p>
          ) : null}
        </div>
      ) : null}
      {props.evidenceId ? (
        <div className="space-y-2 pt-2">
          {showReprocessControls ? (
          <div className="space-y-2 rounded border border-zinc-200 p-2">
            {autoChainRunning ? (
              <p className="text-xs text-zinc-700">
                Fluxo automatico em andamento{autoChainCurrentStep ? `: ${AUTO_CHAIN_STEP_LABEL[autoChainCurrentStep]}` : ""}.
              </p>
            ) : null}
            {autoChainCompleted ? <p className="text-xs text-emerald-700">Fluxo automatizado concluido.</p> : null}
            {autoChainFailedStep ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-amber-700">
                  Fluxo pausado na etapa {AUTO_CHAIN_STEP_LABEL[autoChainFailedStep]}.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyAction !== null || autoChainRunning}
                  onClick={() => void runAutomatedChain(AUTO_CHAIN_STEPS.indexOf(autoChainFailedStep))}
                >
                  Retomar etapa
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-zinc-500">
              Duracoes: reprocessar {formatElapsedMs(operationDurationMs.reprocess)} | enriquecer {formatElapsedMs(operationDurationMs.enrich)} | indexar {formatElapsedMs(operationDurationMs.indexpaths)} | vinculos {formatElapsedMs(operationDurationMs.relink)} | transcrever {formatElapsedMs(operationDurationMs.retranscribe)}
            </p>
          </div>
          ) : null}

          <div className="rounded border border-zinc-200 p-2">
            <p className="text-xs font-medium text-zinc-700">Acoes seguras</p>
            <p className="mt-1 text-[11px] text-zinc-500">
              Reprocessamento completo e retranscricao manual foram ocultados nesta tela para evitar disparos acidentais.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || !props.evidenceId}
                onClick={onResume}
              >
                {busyAction === "resume" ? "Retomando..." : "Retomar processamento"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busyAction !== null} onClick={onEnrich}>
                {busyAction === "enrich" ? "Enriquecendo..." : "Enriquecer metadados"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null}
                onClick={onIndexAttachmentPaths}
              >
                {busyAction === "indexpaths" ? "Indexando..." : "Indexar caminhos"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busyAction !== null} onClick={onRelink}>
                {busyAction === "relink" ? "Recalculando..." : "Recalcular vinculos"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || coreHubExporting}
                onClick={onSendToCoreHub}
              >
                {coreHubExporting ? "Enviando ao CORE HUB..." : "Enviar ao CORE HUB"}
              </Button>
            </div>
          </div>

          {showReprocessControls ? (
          <div className="rounded border border-zinc-200 p-2">
            <p className="text-xs font-medium text-zinc-700">Runtime de reprocessamento (transcricao + IA)</p>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-medium text-zinc-600">Transcricao de audio</p>
                  {!providerAvailability.openai ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">OpenAI sem chave</span>
                  ) : null}
                  {!providerAvailability.assemblyai ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">AssemblyAI sem chave</span>
                  ) : null}
                </div>
                <select
                  value={transcriptionEngine}
                  onChange={(event) => setTranscriptionEngine(event.target.value as TranscriptionEngine)}
                  className="w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                  disabled={busyAction !== null}
                >
                  <option value="local">Local</option>
                  <option value="openai" disabled={!providerAvailability.openai}>
                    OpenAI API {!providerAvailability.openai ? "(indisponivel: sem chave)" : ""}
                  </option>
                  <option value="assemblyai" disabled={!providerAvailability.assemblyai}>
                    AssemblyAI API {!providerAvailability.assemblyai ? "(indisponivel: sem chave)" : ""}
                  </option>
                </select>
                <select
                  value={transcriptionModel}
                  onChange={(event) => setTranscriptionModel(event.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                  disabled={busyAction !== null}
                >
                  {(
                    transcriptionEngine === "openai"
                      ? OPENAI_TRANSCRIPTION_MODELS
                      : transcriptionEngine === "assemblyai"
                        ? ASSEMBLYAI_TRANSCRIPTION_MODELS
                        : LOCAL_TRANSCRIPTION_MODELS
                  ).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={transcriptionLanguage}
                  onChange={(event) => setTranscriptionLanguage(event.target.value)}
                  placeholder="Idioma opcional (pt, en...)"
                  className="w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                  disabled={busyAction !== null}
                />
                {transcriptionEngine === "openai" ? (
                  <p className="text-[11px] text-zinc-500">Chave OpenAI usada: Configuracoes do sistema (banco).</p>
                ) : transcriptionEngine === "assemblyai" ? (
                  <p className="text-[11px] text-zinc-500">Chave AssemblyAI usada: Configuracoes do sistema (banco).</p>
                ) : null}
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-medium text-zinc-600">IA (estimativa e runtime da analise)</p>
                  {!providerAvailability.openai ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">OpenAI sem chave</span>
                  ) : null}
                </div>
                <select
                  value={aiEngine}
                  onChange={(event) => setAiEngine(event.target.value as AiEngine)}
                  className="w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                  disabled={busyAction !== null}
                >
                  <option value="local">Local</option>
                  <option value="openai" disabled={!providerAvailability.openai}>
                    OpenAI API {!providerAvailability.openai ? "(indisponivel: sem chave)" : ""}
                  </option>
                </select>
                <select
                  value={aiModel}
                  onChange={(event) => setAiModel(event.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1 text-xs"
                  disabled={busyAction !== null}
                >
                  {aiEngine === "local" ? (
                    <option value="local-heuristic-v1">local-heuristic-v1</option>
                  ) : (
                    OPENAI_CHAT_MODELS.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  )}
                </select>
                {aiEngine === "openai" ? (
                  <p className="text-[11px] text-zinc-500">Chave OpenAI usada: Configuracoes do sistema (banco).</p>
                ) : null}
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busyAction !== null || autoChainRunning}
                onClick={() => void runAutomatedChain(0)}
              >
                {autoChainRunning ? "Fluxo automatizado em execucao..." : "Executar fluxo automatizado"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busyAction !== null || autoChainRunning} onClick={onReprocess}>
                {busyAction === "reprocess" ? "Reprocessando..." : "Reprocessar completo"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || autoChainRunning || !props.evidenceId}
                onClick={onResume}
              >
                {busyAction === "resume" ? "Retomando..." : "Retomar processamento"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || autoChainRunning}
                onClick={onEnrich}
              >
                {busyAction === "enrich" ? "Enriquecendo..." : "Enriquecer metadados"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || autoChainRunning}
                onClick={onIndexAttachmentPaths}
              >
                {busyAction === "indexpaths" ? "Indexando..." : "Indexar caminhos"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || autoChainRunning}
                onClick={onRelink}
              >
                {busyAction === "relink" ? "Recalculando..." : "Recalcular vinculos"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || autoChainRunning}
                onClick={onRetranscribe}
              >
                {busyAction === "retranscribe" ? "Transcrevendo..." : "Reprocessar transcricoes"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busyAction !== null || estimating} onClick={onEstimate}>
                {estimating ? "Estimando..." : "Atualizar estimativa de custo"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || autoChainRunning || coreHubExporting}
                onClick={onSendToCoreHub}
              >
                {coreHubExporting ? "Enviando ao CORE HUB..." : "Enviar ao CORE HUB"}
              </Button>
              {estimate?.audioIndexing ? (
                <p className="text-xs text-zinc-600">
                  Audios: {estimate.audioIndexing.attachmentCount} | Duracao total: {estimate.audioIndexing.totalDurationMin.toFixed(2)} min
                </p>
              ) : null}
            </div>
            {estimate ? (
              <div className="mt-2 grid gap-2 text-xs md:grid-cols-2">
                <div className="rounded border border-zinc-200 p-2">
                  <p className="font-medium">Transcricao</p>
                  <p>Tokens saida estimados: {estimate.estimate?.estimatedOutputTokens ?? 0}</p>
                  <p>Tempo: {estimate.estimate?.estimatedTimeMinutes?.toFixed(2) ?? "0.00"} min</p>
                  <p>Custo: {formatUsd(estimate.estimate?.estimatedCostUsd)}</p>
                </div>
                <div className="rounded border border-zinc-200 p-2">
                  <p className="font-medium">IA ({aiEngine === "openai" ? "GPT 4.1 - 5.3" : "local"})</p>
                  <p>Tokens entrada: {estimate.aiEstimate?.estimatedInputTokens ?? 0}</p>
                  <p>Tokens saida: {estimate.aiEstimate?.estimatedOutputTokens ?? 0}</p>
                  <p>Total tokens: {estimate.aiEstimate?.estimatedTotalTokens ?? 0}</p>
                  <p>Tempo: {estimate.aiEstimate?.estimatedTimeMinutes?.toFixed(2) ?? "0.00"} min</p>
                  <p>Custo: {formatUsd(estimate.aiEstimate?.estimatedCostUsd)}</p>
                </div>
              </div>
            ) : null}
          </div>
          ) : null}

          {actionError ? <p className="pt-1 text-xs text-red-700">{actionError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
