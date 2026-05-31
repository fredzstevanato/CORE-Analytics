"use client";

import { useMemo, useState } from "react";
import { Upload, Send, Download, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SyncConfig = {
  role: "STANDALONE" | "NODE" | "CENTRALIZER";
  nodeId: string;
  displayName: string;
  centralizerUrl: string;
  canReceiveExternalPackages: boolean;
  canSendExternalPackages: boolean;
};

type CaseOption = {
  id: string;
  caseNumber: string;
  title: string;
};

type ExtractionOption = {
  id: string;
  caseId: string;
  evidenceId: string;
  status: string;
  sourceFormat: string;
  evidenceLabel: string;
  evidenceFileName: string;
};

type ChatOption = {
  id: string;
  caseId: string;
  evidenceId: string;
  title: string;
  sourceApp: string;
  messageCount: number;
};

type AttachmentOption = {
  id: string;
  caseId: string;
  evidenceId: string;
  messageChatId: string | null;
  fileName: string;
  mimeType: string;
  hasRecoveredFile: boolean;
};

type SyncPackageRow = {
  packageId: string;
  direction: string;
  status: string;
  sourceNodeId: string;
  caseNumber: string | null;
  itemCounts: unknown;
  errorMessage: string | null;
  createdAt: string;
  importedAt: string | null;
};

export function ConsolidatedSyncPanel({
  config,
  cases,
  extractions,
  chats,
  attachments,
  packages
}: {
  config: SyncConfig;
  cases: CaseOption[];
  extractions: ExtractionOption[];
  chats: ChatOption[];
  attachments: AttachmentOption[];
  packages: SyncPackageRow[];
}) {
  const [caseId, setCaseId] = useState(cases[0]?.id ?? "");
  const [extractionId, setExtractionId] = useState("");
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [includeTranscriptions, setIncludeTranscriptions] = useState(true);
  const [includeOcr, setIncludeOcr] = useState(true);
  const [includeInsights, setIncludeInsights] = useState(true);
  const [includeMediaFiles, setIncludeMediaFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const caseExtractions = useMemo(() => extractions.filter((item) => item.caseId === caseId), [caseId, extractions]);
  const selectedExtraction = caseExtractions.find((item) => item.id === extractionId);
  const effectiveEvidenceId = selectedExtraction?.evidenceId;
  const caseChats = useMemo(
    () =>
      chats
        .filter((item) => item.caseId === caseId && (!effectiveEvidenceId || item.evidenceId === effectiveEvidenceId))
        .slice(0, 80),
    [caseId, chats, effectiveEvidenceId]
  );
  const selectedChatSet = new Set(selectedChatIds);
  const caseAttachments = useMemo(
    () =>
      attachments
        .filter((item) => item.caseId === caseId && (!effectiveEvidenceId || item.evidenceId === effectiveEvidenceId))
        .filter((item) => selectedChatSet.size === 0 || (item.messageChatId && selectedChatSet.has(item.messageChatId)))
        .slice(0, 120),
    [attachments, caseId, effectiveEvidenceId, selectedChatSet]
  );
  const optionToggles: Array<[string, boolean, (next: boolean) => void]> = [
    ["Transcricoes", includeTranscriptions, setIncludeTranscriptions],
    ["OCR", includeOcr, setIncludeOcr],
    ["Insights", includeInsights, setIncludeInsights],
    ["Binarios", includeMediaFiles, setIncludeMediaFiles]
  ];

  function resetSelection(nextCaseId: string) {
    setCaseId(nextCaseId);
    setExtractionId("");
    setSelectedChatIds([]);
    setSelectedAttachmentIds([]);
    setMessage(null);
    setError(null);
  }

  function toggle(list: string[], value: string, setter: (next: string[]) => void) {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  }

  async function exportPackage(sendToCentralizer: boolean) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/sync/packages/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          evidenceId: effectiveEvidenceId,
          extractionId: extractionId || undefined,
          selectedChatIds,
          selectedAttachmentIds,
          includeTranscriptions,
          includeOcr,
          includeInsights,
          includeMediaFiles,
          sendToCentralizer
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Falha ao gerar pacote consolidado.");

      if (!sendToCentralizer) {
        const blob = new Blob([JSON.stringify(payload.package, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `core-sync-${payload.package.packageId}.json`;
        link.click();
        URL.revokeObjectURL(url);
      }

      setMessage(
        sendToCentralizer
          ? "Pacote consolidado enviado ao centralizador."
          : "Pacote consolidado gerado para arquivo."
      );
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Falha ao sincronizar pacote consolidado.");
    } finally {
      setBusy(false);
    }
  }

  async function importPackage(file: File | null) {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const text = await file.text();
      const pkg = JSON.parse(text);
      const response = await fetch("/api/sync/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pkg)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Falha ao importar pacote consolidado.");
      setMessage(`Pacote importado. Caso local: ${payload.caseId}`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Falha ao importar arquivo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <p className="text-xs uppercase text-zinc-500">Papel</p>
          <div className="mt-1">
            <Badge>{config.role}</Badge>
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <p className="text-xs uppercase text-zinc-500">Node</p>
          <p className="mt-1 truncate text-sm font-medium">{config.displayName || config.nodeId}</p>
        </div>
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 md:col-span-2">
          <p className="text-xs uppercase text-zinc-500">Centralizador</p>
          <p className="mt-1 truncate text-sm font-medium">{config.centralizerUrl || "Nao configurado"}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Caso</span>
              <select
                className="h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm"
                value={caseId}
                onChange={(event) => resetSelection(event.target.value)}
              >
                {cases.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.caseNumber} - {item.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Extracao de referencia</span>
              <select
                className="h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm"
                value={extractionId}
                onChange={(event) => {
                  setExtractionId(event.target.value);
                  setSelectedChatIds([]);
                  setSelectedAttachmentIds([]);
                }}
              >
                <option value="">Todas as evidencias do caso</option>
                {caseExtractions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.status} - {item.evidenceLabel || item.evidenceFileName}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-md border border-zinc-200">
              <div className="border-b border-zinc-200 p-3">
                <p className="font-medium">Chats selecionados</p>
                <p className="text-xs text-zinc-500">{selectedChatIds.length} marcados</p>
              </div>
              <div className="max-h-80 divide-y divide-zinc-100 overflow-auto">
                {caseChats.map((chat) => (
                  <label key={chat.id} className="flex gap-3 p-3 text-sm hover:bg-zinc-50">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedChatIds.includes(chat.id)}
                      onChange={() => toggle(selectedChatIds, chat.id, setSelectedChatIds)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{chat.title || "Chat sem titulo"}</span>
                      <span className="text-xs text-zinc-500">
                        {chat.sourceApp || "app"} | {chat.messageCount} mensagens
                      </span>
                    </span>
                  </label>
                ))}
                {caseChats.length === 0 ? <p className="p-3 text-sm text-zinc-500">Nenhum chat neste filtro.</p> : null}
              </div>
            </div>

            <div className="rounded-md border border-zinc-200">
              <div className="border-b border-zinc-200 p-3">
                <p className="font-medium">Arquivos selecionados</p>
                <p className="text-xs text-zinc-500">{selectedAttachmentIds.length} marcados para envio binario</p>
              </div>
              <div className="max-h-80 divide-y divide-zinc-100 overflow-auto">
                {caseAttachments.map((attachment) => (
                  <label key={attachment.id} className="flex gap-3 p-3 text-sm hover:bg-zinc-50">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedAttachmentIds.includes(attachment.id)}
                      onChange={() => toggle(selectedAttachmentIds, attachment.id, setSelectedAttachmentIds)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{attachment.fileName || attachment.id}</span>
                      <span className="text-xs text-zinc-500">
                        {attachment.mimeType || "mime indefinido"} | {attachment.hasRecoveredFile ? "arquivo local" : "sem arquivo local"}
                      </span>
                    </span>
                  </label>
                ))}
                {caseAttachments.length === 0 ? (
                  <p className="p-3 text-sm text-zinc-500">Nenhum arquivo neste filtro.</p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid gap-2 rounded-md border border-zinc-200 p-3 text-sm md:grid-cols-4">
            {optionToggles.map(([label, checked, setter]) => (
              <label key={label} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setter(event.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || !caseId} onClick={() => exportPackage(false)}>
              <Download className="h-4 w-4" />
              Gerar arquivo
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !caseId || !config.canSendExternalPackages || !config.centralizerUrl}
              onClick={() => exportPackage(true)}
            >
              <Send className="h-4 w-4" />
              Enviar ao centralizador
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-md border border-zinc-200 p-3">
            <p className="font-medium">Importar pacote no centralizador</p>
            <p className="mt-1 text-xs text-zinc-500">Aceita somente pacote consolidado; UFDR bruto e diretorios de extracao sao rejeitados.</p>
            <Input
              className="mt-3"
              type="file"
              accept="application/json,.json"
              disabled={busy || !config.canReceiveExternalPackages}
              onChange={(event) => importPackage(event.target.files?.[0] ?? null)}
            />
          </div>

          <div className="rounded-md border border-zinc-200">
            <div className="flex items-center justify-between border-b border-zinc-200 p-3">
              <p className="font-medium">Historico recente</p>
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <div className="max-h-96 divide-y divide-zinc-100 overflow-auto">
              {packages.map((item) => (
                <div key={item.packageId} className="p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">{item.caseNumber ?? item.packageId}</p>
                    <Badge>{item.status}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {item.direction} | {item.sourceNodeId} | {new Date(item.createdAt).toLocaleString("pt-BR")}
                  </p>
                  {item.errorMessage ? <p className="mt-1 text-xs text-red-700">{item.errorMessage}</p> : null}
                </div>
              ))}
              {packages.length === 0 ? <p className="p-3 text-sm text-zinc-500">Nenhum pacote registrado.</p> : null}
            </div>
          </div>
        </div>
      </div>

      {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p> : null}
      {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
    </div>
  );
}
