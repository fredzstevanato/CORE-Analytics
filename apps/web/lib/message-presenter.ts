type ParticipantLike = {
  externalId?: string | null;
  name?: string | null;
  handle?: string | null;
  phone?: string | null;
  email?: string | null;
  metadata?: unknown;
};

type MessageLike = {
  senderId?: string | null;
  direction?: string | null;
  metadata?: unknown;
};

type SenderPresentation = {
  name: string;
  initials: string;
  avatarSrc?: string;
};

type MessageBodyOptions = {
  fallback?: string;
  singleLine?: boolean;
  maxLength?: number;
};

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function extractText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readMetadataString(metadata: unknown, keys: string[]): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const row = metadata as Record<string, unknown>;
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) normalized.set(k.toLowerCase(), v);

  for (const key of keys) {
    const direct = extractText(row[key]);
    if (direct) return direct;
    const indirect = extractText(normalized.get(key.toLowerCase()));
    if (indirect) return indirect;
  }
  return undefined;
}

function looksLikeBase64Image(value: string) {
  if (value.length < 120) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function looksLikeImagePath(value: string) {
  return /\.(png|jpe?g|gif|bmp|webp)$/i.test(value);
}

function toAvatarSrc(raw?: string) {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith("data:image/")) return value;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (looksLikeBase64Image(value)) return `data:image/jpeg;base64,${value.replace(/\s+/g, "")}`;
  if (looksLikeImagePath(value)) return `/api/media/local?path=${encodeURIComponent(value)}`;
  return undefined;
}

function resolveAvatarFromMetadata(metadata: unknown) {
  const raw =
    readMetadataString(metadata, ["avatar", "avatarUrl", "avatarPath", "profilePicture", "profilePhoto"]) ??
    readMetadataString(metadata, ["photo", "photoUrl", "photoPath", "thumbnail", "thumb"]) ??
    readMetadataString(metadata, ["image", "imageUrl", "imagePath", "path"]);
  return toAvatarSrc(raw);
}

function participantToName(participant: ParticipantLike) {
  return participant.name ?? participant.handle ?? participant.phone ?? participant.email ?? undefined;
}

function toInitials(name: string) {
  const words = name
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const only = words[0] ?? "";
    return only.slice(0, 2).toUpperCase();
  }
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function getRecordValue(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key];
  const lowered = key.toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === lowered) return v;
  }
  return undefined;
}

function extractActionLabels(suggestions: unknown): string[] {
  if (!Array.isArray(suggestions)) return [];
  const labels: string[] = [];
  for (const suggestion of suggestions) {
    const suggestionRow = asRecord(suggestion);
    if (!suggestionRow) continue;
    const action = asRecord(getRecordValue(suggestionRow, "action"));
    if (!action) continue;
    const displayText = extractText(getRecordValue(action, "displayText"));
    if (displayText) labels.push(displayText);
  }
  return labels;
}

function parseMessageJson(rawBody: string): unknown {
  const trimmed = rawBody.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractRcsCardText(payload: unknown): string | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const message = asRecord(getRecordValue(root, "message")) ?? root;
  const card = asRecord(getRecordValue(message, "generalPurposeCard"));
  if (!card) return undefined;

  const content = asRecord(getRecordValue(card, "content")) ?? {};
  const title = extractText(getRecordValue(content, "title"));
  const description = extractText(getRecordValue(content, "description"));
  const labels = extractActionLabels(getRecordValue(card, "suggestions"));

  const lines: string[] = [];
  if (title) lines.push(title);
  if (description) lines.push(description);
  if (labels.length > 0) lines.push(`Acoes: ${labels.join(" | ")}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function extractGenericJsonText(payload: unknown): string | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const message = asRecord(getRecordValue(root, "message"));
  const source = message ?? root;

  const direct =
    extractText(getRecordValue(source, "text")) ??
    extractText(getRecordValue(source, "body")) ??
    extractText(getRecordValue(source, "caption")) ??
    extractText(getRecordValue(source, "description"));
  if (direct) return direct;

  const content = asRecord(getRecordValue(source, "content"));
  if (!content) return undefined;
  return (
    extractText(getRecordValue(content, "text")) ??
    extractText(getRecordValue(content, "title")) ??
    extractText(getRecordValue(content, "description"))
  );
}

function applyBodyOptions(text: string, options: MessageBodyOptions): string {
  let value = text;
  if (options.singleLine) value = value.replace(/\s+/g, " ").trim();
  if (typeof options.maxLength === "number" && options.maxLength > 0 && value.length > options.maxLength) {
    value = `${value.slice(0, options.maxLength)}...`;
  }
  return value;
}

export function resolveMessageBodyForDisplay(rawBody: string | null | undefined, options: MessageBodyOptions = {}): string {
  const fallback = options.fallback ?? "(mensagem sem texto)";
  const clean = (rawBody ?? "").trim();
  if (!clean) return fallback;

  const parsed = parseMessageJson(clean);
  const parsedText = extractRcsCardText(parsed) ?? extractGenericJsonText(parsed);
  if (parsedText) return applyBodyOptions(parsedText, options);

  return applyBodyOptions(clean, options);
}

export function resolveSenderPresentation(message: MessageLike, participants: ParticipantLike[]): SenderPresentation {
  const outgoing = normalize(message.direction) === "outgoing";
  if (outgoing) return { name: "Voce", initials: "VC" };

  const byKeys = new Map<string, ParticipantLike>();
  for (const participant of participants) {
    const keys = [participant.externalId, participant.handle, participant.phone, participant.email, participant.name];
    for (const key of keys) {
      const norm = normalize(key);
      if (norm.length > 0 && !byKeys.has(norm)) byKeys.set(norm, participant);
    }
  }

  const senderId = normalize(message.senderId);
  if (senderId.length > 0 && byKeys.has(senderId)) {
    const p = byKeys.get(senderId)!;
    const name = participantToName(p) ?? message.senderId ?? "Contato";
    const avatarSrc = resolveAvatarFromMetadata((p as { metadata?: unknown }).metadata);
    return { name, initials: toInitials(name), avatarSrc };
  }

  const metadataName =
    readMetadataString(message.metadata, ["senderName", "displayName", "authorName", "contactName"]) ??
    readMetadataString(message.metadata, ["sender", "author", "from"]);
  if (metadataName) {
    const avatarSrc = resolveAvatarFromMetadata(message.metadata);
    return { name: metadataName, initials: toInitials(metadataName), avatarSrc };
  }

  if (message.senderId && message.senderId.trim().length > 0) {
    const sender = message.senderId.trim();
    const avatarSrc = resolveAvatarFromMetadata(message.metadata);
    return { name: sender, initials: toInitials(sender), avatarSrc };
  }

  return { name: "Contato", initials: "CT", avatarSrc: resolveAvatarFromMetadata(message.metadata) };
}
