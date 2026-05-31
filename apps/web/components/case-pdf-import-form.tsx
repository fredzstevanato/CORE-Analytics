"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function CasePdfImportForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"analysis-only" | "analysis-and-ocr">("analysis-and-ocr");
  const [contextModel, setContextModel] = useState("gpt-5.4");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("mode", mode);
      formData.append("contextModel", contextModel);
      if (openaiApiKey.trim()) formData.append("openaiApiKey", openaiApiKey.trim());

      const response = await fetch("/api/cases/import-pdf", {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as { sessionId?: string; error?: string };
      if (!response.ok || !payload.sessionId) {
        throw new Error(payload.error ?? "Falha ao importar PDF.");
      }

      router.push(`/cases/import/${payload.sessionId}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao importar PDF.");
    } finally {
      setBusy(false);
      setOpenaiApiKey("");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1">
        <label className="text-sm font-medium">PDF do inquerito</label>
        <input
          type="file"
          accept=".pdf,application/pdf"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          required
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <select
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          value={mode}
          onChange={(event) => setMode(event.target.value as "analysis-only" | "analysis-and-ocr")}
        >
          <option value="analysis-and-ocr">Analise + OCR seletivo</option>
          <option value="analysis-only">Somente analise</option>
        </select>
        <select
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          value={contextModel}
          onChange={(event) => setContextModel(event.target.value)}
        >
          <option value="gpt-5.4">Contexto: gpt-5.4</option>
          <option value="gpt-5.4-mini">Contexto: gpt-5.4-mini</option>
          <option value="gpt-5.2">Contexto: gpt-5.2</option>
          <option value="gpt-4.1">Contexto: gpt-4.1</option>
        </select>
      </div>

      <input
        type="password"
        value={openaiApiKey}
        onChange={(event) => setOpenaiApiKey(event.target.value)}
        placeholder="OpenAI API Key (opcional, sobrescreve chave global)"
        className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        autoComplete="off"
        spellCheck={false}
      />

      <Button type="submit" disabled={busy}>
        {busy ? "Processando PDF..." : "Criar rascunho a partir do PDF"}
      </Button>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </form>
  );
}
