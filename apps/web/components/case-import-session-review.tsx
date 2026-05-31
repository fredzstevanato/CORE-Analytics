"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type SessionView = {
  id: string;
  status: string;
  draftPayload: Record<string, unknown> | null;
  pipelineSummary: Record<string, unknown> | null;
  document?: {
    id: string;
    fileName: string;
  } | null;
};

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function deriveCaseTitleFromIdentifiers(input: { caseNumber: string; inquiryNumber: string; inquiryType: string; fallbackTitle: string }) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const inquiryNumber = normalize(input.inquiryNumber);
  const caseNumber = normalize(input.caseNumber);
  const inquiryType = normalize(input.inquiryType).toUpperCase();
  const fallbackTitle = normalize(input.fallbackTitle);
  const primary = inquiryNumber || caseNumber;
  if (primary) return primary;

  const patterns: RegExp[] = [];
  if (inquiryType.includes("TCO")) patterns.push(/\b(TCO[\s:/-]*[A-Z0-9./-]+)\b/i);
  if (inquiryType.includes("BOC")) patterns.push(/\b(BOC[\s:/-]*[A-Z0-9./-]+)\b/i);
  patterns.push(/\b((?:IP|INQ(?:UERITO)?|INQU[ÉE]RITO|TCO|BOC)[\s:/-]*[A-Z0-9./-]+)\b/i);

  for (const regex of patterns) {
    const match = fallbackTitle.match(regex)?.[1]?.trim();
    if (match) return match;
  }

  return fallbackTitle || "Caso importado por PDF";
}

export function CaseImportSessionReview({ session }: { session: SessionView }) {
  const router = useRouter();
  const draft = session.draftPayload ?? {};
  const summary = session.pipelineSummary ?? {};
  const categorizedPeopleDraft =
    Array.isArray((draft as Record<string, unknown>).involvedPeopleCategorized) ||
    typeof (draft as Record<string, unknown>).involvedPeopleCategorized === "object"
      ? (draft as Record<string, unknown>).involvedPeopleCategorized
      : undefined;
  const [form, setForm] = useState({
    caseNumber: stringValue(draft.caseNumber),
    title: stringValue(draft.title),
    description: stringValue(draft.description),
    inquiryType: stringValue(draft.inquiryType),
    inquiryNumber: stringValue(draft.inquiryNumber),
    policeUnit: stringValue(draft.policeUnit),
    inquiryLegalFraming: stringValue(draft.inquiryLegalFraming),
    inquirySummaryText: stringValue(draft.inquirySummaryText),
    inquiryMainFacts: stringValue(draft.inquiryMainFacts),
    inquiryInvestigativeFocus: stringValue(draft.inquiryInvestigativeFocus),
    extractionReportSummary: stringValue(draft.extractionReportSummary),
    inquiryInvolvedPeople: stringArrayValue(draft.involvedPeople).join("\n")
  });
  const [busy, setBusy] = useState<"save" | "confirm" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const warnings = useMemo(() => (Array.isArray(summary.warnings) ? summary.warnings : []), [summary.warnings]);
  const processedFilePath =
    summary?.processedFile && typeof summary.processedFile === "object"
      ? (summary.processedFile as Record<string, unknown>).absolutePath
      : undefined;
  const processedFileAbsolutePath = typeof processedFilePath === "string" ? processedFilePath : undefined;
  const processedFileName =
    summary?.processedFile && typeof summary.processedFile === "object"
      ? (summary.processedFile as Record<string, unknown>).fileName
      : undefined;

  useEffect(() => {
    setForm((current) => ({
      ...current,
      title: deriveCaseTitleFromIdentifiers({
        caseNumber: current.caseNumber,
        inquiryNumber: current.inquiryNumber,
        inquiryType: current.inquiryType,
        fallbackTitle: current.title
      })
    }));
  }, [form.caseNumber, form.inquiryNumber, form.inquiryType]);

  function updateField(name: string, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function saveDraft() {
    setBusy("save");
    setError(null);
    try {
      const response = await fetch(`/api/cases/import-pdf/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftPayload: {
            ...form,
            involvedPeople: form.inquiryInvolvedPeople
              .split(/\n|,/)
              .map((item) => item.trim())
              .filter(Boolean),
            involvedPeopleCategorized: categorizedPeopleDraft
          }
        })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao salvar rascunho.");
      }
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao salvar rascunho.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmDraft() {
    setBusy("confirm");
    setError(null);
    try {
      const response = await fetch(`/api/cases/import-pdf/${session.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          inquiryInvolvedPeople: form.inquiryInvolvedPeople
            .split(/\n|,/)
            .map((item) => item.trim())
            .filter(Boolean),
          inquiryInvolvedPeopleCategorized: categorizedPeopleDraft
        })
      });
      const payload = (await response.json()) as { caseId?: string; error?: string };
      if (!response.ok || !payload.caseId) {
        throw new Error(payload.error ?? "Falha ao confirmar rascunho.");
      }
      router.push(`/cases/${payload.caseId}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao confirmar rascunho.");
    } finally {
      setBusy(null);
    }
  }

  async function discardDraft() {
    setBusy("discard");
    setError(null);
    try {
      const response = await fetch(`/api/cases/import-pdf/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "discard"
        })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao descartar rascunho.");
      }
      router.push("/cases");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao descartar rascunho.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-sm">
        <p>
          <strong>Status:</strong> {session.status}
        </p>
        <p>
          <strong>Documento:</strong> {session.document?.fileName ?? "N/D"}
        </p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          {session.document?.id ? (
            <a
              href={`/api/case-documents/${session.document.id}/content?download=1`}
              className="text-blue-700 underline"
              target="_blank"
              rel="noreferrer"
            >
              Baixar documento original
            </a>
          ) : null}
          {processedFileAbsolutePath ? (
            <a
              href={`/api/pdf/processed?path=${encodeURIComponent(processedFileAbsolutePath)}&download=1${
                typeof processedFileName === "string" && processedFileName
                  ? `&filename=${encodeURIComponent(processedFileName)}`
                  : ""
              }`}
              className="text-emerald-700 underline"
              target="_blank"
              rel="noreferrer"
            >
              Baixar documento reestruturado (OCR/limpeza)
            </a>
          ) : null}
        </div>
        <pre className="mt-2 max-h-56 overflow-auto rounded bg-white p-2 text-xs">
          {JSON.stringify(summary, null, 2)}
        </pre>
      </div>

      {warnings.length > 0 ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">Warnings do pipeline</p>
          {warnings.map((warning, index) => (
            <p key={`${warning}-${index}`}>- {String(warning)}</p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Numero do caso / IP</label>
          <input className="w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.caseNumber} onChange={(e) => updateField("caseNumber", e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Nome do caso (automatico)</label>
          <input className="w-full rounded border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm" value={form.title} readOnly />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Tipo de inquerito</label>
          <input className="w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.inquiryType} onChange={(e) => updateField("inquiryType", e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Numero do inquerito</label>
          <input className="w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.inquiryNumber} onChange={(e) => updateField("inquiryNumber", e.target.value)} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Unidade policial</label>
          <input className="w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.policeUnit} onChange={(e) => updateField("policeUnit", e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Enquadramento legal</label>
          <input className="w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.inquiryLegalFraming} onChange={(e) => updateField("inquiryLegalFraming", e.target.value)} />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Descricao</label>
        <textarea className="min-h-[90px] w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.description} onChange={(e) => updateField("description", e.target.value)} />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Resumo do inquerito</label>
        <textarea className="min-h-[110px] w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.inquirySummaryText} onChange={(e) => updateField("inquirySummaryText", e.target.value)} />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Fatos principais</label>
        <textarea className="min-h-[110px] w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.inquiryMainFacts} onChange={(e) => updateField("inquiryMainFacts", e.target.value)} />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Foco investigativo</label>
        <textarea className="min-h-[110px] w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.inquiryInvestigativeFocus} onChange={(e) => updateField("inquiryInvestigativeFocus", e.target.value)} />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Resumo da extracao</label>
        <textarea className="min-h-[90px] w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.extractionReportSummary} onChange={(e) => updateField("extractionReportSummary", e.target.value)} />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Envolvidos</label>
        <textarea className="min-h-[90px] w-full rounded border border-zinc-300 px-3 py-2 text-sm" value={form.inquiryInvolvedPeople} onChange={(e) => updateField("inquiryInvolvedPeople", e.target.value)} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy !== null} onClick={saveDraft}>
          {busy === "save" ? "Salvando..." : "Salvar rascunho"}
        </Button>
        <Button type="button" disabled={busy !== null} onClick={confirmDraft}>
          {busy === "confirm" ? "Confirmando..." : "Confirmar criacao do caso"}
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={discardDraft}>
          {busy === "discard" ? "Descartando..." : "Descartar"}
        </Button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
