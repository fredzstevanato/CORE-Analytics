"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function AnalysisSyncActions({
  caseId,
  evidenceId
}: {
  caseId?: string;
  evidenceId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSync() {
    if (!caseId) {
      setError("Selecione um caso para sincronizar.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/cases/${caseId}/analysis/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          evidenceId: evidenceId || undefined
        })
      });
      const payload = (await response.json()) as {
        error?: string;
        timelineCreated?: number;
        locationArtifactsCreated?: number;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao sincronizar visões derivadas.");
      }
      setMessage(
        `Sincronização concluída: ${payload.timelineCreated ?? 0} eventos de timeline e ${payload.locationArtifactsCreated ?? 0} localizações.`
      );
      router.refresh();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Falha ao sincronizar visões derivadas.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" disabled={busy || !caseId} onClick={onSync}>
        {busy ? "Sincronizando..." : "Sincronizar timeline e localizacoes"}
      </Button>
      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
