"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type AudioRow = {
  attachmentId: string;
  fileName: string;
  evidenceLabel: string;
  hasArchivePath: boolean;
};

type BenchmarkResponse = {
  sampleCount: number;
  files?: Array<{
    attachmentId: string;
    fileName: string;
    sizeBytes: number;
    localText?: string;
    apiText?: string;
    localSeconds?: number | null;
    apiSeconds?: number | null;
  }>;
  totals: {
    totalMinutes: number;
    totalSizeMB: number;
  };
  local: {
    engine?: string;
    totalSeconds: number;
    avgSecondsPerFile: number;
    rssBeforeMB: number;
    rssAfterMB: number;
    rssDeltaMB: number;
  };
  api: {
    engine?: string;
    model: string;
    totalSeconds: number;
    avgSecondsPerFile: number;
    error?: string | null;
  };
  costEstimateUsd: {
    whisper1: number;
    gpt4oTranscribe: number;
    gpt4oMiniTranscribe: number;
  };
  error?: string;
};

type CompareRow = {
  attachmentId: string;
  fileName: string;
  localText: string;
  apiText: string;
  localSeconds?: number | null;
  apiSeconds?: number | null;
};

function normalizeWord(word: string) {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function uniqueWordSet(text: string) {
  const set = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const cleaned = normalizeWord(raw);
    if (cleaned) set.add(cleaned);
  }
  return set;
}

function computeSimilarityPercent(a: string, b: string) {
  const setA = uniqueWordSet(a);
  const setB = uniqueWordSet(b);
  if (setA.size === 0 && setB.size === 0) return 100;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return Math.round((intersection / Math.max(1, union)) * 100);
}

function renderDiffText(text: string, otherText: string) {
  const otherSet = uniqueWordSet(otherText);
  const parts = text.split(/(\s+)/);
  return parts.map((part, index) => {
    if (!part.trim()) return <span key={`${part}-${index}`}>{part}</span>;
    const cleaned = normalizeWord(part);
    if (!cleaned || otherSet.has(cleaned)) {
      return <span key={`${part}-${index}`}>{part}</span>;
    }
    return (
      <span key={`${part}-${index}`} className="rounded bg-amber-200 px-0.5">
        {part}
      </span>
    );
  });
}

export function BenchmarkTranscriptionRunner({ rows }: { rows: AudioRow[] }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BenchmarkResponse | null>(null);
  const [openaiModel, setOpenaiModel] = useState("whisper-1");
  const [runtimeApiKey, setRuntimeApiKey] = useState("");
  const [localDone, setLocalDone] = useState(0);
  const [apiDone, setApiDone] = useState(0);
  const [totalPlanned, setTotalPlanned] = useState(0);
  const [compareRows, setCompareRows] = useState<CompareRow[]>([]);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (row) => row.fileName.toLowerCase().includes(q) || row.evidenceLabel.toLowerCase().includes(q)
    );
  }, [rows, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectTop(limit: number) {
    const ids = filtered.slice(0, limit).map((row) => row.attachmentId);
    setSelected(new Set(ids));
  }

  async function copyText(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback(key);
      setTimeout(() => setCopyFeedback((prev) => (prev === key ? null : prev)), 1400);
    } catch {
      setError("Nao foi possivel copiar para a area de transferencia.");
    }
  }

  async function runBenchmark() {
    setError(null);
    setResult(null);
    if (selected.size === 0) {
      setError("Selecione ao menos 1 audio.");
      return;
    }
    if (selected.size > 50) {
      setError("Selecione no maximo 50 audios por execucao.");
      return;
    }

    setBusy(true);
    setLocalDone(0);
    setApiDone(0);
    setCompareRows([]);

    try {
      const selectedIds = [...selected];
      setTotalPlanned(selectedIds.length);

      let totalMinutes = 0;
      let totalSizeMB = 0;
      let localTotalSeconds = 0;
      let localRssBeforeMB = 0;
      let localRssAfterMB = 0;
      let localRssDeltaMB = 0;
      let apiTotalSeconds = 0;
      let apiError: string | null = null;
      const comparisons = new Map<string, CompareRow>();

      for (let index = 0; index < selectedIds.length; index += 1) {
        const response = await fetch("/api/benchmark/transcription", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attachmentIds: [selectedIds[index]],
            openaiModel,
            openaiApiKey: runtimeApiKey || undefined,
            runLocal: true,
            runApi: false
          })
        });

        const payload = (await response.json()) as BenchmarkResponse;
        if (!response.ok) {
          throw new Error(payload.error ?? "Falha no benchmark local.");
        }

        totalMinutes += payload.totals.totalMinutes;
        totalSizeMB += payload.totals.totalSizeMB;
        localTotalSeconds += payload.local.totalSeconds;
        localRssBeforeMB += payload.local.rssBeforeMB;
        localRssAfterMB += payload.local.rssAfterMB;
        localRssDeltaMB += payload.local.rssDeltaMB;
        const file = payload.files?.[0];
        if (file) {
          comparisons.set(file.attachmentId, {
            attachmentId: file.attachmentId,
            fileName: file.fileName,
            localText: file.localText ?? "",
            apiText: comparisons.get(file.attachmentId)?.apiText ?? "",
            localSeconds: file.localSeconds ?? null,
            apiSeconds: comparisons.get(file.attachmentId)?.apiSeconds ?? null
          });
        }
        setLocalDone(index + 1);
      }

      for (let index = 0; index < selectedIds.length; index += 1) {
        const response = await fetch("/api/benchmark/transcription", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attachmentIds: [selectedIds[index]],
            openaiModel,
            openaiApiKey: runtimeApiKey || undefined,
            runLocal: false,
            runApi: true
          })
        });

        const payload = (await response.json()) as BenchmarkResponse;
        if (!response.ok) {
          throw new Error(payload.error ?? "Falha no benchmark API.");
        }

        apiTotalSeconds += payload.api.totalSeconds;
        if (payload.api.error) apiError = payload.api.error;
        const file = payload.files?.[0];
        if (file) {
          comparisons.set(file.attachmentId, {
            attachmentId: file.attachmentId,
            fileName: file.fileName,
            localText: comparisons.get(file.attachmentId)?.localText ?? "",
            apiText: file.apiText ?? "",
            localSeconds: comparisons.get(file.attachmentId)?.localSeconds ?? null,
            apiSeconds: file.apiSeconds ?? null
          });
        }
        setApiDone(index + 1);
      }

      const pricing = {
        whisper1: 0.006,
        gpt4oTranscribe: 0.006,
        gpt4oMiniTranscribe: 0.003
      };

      setResult({
        sampleCount: selectedIds.length,
        totals: {
          totalMinutes,
          totalSizeMB
        },
        local: {
          totalSeconds: localTotalSeconds,
          avgSecondsPerFile: localTotalSeconds / Math.max(1, selectedIds.length),
          rssBeforeMB: localRssBeforeMB / Math.max(1, selectedIds.length),
          rssAfterMB: localRssAfterMB / Math.max(1, selectedIds.length),
          rssDeltaMB: localRssDeltaMB / Math.max(1, selectedIds.length)
        },
        api: {
          model: openaiModel,
          totalSeconds: apiTotalSeconds,
          avgSecondsPerFile: apiTotalSeconds / Math.max(1, selectedIds.length),
          error: apiError
        },
        costEstimateUsd: {
          whisper1: totalMinutes * pricing.whisper1,
          gpt4oTranscribe: totalMinutes * pricing.gpt4oTranscribe,
          gpt4oMiniTranscribe: totalMinutes * pricing.gpt4oMiniTranscribe
        }
      });
      setCompareRows(
        [...comparisons.values()].sort((a, b) => a.fileName.localeCompare(b.fileName, "pt-BR"))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao executar benchmark.");
    } finally {
      setRuntimeApiKey("");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filtrar por nome de audio ou evidencia..."
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        />
        <select
          value={openaiModel}
          onChange={(event) => setOpenaiModel(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="whisper-1">whisper-1 (qualidade)</option>
          <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
          <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
        </select>
        <Button type="button" variant="outline" onClick={() => selectTop(20)}>
          Selecionar 20
        </Button>
        <Button type="button" variant="outline" onClick={() => setSelected(new Set())}>
          Limpar
        </Button>
      </div>

      <div className="grid gap-2 md:grid-cols-[1fr_auto]">
        <input
          type="password"
          value={runtimeApiKey}
          onChange={(event) => setRuntimeApiKey(event.target.value)}
          placeholder="OpenAI API Key somente para esta execucao (nao salva)"
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="self-center text-xs text-zinc-500">Uso temporario, limpa ao finalizar.</span>
      </div>

      <div className="rounded border border-zinc-200">
        <div className="max-h-[360px] overflow-auto">
          {filtered.map((row) => (
            <label
              key={row.attachmentId}
              className="flex cursor-pointer items-center gap-2 border-b border-zinc-100 px-3 py-2 text-sm"
            >
              <input type="checkbox" checked={selected.has(row.attachmentId)} onChange={() => toggle(row.attachmentId)} />
              <span className="truncate font-medium">{row.fileName}</span>
              <span className="text-xs text-zinc-500">{row.evidenceLabel}</span>
              {!row.hasArchivePath ? <span className="ml-auto text-[10px] text-amber-700">sem archivePath</span> : null}
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={runBenchmark} disabled={busy}>
          {busy ? "Executando benchmark..." : `Rodar Benchmark (${selected.size})`}
        </Button>
        <span className="text-xs text-zinc-500">Limite por execucao: 50 arquivos</span>
      </div>

      {busy && totalPlanned > 0 ? (
        <div className="space-y-2 rounded border border-zinc-200 p-3 text-sm">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-zinc-600">
              <span>Benchmark local (Whisper)</span>
              <span>
                {localDone}/{totalPlanned}
              </span>
            </div>
            <Progress value={(localDone / totalPlanned) * 100} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-zinc-600">
              <span>Benchmark API OpenAI</span>
              <span>
                {apiDone}/{totalPlanned}
              </span>
            </div>
            <Progress value={(apiDone / totalPlanned) * 100} />
          </div>
        </div>
      ) : null}

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {result ? (
        <div className="space-y-3 rounded border border-zinc-200 p-3 text-sm">
          <p className="font-semibold">Resultado</p>
          <p>
            Amostra: {result.sampleCount} | Minutos totais: {result.totals.totalMinutes.toFixed(2)} | Tamanho: {" "}
            {result.totals.totalSizeMB.toFixed(2)} MB
          </p>
          <p>
            Local ({result.local.engine ?? "whisper-local"}): total {result.local.totalSeconds.toFixed(2)}s | media {result.local.avgSecondsPerFile.toFixed(2)}s/arquivo | RSS delta {" "}
            {result.local.rssDeltaMB.toFixed(2)} MB
          </p>
          <p>
            API ({result.api.engine ?? result.api.model}): total {result.api.totalSeconds.toFixed(2)}s | media {" "}
            {result.api.avgSecondsPerFile.toFixed(2)}s/arquivo
          </p>
          {result.api.error ? <p className="text-amber-700">API: {result.api.error}</p> : null}
          <p>
            Custo estimado: whisper-1 US$ {result.costEstimateUsd.whisper1.toFixed(2)} | gpt-4o-transcribe US${" "}
            {result.costEstimateUsd.gpt4oTranscribe.toFixed(2)} | gpt-4o-mini-transcribe US${" "}
            {result.costEstimateUsd.gpt4oMiniTranscribe.toFixed(2)}
          </p>
          {compareRows.length > 0 ? (
            <div className="space-y-2 pt-2">
              <p className="font-semibold">Comparativo de Qualidade por Audio</p>
              {compareRows.map((row) => (
                <article key={row.attachmentId} className="space-y-2 rounded border border-zinc-200 bg-zinc-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold text-zinc-900">{row.fileName}</p>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-zinc-200 px-2 py-1 text-[11px] font-semibold text-zinc-700">
                        Similaridade: {computeSimilarityPercent(row.localText, row.apiText)}%
                      </span>
                      {row.localText.trim() && row.apiText.trim() && row.localText.trim() === row.apiText.trim() ? (
                        <span className="rounded bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-700">
                          Textos idênticos
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="rounded border border-zinc-200 bg-white p-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Transcricao Local</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-zinc-500">
                          {typeof row.localSeconds === "number" ? `${row.localSeconds.toFixed(2)}s` : "-"}
                        </span>
                      <button
                        type="button"
                        className="text-[11px] font-medium text-zinc-600 underline"
                        onClick={() => copyText(row.localText.trim() || "", `${row.attachmentId}-local`)}
                      >
                        {copyFeedback === `${row.attachmentId}-local` ? "Copiado" : "Copiar"}
                      </button>
                      </div>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-zinc-900">
                      {row.localText.trim()
                        ? renderDiffText(row.localText, row.apiText)
                        : "(sem texto reconhecido)"}
                    </p>
                  </div>
                  <div className="rounded border border-zinc-200 bg-white p-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Transcricao OpenAI</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-zinc-500">
                          {typeof row.apiSeconds === "number" ? `${row.apiSeconds.toFixed(2)}s` : "-"}
                        </span>
                      <button
                        type="button"
                        className="text-[11px] font-medium text-zinc-600 underline"
                        onClick={() => copyText(row.apiText.trim() || "", `${row.attachmentId}-api`)}
                      >
                        {copyFeedback === `${row.attachmentId}-api` ? "Copiado" : "Copiar"}
                      </button>
                      </div>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-zinc-900">
                      {row.apiText.trim()
                        ? renderDiffText(row.apiText, row.localText)
                        : "(sem texto reconhecido ou nao executado)"}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
