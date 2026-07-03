"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type AudioReviewItem = {
  attachmentId: string;
  label: string;
  aiRelevant: boolean;
};

export function AudioReviewSelection({
  caseId,
  evidenceId,
  extractionId,
  items,
  initialSelectedIds
}: {
  caseId?: string;
  evidenceId?: string;
  extractionId?: string;
  items: AudioReviewItem[];
  initialSelectedIds: string[];
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(initialSelectedIds));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const relevantIds = useMemo(() => items.filter((item) => item.aiRelevant).map((item) => item.attachmentId), [items]);

  function replaceSelection(ids: string[]) {
    setSelectedIds(new Set(ids));
    setStatus(null);
  }

  function toggle(id: string) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setStatus(null);
  }

  async function saveSelection() {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/analysis/audios/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          evidenceId,
          extractionId,
          selectedAttachmentIds: [...selectedIds],
          visibleAttachmentIds: items.map((item) => item.attachmentId)
        })
      });
      const payload = (await response.json()) as { selectedCount?: number; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao salvar selecao.");
      setStatus(`Selecao salva com ${payload.selectedCount ?? selectedIds.size} audio(s).`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Falha ao salvar selecao.");
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold">Selecao de audios soltos para analise</p>
          <p className="text-xs text-zinc-600">
            {selectedIds.size} selecionado(s) nesta pagina | {relevantIds.length} apontado(s) pela IA
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => replaceSelection(relevantIds)}>
            Selecionar relevantes por IA
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => replaceSelection(items.map((item) => item.attachmentId))}>
            Selecionar pagina
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => replaceSelection([])}>
            Limpar
          </Button>
          <Button type="button" size="sm" disabled={busy || !caseId} onClick={saveSelection}>
            Salvar selecao
          </Button>
        </div>
      </div>
      {!caseId ? <p className="mt-2 text-xs text-amber-700">Escolha um caso para salvar a selecao.</p> : null}
      {status ? <p className="mt-2 text-xs text-zinc-700">{status}</p> : null}
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {items.map((item) => (
          <label key={item.attachmentId} className="flex items-center gap-2 rounded border border-zinc-200 bg-white px-2 py-1">
            <input type="checkbox" checked={selectedIds.has(item.attachmentId)} onChange={() => toggle(item.attachmentId)} />
            <span className="truncate text-xs text-zinc-700">{item.label}</span>
            {item.aiRelevant ? <span className="ml-auto rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">IA</span> : null}
          </label>
        ))}
      </div>
    </div>
  );
}

export function AudioReviewInlineCheckbox({
  caseId,
  evidenceId,
  extractionId,
  attachmentId,
  initialSelected
}: {
  caseId?: string;
  evidenceId?: string;
  extractionId?: string;
  attachmentId: string;
  initialSelected: boolean;
}) {
  const [selected, setSelected] = useState(initialSelected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(nextSelected: boolean) {
    if (!caseId) {
      setError("Escolha um caso para salvar.");
      return;
    }

    setSelected(nextSelected);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/analysis/audios/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          evidenceId,
          extractionId,
          toggleAttachmentId: attachmentId,
          toggleSelected: nextSelected
        })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao salvar selecao.");
    } catch (err) {
      setSelected(!nextSelected);
      setError(err instanceof Error ? err.message : "Falha ao salvar selecao.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="inline-flex items-center gap-2 rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700">
      <input
        type="checkbox"
        checked={selected}
        disabled={busy || !caseId}
        onChange={(event) => toggle(event.target.checked)}
      />
      Selecionar
      {error ? <span className="text-red-700">{error}</span> : null}
    </label>
  );
}
