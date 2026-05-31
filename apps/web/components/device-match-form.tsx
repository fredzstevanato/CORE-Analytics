"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

type SeizedObjectOption = {
  id: string;
  label: string;
  manufacturer?: string | null;
  model?: string | null;
  imei?: string | null;
  serialNumber?: string | null;
};

type ExpertReportOption = {
  id: string;
  title: string;
};

export function DeviceMatchForm({
  deviceId,
  seizedObjects,
  expertReports,
  currentMatchedSeizedObjectId,
  currentMatchStatus
}: {
  deviceId: string;
  seizedObjects: SeizedObjectOption[];
  expertReports: ExpertReportOption[];
  currentMatchedSeizedObjectId?: string | null;
  currentMatchStatus?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    seizedObjectId: currentMatchedSeizedObjectId ?? seizedObjects[0]?.id ?? "",
    expertReportId: "",
    status: currentMatchStatus === "CONFIRMED" ? "CONFIRMED" : "SUGGESTED",
    confidence: "0.8",
    justification: ""
  });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.seizedObjectId) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/devices/${deviceId}/matches`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          seizedObjectId: form.seizedObjectId,
          expertReportId: form.expertReportId || undefined,
          status: form.status,
          confidence: Number(form.confidence),
          justification: form.justification || undefined
        })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao registrar match.");
      }
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao registrar match.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3 rounded border border-zinc-200 bg-zinc-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-600">Match com objeto apreendido</p>
      <div className="grid gap-3 md:grid-cols-2">
        <select
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          value={form.seizedObjectId}
          onChange={(event) => setForm((current) => ({ ...current, seizedObjectId: event.target.value }))}
        >
          {seizedObjects.map((object) => (
            <option key={object.id} value={object.id}>
              {object.label}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          value={form.expertReportId}
          onChange={(event) => setForm((current) => ({ ...current, expertReportId: event.target.value }))}
        >
          <option value="">Sem laudo associado</option>
          {expertReports.map((report) => (
            <option key={report.id} value={report.id}>
              {report.title}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <select
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          value={form.status}
          onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}
        >
          <option value="SUGGESTED">Sugestao</option>
          <option value="CONFIRMED">Confirmado</option>
          <option value="REJECTED">Rejeitado</option>
        </select>
        <input
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          value={form.confidence}
          onChange={(event) => setForm((current) => ({ ...current, confidence: event.target.value }))}
          placeholder="Confianca 0-1"
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Salvando..." : "Salvar match"}
        </Button>
      </div>
      <textarea
        className="min-h-[80px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        value={form.justification}
        onChange={(event) => setForm((current) => ({ ...current, justification: event.target.value }))}
        placeholder="Justificativa / observacao da comparacao"
      />
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </form>
  );
}
