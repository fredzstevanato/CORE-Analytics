"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type QueueJob = {
  id: string;
  name: string;
  state: string;
  attemptsMade: number;
  priority: number | null;
  delay: number | null;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
  referenceLabel: string;
  data: {
    extractionId: string | null;
    caseId: string | null;
    evidenceId: string | null;
    transcriptionId: string | null;
    attachmentId: string | null;
    sourceType: string | null;
  };
};

type QueueRow = {
  queue: string;
  workers: number;
  paused: boolean;
  counts: Record<string, number>;
  jobs: QueueJob[];
};

type JobsResponse = {
  ok: boolean;
  timestamp: string;
  queues: QueueRow[];
};

function formatDate(value: number | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
}

export function OperationsJobsPanel() {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [queueFilter, setQueueFilter] = useState<string>("ALL");
  const [referenceFilter, setReferenceFilter] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [selectedJobs, setSelectedJobs] = useState<Record<string, boolean>>({});

  function jobKey(queue: string, jobId: string) {
    return `${queue}:${jobId}`;
  }

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const url = new URL("/api/ops/jobs", window.location.origin);
      url.searchParams.set("limit", "40");
      url.searchParams.set("statuses", "active,waiting,delayed,prioritized,failed");
      if (queueFilter !== "ALL") url.searchParams.set("queue", queueFilter);

      const response = await fetch(url.toString(), { cache: "no-store" });
      const payload = (await response.json()) as JobsResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao carregar jobs.");
      setData(payload);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Falha ao carregar jobs.");
    } finally {
      setBusy(false);
    }
  }

  async function callAction(input: {
    queue: string;
    action:
      | "stop"
      | "remove"
      | "retry"
      | "pause_queue"
      | "resume_queue"
      | "stop_by_reference"
      | "remove_by_reference";
    jobId?: string;
    referenceLabel?: string;
  }) {
    const response = await fetch("/api/ops/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    const payload = (await response.json()) as { error?: string; message?: string };
    if (!response.ok) throw new Error(payload.error ?? "Acao nao executada.");
    return payload;
  }

  async function runAction(input: { queue: string; action: "stop" | "remove" | "retry" | "pause_queue" | "resume_queue"; jobId?: string }) {
    const actionKey = `${input.queue}:${input.jobId ?? "queue"}:${input.action}`;
    setActionBusy(actionKey);
    setError(null);
    setNotice(null);
    try {
      const payload = await callAction(input);
      if (payload.message) setNotice(payload.message);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Acao nao executada.");
    } finally {
      setActionBusy(null);
    }
  }

  async function runBulkAction(action: "stop" | "remove") {
    const keys = Object.keys(selectedJobs).filter((key) => selectedJobs[key]);
    if (keys.length === 0) return;

    setActionBusy(`bulk:${action}`);
    setError(null);
    setNotice(null);

    let success = 0;
    const failures: string[] = [];

    for (const key of keys) {
      const delimiter = key.indexOf(":");
      if (delimiter <= 0) continue;
      const queue = key.slice(0, delimiter);
      const jobId = key.slice(delimiter + 1);
      try {
        await callAction({ queue, action, jobId });
        success += 1;
      } catch (jobError) {
        const message = jobError instanceof Error ? jobError.message : "erro desconhecido";
        failures.push(`${queue}/${jobId}: ${message}`);
      }
    }

    const nextSelection: Record<string, boolean> = {};
    for (const key of keys) {
      if (selectedJobs[key]) nextSelection[key] = false;
    }
    setSelectedJobs((prev) => ({ ...prev, ...nextSelection }));

    if (failures.length > 0) {
      setError(`Ação em lote parcial. Sucesso: ${success}. Falhas: ${failures.length}. Primeiro erro: ${failures[0]}`);
    } else {
      setNotice(`Ação em lote concluída. Sucesso: ${success}.`);
    }

    await load();
    setActionBusy(null);
  }

  async function runReferenceAction(action: "stop_by_reference" | "remove_by_reference") {
    const label = referenceFilter.trim();
    if (!label) {
      setError("Informe a referência (caso + UFDR) para executar ação em lote por referência.");
      return;
    }

    const confirmed = window.confirm(
      action === "remove_by_reference"
        ? `Excluir todos os jobs da referência \"${label}\"?`
        : `Parar todos os jobs da referência \"${label}\"?`
    );
    if (!confirmed) return;

    setActionBusy(`reference:${action}`);
    setError(null);
    setNotice(null);
    try {
      const payload = await callAction({
        queue: queueFilter === "ALL" ? "" : queueFilter,
        action,
        referenceLabel: label
      });
      if (payload.message) setNotice(payload.message);
      setSelectedJobs({});
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Ação por referência não executada.");
    } finally {
      setActionBusy(null);
    }
  }

  useEffect(() => {
    void load();
  }, [queueFilter]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void load();
    }, 10000);
    return () => clearInterval(timer);
  }, [autoRefresh, queueFilter]);

  const availableQueues = useMemo(() => {
    const names = data?.queues.map((row) => row.queue) ?? [];
    return ["ALL", ...names];
  }, [data]);

  const selectedCount = useMemo(() => {
    return Object.values(selectedJobs).filter(Boolean).length;
  }, [selectedJobs]);

  return (
    <div className="space-y-3 rounded border border-zinc-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">Controle de jobs dos workers</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
          {busy ? "Atualizando..." : "Atualizar agora"}
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-zinc-600">
          <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
          Auto (10s)
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-zinc-600">Fila:</label>
        <select
          value={queueFilter}
          onChange={(event) => setQueueFilter(event.target.value)}
          className="rounded border border-zinc-300 px-2 py-1 text-xs"
        >
          {availableQueues.map((queueName) => (
            <option key={queueName} value={queueName}>
              {queueName === "ALL" ? "Todas" : queueName}
            </option>
          ))}
        </select>
        <label className="ml-2 text-xs text-zinc-600">Filtro caso + UFDR:</label>
        <input
          type="text"
          value={referenceFilter}
          onChange={(event) => setReferenceFilter(event.target.value)}
          placeholder="Ex.: 150.5.2021.15259 ou Xiaomi Redmi"
          className="min-w-80 rounded border border-zinc-300 px-2 py-1 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={referenceFilter.trim().length === 0 || actionBusy === "reference:stop_by_reference"}
          onClick={() => void runReferenceAction("stop_by_reference")}
        >
          {actionBusy === "reference:stop_by_reference" ? "Parando referência..." : "Parar tudo da referência"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={referenceFilter.trim().length === 0 || actionBusy === "reference:remove_by_reference"}
          onClick={() => void runReferenceAction("remove_by_reference")}
        >
          {actionBusy === "reference:remove_by_reference" ? "Excluindo referência..." : "Excluir tudo da referência"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-600">Selecionados: {selectedCount}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={selectedCount === 0 || actionBusy === "bulk:stop"}
          onClick={() => void runBulkAction("stop")}
        >
          {actionBusy === "bulk:stop" ? "Parando..." : "Parar selecionados"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={selectedCount === 0 || actionBusy === "bulk:remove"}
          onClick={() => void runBulkAction("remove")}
        >
          {actionBusy === "bulk:remove" ? "Excluindo..." : "Excluir selecionados"}
        </Button>
      </div>

      {data ? <p className="text-xs text-zinc-500">Ultima leitura: {new Date(data.timestamp).toLocaleString("pt-BR")}</p> : null}
      {notice ? <p className="text-xs text-emerald-700">{notice}</p> : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}

      {data?.queues.map((queueRow) => (
        <div key={queueRow.queue} className="space-y-2 rounded border border-zinc-200 p-2">
          {(() => {
            const filter = referenceFilter.trim().toLowerCase();
            const visibleJobs =
              filter.length > 0
                ? queueRow.jobs.filter((job) => job.referenceLabel.toLowerCase().includes(filter))
                : queueRow.jobs;
            const visibleKeys = visibleJobs.map((job) => jobKey(queueRow.queue, job.id));
            const selectedVisible = visibleKeys.filter((key) => selectedJobs[key]).length;
            const allVisibleSelected = visibleKeys.length > 0 && selectedVisible === visibleKeys.length;

            return (
              <>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold">{queueRow.queue}</p>
            <span className="text-xs text-zinc-600">
              workers {queueRow.workers} | waiting {queueRow.counts.waiting ?? 0} | active {queueRow.counts.active ?? 0} | failed {queueRow.counts.failed ?? 0}
            </span>
            <span className={`rounded px-2 py-0.5 text-[11px] ${queueRow.paused ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
              {queueRow.paused ? "PAUSADA" : "ATIVA"}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-zinc-600">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={visibleJobs.length === 0}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelectedJobs((prev) => {
                      const next = { ...prev };
                      for (const key of visibleKeys) next[key] = checked;
                      return next;
                    });
                  }}
                />
                Selecionar visíveis ({selectedVisible}/{visibleJobs.length})
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={actionBusy === `${queueRow.queue}:queue:pause_queue` || queueRow.paused}
                onClick={() => void runAction({ queue: queueRow.queue, action: "pause_queue" })}
              >
                Pausar fila
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={actionBusy === `${queueRow.queue}:queue:resume_queue` || !queueRow.paused}
                onClick={() => void runAction({ queue: queueRow.queue, action: "resume_queue" })}
              >
                Retomar fila
              </Button>
            </div>
          </div>

          {visibleJobs.length === 0 ? (
            <p className="text-xs text-zinc-500">Sem jobs no recorte atual.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-zinc-200 text-left">
                    <th className="px-2 py-1">Sel.</th>
                    <th className="px-2 py-1">Job</th>
                    <th className="px-2 py-1">Estado</th>
                    <th className="px-2 py-1">Referencia</th>
                    <th className="px-2 py-1">Tentativas</th>
                    <th className="px-2 py-1">Criado</th>
                    <th className="px-2 py-1">Processado</th>
                    <th className="px-2 py-1">Finalizado</th>
                    <th className="px-2 py-1">Acoes</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map((job) => {
                    const keyBase = `${queueRow.queue}:${job.id}`;
                    const selected = selectedJobs[keyBase] ?? false;
                    return (
                      <tr key={`${queueRow.queue}:${job.id}`} className="border-b border-zinc-100 align-top">
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelectedJobs((prev) => ({ ...prev, [keyBase]: checked }));
                            }}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <p className="font-medium">{job.name}</p>
                          <p className="text-zinc-500">{job.id}</p>
                          {job.failedReason ? <p className="text-red-700">{job.failedReason}</p> : null}
                        </td>
                        <td className="px-2 py-1">{job.state}</td>
                        <td className="px-2 py-1">
                          <p>{job.referenceLabel}</p>
                          <p className="text-zinc-500">extraction {job.data.extractionId ?? "-"}</p>
                        </td>
                        <td className="px-2 py-1">{job.attemptsMade}</td>
                        <td className="px-2 py-1">{formatDate(job.timestamp)}</td>
                        <td className="px-2 py-1">{formatDate(job.processedOn)}</td>
                        <td className="px-2 py-1">{formatDate(job.finishedOn)}</td>
                        <td className="px-2 py-1">
                          <div className="flex flex-wrap gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={actionBusy === `${keyBase}:stop` || actionBusy === "bulk:stop"}
                              onClick={() => void runAction({ queue: queueRow.queue, action: "stop", jobId: job.id })}
                            >
                              Parar
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={actionBusy === `${keyBase}:remove` || actionBusy === "bulk:remove"}
                              onClick={() => void runAction({ queue: queueRow.queue, action: "remove", jobId: job.id })}
                            >
                              Remover
                            </Button>
                            {job.state === "failed" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={actionBusy === `${keyBase}:retry`}
                                onClick={() => void runAction({ queue: queueRow.queue, action: "retry", jobId: job.id })}
                              >
                                Retry
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
              </>
            );
          })()}
        </div>
      ))}
    </div>
  );
}
