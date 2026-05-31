"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type PdfProcessingMode = "analysis-only" | "analysis-and-ocr";

type PdfPageAnalysis = {
  pageNumber: number;
  hasExtractableText: boolean;
  needsOcr: boolean;
  isLikelyBlank: boolean;
  isLikelyDuplicate: boolean;
  duplicateOfPageNumber?: number;
  confidenceScore: number;
  extractedTextLength: number;
};

type PdfProcessingResponse = {
  success: boolean;
  mode: PdfProcessingMode;
  processedFileUrl?: string | null;
  temporary?: boolean;
  note?: string;
  summary: {
    totalPages: number;
    pagesNeedingOcr: number;
    blankPages: number;
    possibleDuplicatePages: number;
  };
  pages: PdfPageAnalysis[];
  warnings: string[];
  errors: string[];
  processingTimeMs: number;
};

export function PdfTemporaryProcessingForm() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<PdfProcessingMode>("analysis-only");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfProcessingResponse | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("mode", mode);
      const response = await fetch("/api/pdf/temp-import", {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as PdfProcessingResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha no tratamento temporario de PDF.");
      }
      setResult(payload);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Erro inesperado.");
    } finally {
      setLoading(false);
    }
  }

  const pagesWithoutOcr = result?.pages.filter((page) => page.needsOcr) ?? [];
  const blankPages = result?.pages.filter((page) => page.isLikelyBlank) ?? [];
  const duplicatePages = result?.pages.filter((page) => page.isLikelyDuplicate) ?? [];

  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1">
          <label className="text-sm font-medium text-zinc-700">Arquivo PDF</label>
          <Input type="file" accept=".pdf,application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-zinc-700">Modo</label>
          <select
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
            value={mode}
            onChange={(event) => setMode(event.target.value as PdfProcessingMode)}
          >
            <option value="analysis-only">analysis-only (analisa páginas)</option>
            <option value="analysis-and-ocr">analysis-and-ocr (executa OCR seletivo)</option>
          </select>
        </div>

        <Button type="submit" disabled={loading}>
          {loading ? "Processando PDF..." : "Tratar PDF (temporário)"}
        </Button>
      </form>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {result ? (
        <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
          <p>
            <strong>Resumo:</strong> {result.summary.totalPages} páginas, {result.summary.pagesNeedingOcr} com OCR necessário,{" "}
            {result.summary.blankPages} em branco, {result.summary.possibleDuplicatePages} possíveis duplicadas.
          </p>
          <p>
            <strong>Tempo:</strong> {result.processingTimeMs} ms
          </p>
          {result.note ? <p className="text-xs text-zinc-600">{result.note}</p> : null}
          {result.processedFileUrl ? (
            <a className="text-emerald-700 underline" href={result.processedFileUrl} target="_blank" rel="noreferrer">
              Baixar PDF tratado
            </a>
          ) : null}

          <div>
            <p className="font-medium">Páginas sem OCR útil: {pagesWithoutOcr.map((page) => page.pageNumber).join(", ") || "-"}</p>
            <p className="font-medium">Páginas em branco: {blankPages.map((page) => page.pageNumber).join(", ") || "-"}</p>
            <p className="font-medium">
              Páginas duplicadas:{" "}
              {duplicatePages
                .map((page) => `${page.pageNumber}${page.duplicateOfPageNumber ? `->${page.duplicateOfPageNumber}` : ""}`)
                .join(", ") || "-"}
            </p>
          </div>

          <div className="max-h-60 overflow-auto rounded border border-zinc-200 bg-white p-2">
            <p className="mb-2 font-medium">Análise por página</p>
            <div className="space-y-1 text-xs">
              {result.pages.map((page) => (
                <p key={page.pageNumber}>
                  P{page.pageNumber}: text={page.hasExtractableText ? "yes" : "no"}, needsOcr={page.needsOcr ? "yes" : "no"},
                  blank={page.isLikelyBlank ? "yes" : "no"}, dup=
                  {page.isLikelyDuplicate ? `yes(${page.duplicateOfPageNumber ?? "?"})` : "no"}, conf=
                  {page.confidenceScore.toFixed(2)}, len={page.extractedTextLength}
                </p>
              ))}
            </div>
          </div>

          {result.warnings.length > 0 ? (
            <div>
              <p className="font-medium text-amber-700">Warnings</p>
              {result.warnings.map((warning, index) => (
                <p key={`${warning}-${index}`} className="text-xs text-amber-700">
                  - {warning}
                </p>
              ))}
            </div>
          ) : null}
          {result.errors.length > 0 ? (
            <div>
              <p className="font-medium text-red-700">Errors</p>
              {result.errors.map((entry, index) => (
                <p key={`${entry}-${index}`} className="text-xs text-red-700">
                  - {entry}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
