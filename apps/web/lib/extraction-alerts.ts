export type OperationalAlertSeverity = "INFO" | "WARN" | "CRITICAL";

export type OperationalAlert = {
  code: string;
  severity: OperationalAlertSeverity;
  message: string;
};

export function severityRank(severity: OperationalAlertSeverity): number {
  if (severity === "CRITICAL") return 3;
  if (severity === "WARN") return 2;
  return 1;
}

export function buildOperationalAlertsFromDetails(details: Record<string, unknown>): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const ingestMetrics =
    details.ingestMetrics && typeof details.ingestMetrics === "object"
      ? (details.ingestMetrics as Record<string, unknown>)
      : undefined;
  const parserDropped =
    ingestMetrics?.parserDropped && typeof ingestMetrics.parserDropped === "object"
      ? (ingestMetrics.parserDropped as Record<string, unknown>)
      : undefined;

  const droppedChats = typeof parserDropped?.chats === "number" ? parserDropped.chats : 0;
  const droppedMessages = typeof parserDropped?.messages === "number" ? parserDropped.messages : 0;
  const droppedAudio = typeof parserDropped?.audioFiles === "number" ? parserDropped.audioFiles : 0;

  const audioCapReached =
    typeof details.audioCapReached === "boolean"
      ? details.audioCapReached
      : typeof ingestMetrics?.audioCapReached === "boolean"
        ? ingestMetrics.audioCapReached
        : false;
  const audioExtractedCount = typeof details.audioExtractedCount === "number" ? details.audioExtractedCount : undefined;
  const audioMaxFiles =
    typeof details.audioMaxFiles === "number"
      ? details.audioMaxFiles
      : typeof ingestMetrics?.audioMaxFiles === "number"
        ? ingestMetrics.audioMaxFiles
        : undefined;

  if (audioCapReached) {
    alerts.push({
      code: "AUDIO_CAP_REACHED",
      severity: "WARN",
      message: `Limite de áudios atingido (${audioExtractedCount ?? "?"}/${audioMaxFiles ?? "?"}). Aumente UFDR_AUDIO_MAX_FILES para extrair mais.`
    });
  }
  if (droppedMessages > 0) {
    alerts.push({
      code: "PARSER_DROPPED_MESSAGES",
      severity: "CRITICAL",
      message: `Parser descartou ${droppedMessages} mensagens por limite configurado.`
    });
  }
  if (droppedChats > 0) {
    alerts.push({
      code: "PARSER_DROPPED_CHATS",
      severity: "CRITICAL",
      message: `Parser descartou ${droppedChats} chats por limite configurado.`
    });
  }
  if (droppedAudio > 0) {
    alerts.push({
      code: "PARSER_DROPPED_AUDIO_FILES",
      severity: "WARN",
      message: `Parser descartou ${droppedAudio} arquivos de áudio por limite configurado.`
    });
  }

  return alerts;
}
