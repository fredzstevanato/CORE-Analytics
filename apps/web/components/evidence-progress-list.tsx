"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAutomatedChain } from "@/components/hooks/use-automated-chain";

type ExtractionProgress = {
  id: string;
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
  stats?: {
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
  };
};

type EvidenceItem = {
  id: string;
  fileName: string;
  caseTitle: string;
  extraction: ExtractionProgress | null;
};

type TranscriptionEngine = "local" | "openai" | "assemblyai";
type AiEngine = "local" | "openai";
type TranscriptionProviderAvailability = {
  local: boolean;
  openai: boolean;
  assemblyai: boolean;
};
type ActionStep = "reprocess" | "enrich" | "indexpaths" | "relink" | "retranscribe";
type BusyAction = "reprocess" | "retranscribe" | "relink" | "indexpaths" | "enrich" | "resume" | "delete" | "hardReset";

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

const ACTION_LABELS: Record<BusyAction, string> = {
  reprocess: "Reprocessar completo",
  retranscribe: "Transcrever audios",
  relink: "Recalcular vinculos",
  indexpaths: "Indexar caminhos de anexos",
  enrich: "Enriquecer metadados",
  resume: "Retomar processamento",
  delete: "Excluir evidencia",
  hardReset: "Reset UFDR (hard reset)"
};

const AUTO_CHAIN_STEPS: ActionStep[] = ["reprocess", "enrich", "indexpaths", "relink", "retranscribe"];
const AUTO_CHAIN_STEP_LABEL: Record<ActionStep, string> = {
  reprocess: "1. Reprocessar Completo",
  enrich: "2. Enriquecer Metadados",
  indexpaths: "3. Indexar Caminhos de Anexos",
  relink: "4. Recalcular Vinculos",
  retranscribe: "5. Transcrever Audios"
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function EvidenceRow({ item }: { item: EvidenceItem }) {
  const router = useRouter();
  const [state, setState] = useState<ExtractionProgress | null>(item.extraction);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  const [estimate, setEstimate] = useState<{
    audioIndexing?: { attachmentCount: number; totalDurationMin: number };
    estimate?: { estimatedOutputTokens: number; estimatedTimeMinutes: number; estimatedCostUsd: number | null };
    aiEstimate?: { estimatedCostUsd: number | null };
  } | null>(null);

  useEffect(() => {
    const runtime = state?.transcriptionRuntime;
    if (!runtime?.engine) return;
    setTranscriptionEngine(runtime.engine);
    if (runtime.model) setTranscriptionModel(runtime.model);
    setTranscriptionLanguage(runtime.language ?? "");
  }, [state?.transcriptionRuntime?.engine, state?.transcriptionRuntime?.model, state?.transcriptionRuntime?.language]);

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

  async function fetchTranscriptionEstimate() {
    const response = await fetch(`/api/evidences/${item.id}/transcription-estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: transcriptionEngine,
        model: transcriptionModel,
        aiEngine,
        aiModel
      })
    });
    const payload = (await response.json()) as {
      error?: string;
      audioIndexing?: {
        attachmentCount: number;
        totalDurationMin: number;
      };
      estimate?: {
        estimatedOutputTokens: number;
        estimatedTimeMinutes: number;
        estimatedCostUsd: number | null;
      };
      aiEstimate?: {
        estimatedCostUsd: number | null;
      };
    };
    if (!response.ok) {
      throw new Error(payload.error ?? "Falha ao estimar reprocessamento de transcricao.");
    }
    setEstimate(payload);
    return payload;
  }

  useEffect(() => {
    if (!state) return;
    if ((state.status === "COMPLETED" || state.status === "FAILED") && state.stats?.transcriptions) return;

    const source = new EventSource(`/api/extractions/${state.id}/stream`);

    const onProgress = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as ExtractionProgress;
        setState(payload);
        const transcriptionsPending = payload.stats?.transcriptions?.pending ?? 0;
        const transcriptionsProcessing = payload.stats?.transcriptions?.processing ?? 0;
        const hasActiveBackgroundWork = transcriptionsPending > 0 || transcriptionsProcessing > 0;
        if ((payload.status === "COMPLETED" || payload.status === "FAILED") && !hasActiveBackgroundWork) {
          source.close();
        }
      } catch {
        source.close();
      }
    };

    source.addEventListener("progress", onProgress);
    source.addEventListener("done", onProgress);
    source.onerror = () => source.close();

    return () => source.close();
  }, [state?.id, state?.status]);

  async function waitForExtractionIdle(extractionId: string, maxMs = 30 * 60 * 1000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxMs) {
      const response = await fetch(`/api/extractions/${extractionId}/status`, { cache: "no-store" });
      const payload = (await response.json()) as ExtractionProgress & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao consultar status da extracao.");
      }
      setState(payload);
      const transcriptionsPending = payload.stats?.transcriptions?.pending ?? 0;
      const transcriptionsProcessing = payload.stats?.transcriptions?.processing ?? 0;
      const hasActiveBackgroundWork = transcriptionsPending > 0 || transcriptionsProcessing > 0;
      if ((payload.status === "COMPLETED" || payload.status === "FAILED") && !hasActiveBackgroundWork) {
        return;
      }
      await delay(2000);
    }
    throw new Error("Timeout aguardando conclusao da etapa automatizada.");
  }

  async function runAutomatedStep(step: ActionStep) {
    if (!state) throw new Error("Extracao indisponivel para automacao.");
    const startedAt = Date.now();
    setBusyAction(step);
    setActionError(null);

    try {
      if (step === "reprocess") {
        setState((prev) => (prev ? { ...prev, phase: "requeued", progress: 0, status: "PENDING" } : prev));
        const response = await fetch(`/api/evidences/${item.id}/reprocess`, {
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
        const payload = (await response.json()) as { extractionId?: string; error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Falha ao reprocessar evidencia.");
        }
        const extractionId = payload.extractionId ?? state.id;
        setState((prev) =>
          prev
            ? {
                ...prev,
                id: extractionId,
                status: "PENDING",
                phase: "requeued",
                progress: 0,
                reportError: null
              }
            : prev
        );
        await waitForExtractionIdle(extractionId);
      }

      if (step === "enrich") {
        setState((prev) => (prev ? { ...prev, phase: "enrich-iniciando", progress: 0, status: "PROCESSING" } : prev));
        const response = await fetch(`/api/evidences/${item.id}/enrich`, { method: "POST" });
        const payload = (await response.json()) as { extractionId?: string; error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Falha ao enriquecer metadados.");
        }
        await waitForExtractionIdle(payload.extractionId ?? state.id);
      }

      if (step === "indexpaths") {
        const response = await fetch(`/api/evidences/${item.id}/index-attachment-paths`, { method: "POST" });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Falha ao indexar caminhos de anexos.");
        }
      }

      if (step === "relink") {
        const response = await fetch(`/api/evidences/${item.id}/relink`, { method: "POST" });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Falha ao recalcular vinculos.");
        }
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
        setState((prev) => (prev ? { ...prev, phase: "retranscription-queued" } : prev));
        const response = await fetch(`/api/evidences/${item.id}/retranscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            engine: transcriptionEngine,
            model: transcriptionModel,
            language: transcriptionLanguage.trim() || undefined
          })
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Falha ao reenfileirar transcricoes.");
        }
        await waitForExtractionIdle(state.id);
      }
    } finally {
      setBusyAction(null);
    }
  }

  const { autoChainRunning, autoChainCompleted, autoChainCurrentStep, autoChainFailedStep, runAutomatedChain } =
    useAutomatedChain<ActionStep>({
      evidenceId: item.id,
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

  async function onReprocess() {
    if (!state) return;
    let confirmed = false;
    try {
      const currentEstimate = estimate ?? (await fetchTranscriptionEstimate());
      confirmed = window.confirm(
        [
          "Reprocessar COMPLETO esta evidencia?",
          "Isso refaz ingestao, parsing, vinculos e ja enfileira transcricoes automaticamente.",
          `Runtime transcricao (estimativa): ${transcriptionEngine}/${transcriptionModel}`,
          `Runtime IA: ${aiEngine}/${aiModel}`,
          `Audios indexados: ${currentEstimate.audioIndexing?.attachmentCount ?? 0}`,
          `Duracao total: ${currentEstimate.audioIndexing?.totalDurationMin?.toFixed(2) ?? "0.00"} min`,
          `Tokens estimados (saida): ${currentEstimate.estimate?.estimatedOutputTokens ?? 0}`,
          `Tempo estimado: ${currentEstimate.estimate?.estimatedTimeMinutes?.toFixed(2) ?? "0.00"} min`,
          `Custo estimado: ${
            typeof currentEstimate.estimate?.estimatedCostUsd === "number"
              ? `US$ ${currentEstimate.estimate.estimatedCostUsd.toFixed(4)}`
              : "N/D"
          }`,
          `Custo IA estimado: ${
            typeof currentEstimate.aiEstimate?.estimatedCostUsd === "number"
              ? `US$ ${currentEstimate.aiEstimate.estimatedCostUsd.toFixed(4)}`
              : "N/D"
          }`
        ].join("\n")
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao calcular estimativa.");
      return;
    }
    if (!confirmed) return;
    setActionError(null);
    setBusyAction("reprocess");
    try {
      const response = await fetch(`/api/evidences/${item.id}/reprocess`, {
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
      const payload = (await response.json()) as { extractionId?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao reprocessar evidencia.");
      }
      if (payload.extractionId) {
        setState({
          id: payload.extractionId,
          status: "PENDING",
          phase: "requeued",
          progress: 0,
          reportError: null
        });
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao reprocessar evidencia.");
    } finally {
      setBusyAction(null);
    }
  }

  async function onDelete() {
    const confirmed = window.confirm("Excluir apenas a evidencia e arquivos no storage? Esta acao nao pode ser desfeita.");
    if (!confirmed) return;

    setActionError(null);
    setBusyAction("delete");
    try {
      const response = await fetch(`/api/evidences/${item.id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hardReset: false })
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao excluir evidencia.");
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao excluir evidencia.");
    } finally {
      setBusyAction(null);
    }
  }

  async function onHardReset() {
    const confirmed = window.confirm(
      "Reset UFDR completo? Isso exclui evidencia, storage e limpa ingestoes associadas (filas/transcricoes). Esta acao nao pode ser desfeita."
    );
    if (!confirmed) return;

    setActionError(null);
    setBusyAction("hardReset");
    try {
      const response = await fetch(`/api/evidences/${item.id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hardReset: true })
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao executar hard reset do UFDR.");
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao executar hard reset do UFDR.");
    } finally {
      setBusyAction(null);
    }
  }

  async function onRetranscribe() {
    if (!state) return;
    const confirmed = window.confirm(
      [
        "Reprocessar apenas transcricoes de audio desta evidencia?",
        "Isso nao refaz ingestao de chats/mensagens.",
        `Runtime: ${transcriptionEngine}/${transcriptionModel}`,
        estimate?.audioIndexing
          ? `Audios indexados: ${estimate.audioIndexing.attachmentCount}`
          : "Audios indexados: calculo sob demanda",
        estimate?.audioIndexing
          ? `Duracao total: ${estimate.audioIndexing.totalDurationMin.toFixed(2)} min`
          : "Duracao total: use 'Atualizar estimativa' para calcular",
        estimate
          ? `Custo estimado: ${
              typeof estimate.estimate?.estimatedCostUsd === "number"
                ? `US$ ${estimate.estimate.estimatedCostUsd.toFixed(4)}`
                : "N/D"
            }`
          : "Custo estimado: opcional"
      ].join("\n")
    );
    if (!confirmed) return;

    setActionError(null);
    setBusyAction("retranscribe");
    try {
      const response = await fetch(`/api/evidences/${item.id}/retranscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: transcriptionEngine,
          model: transcriptionModel,
          language: transcriptionLanguage.trim() || undefined
        })
      });
      const payload = (await response.json()) as {
        extractionId?: string;
        jobsQueued?: number;
        preservedCompleted?: number;
        preservedProcessing?: number;
        resetFailedOrPending?: number;
        createdNew?: number;
        transcriptionRuntime?: { engine?: string; model?: string };
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao reenfileirar transcricoes.");
      }
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
      if (payload.extractionId) {
        setState((prev) =>
          prev
            ? {
                ...prev,
                phase: "retranscription-queued",
                progress: prev.status === "COMPLETED" ? 100 : prev.progress
              }
            : null
        );
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao reenfileirar transcricoes.");
    } finally {
      setBusyAction(null);
    }
  }

  async function onResume() {
    if (!state) return;
    const confirmed = window.confirm(
      "Retomar processamento desta evidencia a partir do ponto salvo? Use isto quando o HD/Windows desconectou ou o worker caiu."
    );
    if (!confirmed) return;

    setActionError(null);
    setBusyAction("resume");
    try {
      const response = await fetch(`/api/evidences/${item.id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "audio-recovery" })
      });
      const payload = (await response.json()) as {
        extractionId?: string;
        queuedBatches?: number;
        queued?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao retomar processamento.");
      }
      if (payload.extractionId) {
        setState((prev) =>
          prev
            ? {
                ...prev,
                phase: payload.queuedBatches ? "resume-audio-recovery-batches-running" : "resume-queued",
                progress: prev.progress,
                status: "PROCESSING",
                reportError: null
              }
            : null
        );
      }
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
      setBusyAction(null);
    }
  }

  async function onRelink() {
    if (!state) return;
    const confirmed = window.confirm(
      "Recalcular vinculos de audio para mensagens sem retranscrever? Isso atualiza apenas o link anexo->mensagem."
    );
    if (!confirmed) return;

    setActionError(null);
    setBusyAction("relink");
    try {
      const response = await fetch(`/api/evidences/${item.id}/relink`, { method: "POST" });
      const payload = (await response.json()) as { ok?: boolean; relinked?: number; scanned?: number; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao recalcular vinculos.");
      }
      window.alert(
        `Recalculo concluido. Audios analisados: ${payload.scanned ?? 0} | Relinkados: ${payload.relinked ?? 0}`
      );
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao recalcular vinculos.");
    } finally {
      setBusyAction(null);
    }
  }

  async function onIndexAttachmentPaths() {
    if (!state) return;
    const confirmed = window.confirm(
      "Indexar caminhos de anexos no UFDR sem retranscrever? Isso melhora preview/abertura de imagens e documentos."
    );
    if (!confirmed) return;

    setActionError(null);
    setBusyAction("indexpaths");
    try {
      const response = await fetch(`/api/evidences/${item.id}/index-attachment-paths`, { method: "POST" });
      const payload = (await response.json()) as { ok?: boolean; indexed?: number; unresolved?: number; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao indexar caminhos de anexos.");
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao indexar caminhos de anexos.");
    } finally {
      setBusyAction(null);
    }
  }

  async function onEnrich() {
    if (!state) return;
    const confirmed = window.confirm(
      "Enriquecer metadados? Atualiza dispositivo, sincroniza contas de usuario (UserAccount), localizacoes e timeline sem alterar chats e transcricoes."
    );
    if (!confirmed) return;

    setActionError(null);
    setBusyAction("enrich");
    try {
      const response = await fetch(`/api/evidences/${item.id}/enrich`, { method: "POST" });
      const payload = (await response.json()) as { ok?: boolean; extractionId?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao enriquecer metadados.");
      }
      if (payload.extractionId) {
        setState({
          id: payload.extractionId,
          status: "PROCESSING",
          phase: "enrich-iniciando",
          progress: state?.progress ?? 0,
          reportError: null
        });
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao enriquecer metadados.");
    } finally {
      setBusyAction(null);
    }
  }

  const extractionProgress = state ? Math.max(0, Math.min(100, state.progress)) : 0;
  const actionProgress =
    busyAction === "reprocess"
      ? extractionProgress
      : busyAction
        ? 20
        : 0;

  return (
    <div className="rounded border border-zinc-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/evidences/${item.id}`} className="font-medium hover:underline">
          {item.fileName}
        </Link>
        <Badge>{state?.status ?? "PENDING"}</Badge>
      </div>
      <p className="text-xs text-zinc-500">Caso: {item.caseTitle}</p>
      {state ? (
        <div className="mt-3 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>Fase: {state.phase}</span>
            <span>{extractionProgress}%</span>
          </div>
          <Progress value={extractionProgress} />
          {state.stats?.transcriptions ? (
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span>
                  Transcricao (Total/Transcritos: {state.stats.transcriptions.total}/{state.stats.transcriptions.completed})
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-600">
                    Executando: {state.stats.transcriptions.processing}/{state.stats.transcriptions.total}
                  </span>
                  {autoChainFailedStep === "retranscribe" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busyAction !== null || !state || autoChainRunning}
                      onClick={() => void runAutomatedChain(4)}
                      className="h-6 px-2 text-[11px]"
                    >
                      Retomar 5. Transcrever Audios
                    </Button>
                  ) : (
                    <span className="text-zinc-500">Automatizado</span>
                  )}
                  <span>
                    {state.stats.transcriptions.total > 0
                      ? Math.round(
                          (state.stats.transcriptions.completed / state.stats.transcriptions.total) *
                            100
                        )
                      : 0}
                    %
                  </span>
                </div>
              </div>
              <Progress
                value={
                  state.stats.transcriptions.total > 0
                    ? (state.stats.transcriptions.completed / state.stats.transcriptions.total) *
                      100
                    : 0
                }
              />
            </div>
          ) : null}
          {state.reportError ? <p className="text-xs text-red-700">{state.reportError}</p> : null}
          {state.operationalAlerts && state.operationalAlerts.length > 0 ? (
            <div className="space-y-1">
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
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!providerAvailability.openai ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">OpenAI sem chave</span>
        ) : null}
        {!providerAvailability.assemblyai ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">AssemblyAI sem chave</span>
        ) : null}
        <select
          value={transcriptionEngine}
          onChange={(event) => setTranscriptionEngine(event.target.value as TranscriptionEngine)}
          className="rounded border border-zinc-300 px-2 py-1 text-xs"
          disabled={busyAction !== null}
        >
          <option value="local">Transcricao local</option>
          <option value="openai" disabled={!providerAvailability.openai}>
            Transcricao OpenAI {!providerAvailability.openai ? "(indisponivel: sem chave)" : ""}
          </option>
          <option value="assemblyai" disabled={!providerAvailability.assemblyai}>
            Transcricao AssemblyAI {!providerAvailability.assemblyai ? "(indisponivel: sem chave)" : ""}
          </option>
        </select>
        <select
          value={transcriptionModel}
          onChange={(event) => setTranscriptionModel(event.target.value)}
          className="rounded border border-zinc-300 px-2 py-1 text-xs"
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
          placeholder="Idioma (opcional)"
          className="rounded border border-zinc-300 px-2 py-1 text-xs"
          disabled={busyAction !== null}
        />
        <select
          value={aiEngine}
          onChange={(event) => setAiEngine(event.target.value as AiEngine)}
          className="rounded border border-zinc-300 px-2 py-1 text-xs"
          disabled={busyAction !== null}
        >
          <option value="local">IA local</option>
          <option value="openai" disabled={!providerAvailability.openai}>
            IA OpenAI {!providerAvailability.openai ? "(indisponivel: sem chave)" : ""}
          </option>
        </select>
        <select
          value={aiModel}
          onChange={(event) => setAiModel(event.target.value)}
          className="rounded border border-zinc-300 px-2 py-1 text-xs"
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
        <Button type="button" size="sm" variant="outline" disabled={busyAction !== null} onClick={() => fetchTranscriptionEstimate()}>
          Atualizar estimativa
        </Button>
        {state ? (
          <Link href={`/extractions/${state.id}`} className="text-xs text-blue-700 hover:underline">
            Ver extracao
          </Link>
        ) : null}
        <Button type="button" size="sm" variant="outline" disabled={busyAction !== null || !state} onClick={onResume}>
          {busyAction === "resume" ? "Retomando..." : "Retomar processamento"}
        </Button>
        {autoChainFailedStep ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busyAction !== null || !state || autoChainRunning}
            onClick={() => void runAutomatedChain(AUTO_CHAIN_STEPS.indexOf(autoChainFailedStep))}
          >
            Retomar {AUTO_CHAIN_STEP_LABEL[autoChainFailedStep]}
          </Button>
        ) : (
          <p className="text-xs text-zinc-600">Etapas 1-5 automatizadas.</p>
        )}
        <Button type="button" size="sm" variant="outline" disabled={busyAction !== null} onClick={onDelete}>
          {busyAction === "delete" ? "Excluindo..." : "Excluir"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="default"
          className="bg-red-700 text-white hover:bg-red-800"
          disabled={busyAction !== null}
          onClick={onHardReset}
        >
          {busyAction === "hardReset" ? "Resetando..." : "Reset UFDR"}
        </Button>
      </div>
      {busyAction ? (
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-600">
            <span>Acao em execucao: {ACTION_LABELS[busyAction]}</span>
            <span>{Math.round(actionProgress)}%</span>
          </div>
          <Progress value={actionProgress} />
        </div>
      ) : null}
      {autoChainRunning ? (
        <p className="mt-1 text-xs text-zinc-700">
          Fluxo automatico em andamento{autoChainCurrentStep ? `: ${AUTO_CHAIN_STEP_LABEL[autoChainCurrentStep]}` : ""}.
        </p>
      ) : null}
      {autoChainCompleted ? <p className="mt-1 text-xs text-emerald-700">Fluxo automatizado concluido.</p> : null}
      {autoChainFailedStep ? (
        <p className="mt-1 text-xs text-amber-700">
          Fluxo pausado em {AUTO_CHAIN_STEP_LABEL[autoChainFailedStep]}. Botao de retomar liberado.
        </p>
      ) : null}
      {estimate ? (
        <p className="mt-1 text-xs text-zinc-600">
          Audios: {estimate.audioIndexing?.attachmentCount ?? 0} | Duracao: {estimate.audioIndexing?.totalDurationMin?.toFixed(2) ?? "0.00"} min |
          Custo transcricao: {typeof estimate.estimate?.estimatedCostUsd === "number" ? ` US$ ${estimate.estimate.estimatedCostUsd.toFixed(4)}` : " N/D"}
        </p>
      ) : null}
      {actionError ? <p className="mt-2 text-xs text-red-700">{actionError}</p> : null}
    </div>
  );
}

export function EvidenceProgressList({ items }: { items: EvidenceItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <EvidenceRow key={item.id} item={item} />
      ))}
    </div>
  );
}
