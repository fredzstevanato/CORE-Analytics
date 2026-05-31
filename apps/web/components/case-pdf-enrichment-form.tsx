"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

type EnrichmentResponse = {
  success: boolean;
  caseId: string;
  evidenceId: string;
  contextInsightId: string;
  mode: "analysis-only" | "analysis-and-ocr";
  pipeline: {
    success: boolean;
    summary: {
      totalPages: number;
      pagesNeedingOcr: number;
      blankPages: number;
      possibleDuplicatePages: number;
    };
    warnings: string[];
    errors: string[];
    processedFile?: { absolutePath: string };
  };
  contextUpdatedFields: Record<string, unknown>;
  triage: { insightId: string; summary?: string } | null;
  report: { id: string; title: string } | null;
};

export function CasePdfEnrichmentForm({ caseId }: { caseId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"analysis-only" | "analysis-and-ocr">("analysis-only");
  const [contextModel, setContextModel] = useState("gpt-5.4");
  const [analysisModel, setAnalysisModel] = useState("gpt-5.4-mini");
  const [reportModel, setReportModel] = useState("gpt-5.4");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [autoRunTriage, setAutoRunTriage] = useState(true);
  const [autoRunFinalReport, setAutoRunFinalReport] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<EnrichmentResponse | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;

    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(8);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("mode", mode);
      formData.append("contextModel", contextModel);
      formData.append("analysisModel", analysisModel);
      formData.append("reportModel", reportModel);
      formData.append("overwriteExisting", String(overwriteExisting));
      formData.append("autoRunTriage", String(autoRunTriage || autoRunFinalReport));
      formData.append("autoRunFinalReport", String(autoRunFinalReport));
      if (openaiApiKey.trim()) formData.append("openaiApiKey", openaiApiKey.trim());

      setProgress(35);
      const response = await fetch(`/api/cases/${caseId}/enrich-pdf`, {
        method: "POST",
        body: formData
      });
      setProgress(75);
      const payload = (await response.json()) as EnrichmentResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao enriquecer caso com PDF.");
      }
      setResult(payload);
      setProgress(100);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Erro inesperado.");
      setProgress(0);
    } finally {
      setBusy(false);
      setOpenaiApiKey("");
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">PDF do Inquerito (inclusao tardia)</p>
          <Input
            type="file"
            accept=".pdf,application/pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as "analysis-only" | "analysis-and-ocr")}
            className="rounded border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="analysis-only">PDF mode: analysis-only</option>
            <option value="analysis-and-ocr">PDF mode: analysis-and-ocr</option>
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

        <div className="grid gap-2 md:grid-cols-3">
          <select
            value={contextModel}
            onChange={(event) => setContextModel(event.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="gpt-5.4">Contexto: gpt-5.4</option>
            <option value="gpt-5.4-mini">Contexto: gpt-5.4-mini</option>
            <option value="gpt-5.2">Contexto: gpt-5.2</option>
            <option value="gpt-4.1">Contexto: gpt-4.1</option>
          </select>
          <select
            value={analysisModel}
            onChange={(event) => setAnalysisModel(event.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="gpt-5.4-mini">Triagem: gpt-5.4-mini</option>
            <option value="gpt-5.4">Triagem: gpt-5.4</option>
            <option value="gpt-4.1-mini">Triagem: gpt-4.1-mini</option>
            <option value="gpt-4.1">Triagem: gpt-4.1</option>
          </select>
          <select
            value={reportModel}
            onChange={(event) => setReportModel(event.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="gpt-5.4">Relatorio: gpt-5.4</option>
            <option value="gpt-5.4-mini">Relatorio: gpt-5.4-mini</option>
            <option value="gpt-4.1">Relatorio: gpt-4.1</option>
            <option value="gpt-4o">Relatorio: gpt-4o</option>
          </select>
        </div>

        <div className="grid gap-2 md:grid-cols-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={overwriteExisting}
              onChange={(event) => setOverwriteExisting(event.target.checked)}
            />
            sobrescrever campos existentes
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autoRunTriage} onChange={(event) => setAutoRunTriage(event.target.checked)} />
            rodar triagem automaticamente
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoRunFinalReport}
              onChange={(event) => setAutoRunFinalReport(event.target.checked)}
            />
            gerar relatorio final consolidado
          </label>
        </div>

        <Button type="submit" disabled={busy}>
          {busy ? "Processando PDF e atualizando caso..." : "Analisar PDF e Atualizar Caso"}
        </Button>
      </form>

      {(busy || progress > 0) && (
        <div className="space-y-1 rounded border border-zinc-200 p-3">
          <p className="text-xs text-zinc-700">{busy ? "Executando fluxo de enriquecimento..." : "Concluido."}</p>
          <Progress value={progress} />
        </div>
      )}

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {result ? (
        <div className="space-y-2 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p>
            <strong>Caso atualizado.</strong> Insight: {result.contextInsightId}
          </p>
          <p>
            PDF analisado: {result.pipeline.summary.totalPages} pags | OCR pendente:{" "}
            {result.pipeline.summary.pagesNeedingOcr} | Brancas: {result.pipeline.summary.blankPages} | Duplicadas:{" "}
            {result.pipeline.summary.possibleDuplicatePages}
          </p>
          <p>Triagem: {result.triage ? `ok (${result.triage.insightId})` : "nao executada"}</p>
          <p>Relatorio final: {result.report ? `ok (${result.report.id})` : "nao executado"}</p>
          {result.pipeline.warnings.length > 0 ? (
            <p className="text-xs text-amber-700">Warnings: {result.pipeline.warnings.join(" | ")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
