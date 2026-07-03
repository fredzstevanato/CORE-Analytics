"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Props = {
  evidenceId: string;
  evidenceFileName: string;
  extractionStatus?: string | null;
};

export function CaseUfdrHardResetButton({ evidenceId, evidenceFileName, extractionStatus }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blockedByExtraction = extractionStatus === "PROCESSING" || extractionStatus === "INDEXING";

  async function onHardReset() {
    const confirmed = window.confirm(
      [
        `Reset UFDR para ${evidenceFileName}?`,
        "Isso exclui evidencia, storage e limpa ingestoes associadas (filas/transcricoes).",
        "Esta acao nao pode ser desfeita."
      ].join("\n")
    );
    if (!confirmed) return;

    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/evidences/${evidenceId}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hardReset: true })
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao executar hard reset do UFDR.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao executar hard reset do UFDR.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-1">
      <Button
        type="button"
        size="sm"
        variant="default"
        className="bg-red-700 text-white hover:bg-red-800"
        disabled={busy || blockedByExtraction}
        onClick={onHardReset}
      >
        {busy ? "Resetando..." : "Reset UFDR"}
      </Button>
      {blockedByExtraction ? (
        <p className="text-xs text-amber-700">Aguarde o fim da extracao para executar o hard reset.</p>
      ) : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
