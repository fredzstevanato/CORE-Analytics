"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type OpsResponse = {
  ok: boolean;
  overallStatus: "ok" | "degraded" | "down";
  timestamp: string;
  services: {
    database: { status: "ok" | "degraded" | "down"; pingMs: number | null };
    redis: { status: "ok" | "degraded" | "down"; pingMs: number | null };
    opensearch: { status: "ok" | "degraded" | "down"; pingMs: number | null; clusterStatus: string | null };
    queues: {
      status: "ok" | "degraded" | "down";
      items: Array<{
        name: string;
        status: "ok" | "degraded" | "down";
        workers: number;
        counts: Record<string, number>;
      }>;
    };
  };
  workload: {
    extractions: Array<{ status: string; _count: { _all: number } }>;
    transcriptions: Array<{ status: string; _count: { _all: number } }>;
  };
};

function statusClass(status: "ok" | "degraded" | "down") {
  if (status === "ok") return "bg-emerald-100 text-emerald-800";
  if (status === "degraded") return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

export function OperationsHealthPanel() {
  const [data, setData] = useState<OpsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ops/health");
      const payload = (await response.json()) as OpsResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao carregar saude operacional.");
      }
      setData(payload);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Falha ao carregar saude operacional.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void load();
    }, 15000);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  const extractionSummary = useMemo(() => {
    const rows = data?.workload.extractions ?? [];
    return rows
      .map((row) => `${row.status}: ${row._count._all}`)
      .join(" | ");
  }, [data?.workload.extractions]);

  const transcriptionSummary = useMemo(() => {
    const rows = data?.workload.transcriptions ?? [];
    return rows
      .map((row) => `${row.status}: ${row._count._all}`)
      .join(" | ");
  }, [data?.workload.transcriptions]);

  return (
    <div className="space-y-3 rounded border border-zinc-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">Saude operacional</p>
        {data ? (
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusClass(data.overallStatus)}`}>
            {data.overallStatus.toUpperCase()}
          </span>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
          {busy ? "Atualizando..." : "Atualizar agora"}
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-zinc-600">
          <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
          Auto (15s)
        </label>
      </div>

      {data ? (
        <p className="text-xs text-zinc-500">Ultima leitura: {new Date(data.timestamp).toLocaleString("pt-BR")}</p>
      ) : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}

      {data ? (
        <>
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded border border-zinc-200 p-2 text-xs">
              <p className="font-medium">Database</p>
              <p>Status: {data.services.database.status}</p>
              <p>Ping: {data.services.database.pingMs ?? "-"} ms</p>
            </div>
            <div className="rounded border border-zinc-200 p-2 text-xs">
              <p className="font-medium">Redis</p>
              <p>Status: {data.services.redis.status}</p>
              <p>Ping: {data.services.redis.pingMs ?? "-"} ms</p>
            </div>
            <div className="rounded border border-zinc-200 p-2 text-xs">
              <p className="font-medium">OpenSearch</p>
              <p>Status: {data.services.opensearch.status}</p>
              <p>Cluster: {data.services.opensearch.clusterStatus ?? "-"}</p>
              <p>Ping: {data.services.opensearch.pingMs ?? "-"} ms</p>
            </div>
          </div>

          <div className="rounded border border-zinc-200 p-2">
            <p className="text-xs font-medium">Filas e workers</p>
            <div className="mt-2 space-y-1">
              {data.services.queues.items.map((queue) => (
                <div key={queue.name} className="rounded border border-zinc-100 p-2 text-xs">
                  <p className="font-medium">{queue.name}</p>
                  <p>
                    Status: {queue.status} | Workers: {queue.workers} | Waiting: {queue.counts.waiting ?? 0} | Active:{" "}
                    {queue.counts.active ?? 0} | Failed: {queue.counts.failed ?? 0}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded border border-zinc-200 p-2 text-xs">
              <p className="font-medium">Carga de extracoes</p>
              <p>{extractionSummary || "Sem dados"}</p>
            </div>
            <div className="rounded border border-zinc-200 p-2 text-xs">
              <p className="font-medium">Carga de transcricoes</p>
              <p>{transcriptionSummary || "Sem dados"}</p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

