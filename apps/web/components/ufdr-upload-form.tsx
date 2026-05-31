"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Progress } from "./ui/progress";

type UploadResponse = {
  extractionId: string;
  evidenceId: string;
  caseId: string;
  importStarted?: boolean;
  queueJobId?: string | null;
};

type ExtractionProgress = {
  status: string;
  phase: string;
  progress: number;
  updatedAt?: string;
  reportError?: string;
  alerts?: string[];
  operationalAlerts?: Array<{
    code: string;
    severity: "INFO" | "WARN" | "CRITICAL";
    message: string;
  }>;
  diagnostics?: {
    elapsedMs?: number;
    filesScanned?: number;
    parserMode?: string;
    ingestTimingsMs?: {
      total?: number;
    };
    audio?: {
      hintsCount?: number;
      extractedCount?: number;
      maxFiles?: number;
      capReached?: boolean;
    };
    parserDropped?: {
      chats?: number;
      messages?: number;
      audioFiles?: number;
    };
  };
  stats?: {
    chats: number;
    messages: number;
    attachments: number;
    transcriptions: {
      total: number;
      pending: number;
      processing: number;
      completed: number;
      failed: number;
    };
  };
};

type CaseOption = {
  id: string;
  caseNumber: string;
  title: string;
};

type TranscriptionEngine = "local" | "openai" | "assemblyai";
type TranscriptionProviderAvailability = {
  local: boolean;
  openai: boolean;
  assemblyai: boolean;
};

function isLikelyAbsolutePath(value: string) {
  const v = value.trim();
  return /^[a-zA-Z]:[\\/]/.test(v) || /^\\\\/.test(v) || v.startsWith("/");
}

function normalizePathInput(value: string) {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^"(.*)"$/);
  return quoted ? (quoted[1] ?? "").trim() : trimmed;
}

export function UfdrUploadForm({
  caseOptions,
  preselectedCaseId,
  lockCaseSelection = false
}: {
  caseOptions: CaseOption[];
  preselectedCaseId?: string;
  lockCaseSelection?: boolean;
}) {
  const router = useRouter();
  const [localFilePath, setLocalFilePath] = useState("");
  const [pathSelectionNotice, setPathSelectionNotice] = useState<string | null>(null);
  const [pickingNativePath, setPickingNativePath] = useState(false);
  const [caseId, setCaseId] = useState(preselectedCaseId ?? caseOptions[0]?.id ?? "");
  const [transcriptionEngine, setTranscriptionEngine] = useState<TranscriptionEngine>("local");
  const [transcriptionModel, setTranscriptionModel] = useState("base");
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("");
  const [providerAvailability, setProviderAvailability] = useState<TranscriptionProviderAvailability>({
    local: true,
    openai: false,
    assemblyai: false
  });
  const [loadingLocalImport, setLoadingLocalImport] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localImportProgress, setLocalImportProgress] = useState<number | null>(null);
  const [localImportStartedAt, setLocalImportStartedAt] = useState<number | null>(null);
  const [localImportUpdatedAt, setLocalImportUpdatedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);
  const [processingUpdatedAt, setProcessingUpdatedAt] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (preselectedCaseId && preselectedCaseId !== caseId) {
      setCaseId(preselectedCaseId);
      return;
    }
    if (!caseId && caseOptions[0]?.id) {
      setCaseId(caseOptions[0].id);
    }
  }, [preselectedCaseId, caseId, caseOptions]);

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

  function formatEta(seconds: number | null) {
    if (seconds === null) return "Calculando...";
    if (seconds <= 0) return "< 1s";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  }

  function computeEta(startedAt: number | null, pct: number) {
    if (!startedAt || pct <= 0 || pct >= 100) return null;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const totalEstimate = elapsedSec / (pct / 100);
    const remaining = totalEstimate - elapsedSec;
    return Math.max(0, Math.round(remaining));
  }

  function computeServerStaleSeconds(updatedAt?: string) {
    if (!updatedAt) return null;
    const ts = new Date(updatedAt).getTime();
    if (!Number.isFinite(ts)) return null;
    return Math.max(0, Math.round((Date.now() - ts) / 1000));
  }

  async function pollExtractionProgress(extractionId: string) {
    let attempts = 0;
    while (attempts < 600) {
      attempts += 1;
      const response = await fetch(`/api/extractions/${extractionId}/status`, { cache: "no-store" });
      if (!response.ok) break;
      const payload = (await response.json()) as ExtractionProgress;
      setProgress(payload);
      setProcessingUpdatedAt(Date.now());
      if (payload.status === "COMPLETED" || payload.status === "FAILED") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  function stopStream() {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }

  function startProgressStream(extractionId: string) {
    stopStream();
    const eventSource = new EventSource(`/api/extractions/${extractionId}/stream`);
    eventSourceRef.current = eventSource;

    const onProgress = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as ExtractionProgress;
      setProcessingStartedAt((previous) => previous ?? Date.now());
      setProgress(payload);
      setProcessingUpdatedAt(Date.now());
      if (payload.status === "COMPLETED" || payload.status === "FAILED") {
        stopStream();
      }
    };

    eventSource.addEventListener("progress", onProgress);
    eventSource.addEventListener("done", onProgress);
    eventSource.onerror = () => {
      stopStream();
      void pollExtractionProgress(extractionId);
    };
  }

  useEffect(() => () => stopStream(), []);

  async function onPickNativePath() {
    setPickingNativePath(true);
    setError(null);
    try {
      const response = await fetch("/api/import-ufdr-path/pick", { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { filePath?: string; cancelled?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao abrir seletor nativo.");
      }
      if (payload.cancelled) {
        setPathSelectionNotice("Selecao cancelada.");
        return;
      }
      if (!payload.filePath) {
        throw new Error("Seletor nativo nao retornou caminho.");
      }
      setLocalFilePath(payload.filePath);
      setPathSelectionNotice(null);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "Falha ao abrir seletor nativo.");
    } finally {
      setPickingNativePath(false);
    }
  }

  async function onPickNativeFile() {
    setPickingNativePath(true);
    setError(null);
    try {
      const response = await fetch("/api/import-ufdr-path/pick-file", { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { filePath?: string; cancelled?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao abrir seletor nativo.");
      }
      if (payload.cancelled) {
        setPathSelectionNotice("Selecao cancelada.");
        return;
      }
      if (!payload.filePath) {
        throw new Error("Seletor nativo nao retornou caminho.");
      }
      setLocalFilePath(payload.filePath);
      setPathSelectionNotice(null);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "Falha ao abrir seletor nativo.");
    } finally {
      setPickingNativePath(false);
    }
  }

  async function onImportFromPath(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedPath = normalizePathInput(localFilePath);
    if (!normalizedPath) return;
    if (!caseId.trim()) {
      setError("Selecione um caso antes de importar por caminho local.");
      return;
    }
    if (!isLikelyAbsolutePath(normalizedPath)) {
      setError("Informe um caminho absoluto valido da pasta descompactada (ex.: C:\\pasta\\EXTRACTI.2026-...).");
      return;
    }
    setLoadingLocalImport(true);
    setError(null);
    setPathSelectionNotice(null);
    setResult(null);
    setLocalImportProgress(2);
    setLocalImportStartedAt(Date.now());
    setLocalImportUpdatedAt(Date.now());
    setProgress(null);
    setProcessingStartedAt(null);
    setProcessingUpdatedAt(null);

    try {
      const response = await fetch("/api/import-ufdr-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: normalizedPath,
          caseId: caseId.trim(),
          transcriptionRuntime: {
            enabled: true,
            engine: transcriptionEngine,
            model: transcriptionModel.trim() || undefined,
            language: transcriptionLanguage.trim() || undefined
          }
        })
      });

      const payload = (await response.json()) as UploadResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao importar arquivo por caminho local.");
      }

      setLocalImportProgress(null);
      setLocalImportUpdatedAt(Date.now());
      setResult(payload);
      setProcessingStartedAt(Date.now());
      setProcessingUpdatedAt(Date.now());
      startProgressStream(payload.extractionId);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Erro inesperado.");
    } finally {
      setLoadingLocalImport(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium text-zinc-700">Caso *</label>
        <select
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          value={caseId}
          disabled={lockCaseSelection}
          onChange={(event) => setCaseId(event.target.value)}
          required
        >
          {!caseOptions.length ? <option value="">Nenhum caso disponivel</option> : null}
          {caseOptions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.caseNumber} - {item.title}
            </option>
          ))}
        </select>
        <p className="text-xs text-zinc-500">Cada UFDR deve estar vinculada a um caso. Um caso pode ter varias evidencias UFDR.</p>
        <Link href="/cases/new" className="text-xs text-blue-700 hover:underline">
          Criar novo caso
        </Link>
      </div>
      <form onSubmit={onImportFromPath} className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
        <p className="text-sm font-medium">Importar UFDR por caminho local (pasta descompactada ou arquivo .ufdr)</p>
        <div className="space-y-1">
          <label className="text-sm font-medium text-zinc-700">Selecionar origem UFDR</label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onPickNativePath} disabled={pickingNativePath}>
              {pickingNativePath ? "Abrindo seletor..." : "Selecionar pasta no Windows"}
            </Button>
            <Button type="button" variant="outline" onClick={onPickNativeFile} disabled={pickingNativePath}>
              {pickingNativePath ? "Abrindo seletor..." : "Selecionar arquivo .ufdr"}
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium text-zinc-700">Caminho absoluto da pasta ou arquivo .ufdr</label>
          <Input
            value={localFilePath}
            onChange={(event) => setLocalFilePath(normalizePathInput(event.target.value))}
            placeholder="C:\\laudos\\EXTRACTI.2026-...\\  ou  C:\\laudos\\extração.ufdr"
            required
          />
          <p className="text-xs text-zinc-500">Aceita a raiz da pasta descompactada (com report.xml) ou o arquivo .ufdr.</p>
          {pathSelectionNotice ? <p className="text-xs text-amber-700">{pathSelectionNotice}</p> : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-zinc-700">Motor de transcricao</label>
              {!providerAvailability.openai ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">OpenAI sem chave</span>
              ) : null}
              {!providerAvailability.assemblyai ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">AssemblyAI sem chave</span>
              ) : null}
            </div>
            <select
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
              value={transcriptionEngine}
              onChange={(event) => setTranscriptionEngine(event.target.value as TranscriptionEngine)}
            >
              <option value="local">Local (Whisper)</option>
              <option value="openai" disabled={!providerAvailability.openai}>
                API OpenAI {!providerAvailability.openai ? "(indisponivel: sem chave)" : ""}
              </option>
              <option value="assemblyai" disabled={!providerAvailability.assemblyai}>
                API AssemblyAI {!providerAvailability.assemblyai ? "(indisponivel: sem chave)" : ""}
              </option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-zinc-700">Modelo de transcricao</label>
            <Input
              value={transcriptionModel}
              onChange={(event) => setTranscriptionModel(event.target.value)}
              placeholder={
                transcriptionEngine === "openai"
                  ? "gpt-4o-mini-transcribe"
                  : transcriptionEngine === "assemblyai"
                    ? "best"
                    : "base"
              }
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-zinc-700">Idioma (opcional)</label>
            <Input
              value={transcriptionLanguage}
              onChange={(event) => setTranscriptionLanguage(event.target.value)}
              placeholder="pt"
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          O runtime de IA/transcricao escolhido aqui sera usado ja na importacao inicial da evidencia.
        </p>
        <Button
          type="submit"
          variant="secondary"
          disabled={loadingLocalImport || !caseId || !isLikelyAbsolutePath(normalizePathInput(localFilePath))}
        >
          {loadingLocalImport ? "Importando por caminho..." : "Importar UFDR por Caminho"}
        </Button>
      </form>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {localImportProgress !== null ? (
        <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">Importacao por caminho local</span>
            <span>{localImportProgress}%</span>
          </div>
          <Progress value={localImportProgress} />
          {loadingLocalImport && localImportProgress >= 92 ? (
            <p className="text-xs text-amber-700">
              Registrando rastreamento inicial. Assim que o identificador da extracao for criado, o progresso real aparece abaixo.
            </p>
          ) : (
            <p className="text-xs text-zinc-600">ETA: {formatEta(computeEta(localImportStartedAt, localImportProgress))}</p>
          )}
          {localImportUpdatedAt ? (
            <p className="text-xs text-zinc-600">
              Ultima atualizacao: {new Date(localImportUpdatedAt).toLocaleTimeString()}
            </p>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p>
            Rastreamento da importacao registrado. Extraction: <strong>{result.extractionId}</strong>
          </p>
          <p className="text-xs text-emerald-900">
            A validacao, hash, copia e fila agora aparecem no progresso em tempo real.
          </p>
          <Link href={`/extractions/${result.extractionId}`} className="text-xs text-emerald-800 underline">
            Abrir tela de processamento
          </Link>
        </div>
      ) : null}
      {progress ? (
        <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">Processamento: {progress.phase}</span>
            <span>{progress.progress}%</span>
          </div>
          <Progress value={progress.progress} />
          <p className="text-xs text-zinc-600">
            ETA: {formatEta(computeEta(processingStartedAt, progress.progress))}
          </p>
          {processingUpdatedAt ? (
            <p className="text-xs text-zinc-600">
              Ultima atualizacao: {new Date(processingUpdatedAt).toLocaleTimeString()}
            </p>
          ) : null}
          {progress.updatedAt ? (
            <p className="text-xs text-zinc-600">
              Ultimo heartbeat do servidor: {new Date(progress.updatedAt).toLocaleTimeString()}
            </p>
          ) : null}
          {(() => {
            const staleSeconds = computeServerStaleSeconds(progress.updatedAt);
            const terminal = progress.status === "COMPLETED" || progress.status === "FAILED";
            if (terminal || staleSeconds === null || staleSeconds < 120) return null;
            return (
              <p className="text-xs text-red-700">
                Sem heartbeat real ha {Math.floor(staleSeconds / 60)}m {staleSeconds % 60}s. O processo pode ter parado.
              </p>
            );
          })()}
          <p className="text-xs text-zinc-600">Status: {progress.status}</p>
          <div className="rounded border border-zinc-200 bg-white p-2 text-xs">
            <p className="font-medium text-zinc-700">Resumo em tempo real</p>
            <p className="text-zinc-600">
              Importacao local: {result ? "concluida" : "em andamento"} | Job: {result ? "enfileirado" : "aguardando"}
            </p>
            <p className="text-zinc-600">
              Ingestao: {progress.progress >= 90 || progress.status === "COMPLETED" ? "quase finalizada" : "processando"}
            </p>
            <p className="text-zinc-600">
              Transcricao:{" "}
              {progress.stats
                ? `${progress.stats.transcriptions.completed}/${progress.stats.transcriptions.total} concluidas (${transcriptionEngine}/${transcriptionModel})`
                : "aguardando"}
            </p>
            {progress.stats ? (
              <p className="text-zinc-500">
                Chats: {progress.stats.chats} | Mensagens: {progress.stats.messages} | Anexos: {progress.stats.attachments}
              </p>
            ) : null}
            {progress.stats ? (
              <p className="text-zinc-500">
                TranscriÃ§Ãµes P:{progress.stats.transcriptions.pending} / X:{progress.stats.transcriptions.processing} / C:{progress.stats.transcriptions.completed} / F:{progress.stats.transcriptions.failed}
              </p>
            ) : null}
            {progress.diagnostics ? (
              <p className="text-zinc-500">
                Parser: {progress.diagnostics.parserMode ?? "n/d"} | Arquivos UFDR: {progress.diagnostics.filesScanned ?? 0} |
                Tempo ingestao:{" "}
                {typeof progress.diagnostics.ingestTimingsMs?.total === "number"
                  ? `${(progress.diagnostics.ingestTimingsMs.total / 1000).toFixed(1)}s`
                  : "n/d"}
              </p>
            ) : null}
            {progress.diagnostics?.audio ? (
              <p className="text-zinc-500">
                Áudios extraídos: {progress.diagnostics.audio.extractedCount ?? 0}/{progress.diagnostics.audio.maxFiles ?? 0}
                {progress.diagnostics.audio.capReached ? " (limite atingido)" : ""}
              </p>
            ) : null}
            {progress.diagnostics?.parserDropped &&
            ((progress.diagnostics.parserDropped.messages ?? 0) > 0 ||
              (progress.diagnostics.parserDropped.chats ?? 0) > 0 ||
              (progress.diagnostics.parserDropped.audioFiles ?? 0) > 0) ? (
              <p className="text-amber-700">
                Parser descartou: chats {progress.diagnostics.parserDropped.chats ?? 0}, mensagens{" "}
                {progress.diagnostics.parserDropped.messages ?? 0}, áudios {progress.diagnostics.parserDropped.audioFiles ?? 0}
              </p>
            ) : null}
          </div>
          {progress.reportError ? <p className="text-xs text-red-700">{progress.reportError}</p> : null}
          {progress.operationalAlerts && progress.operationalAlerts.length > 0 ? (
            <div className="space-y-1">
              {progress.operationalAlerts.map((alert) => (
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
    </div>
  );
}
