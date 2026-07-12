"use client";

import { useEffect, useMemo, useState } from "react";
import { Cpu, HardDrive, MonitorCog, RotateCcw, Save, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type TargetOs = "windows" | "linux";

type SystemConfigPayload = {
  envPath: string;
  editableKeys: string[];
  currentOs: TargetOs;
  targetOs: TargetOs;
  env: Record<string, string | undefined>;
  hardware: {
    platform: string;
    arch: string;
    hostname: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    disk: {
      kind: "ssd" | "hdd" | "unknown";
      disks: Array<{
        name: string;
        type: string;
        busType: string;
        sizeBytes?: number | null;
        size?: string;
      }>;
    };
  };
  recommendations: {
    profile: string;
    values: Record<string, string | undefined>;
  };
  saved?: boolean;
  backupPath?: string | null;
  restartRequired?: boolean;
};

const PATH_KEYS = ["STORAGE_ROOT", "UFDR_SOURCE_ROOT", "WHISPER_BIN", "WHISPER_MODEL_DIR", "FFMPEG_BIN", "TESSERACT_BIN", "SEVEN_Z_BIN"];
const UFDR_KEYS = [
  "UFDR_FORCE_XML_STREAM",
  "UFDR_XML_STREAM_MIN_FILES",
  "UFDR_XML_IN_MEMORY_MAX_CHARS",
  "UFDR_AUDIO_EXTRACTION_TIMEOUT_MS",
  "UFDR_AUDIO_ENTRY_TIMEOUT_MS",
  "UFDR_AUDIO_RECOVERY_BATCH_SIZE",
  "UFDR_AUDIO_RECOVERY_BATCH_TIMEOUT_MS",
  "UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY",
  "UFDR_STALE_PROCESSING_TIMEOUT_MS",
  "UFDR_STALE_PENDING_TIMEOUT_MS",
  "UFDR_STALE_WATCHDOG_INTERVAL_MS"
];
const WORKER_KEYS = [
  "WHISPER_MODEL",
  "AI_TRANSCRIPTION_WORKER_CONCURRENCY",
  "AI_TRANSCRIPTION_LOCK_DURATION_SECONDS",
  "AI_TRANSCRIPTION_STALLED_INTERVAL_SECONDS",
  "AI_TRANSCRIPTION_MAX_STALLED_COUNT",
  "AI_TRANSCRIPTION_STALE_PROCESSING_SECONDS",
  "WORKER_LOG_HEARTBEAT_SECONDS"
];
const PDF_KEYS = ["PDF_OCR_COMMAND", "PDF_OCR_COMMAND_ARGS", "PDF_OCR_LANGUAGE"];

function formatBytes(bytes: number) {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}

function osLabel(value: TargetOs) {
  return value === "windows" ? "Windows" : "Linux";
}

function profileLabel(value?: string) {
  if (value === "alta_performance") return "Alta performance";
  if (value === "equilibrado") return "Equilibrado";
  return "Conservador";
}

function FieldGroup({
  title,
  keys,
  values,
  recommendations,
  onChange
}: {
  title: string;
  keys: string[];
  values: Record<string, string>;
  recommendations: Record<string, string | undefined>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-sm font-semibold">{title}</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {keys.map((key) => (
          <label key={key} className={key === "PDF_OCR_COMMAND_ARGS" ? "space-y-1 lg:col-span-2" : "space-y-1"}>
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{key}</span>
            <Input value={values[key] ?? ""} onChange={(event) => onChange(key, event.target.value)} spellCheck={false} />
            {recommendations[key] && recommendations[key] !== values[key] ? (
              <button
                type="button"
                className="text-left text-xs text-blue-700 hover:underline dark:text-blue-300"
                onClick={() => onChange(key, recommendations[key] ?? "")}
              >
                Usar sugerido: {recommendations[key]}
              </button>
            ) : null}
          </label>
        ))}
      </div>
    </div>
  );
}

export function SystemConfigPanel() {
  const [targetOs, setTargetOs] = useState<TargetOs>("windows");
  const [payload, setPayload] = useState<SystemConfigPayload | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(nextTargetOs = targetOs) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/settings/system?targetOs=${nextTargetOs}`, { cache: "no-store" });
      const nextPayload = (await response.json()) as SystemConfigPayload & { error?: string };
      if (!response.ok) throw new Error(nextPayload.error ?? "Falha ao carregar configuracao do sistema.");
      setPayload(nextPayload);
      setTargetOs(nextPayload.targetOs);
      const nextValues: Record<string, string> = {};
      for (const key of nextPayload.editableKeys) {
        nextValues[key] = nextPayload.env[key] ?? nextPayload.recommendations.values[key] ?? "";
      }
      setValues(nextValues);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar configuracao do sistema.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchTargetOs(nextTargetOs: TargetOs) {
    setTargetOs(nextTargetOs);
    await load(nextTargetOs);
  }

  function applyRecommendations() {
    if (!payload) return;
    const definedRecommendations = Object.fromEntries(
      Object.entries(payload.recommendations.values).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    setValues((current) => ({ ...current, ...definedRecommendations }));
    setMessage("Sugestoes aplicadas ao formulario. Revise e salve para gravar no .env.");
  }

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetOs, values })
      });
      const nextPayload = (await response.json()) as SystemConfigPayload & { error?: string };
      if (!response.ok) throw new Error(nextPayload.error ?? "Falha ao salvar configuracao do sistema.");
      setPayload(nextPayload);
      setMessage(
        `Configuracao salva em ${nextPayload.envPath}. Backup: ${nextPayload.backupPath ?? "nao criado"}. Reinicie web/workers para todos os processos relerem o .env.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar configuracao do sistema.");
    } finally {
      setBusy(false);
    }
  }

  const recommendationValues = payload?.recommendations.values ?? {};
  const diskSummary = useMemo(() => {
    if (!payload) return "N/D";
    const label = payload.hardware.disk.kind === "ssd" ? "SSD/NVMe" : payload.hardware.disk.kind === "hdd" ? "HD mecanico" : "Desconhecido";
    return `${label} (${payload.hardware.disk.disks.length || 0} detectado(s))`;
  }, [payload]);

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold">Sistema e .env</p>
            <p className="text-xs text-zinc-600 dark:text-zinc-300">Arquivo ativo: {payload?.envPath ?? "carregando..."}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={targetOs === "windows" ? "default" : "outline"} onClick={() => void switchTargetOs("windows")}>
              <MonitorCog className="h-4 w-4" />
              Windows
            </Button>
            <Button type="button" variant={targetOs === "linux" ? "default" : "outline"} onClick={() => void switchTargetOs("linux")}>
              <MonitorCog className="h-4 w-4" />
              Linux
            </Button>
            <Button type="button" variant="outline" onClick={() => void load()} disabled={busy}>
              <RotateCcw className="h-4 w-4" />
              Atualizar
            </Button>
          </div>
        </div>
      </div>

      {payload ? (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <Cpu className="mb-2 h-4 w-4 text-zinc-600 dark:text-zinc-300" />
            <p className="font-medium">{payload.hardware.cpuCount} threads</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{payload.hardware.cpuModel}</p>
          </div>
          <div className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <HardDrive className="mb-2 h-4 w-4 text-zinc-600 dark:text-zinc-300" />
            <p className="font-medium">{formatBytes(payload.hardware.totalMemoryBytes)} RAM</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Livre agora: {formatBytes(payload.hardware.freeMemoryBytes)}</p>
          </div>
          <div className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <HardDrive className="mb-2 h-4 w-4 text-zinc-600 dark:text-zinc-300" />
            <p className="font-medium">{diskSummary}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Perfil sugerido: {profileLabel(payload.recommendations.profile)}</p>
          </div>
        </div>
      ) : null}

      <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Ajuste adaptativo para {osLabel(targetOs)}</p>
            <p className="text-xs text-zinc-600 dark:text-zinc-300">
              Exemplo UFDR: {recommendationValues.exampleUfdrFolder ?? ""} ou {recommendationValues.exampleUfdrFile ?? ""}
            </p>
          </div>
          <Button type="button" variant="secondary" onClick={applyRecommendations} disabled={!payload}>
            <Wand2 className="h-4 w-4" />
            Aplicar sugestoes
          </Button>
        </div>
      </div>

      <FieldGroup title="Diretorios e binarios" keys={PATH_KEYS} values={values} recommendations={recommendationValues} onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))} />
      <FieldGroup title="Importacao UFDR" keys={UFDR_KEYS} values={values} recommendations={recommendationValues} onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))} />
      <FieldGroup title="Transcricao e workers" keys={WORKER_KEYS} values={values} recommendations={recommendationValues} onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))} />
      <FieldGroup title="OCR de PDF" keys={PDF_KEYS} values={values} recommendations={recommendationValues} onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))} />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => void save()} disabled={busy || !payload}>
          <Save className="h-4 w-4" />
          {busy ? "Salvando..." : "Salvar no .env"}
        </Button>
        {message ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    </div>
  );
}
