type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function resolveConfiguredLogLevel(): LogLevel {
  const raw = (
    process.env.WORKER_AI_LOG_LEVEL ??
    process.env.WORKER_LOG_LEVEL ??
    process.env.LOG_LEVEL ??
    "info"
  )
    .trim()
    .toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

const CONFIGURED_LOG_LEVEL = resolveConfiguredLogLevel();

export function log(level: LogLevel, message: string, details?: Record<string, unknown>) {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[CONFIGURED_LOG_LEVEL]) return;
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "worker-ai",
      level,
      message,
      ...details
    })
  );
}
