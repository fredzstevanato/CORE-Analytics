"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Props = {
  evidenceId: string;
  fileName: string;
  currentLabel: string;
};

export function CaseUfdrAliasForm({ evidenceId, fileName, currentLabel }: Props) {
  const router = useRouter();
  const initialValue = currentLabel === fileName ? "" : currentLabel;
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(`/api/evidences/${evidenceId}/alias`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: value.trim() })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao salvar nome opcional da UFDR.");
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar nome opcional da UFDR.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-1">
      <label className="text-xs text-zinc-600">Nome opcional da UFDR (para visualizacao no grafo)</label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Ex.: UFDR aparelho da esposa"
          maxLength={120}
          className="w-full max-w-[340px] rounded border border-zinc-300 px-2 py-1 text-xs"
        />
        <Button type="button" size="sm" variant="outline" onClick={onSave} disabled={busy}>
          {busy ? "Salvando..." : "Salvar nome"}
        </Button>
      </div>
      {saved ? <p className="text-xs text-emerald-700">Nome salvo.</p> : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
