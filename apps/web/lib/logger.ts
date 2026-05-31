type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, message: string, details?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "web",
      level,
      message,
      ...details
    })
  );
}
