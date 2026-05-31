"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type ExpertReportView = {
  id: string;
  title: string;
  status: string;
  reportNumber?: string | null;
  issuingAgency?: string | null;
  summary?: string | null;
  metadata?: unknown;
  parsedPayload?: unknown;
  caseDocument?: {
    id: string;
    fileName: string;
    sha256: string;
    createdAt: string | Date;
  } | null;
  seizedObjects: Array<{
    id: string;
    label: string;
    objectType?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    imei?: string | null;
    imei2?: string | null;
    iccid1?: string | null;
    iccid2?: string | null;
    serialNumber?: string | null;
  }>;
  expertIdentifiers?: Array<{
    id: string;
    kind: string;
    algorithm?: string | null;
    value: string;
    sourceReference?: string | null;
  }>;
};

type SeizedObjectView = {
  id: string;
  label: string;
  objectType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  imei?: string | null;
  imei2?: string | null;
  iccid1?: string | null;
  iccid2?: string | null;
  serialNumber?: string | null;
  custodyTag?: string | null;
  expertReport?: {
    id: string;
    title: string;
  } | null;
};

export function CaseExpertReportsPanel({
  caseId,
  reports,
  seizedObjects
}: {
  caseId: string;
  reports: ExpertReportView[];
  seizedObjects: SeizedObjectView[];
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busyImport, setBusyImport] = useState(false);
  const [busyObject, setBusyObject] = useState(false);
  const [busyDeleteObjectId, setBusyDeleteObjectId] = useState<string | null>(null);
  const [busyClearReportId, setBusyClearReportId] = useState<string | null>(null);
  const [busyDeleteReportId, setBusyDeleteReportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedImport, setAdvancedImport] = useState(false);
  const [importMode, setImportMode] = useState<"analysis-and-ocr" | "analysis-only">("analysis-and-ocr");
  const [aiModel, setAiModel] = useState("gpt-4.1-mini");
  const [aiRetryModel, setAiRetryModel] = useState("gpt-5.4-mini");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [objectForm, setObjectForm] = useState({
    label: "",
    objectType: "",
    manufacturer: "",
    model: "",
    imei: "",
    imei2: "",
    iccid1: "",
    iccid2: "",
    serialNumber: "",
    custodyTag: "",
    expertReportId: ""
  });

  const reportOptions = useMemo(() => reports.map((report) => ({ id: report.id, title: report.title })), [reports]);

  function getDescriptiveLines(report: ExpertReportView) {
    const metadata =
      report.metadata && typeof report.metadata === "object" ? (report.metadata as Record<string, unknown>) : null;
    const descriptiveFile =
      metadata?.descriptiveFile && typeof metadata.descriptiveFile === "object"
        ? (metadata.descriptiveFile as Record<string, unknown>)
        : null;
    const lines = Array.isArray(descriptiveFile?.lines)
      ? descriptiveFile.lines.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [];
    const hashLines = Array.isArray(metadata?.hashes)
      ? metadata.hashes
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const row = item as Record<string, unknown>;
            const algorithm = typeof row.algorithm === "string" ? row.algorithm : "HASH";
            const value = typeof row.value === "string" ? row.value : "";
            return value ? `${algorithm}: ${value}` : "";
          })
          .filter(Boolean)
      : [];
    if (lines.length > 0) return lines;
    return [
      report.caseDocument?.fileName ? `Arquivo: ${report.caseDocument.fileName}` : "",
      report.caseDocument?.sha256 ? `SHA256 do arquivo: ${report.caseDocument.sha256}` : "",
      ...hashLines
    ].filter(Boolean);
  }

  function getPolitecFields(report: ExpertReportView) {
    const payload =
      report.parsedPayload && typeof report.parsedPayload === "object"
        ? (report.parsedPayload as Record<string, unknown>)
        : null;
    const politec =
      payload?.politec && typeof payload.politec === "object" ? (payload.politec as Record<string, unknown>) : null;
    if (!politec) return [];
    return [
      ["Nº Laudo", typeof politec.reportNumber === "string" ? politec.reportNumber : ""],
      ["Protocolo", typeof politec.protocol === "string" ? politec.protocol : ""],
      ["Autoridade", typeof politec.authority === "string" ? politec.authority : ""],
      ["Referência/IP", typeof politec.referenceIp === "string" ? politec.referenceIp : ""],
      ["Natureza", typeof politec.nature === "string" ? politec.nature : ""],
      ["Data solicitação", typeof politec.requestedAt === "string" ? politec.requestedAt : ""],
      ["Destino", typeof politec.destination === "string" ? politec.destination : ""]
    ].filter((entry) => entry[1]);
  }

  function getHybridExtraction(report: ExpertReportView) {
    const payload =
      report.parsedPayload && typeof report.parsedPayload === "object"
        ? (report.parsedPayload as Record<string, unknown>)
        : null;
    const hybrid =
      payload?.hybridExtraction && typeof payload.hybridExtraction === "object"
        ? (payload.hybridExtraction as Record<string, unknown>)
        : null;
    if (!hybrid) return null;

    const readField = (value: unknown) => {
      if (!value || typeof value !== "object") return null;
      const row = value as Record<string, unknown>;
      return {
        value: typeof row.value === "string" ? row.value : "",
        sourceSnippet: typeof row.sourceSnippet === "string" ? row.sourceSnippet : "",
        confidence: typeof row.confidence === "number" ? row.confidence : 0,
        reason: typeof row.reason === "string" ? row.reason : "",
        provider: typeof row.provider === "string" ? row.provider : ""
      };
    };

    const readIdentifierList = (value: unknown) => {
      if (!Array.isArray(value)) return [];
      return value
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const row = item as Record<string, unknown>;
          const idValue = typeof row.value === "string" ? row.value : "";
          if (!idValue) return null;
          return {
            value: idValue,
            sourceSnippet: typeof row.sourceSnippet === "string" ? row.sourceSnippet : "",
            confidence: typeof row.confidence === "number" ? row.confidence : 0,
            reason: typeof row.reason === "string" ? row.reason : "",
            provider: typeof row.provider === "string" ? row.provider : ""
          };
        })
        .filter((item): item is { value: string; sourceSnippet: string; confidence: number; reason: string; provider: string } =>
          Boolean(item)
        );
    };

    return {
      parserScore: typeof hybrid.parserScore === "number" ? hybrid.parserScore : 0,
      fallbackTriggered: hybrid.fallbackTriggered === true,
      strongRetryTriggered: hybrid.strongRetryTriggered === true,
      routeReason: typeof hybrid.routeReason === "string" ? hybrid.routeReason : "",
      reportNumber: readField(hybrid.reportNumber),
      protocol: readField(hybrid.protocol),
      imeiCandidates: readIdentifierList(hybrid.imeiCandidates),
      iccidCandidates: readIdentifierList(hybrid.iccidCandidates)
    };
  }

  function getComparisonDocuments(report: ExpertReportView) {
    const metadata =
      report.metadata && typeof report.metadata === "object" ? (report.metadata as Record<string, unknown>) : null;
    const printSimulationDocumentId =
      typeof metadata?.printSimulationDocumentId === "string"
        ? metadata.printSimulationDocumentId
        : typeof metadata?.unsignedCopyDocumentId === "string"
          ? metadata.unsignedCopyDocumentId
          : "";
    const originalDocumentId = report.caseDocument?.id || (typeof metadata?.originalDocumentId === "string" ? metadata.originalDocumentId : "");
    const printSimulationFileName =
      typeof metadata?.printSimulationFileName === "string"
        ? metadata.printSimulationFileName
        : typeof metadata?.unsignedCopyFileName === "string"
          ? metadata.unsignedCopyFileName
        : report.caseDocument?.fileName
          ? `${report.caseDocument.fileName}.print-simulated.pdf`
          : "copia-simulacao-impressao.pdf";

    return {
      originalDocumentId,
      printSimulationDocumentId,
      originalFileName: report.caseDocument?.fileName || "original.pdf",
      printSimulationFileName
    };
  }

  function objectConfidenceBadge(object: SeizedObjectView) {
    const scoredFields = [
      object.imei,
      object.imei2,
      object.iccid1,
      object.iccid2,
      object.serialNumber,
      object.manufacturer,
      object.model
    ].filter(Boolean).length;
    return scoredFields >= 2
      ? { label: "Extração automática", className: "bg-emerald-100 text-emerald-700" }
      : { label: "Revisão manual recomendada", className: "bg-amber-100 text-amber-700" };
  }

  async function onImportReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setBusyImport(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      formData.append("mode", importMode);
      if (aiModel.trim()) formData.append("aiModel", aiModel.trim());
      if (aiRetryModel.trim()) formData.append("aiRetryModel", aiRetryModel.trim());
      if (openaiApiKey.trim()) formData.append("openaiApiKey", openaiApiKey.trim());
      const response = await fetch(`/api/cases/${caseId}/expert-reports`, { method: "POST", body: formData });
      const payload = (await response.json()) as { error?: string; details?: string };
      if (!response.ok) {
        const details = typeof payload.details === "string" && payload.details.trim() ? `\nDetalhes: ${payload.details}` : "";
        throw new Error(`${payload.error ?? "Falha ao importar laudo."}${details}`);
      }
      setFile(null);
      setTitle("");
      setOpenaiApiKey("");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao importar laudo.");
    } finally {
      setBusyImport(false);
    }
  }

  async function onCreateObject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyObject(true);
    setError(null);
    try {
      const response = await fetch(`/api/cases/${caseId}/seized-objects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...objectForm,
          expertReportId: objectForm.expertReportId || undefined
        })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao cadastrar objeto apreendido.");
      setObjectForm({
        label: "",
        objectType: "",
        manufacturer: "",
        model: "",
        imei: "",
        imei2: "",
        iccid1: "",
        iccid2: "",
        serialNumber: "",
        custodyTag: "",
        expertReportId: ""
      });
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao cadastrar objeto apreendido.");
    } finally {
      setBusyObject(false);
    }
  }

  async function onClearImportedData(reportId: string) {
    const confirmed = window.confirm(
      "Isso vai remover apenas dados importados automaticamente deste laudo (objetos e identificadores extraidos). O PDF do laudo sera mantido. Deseja continuar?"
    );
    if (!confirmed) return;
    setBusyClearReportId(reportId);
    setError(null);
    try {
      const response = await fetch(`/api/cases/${caseId}/expert-reports/${reportId}/clear-imported-data`, {
        method: "POST"
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao limpar dados importados do laudo.");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao limpar dados importados do laudo.");
    } finally {
      setBusyClearReportId(null);
    }
  }

  async function onDeleteReport(reportId: string) {
    const confirmed = window.confirm(
      "Isso vai excluir o laudo e os anexos relacionados (original e copia sem assinatura), alem dos dados importados. Deseja continuar?"
    );
    if (!confirmed) return;
    setBusyDeleteReportId(reportId);
    setError(null);
    try {
      const response = await fetch(`/api/cases/${caseId}/expert-reports/${reportId}`, {
        method: "DELETE"
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao excluir laudo e anexos.");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao excluir laudo e anexos.");
    } finally {
      setBusyDeleteReportId(null);
    }
  }

  async function onDeleteSeizedObject(objectId: string) {
    const confirmed = window.confirm(
      "Deseja excluir este objeto apreendido? O laudo vinculado sera mantido e nao sera excluido."
    );
    if (!confirmed) return;

    setBusyDeleteObjectId(objectId);
    setError(null);
    try {
      const response = await fetch(`/api/cases/${caseId}/seized-objects`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectId })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao excluir objeto apreendido.");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Falha ao excluir objeto apreendido.");
    } finally {
      setBusyDeleteObjectId(null);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onImportReport} className="space-y-3 rounded border border-zinc-200 p-3">
        <p className="text-sm font-medium">Importar laudo pericial</p>
        <input
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Título do laudo"
        />
        <input
          type="file"
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          required
        />
        <button
          type="button"
          className="text-xs text-zinc-600 underline"
          onClick={() => setAdvancedImport((current) => !current)}
        >
          {advancedImport ? "Ocultar opções avançadas" : "Mostrar opções avançadas"}
        </button>
        {advancedImport ? (
          <div className="space-y-3 rounded border border-zinc-200 bg-zinc-50 p-3">
            <div className="grid gap-3 md:grid-cols-2">
              <select
                className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={importMode}
                onChange={(event) =>
                  setImportMode(event.target.value === "analysis-only" ? "analysis-only" : "analysis-and-ocr")
                }
              >
                <option value="analysis-and-ocr">OCR forte (recomendado)</option>
                <option value="analysis-only">Sem OCR (apenas texto nativo)</option>
              </select>
              <input
                className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={aiModel}
                onChange={(event) => setAiModel(event.target.value)}
                placeholder="Modelo IA fallback (ex.: gpt-4.1-mini)"
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <input
                className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={aiRetryModel}
                onChange={(event) => setAiRetryModel(event.target.value)}
                placeholder="Modelo retry forte (ex.: gpt-5.4-mini)"
              />
              <input
                type="password"
                className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={openaiApiKey}
                onChange={(event) => setOpenaiApiKey(event.target.value)}
                placeholder="OpenAI API Key opcional (sobrescreve chave global)"
              />
            </div>
          </div>
        ) : null}
        <Button type="submit" disabled={busyImport}>
          {busyImport ? "Importando..." : "Importar laudo"}
        </Button>
      </form>

      <form onSubmit={onCreateObject} className="space-y-3 rounded border border-zinc-200 p-3">
        <p className="text-sm font-medium">Cadastrar objeto apreendido</p>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.label}
            onChange={(event) => setObjectForm((current) => ({ ...current, label: event.target.value }))}
            placeholder="Descrição do objeto"
            required
          />
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.objectType}
            onChange={(event) => setObjectForm((current) => ({ ...current, objectType: event.target.value }))}
            placeholder="Tipo"
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.manufacturer}
            onChange={(event) => setObjectForm((current) => ({ ...current, manufacturer: event.target.value }))}
            placeholder="Fabricante"
          />
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.model}
            onChange={(event) => setObjectForm((current) => ({ ...current, model: event.target.value }))}
            placeholder="Modelo"
          />
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.imei}
            onChange={(event) => setObjectForm((current) => ({ ...current, imei: event.target.value }))}
            placeholder="IMEI"
          />
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.imei2}
            onChange={(event) => setObjectForm((current) => ({ ...current, imei2: event.target.value }))}
            placeholder="IMEI 2"
          />
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.iccid1}
            onChange={(event) => setObjectForm((current) => ({ ...current, iccid1: event.target.value }))}
            placeholder="ICCID 1"
          />
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.iccid2}
            onChange={(event) => setObjectForm((current) => ({ ...current, iccid2: event.target.value }))}
            placeholder="ICCID 2"
          />
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.serialNumber}
            onChange={(event) => setObjectForm((current) => ({ ...current, serialNumber: event.target.value }))}
            placeholder="Serial"
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.custodyTag}
            onChange={(event) => setObjectForm((current) => ({ ...current, custodyTag: event.target.value }))}
            placeholder="Lacre / etiqueta"
          />
          <select
            className="rounded border border-zinc-300 px-3 py-2 text-sm"
            value={objectForm.expertReportId}
            onChange={(event) => setObjectForm((current) => ({ ...current, expertReportId: event.target.value }))}
          >
            <option value="">Sem laudo vinculado</option>
            {reportOptions.map((report) => (
              <option key={report.id} value={report.id}>
                {report.title}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={busyObject}>
          {busyObject ? "Salvando..." : "Cadastrar objeto"}
        </Button>
      </form>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm font-medium">Laudos periciais</p>
          {reports.length === 0 ? <p className="text-sm text-zinc-500">Nenhum laudo importado.</p> : null}
          {reports.map((report) => {
            const politec = getPolitecFields(report);
            const docs = getComparisonDocuments(report);
            const metadata =
              report.metadata && typeof report.metadata === "object" ? (report.metadata as Record<string, unknown>) : null;
            const hashes = Array.isArray(metadata?.hashes)
              ? (metadata.hashes as Array<Record<string, unknown>>)
                  .map((item) => {
                    const algorithm = typeof item.algorithm === "string" ? item.algorithm : "HASH";
                    const value = typeof item.value === "string" ? item.value : "";
                    return value ? `${algorithm}: ${value}` : "";
                  })
                  .filter(Boolean)
              : [];
            const fileSha256 = report.caseDocument?.sha256;

            return (
              <div key={report.id} className="rounded border border-zinc-200 p-3 text-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="font-medium">{report.title}</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => onClearImportedData(report.id)}
                      disabled={busyClearReportId === report.id || busyDeleteReportId === report.id}
                    >
                      {busyClearReportId === report.id ? "Limpando..." : "Excluir dados importados"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => onDeleteReport(report.id)}
                      disabled={busyDeleteReportId === report.id || busyClearReportId === report.id}
                    >
                      {busyDeleteReportId === report.id ? "Excluindo..." : "Excluir anexo"}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1 rounded border border-zinc-100 bg-zinc-50 p-2">
                  <p className="text-xs">
                    <span className="font-medium text-zinc-700">Número do Laudo:</span>{" "}
                    {report.reportNumber || politec.find(([label]) => label === "Nº Laudo")?.[1] || "Não extraído"}
                  </p>
                  <p className="text-xs">
                    <span className="font-medium text-zinc-700">Hash:</span>{" "}
                    {hashes.length > 0
                      ? hashes.join(" | ")
                      : fileSha256
                        ? `SHA256: ${fileSha256}`
                        : "Nenhum hash encontrado"}
                  </p>
                  <p className="text-xs">
                    <span className="font-medium text-zinc-700">Autoridade Requisitante:</span>{" "}
                    {politec.find(([label]) => label === "Autoridade")?.[1] || "Não extraída"}
                  </p>
                </div>

                {report.caseDocument ? (
                  <p className="mt-2 text-xs text-zinc-500">Arquivo: {report.caseDocument.fileName}</p>
                ) : null}

                {(docs.originalDocumentId || docs.printSimulationDocumentId) ? (
                  <div className="mt-2 flex gap-3">
                    {docs.originalDocumentId ? (
                      <a
                        href={`/api/case-documents/${docs.originalDocumentId}/content?download=1`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-700 underline"
                      >
                        Baixar original
                      </a>
                    ) : null}
                    {docs.printSimulationDocumentId ? (
                      <a
                        href={`/api/case-documents/${docs.printSimulationDocumentId}/content?download=1`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-700 underline"
                      >
                        Baixar cópia impressão
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Objetos apreendidos</p>
          {seizedObjects.length === 0 ? <p className="text-sm text-zinc-500">Nenhum objeto cadastrado.</p> : null}
          {seizedObjects.map((object) => (
            <div key={object.id} className="rounded border border-zinc-200 p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{object.label}</p>
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => onDeleteSeizedObject(object.id)}
                  disabled={busyDeleteObjectId === object.id}
                >
                  {busyDeleteObjectId === object.id ? "Excluindo..." : "Excluir objeto"}
                </Button>
              </div>
              {[object.objectType, object.manufacturer, object.model].filter(Boolean).length > 0 ? (
                <p className="mt-1 text-xs text-zinc-600">
                  {[object.objectType, object.manufacturer, object.model].filter(Boolean).join(" • ")}
                </p>
              ) : null}
              {(object.imei || object.imei2) ? (
                <p className="mt-1 text-xs text-zinc-600">
                  {[object.imei ? `IMEI: ${object.imei}` : null, object.imei2 ? `IMEI2: ${object.imei2}` : null]
                    .filter(Boolean)
                    .join(" | ")}
                </p>
              ) : null}
              {(object.iccid1 || object.iccid2) ? (
                <p className="text-xs text-zinc-600">
                  {[object.iccid1 ? `ICCID: ${object.iccid1}` : null, object.iccid2 ? `ICCID2: ${object.iccid2}` : null]
                    .filter(Boolean)
                    .join(" | ")}
                </p>
              ) : null}
              {object.serialNumber ? <p className="text-xs text-zinc-600">Serial: {object.serialNumber}</p> : null}
              {object.expertReport ? <p className="mt-1 text-xs text-zinc-400">Laudo: {object.expertReport.title}</p> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
