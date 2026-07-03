"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type IntakeResponse = {
  caseId?: string;
  error?: string;
};

export function CaseIntakeForm() {
  const router = useRouter();
  const [inquiryCompiledText, setInquiryCompiledText] = useState("");
  const [extractionReportText, setExtractionReportText] = useState("");
  const [model, setModel] = useState("gpt-5.4-mini");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (inquiryCompiledText.trim().length < 20) {
      setError("Cole um compilado do inquerito com mais conteudo.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/cases/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inquiryCompiledText,
          extractionReportText,
          model,
          openaiApiKey: openaiApiKey || undefined
        })
      });
      const payload = (await response.json()) as IntakeResponse;
      if (!response.ok || !payload.caseId) {
        throw new Error(payload.error ?? "Falha ao criar caso.");
      }

      setOpenaiApiKey("");
      router.push(`/cases/${payload.caseId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar caso.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-2 md:grid-cols-[220px_1fr]">
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="gpt-5.4-mini">gpt-5.4-mini</option>
          <option value="gpt-5.4">gpt-5.4</option>
          <option value="gpt-5.2">gpt-5.2</option>
          <option value="gpt-4.1-mini">gpt-4.1-mini</option>
          <option value="gpt-4.1">gpt-4.1</option>
          <option value="gpt-4o">gpt-4o</option>
        </select>
        <input
          type="password"
          value={openaiApiKey}
          onChange={(event) => setOpenaiApiKey(event.target.value)}
          placeholder="OpenAI API Key (opcional, sobrescreve chave global)"
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium">Compilado do Inquerito</p>
        <textarea
          value={inquiryCompiledText}
          onChange={(event) => setInquiryCompiledText(event.target.value)}
          className="min-h-[160px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          placeholder="Cole aqui o texto compilado do inquerito para IA resumir e preencher dados do caso..."
        />
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium">Relatorio da Extracao (opcional)</p>
        <textarea
          value={extractionReportText}
          onChange={(event) => setExtractionReportText(event.target.value)}
          className="min-h-[120px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          placeholder="Cole aqui o relatorio da extracao para enriquecer o contexto do caso..."
        />
      </div>

      <Button type="submit" disabled={busy}>
        {busy ? "Criando caso com IA..." : "Criar Caso com Intake IA"}
      </Button>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </form>
  );
}
