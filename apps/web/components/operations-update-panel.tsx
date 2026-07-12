"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type UpdateState = {
  running: boolean;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  command: string;
  pid: number | null;
  logFile: string;
  lastError: string | null;
};

type UpdateResponse = {
  running: boolean;
  state: UpdateState;
  tail: string;
  platform?: string;
};

export function OperationsUpdatePanel() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [tail, setTail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipPull, setSkipPull] = useState(false);
  const [skipBackup, setSkipBackup] = useState(false);
  const [healthTimeout, setHealthTimeout] = useState("300");
  const [platform, setPlatform] = useState<string>("-");
  const preRef = useRef<HTMLPreElement | null>(null);

  const fetchStatus = useCallback(async () => {
    const response = await fetch("/api/ops/update", { cache: "no-store" });
    const payload = (await response.json()) as UpdateResponse | { error: string };
    if (!response.ok) {
      throw new Error("error" in payload ? payload.error : "Falha ao consultar atualizacao.");
    }
    const parsed = payload as UpdateResponse;
    setState(parsed.state);
    setTail(parsed.tail ?? "");
    setPlatform(parsed.platform ?? "-");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function run() {
      try {
        await fetchStatus();
        if (cancelled) return;
        timer = setInterval(() => {
          fetchStatus().catch((err: Error) => setError(err.message));
        }, 2500);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Falha ao carregar status.");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [fetchStatus]);

  useEffect(() => {
    if (!preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [tail]);

  const statusText = useMemo(() => {
    if (!state) return "Carregando...";
    if (state.running) return "Executando";
    if (state.exitCode === 0) return "Concluido com sucesso";
    if (state.exitCode !== null) return `Finalizado com erro (${state.exitCode})`;
    return "Ocioso";
  }, [state]);

  async function startUpdate() {
    try {
      setLoading(true);
      setError(null);
      const timeout = Number(healthTimeout);
      const response = await fetch("/api/ops/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skipPull,
          skipBackup,
          healthTimeoutSeconds: Number.isFinite(timeout) && timeout >= 60 ? timeout : undefined
        })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao iniciar atualizacao.");
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao iniciar atualizacao.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <label className="flex items-center gap-2 rounded border border-zinc-200 p-2 text-sm">
          <input type="checkbox" checked={skipPull} onChange={(e) => setSkipPull(e.target.checked)} />
          Pular git pull
        </label>
        <label className="flex items-center gap-2 rounded border border-zinc-200 p-2 text-sm">
          <input type="checkbox" checked={skipBackup} onChange={(e) => setSkipBackup(e.target.checked)} />
          Pular backup
        </label>
        <label className="flex items-center gap-2 rounded border border-zinc-200 p-2 text-sm">
          Timeout health (s)
          <input
            className="w-24 rounded border border-zinc-300 px-2 py-1"
            value={healthTimeout}
            onChange={(e) => setHealthTimeout(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={startUpdate}
          disabled={loading || Boolean(state?.running)}
          className="rounded bg-zinc-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? "Iniciando..." : "Executar atualizacao"}
        </button>
      </div>

      <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-sm">
        <p>
          <strong>Status:</strong> {statusText}
        </p>
        <p>
          <strong>SO detectado:</strong> {platform}
        </p>
        <p>
          <strong>Comando:</strong> {state?.command || "-"}
        </p>
        <p>
          <strong>Inicio:</strong> {state?.startedAt ? new Date(state.startedAt).toLocaleString() : "-"}
        </p>
        <p>
          <strong>Fim:</strong> {state?.endedAt ? new Date(state.endedAt).toLocaleString() : "-"}
        </p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div>
        <p className="mb-2 text-sm font-semibold">Console de atualizacao</p>
        <pre
          ref={preRef}
          className="max-h-[420px] overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-100"
        >
          {tail || "Sem logs ainda."}
        </pre>
      </div>
    </div>
  );
}
