"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type SettingRow = {
  id: string;
  key: string;
  category: string;
  label?: string | null;
  description?: string | null;
  isSecret: boolean;
  fileName?: string | null;
  mimeType?: string | null;
  hasValue: boolean;
  updatedAt: string | Date;
};

type ProviderCreditRow = {
  provider: "openai" | "assemblyai";
  configured: boolean;
  ok: boolean;
  creditsUsd: number | null;
  source: string;
  message?: string;
};

function formatUsd(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `US$ ${value.toFixed(4)}` : "N/D";
}

export function SettingsPanel() {
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openAiKey, setOpenAiKey] = useState("");
  const [assemblyAiKey, setAssemblyAiKey] = useState("");
  const [providerCredits, setProviderCredits] = useState<{
    openai?: ProviderCreditRow;
    assemblyai?: ProviderCreditRow;
  } | null>(null);
  const [creditsBusy, setCreditsBusy] = useState(false);
  const [form, setForm] = useState({
    key: "",
    category: "GENERAL",
    label: "",
    description: "",
    valueText: "",
    isSecret: false
  });
  const [file, setFile] = useState<File | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/settings");
      const payload = (await response.json()) as { settings?: SettingRow[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao carregar configuracoes.");
      setRows(payload.settings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar configuracoes.");
    } finally {
      setBusy(false);
    }
  }

  async function loadProviderCredits() {
    setCreditsBusy(true);
    try {
      const response = await fetch("/api/settings/providers/credits", { cache: "no-store" });
      const payload = (await response.json()) as {
        providers?: {
          openai?: ProviderCreditRow;
          assemblyai?: ProviderCreditRow;
        };
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao consultar creditos dos provedores.");
      setProviderCredits(payload.providers ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao consultar creditos dos provedores.");
    } finally {
      setCreditsBusy(false);
    }
  }

  useEffect(() => {
    void load();
    void loadProviderCredits();
  }, []);

  async function saveProviderKeys(event: React.FormEvent) {
    event.preventDefault();
    const openAiTrimmed = openAiKey.trim();
    const assemblyAiTrimmed = assemblyAiKey.trim();
    if (!openAiTrimmed && !assemblyAiTrimmed) {
      setError("Informe ao menos uma chave (OpenAI ou AssemblyAI) para salvar.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (openAiTrimmed) {
        const openAiResponse = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "OPENAI_API_KEY",
            category: "AI",
            label: "OpenAI API Key",
            description: "Chave padrao usada nos fluxos de IA do CORE.",
            isSecret: true,
            valueText: openAiTrimmed
          })
        });
        const openAiPayload = (await openAiResponse.json()) as { error?: string };
        if (!openAiResponse.ok) throw new Error(openAiPayload.error ?? "Falha ao salvar chave OpenAI.");
      }

      if (assemblyAiTrimmed) {
        const assemblyResponse = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "ASSEMBLYAI_API_KEY",
            category: "AI",
            label: "AssemblyAI API Key",
            description: "Chave padrao usada no runtime de transcricao AssemblyAI.",
            isSecret: true,
            valueText: assemblyAiTrimmed
          })
        });
        const assemblyPayload = (await assemblyResponse.json()) as { error?: string };
        if (!assemblyResponse.ok) throw new Error(assemblyPayload.error ?? "Falha ao salvar chave AssemblyAI.");
      }

      setOpenAiKey("");
      setAssemblyAiKey("");
      await load();
      await loadProviderCredits();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar chaves de provedores.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTextSetting(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao salvar configuracao.");
      setForm((current) => ({ ...current, valueText: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar configuracao.");
    } finally {
      setBusy(false);
    }
  }

  async function saveFileSetting(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const data = new FormData();
      data.append("key", form.key);
      data.append("category", form.category);
      data.append("label", form.label);
      data.append("description", form.description);
      data.append("isSecret", String(form.isSecret));
      data.append("file", file);
      const response = await fetch("/api/settings", {
        method: "POST",
        body: data
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Falha ao salvar arquivo de configuracao.");
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar arquivo de configuracao.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={saveProviderKeys} className="space-y-3 rounded border border-zinc-200 bg-white p-3">
        <p className="text-sm font-semibold">Chaves dos provedores online (OpenAI + AssemblyAI)</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs font-medium text-zinc-700">OPENAI_API_KEY</p>
            <input
              type="password"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
              placeholder="sk-..."
              value={openAiKey}
              onChange={(event) => setOpenAiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-zinc-700">ASSEMBLYAI_API_KEY</p>
            <input
              type="password"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
              placeholder="xxxxx"
              value={assemblyAiKey}
              onChange={(event) => setAssemblyAiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <p className="text-xs text-zinc-600">
          As chaves ficam criptografadas no banco. Com chave valida, o provider correspondente e liberado nos seletores.
        </p>
        <Button type="submit" disabled={busy || (!openAiKey.trim() && !assemblyAiKey.trim())}>
          {busy ? "Salvando..." : "Salvar chaves de provedores"}
        </Button>
      </form>

      <div className="space-y-3 rounded border border-zinc-200 bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">Creditos e status dos provedores</p>
          <Button type="button" variant="outline" disabled={creditsBusy} onClick={() => void loadProviderCredits()}>
            {creditsBusy ? "Consultando..." : "Atualizar creditos"}
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded border border-zinc-200 p-3 text-xs">
            <p className="font-medium">OpenAI</p>
            <p className="text-zinc-600">Configurado: {providerCredits?.openai?.configured ? "sim" : "nao"}</p>
            <p className="text-zinc-600">Status API: {providerCredits?.openai?.ok ? "ok" : "indisponivel"}</p>
            <p className="text-zinc-600">Creditos estimados: {formatUsd(providerCredits?.openai?.creditsUsd)}</p>
            <p className="text-zinc-500">Fonte: {providerCredits?.openai?.source ?? "n/d"}</p>
            {providerCredits?.openai?.message ? <p className="text-amber-700">{providerCredits.openai.message}</p> : null}
          </div>
          <div className="rounded border border-zinc-200 p-3 text-xs">
            <p className="font-medium">AssemblyAI</p>
            <p className="text-zinc-600">Configurado: {providerCredits?.assemblyai?.configured ? "sim" : "nao"}</p>
            <p className="text-zinc-600">Status API: {providerCredits?.assemblyai?.ok ? "ok" : "indisponivel"}</p>
            <p className="text-zinc-600">Creditos estimados: {formatUsd(providerCredits?.assemblyai?.creditsUsd)}</p>
            <p className="text-zinc-500">Fonte: {providerCredits?.assemblyai?.source ?? "n/d"}</p>
            {providerCredits?.assemblyai?.message ? <p className="text-amber-700">{providerCredits.assemblyai.message}</p> : null}
          </div>
        </div>
      </div>

      <form onSubmit={saveTextSetting} className="space-y-3 rounded border border-zinc-200 bg-white p-3">
        <p className="text-sm font-semibold">Salvar chave/configuracao textual</p>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            className="rounded border border-zinc-300 px-3 py-2 text-sm"
            placeholder="KEY (ex.: OPENAI_CASE_CONTEXT_MODEL)"
            value={form.key}
            onChange={(event) => setForm((current) => ({ ...current, key: event.target.value }))}
            required
          />
          <input
            className="rounded border border-zinc-300 px-3 py-2 text-sm"
            placeholder="Categoria"
            value={form.category}
            onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            className="rounded border border-zinc-300 px-3 py-2 text-sm"
            placeholder="Rotulo"
            value={form.label}
            onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isSecret}
              onChange={(event) => setForm((current) => ({ ...current, isSecret: event.target.checked }))}
            />
            Valor sigiloso (criptografado)
          </label>
        </div>
        <textarea
          className="min-h-[100px] w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          placeholder="Valor (texto/JSON)"
          value={form.valueText}
          onChange={(event) => setForm((current) => ({ ...current, valueText: event.target.value }))}
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Salvando..." : "Salvar configuracao"}
        </Button>
      </form>

      <form onSubmit={saveFileSetting} className="space-y-3 rounded border border-zinc-200 bg-white p-3">
        <p className="text-sm font-semibold">Salvar arquivo de configuracao no banco</p>
        <input
          type="file"
          className="rounded border border-zinc-300 px-3 py-2 text-sm"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          required
        />
        <Button type="submit" disabled={busy || !file}>
          {busy ? "Enviando..." : "Enviar arquivo"}
        </Button>
      </form>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="space-y-2 rounded border border-zinc-200 bg-white p-3">
        <p className="text-sm font-semibold">Repositorio de configuracoes (Banco)</p>
        {rows.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma configuracao cadastrada.</p> : null}
        {rows.map((row) => (
          <div key={row.id} className="rounded border border-zinc-100 p-2 text-xs">
            <p className="font-medium">{row.key}</p>
            <p className="text-zinc-500">
              {row.category} • {row.isSecret ? "Segredo" : "Aberto"} • {row.hasValue ? "Com valor" : "Sem valor"}
            </p>
            {row.fileName ? (
              <a
                href={`/api/settings/${encodeURIComponent(row.key)}/content`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 underline"
              >
                Baixar arquivo ({row.fileName})
              </a>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
