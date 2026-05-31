"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function CaseManualForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    title: "",
    caseNumber: "",
    inquiryType: "",
    inquiryNumber: "",
    policeUnit: "",
    inquiryLegalFraming: "",
    inquirySummaryText: "",
    inquiryMainFacts: "",
    inquiryInvestigativeFocus: "",
    inquiryInvolvedPeople: ""
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateField(name: string, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/cases/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          inquiryInvolvedPeople: form.inquiryInvolvedPeople
            .split(/\n|,/)
            .map((item) => item.trim())
            .filter(Boolean)
        })
      });
      const payload = (await response.json()) as { caseId?: string; error?: string };
      if (!response.ok || !payload.caseId) {
        throw new Error(payload.error ?? "Falha ao criar caso.");
      }
      router.push(`/cases/${payload.caseId}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao criar caso.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Titulo do caso</label>
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={form.title}
            onChange={(event) => updateField("title", event.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Numero do caso / IP</label>
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={form.caseNumber}
            onChange={(event) => updateField("caseNumber", event.target.value)}
            required
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Tipo de inquerito</label>
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={form.inquiryType}
            onChange={(event) => updateField("inquiryType", event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Numero do inquerito</label>
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={form.inquiryNumber}
            onChange={(event) => updateField("inquiryNumber", event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Unidade / origem</label>
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={form.policeUnit}
            onChange={(event) => updateField("policeUnit", event.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Tipificacao</label>
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={form.inquiryLegalFraming}
            onChange={(event) => updateField("inquiryLegalFraming", event.target.value)}
            required
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Resumo inicial</label>
        <textarea
          className="min-h-[110px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          value={form.inquirySummaryText}
          onChange={(event) => updateField("inquirySummaryText", event.target.value)}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Fatos principais</label>
        <textarea
          className="min-h-[110px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          value={form.inquiryMainFacts}
          onChange={(event) => updateField("inquiryMainFacts", event.target.value)}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Contexto inicial para IA / foco investigativo</label>
        <textarea
          className="min-h-[120px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          value={form.inquiryInvestigativeFocus}
          onChange={(event) => updateField("inquiryInvestigativeFocus", event.target.value)}
          required
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Envolvidos</label>
        <textarea
          className="min-h-[90px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          value={form.inquiryInvolvedPeople}
          onChange={(event) => updateField("inquiryInvolvedPeople", event.target.value)}
          placeholder="Uma pessoa por linha ou separado por virgulas"
        />
      </div>

      <Button type="submit" disabled={busy}>
        {busy ? "Criando caso..." : "Criar caso manualmente"}
      </Button>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </form>
  );
}
