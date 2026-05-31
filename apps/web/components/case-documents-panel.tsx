"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

type CaseDocumentView = {
  id: string;
  title: string;
  type: string;
  mimeType?: string | null;
  fileName: string;
  metadata?: unknown;
  createdAt: string | Date;
};

export function CaseDocumentsPanel({
  caseId,
  documents
}: {
  caseId: string;
  documents: CaseDocumentView[];
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("SUPPORTING_DOCUMENT");
  const [busy, setBusy] = useState(false);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      formData.append("type", type);

      const response = await fetch(`/api/cases/${caseId}/documents`, {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao anexar documento.");
      }

      setFile(null);
      setTitle("");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao anexar documento.");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteDocument(documentId: string) {
    setBusyDocumentId(documentId);
    setError(null);
    try {
      const response = await fetch(`/api/cases/${caseId}/documents/${documentId}`, {
        method: "DELETE"
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao excluir documento.");
      }
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Falha ao excluir documento.");
    } finally {
      setBusyDocumentId(null);
    }
  }

  async function onReanalyzeDocument(documentId: string) {
    setBusyDocumentId(documentId);
    setError(null);
    try {
      const response = await fetch(`/api/cases/${caseId}/documents/${documentId}/reanalyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          overwriteExisting: true
        })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao reanalisar documento.");
      }
      router.refresh();
    } catch (reanalyzeError) {
      setError(reanalyzeError instanceof Error ? reanalyzeError.message : "Falha ao reanalisar documento.");
    } finally {
      setBusyDocumentId(null);
    }
  }

  function getProcessedDownloadUrl(document: CaseDocumentView) {
    const metadata =
      document.metadata && typeof document.metadata === "object"
        ? (document.metadata as Record<string, unknown>)
        : null;
    const processedFile =
      metadata?.processedFile && typeof metadata.processedFile === "object"
        ? (metadata.processedFile as Record<string, unknown>)
        : null;
    const absolutePath =
      typeof processedFile?.absolutePath === "string" && processedFile.absolutePath
        ? processedFile.absolutePath
        : null;
    const fileName =
      typeof processedFile?.fileName === "string" && processedFile.fileName
        ? processedFile.fileName
        : `${document.fileName.replace(/\.pdf$/i, "")}-processado.pdf`;
    if (!absolutePath) return null;
    return `/api/pdf/processed?path=${encodeURIComponent(absolutePath)}&download=1&filename=${encodeURIComponent(fileName)}`;
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-3 rounded border border-zinc-200 p-3">
        <div className="grid gap-3 md:grid-cols-2">
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Titulo do documento"
          />
          <select className="rounded border border-zinc-300 px-3 py-2 text-sm" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="SUPPORTING_DOCUMENT">Documento complementar</option>
            <option value="INQUIRY_PDF">PDF do inquerito</option>
            <option value="EXPERT_REPORT_PDF">Laudo pericial</option>
            <option value="CASE_NOTE_ATTACHMENT">Anexo de nota</option>
          </select>
        </div>
        <input
          type="file"
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          required
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Enviando..." : "Anexar documento"}
        </Button>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
      </form>

      <div className="space-y-2">
        {documents.length === 0 ? <p className="text-sm text-zinc-500">Sem documentos vinculados.</p> : null}
        {documents.map((document) => (
          <div key={document.id} className="rounded border border-zinc-200 p-3 text-sm">
            <p className="font-medium">{document.title}</p>
            <p className="text-xs text-zinc-500">{document.type}</p>
            <p className="text-xs text-zinc-500">{document.fileName}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <a
                className="inline-flex items-center rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                href={`/api/case-documents/${document.id}/content?download=1`}
                target="_blank"
                rel="noreferrer"
              >
                Baixar original
              </a>
              {getProcessedDownloadUrl(document) ? (
                <a
                  className="inline-flex items-center rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                  href={getProcessedDownloadUrl(document)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  Baixar reestruturado
                </a>
              ) : null}
              {(document.mimeType?.toLowerCase().includes("pdf") || document.fileName.toLowerCase().endsWith(".pdf")) ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busyDocumentId === document.id}
                  onClick={() => onReanalyzeDocument(document.id)}
                >
                  {busyDocumentId === document.id ? "Reanalisando..." : "Reanalisar"}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={busyDocumentId === document.id}
                onClick={() => onDeleteDocument(document.id)}
              >
                {busyDocumentId === document.id ? "Excluindo..." : "Excluir"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
