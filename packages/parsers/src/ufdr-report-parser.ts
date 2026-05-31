import { XMLParser } from "fast-xml-parser";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import type { NormalizedChat, NormalizedExtraction } from "@core/shared";
import { normalizedExtractionSchema } from "@core/shared";
import sax from "sax";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true
});

const AUDIO_EXT_RE = /\.(aac|amr|flac|m4a|mp3|ogg|opus|wav|wma)$/i;

function parseOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

const PARSER_MAX_CHATS = parseOptionalPositiveIntEnv("UFDR_PARSER_MAX_CHATS");
const PARSER_MAX_MESSAGES_PER_CHAT = parseOptionalPositiveIntEnv("UFDR_PARSER_MAX_MESSAGES_PER_CHAT");
const PARSER_MAX_TOTAL_MESSAGES = parseOptionalPositiveIntEnv("UFDR_PARSER_MAX_TOTAL_MESSAGES");
const PARSER_MAX_AUDIO_FILES = parseOptionalPositiveIntEnv("UFDR_PARSER_MAX_AUDIO_FILES");
const PARSER_TOLERATE_TRUNCATED_XML = String(process.env.UFDR_PARSER_TOLERATE_TRUNCATED_XML ?? "true").toLowerCase() !== "false";
const XML_NAMED_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

function isRecoverableStreamXmlError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unclosed root tag") ||
    normalized.includes("unexpected end") ||
    normalized.includes("unexpected eof")
  );
}

function isValidXmlCodePoint(codePoint: number) {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function sanitizeXmlEntities(input: string) {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z_:][\w.:-]*);|&/g, (match, entity: string | undefined) => {
    if (!entity) return "&amp;";
    if (XML_NAMED_ENTITIES.has(entity)) return match;
    if (entity.startsWith("#x")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) && isValidXmlCodePoint(codePoint) ? match : `&amp;${entity};`;
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) && isValidXmlCodePoint(codePoint) ? match : `&amp;${entity};`;
    }
    return `&amp;${entity};`;
  });
}

function createXmlEntitySanitizerStream() {
  let carry = "";
  return new Transform({
    decodeStrings: false,
    transform(chunk, _encoding, callback) {
      const combined = carry + String(chunk);
      const lastAmp = combined.lastIndexOf("&");
      const lastSemi = combined.lastIndexOf(";");
      const splitAt = lastAmp > lastSemi ? lastAmp : combined.length;
      carry = combined.slice(splitAt);
      callback(null, sanitizeXmlEntities(combined.slice(0, splitAt)));
    },
    flush(callback) {
      callback(null, sanitizeXmlEntities(carry));
    }
  });
}

function asArray<T>(input: T | T[] | undefined): T[] {
  if (!input) return [];
  return Array.isArray(input) ? input : [input];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readAny(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const normalizeValue = (value: unknown): string | undefined => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "boolean") {
      return String(value);
    }
    if (isRecord(value)) {
      const textDirect = normalizeValue(value.text);
      if (textDirect) return textDirect;
      const hashText = normalizeValue(value["#text"]);
      if (hashText) return hashText;
      const nestedValue = normalizeValue(value.value);
      if (nestedValue) return nestedValue;
    }
    return undefined;
  };

  const normalizedMap = new Map<string, unknown>();
  for (const [key, value] of Object.entries(obj)) {
    normalizedMap.set(normalizeKey(key), value);
  }

  for (const key of keys) {
    const direct = obj[key];
    const normalizedDirect = normalizeValue(direct);
    if (normalizedDirect) {
      return normalizedDirect;
    }
    const normalized = normalizedMap.get(normalizeKey(key));
    const normalizedValue = normalizeValue(normalized);
    if (normalizedValue) {
      return normalizedValue;
    }
  }
  return undefined;
}

function collectObjectsByKeys(root: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  const normalizedKeys = new Set(keys.map((k) => normalizeKey(k)));
  const found: Record<string, unknown>[] = [];
  const visited = new Set<unknown>();

  const walk = (node: unknown) => {
    if (!node || visited.has(node)) return;
    if (Array.isArray(node)) {
      visited.add(node);
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    visited.add(node);

    for (const [key, value] of Object.entries(node)) {
      if (normalizedKeys.has(normalizeKey(key))) {
        for (const item of asArray(value).filter(isRecord)) {
          found.push(item);
        }
      }
      walk(value);
    }
  };

  walk(root);
  return found;
}

function parseParticipants(row: Record<string, unknown>) {
  const nested = collectObjectsByKeys(row, ["participant", "participants", "member", "members", "author", "sender"]);
  return nested.map((p) => ({
    externalId: readAny(p, ["id", "externalId", "participantId", "userId", "contactId"]),
    name: readAny(p, ["name", "displayName", "fullName"]),
    phone: readAny(p, ["phone", "phoneNumber", "msisdn"]),
    email: readAny(p, ["email", "mail"]),
    handle: readAny(p, ["handle", "username", "account", "jid"]),
    metadata: p
  }));
}

function parseMessages(chatRow: Record<string, unknown>, chatExternalId?: string) {
  const messages = collectObjectsByKeys(chatRow, ["message", "messages", "msg", "item", "entry"]);
  return messages.map((m) => {
    const rawDirection = readAny(m, ["direction", "type"])?.toLowerCase();
    const direction: "INCOMING" | "OUTGOING" | "SYSTEM" | undefined =
      rawDirection === "incoming"
        ? "INCOMING"
        : rawDirection === "outgoing"
          ? "OUTGOING"
          : rawDirection === "system"
            ? "SYSTEM"
            : undefined;

    return {
      externalId: readAny(m, ["id", "messageId", "externalId", "uid"]),
      chatExternalId,
      senderExternalId: readAny(m, ["senderId", "fromId", "authorId", "ownerId", "contactId", "from"]),
      body: readAny(m, ["body", "text", "content", "message", "ufed:MessageBody", "messageBody"]),
      timestamp: readAny(m, ["timestamp", "date", "createdAt", "time", "startTime"]),
      direction,
      metadata: m
    };
  });
}

function parseChats(doc: Record<string, unknown>): NormalizedChat[] {
  const chatCandidates = collectObjectsByKeys(doc, ["chat", "chats", "conversation", "conversations", "thread", "threads"]);
  const chats: NormalizedChat[] = [];

  for (const row of chatCandidates) {
    const externalId = readAny(row, ["id", "chatId", "externalId", "threadId", "conversationId"]);
    chats.push({
      externalId,
      sourceApp: readAny(row, ["sourceApp", "app", "application", "source"]),
      title: readAny(row, ["title", "name", "subject"]),
      participants: parseParticipants(row),
      messages: parseMessages(row, externalId),
      metadata: row
    });
  }

  return chats;
}

function nodeText(node: unknown): string | undefined {
  if (typeof node === "string") {
    const text = node.trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof node === "number" && Number.isFinite(node)) {
    return String(node);
  }
  if (typeof node === "boolean") {
    return String(node);
  }
  if (!isRecord(node)) return undefined;
  const direct = readAny(node, ["text", "#text", "value"]);
  if (direct) return direct;
  const hashText = node["#text"];
  if (typeof hashText === "number" && Number.isFinite(hashText)) {
    return String(hashText);
  }
  if (typeof hashText === "boolean") {
    return String(hashText);
  }
  const valueNode = (node.value ?? node.Value) as unknown;
  if (typeof valueNode === "string") {
    const text = valueNode.trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof valueNode === "number" && Number.isFinite(valueNode)) {
    return String(valueNode);
  }
  if (typeof valueNode === "boolean") {
    return String(valueNode);
  }
  if (isRecord(valueNode)) return nodeText(valueNode);
  return undefined;
}

function childRecords(node: Record<string, unknown>, key: string) {
  const direct = node[key] ?? node[key.toLowerCase()] ?? node[key.toUpperCase()];
  if (direct !== undefined) return asArray(direct).filter(isRecord);

  const target = normalizeKey(key);
  for (const [entryKey, entryValue] of Object.entries(node)) {
    if (normalizeKey(entryKey) === target) {
      return asArray(entryValue).filter(isRecord);
    }
  }
  return [];
}

function modelType(model: Record<string, unknown>) {
  return readAny(model, ["type"])?.toLowerCase();
}

function findNamedNode(parent: Record<string, unknown>, key: string, name: string) {
  const normName = normalizeKey(name);
  return childRecords(parent, key).find((row) => normalizeKey(readAny(row, ["name"]) ?? "") === normName);
}

function getFieldValue(model: Record<string, unknown>, fieldName: string): string | undefined {
  const field = findNamedNode(model, "field", fieldName);
  if (!field) return undefined;
  const valueNode = childRecords(field, "value")[0];
  return nodeText(valueNode) ?? nodeText(field);
}

function getModelFieldModel(model: Record<string, unknown>, fieldName: string): Record<string, unknown> | undefined {
  const field = findNamedNode(model, "modelfield", fieldName);
  if (!field) return undefined;
  return childRecords(field, "model")[0];
}

function getMultiModelFieldModels(model: Record<string, unknown>, fieldName: string): Record<string, unknown>[] {
  const fields = childRecords(model, "multimodelfield").filter(
    (field) => normalizeKey(readAny(field, ["name"]) ?? "") === normalizeKey(fieldName)
  );
  const rows: Record<string, unknown>[] = [];
  for (const field of fields) {
    rows.push(...childRecords(field, "model"));
  }
  return rows;
}

function parsePartyModel(model: Record<string, unknown>) {
  const isOwnerRaw = getFieldValue(model, "IsPhoneOwner")?.toLowerCase();
  const isPhoneOwner = isOwnerRaw === "true" ? true : isOwnerRaw === "false" ? false : undefined;
  const identifier = getFieldValue(model, "Identifier");
  const name = getFieldValue(model, "Name");
  return {
    externalId: identifier ?? readAny(model, ["id"]),
    name,
    handle: identifier,
    metadata: undefined,
    isPhoneOwner
  };
}

function parseInstantMessageModel(model: Record<string, unknown>, chatExternalId?: string) {
  const fromPartyModel = getModelFieldModel(model, "From");
  const fromParty = fromPartyModel ? parsePartyModel(fromPartyModel) : undefined;
  const body = getFieldValue(model, "Body");
  const timestamp = getFieldValue(model, "TimeStamp");
  const externalIdentifier = getFieldValue(model, "Identifier");
  const sourceApplication = getFieldValue(model, "SourceApplication") ?? getFieldValue(model, "Source");
  const attachments = getMultiModelFieldModels(model, "Attachments")
    .filter((row) => modelType(row) === "attachment" || modelType(row) === "file")
    .map((row) => ({
      id: readAny(row, ["id"]),
      name: getFieldValue(row, "Filename") ?? getFieldValue(row, "Name") ?? readAny(row, ["name", "filename"]),
      path:
        getFieldValue(row, "Path") ??
        getFieldValue(row, "ArchivePath") ??
        readAny(row, ["path", "archivepath", "sourcepath", "fullpath"]),
      mimeType:
        getFieldValue(row, "MimeType") ??
        getFieldValue(row, "ContentType") ??
        readAny(row, ["mimetype", "type", "contenttype"])
    }))
    .filter((row) => Boolean(row.name || row.path || row.mimeType));

  const direction: "INCOMING" | "OUTGOING" | "SYSTEM" | undefined =
    fromParty?.isPhoneOwner === true ? "OUTGOING" : fromParty?.isPhoneOwner === false ? "INCOMING" : undefined;

  return {
    externalId: readAny(model, ["id"]) ?? externalIdentifier,
    chatExternalId,
    senderExternalId: fromParty?.externalId,
    body,
    timestamp,
    direction,
    metadata: {
      sourceApplication,
      messageIdentifier: externalIdentifier,
      senderName: fromParty?.name,
      attachments
    }
  };
}

function parseChatsFromModelGraph(doc: Record<string, unknown>): NormalizedChat[] {
  const models = collectObjectsByKeys(doc, ["model"]);
  const chatModels = models.filter((model) => modelType(model) === "chat");
  const chats: NormalizedChat[] = [];

  for (const chatModel of chatModels) {
    const externalId = getFieldValue(chatModel, "Id") ?? readAny(chatModel, ["id"]);
    const sourceApp = getFieldValue(chatModel, "SourceApplication") ?? getFieldValue(chatModel, "Source");
    const title = getFieldValue(chatModel, "Name");

    const participantsRaw = getMultiModelFieldModels(chatModel, "Participants")
      .filter((row) => modelType(row) === "party")
      .map((row) => parsePartyModel(row));

    const messagesRaw = getMultiModelFieldModels(chatModel, "Messages")
      .filter((row) => modelType(row) === "instantmessage")
      .map((row) => parseInstantMessageModel(row, externalId));

    const participantMap = new Map<string, (typeof participantsRaw)[number]>();
    for (const participant of participantsRaw) {
      const key = normalizeKey(participant.externalId ?? participant.name ?? "");
      if (!key) continue;
      if (!participantMap.has(key)) participantMap.set(key, participant);
    }
    for (const message of messagesRaw) {
      const sender = message.senderExternalId;
      if (!sender) continue;
      const key = normalizeKey(sender);
      if (!participantMap.has(key)) {
        participantMap.set(key, {
          externalId: sender,
          name: sender,
          handle: sender,
          metadata: undefined,
          isPhoneOwner: undefined
        });
      }
    }

    chats.push({
      externalId,
      sourceApp,
      title,
      participants: [...participantMap.values()].map((participant) => ({
        externalId: participant.externalId,
        name: participant.name,
        handle: participant.handle,
        metadata: participant.metadata
      })),
      messages: messagesRaw,
      metadata: {
        sourceApplication: sourceApp
      }
    });
  }

  return chats;
}

function parseChatFromModelNode(chatModel: Record<string, unknown>): NormalizedChat {
  const externalId = getFieldValue(chatModel, "Id") ?? readAny(chatModel, ["id"]);
  const sourceApp = getFieldValue(chatModel, "SourceApplication") ?? getFieldValue(chatModel, "Source");
  const title = getFieldValue(chatModel, "Name");

  const participantsRaw = getMultiModelFieldModels(chatModel, "Participants")
    .filter((row) => modelType(row) === "party")
    .map((row) => parsePartyModel(row));

  const messagesRaw = getMultiModelFieldModels(chatModel, "Messages")
    .filter((row) => modelType(row) === "instantmessage")
    .map((row) => parseInstantMessageModel(row, externalId));

  const participantMap = new Map<string, (typeof participantsRaw)[number]>();
  for (const participant of participantsRaw) {
    const key = normalizeKey(participant.externalId ?? participant.name ?? "");
    if (!key) continue;
    if (!participantMap.has(key)) participantMap.set(key, participant);
  }
  for (const message of messagesRaw) {
    const sender = message.senderExternalId;
    if (!sender) continue;
    const key = normalizeKey(sender);
    if (!participantMap.has(key)) {
      participantMap.set(key, {
        externalId: sender,
        name: sender,
        handle: sender,
        metadata: undefined,
        isPhoneOwner: undefined
      });
    }
  }

  return {
    externalId,
    sourceApp,
    title,
    participants: [...participantMap.values()].map((participant) => ({
      externalId: participant.externalId,
      name: participant.name,
      handle: participant.handle,
      metadata: participant.metadata
    })),
    messages: messagesRaw,
    metadata: {
      sourceApplication: sourceApp
    }
  };
}

function parseUserAccountModel(model: Record<string, unknown>): NormalizedExtraction["userAccounts"][number] {
  const entries = getMultiModelFieldModels(model, "Entries").map((entry) => ({
    type: readAny(entry, ["type"]),
    category: getFieldValue(entry, "Category") ?? readAny(entry, ["category"]),
    value: getFieldValue(entry, "Value") ?? readAny(entry, ["value", "text"]),
    domain: getFieldValue(entry, "Domain") ?? readAny(entry, ["domain"]),
    metadata: entry
  }));

  return {
    externalId: getFieldValue(model, "Identifier") ?? readAny(model, ["id"]),
    sourceApp: getFieldValue(model, "Source") ?? getFieldValue(model, "SourceApplication"),
    serviceType: getFieldValue(model, "ServiceType"),
    serviceIdentifier: getFieldValue(model, "ServiceIdentifier"),
    name: getFieldValue(model, "Name"),
    username: getFieldValue(model, "Username"),
    entries,
    metadata: model
  };
}

function parseUserAccountsFromModelGraph(doc: Record<string, unknown>) {
  const models = collectObjectsByKeys(doc, ["model"]);
  return models.filter((model) => modelType(model) === "useraccount").map((model) => parseUserAccountModel(model));
}

function parseContacts(doc: Record<string, unknown>) {
  return collectObjectsByKeys(doc, ["contact", "contacts", "addressbookcontact"]).map((c) => ({
    externalId: readAny(c, ["id", "contactId", "externalId", "uid"]),
    name: readAny(c, ["name", "displayName", "fullName"]),
    phone: readAny(c, ["phone", "phoneNumber", "msisdn"]),
    email: readAny(c, ["email"]),
    handle: readAny(c, ["handle", "username", "jid"])
  }));
}

function parseCalls(doc: Record<string, unknown>) {
  return collectObjectsByKeys(doc, ["call", "calls", "calllog", "callrecord"]);
}

function parseFiles(doc: Record<string, unknown>) {
  return collectObjectsByKeys(doc, ["file", "files", "media", "attachment", "attachments"]);
}

function parseAudioArtifactsFromChats(chats: NormalizedChat[]) {
  const rows: NormalizedExtraction["audioArtifacts"] = [];
  for (const chat of chats) {
    for (const message of chat.messages) {
      const metadata = message.metadata as Record<string, unknown> | undefined;
      if (!metadata) continue;
      const attachmentCandidates = asArray(metadata.attachments).filter(isRecord);

      for (const attachment of attachmentCandidates) {
        const fileName = readAny(attachment, ["fileName", "name", "filename"]);
        const mimeType = readAny(attachment, ["mimeType", "mimetype", "type", "contentType"]);
        const archivePath = readAny(attachment, ["path", "archivePath", "sourcePath", "fullPath"]);
        const isAudio =
          (mimeType?.toLowerCase().startsWith("audio/") ?? false) ||
          AUDIO_EXT_RE.test(fileName ?? archivePath ?? "");
        if (!isAudio) continue;

        rows.push({
          externalId: readAny(attachment, ["id", "externalId"]),
          chatExternalId: chat.externalId,
          messageExternalId: message.externalId,
          senderExternalId: message.senderExternalId,
          fileName,
          mimeType,
          archivePath,
          timestamp: message.timestamp,
          metadata: {
            source: "message-metadata"
          }
        });
      }
    }
  }
  return rows;
}

function parseAudioArtifactsFromFiles(filesRaw: Record<string, unknown>[]) {
  const ownerMessageIdFromFile = (file: Record<string, unknown>) => {
    const direct = readAny(file, ["ownerid", "ownerId", "messageId", "messageExternalId"]);
    if (direct) return direct;
    const ownerRows = collectObjectsByKeys(file, ["ownerid"]);
    for (const owner of ownerRows) {
      const ownerType = readAny(owner, ["type"])?.toLowerCase();
      if (ownerType && !ownerType.includes("instantmessage")) continue;
      const text = nodeText(owner);
      if (text) return text;
    }
    return undefined;
  };

  return filesRaw
    .filter((file) => {
      const name = readAny(file, ["name", "fileName", "filename", "path", "fullPath"]);
      const type = readAny(file, ["mimeType", "type", "contentType"]);
      return (type?.toLowerCase().startsWith("audio/") ?? false) || AUDIO_EXT_RE.test(name ?? "");
    })
    .map((file) => ({
      externalId: readAny(file, ["id", "externalId"]),
      chatExternalId: readAny(file, ["chatId", "chatExternalId", "threadId"]),
      messageExternalId: ownerMessageIdFromFile(file),
      senderExternalId: readAny(file, ["senderId", "authorId", "from"]),
      fileName: readAny(file, ["name", "fileName", "filename"]),
      mimeType: readAny(file, ["mimeType", "type", "contentType"]),
      archivePath: readAny(file, ["path", "archivePath", "sourcePath", "fullPath"]),
      timestamp: readAny(file, ["timestamp", "date", "createdAt", "time"]),
      metadata: {
        source: "file-node"
      }
    }));
}

function readAnyFromRows(rows: Record<string, unknown>[], keys: string[]) {
  for (const row of rows) {
    const value = readAny(row, keys);
    if (value) return value;
  }
  return undefined;
}

function uniqueNonEmpty(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const clean = value.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(clean);
  }
  return rows;
}

function buildUfdrSummary(parts: Array<string | undefined>) {
  const clean = uniqueNonEmpty(parts);
  if (clean.length === 0) return undefined;
  const text = clean.join(" | ");
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

type ParsedLocation = {
  latitude: number;
  longitude: number;
  timestamp?: string;
  label?: string;
  category?: string;
  metadata?: Record<string, unknown>;
};

function parseCoord(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(",", ".").trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function getLocationCoordinateModel(model: Record<string, unknown>) {
  return (
    getModelFieldModel(model, "Position") ??
    getModelFieldModel(model, "Coordinate") ??
    getModelFieldModel(model, "Coordinates")
  );
}

function readLocationCoordinatePair(model: Record<string, unknown>) {
  const directLat =
    parseCoord(getFieldValue(model, "Latitude")) ??
    parseCoord(readAny(model, ["latitude", "lat"]));
  const directLng =
    parseCoord(getFieldValue(model, "Longitude")) ??
    parseCoord(readAny(model, ["longitude", "lng", "lon"]));
  if (typeof directLat === "number" && typeof directLng === "number") {
    return { lat: directLat, lng: directLng };
  }

  // Cellebrite Reader pattern:
  // model(type=Location) -> modelField(name=Position) -> model(type=Coordinate) -> field Latitude/Longitude
  const positionModel = getLocationCoordinateModel(model);
  if (positionModel) {
    const nestedLat =
      parseCoord(getFieldValue(positionModel, "Latitude")) ??
      parseCoord(readAny(positionModel, ["latitude", "lat"]));
    const nestedLng =
      parseCoord(getFieldValue(positionModel, "Longitude")) ??
      parseCoord(readAny(positionModel, ["longitude", "lng", "lon"]));
    if (typeof nestedLat === "number" && typeof nestedLng === "number") {
      return { lat: nestedLat, lng: nestedLng };
    }
  }

  return undefined;
}

function parseLocationModel(model: Record<string, unknown>): ParsedLocation | undefined {
  const pair = readLocationCoordinatePair(model);
  const lat = pair?.lat;
  const lng = pair?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  if (lat === 0 && lng === 0) return undefined;
  const coordinateModel = getLocationCoordinateModel(model);

  const elevation =
    parseCoord(getFieldValue(coordinateModel ?? {}, "Elevation")) ??
    parseCoord(getFieldValue(coordinateModel ?? {}, "Altitude")) ??
    parseCoord(getFieldValue(model, "Elevation")) ??
    parseCoord(getFieldValue(model, "Altitude"));
  const horizontalAccuracy =
    parseCoord(getFieldValue(coordinateModel ?? {}, "GpsHorizontalAccuracy")) ??
    parseCoord(getFieldValue(coordinateModel ?? {}, "HorizontalAccuracy")) ??
    parseCoord(getFieldValue(model, "GpsHorizontalAccuracy")) ??
    parseCoord(getFieldValue(model, "HorizontalAccuracy")) ??
    parseCoord(getFieldValue(model, "Accuracy")) ??
    parseCoord(getFieldValue(model, "Precision"));
  const confidence = parseCoord(getFieldValue(model, "Confidence"));

  const addressModel = getModelFieldModel(model, "Address");
  const addressText = addressModel
    ? getFieldValue(addressModel, "Street1") ??
      getFieldValue(addressModel, "Street2") ??
      getFieldValue(addressModel, "FormattedAddress") ??
      readAny(addressModel, ["street1", "street2", "address", "formattedAddress"])
    : undefined;

  const sourceApp =
    getFieldValue(model, "Source") ??
    getFieldValue(model, "SourceApplication") ??
    readAny(model, ["source", "sourceApplication", "app"]);

  const modelCategory =
    getFieldValue(model, "Category") ??
    getFieldValue(model, "Type") ??
    readAny(model, ["category", "type"]);

  const timestamp =
    getFieldValue(model, "TimeStamp") ??
    getFieldValue(model, "Timestamp") ??
    getFieldValue(model, "StartTime") ??
    readAny(model, ["timestamp", "date", "time"]);
  const label =
    getFieldValue(model, "Name") ??
    getFieldValue(model, "Description") ??
    getFieldValue(model, "Address") ??
    addressText ??
    readAny(model, ["name", "description", "address"]);
  const type = modelType(model);
  const category =
    type === "celltower"
      ? "CELL_TOWER"
      : type === "wirelessnetwork"
        ? "WIFI"
        : type === "journeypathentry"
          ? "JOURNEY"
          : "LOCATION";
  return {
    latitude: lat,
    longitude: lng,
    timestamp,
    label,
    category,
    metadata: {
      source: "ufdr-location-model",
      sourceApp: sourceApp,
      ufdrCategory: modelCategory,
      address: addressText,
      elevation,
      horizontalAccuracy,
      confidence,
      rawType: type ?? "location",
      ...model
    }
  };
}

function parseLocationsFromModelGraph(doc: Record<string, unknown>): ParsedLocation[] {
  const models = collectObjectsByKeys(doc, ["model"]);
  const locationTypes = new Set(["location", "celltower", "journeypathentry", "wirelessnetwork"]);
  const results: ParsedLocation[] = [];
  for (const m of models) {
    const type = modelType(m);
    if (!type || !locationTypes.has(type)) continue;
    const loc = parseLocationModel(m);
    if (loc) results.push(loc);
  }
  return results;
}

function readDeviceFields(node: Record<string, unknown>): Partial<NonNullable<NormalizedExtraction["device"]>> {
  const entryName = getFieldValue(node, "EntryName") ?? readAny(node, ["entryname", "name", "key"]);
  const entryValue = getFieldValue(node, "EntryValue") ?? readAny(node, ["entryvalue", "value", "text"]);
  let fromEntry: Partial<NonNullable<NormalizedExtraction["device"]>> = {};
  if (entryName && entryValue) {
    const mappedField = DEVICE_ITEM_FIELD_MAP[normalizeDeviceItemKey(entryName)];
    if (mappedField) {
      fromEntry = { [mappedField]: entryValue };
    }
  }

  return {
    ...fromEntry,
    manufacturer:
      fromEntry.manufacturer ??
      getFieldValue(node, "Manufacturer") ??
      getFieldValue(node, "Vendor") ??
      readAny(node, [
        "manufacturer",
        "vendor",
        "brand",
        "detectedphonevendor",
        "deviceinfodetectedphonevendor",
        "deviceinfoselectedmanufacturer"
      ]),
    model:
      fromEntry.model ??
      getFieldValue(node, "Model") ??
      getFieldValue(node, "ModelName") ??
      readAny(node, [
        "model",
        "modelname",
        "modelnumber",
        "devicename",
        "devicemodel",
        "detectedphonemodel",
        "deviceinfodetectedphonemodel",
        "deviceinfoselecteddevicename"
      ]),
    osVersion:
      fromEntry.osVersion ??
      getFieldValue(node, "OSVersion") ??
      readAny(node, ["osversion", "os", "platformversion", "deviceinfoostype"]),
    imei: fromEntry.imei ?? getFieldValue(node, "IMEI") ?? readAny(node, ["imei", "imei1"]),
    imei2: fromEntry.imei2 ?? getFieldValue(node, "IMEI2") ?? readAny(node, ["imei2"]),
    serialNumber:
      fromEntry.serialNumber ??
      getFieldValue(node, "SerialNumber") ?? getFieldValue(node, "FactoryNumber") ?? readAny(node, ["serialnumber", "serial", "factorynumber"]),
    iccid: fromEntry.iccid ?? getFieldValue(node, "ICCID") ?? readAny(node, ["iccid", "simiccid", "iccid1"]),
    msisdn:
      fromEntry.msisdn ?? getFieldValue(node, "MSISDN") ?? readAny(node, ["msisdn", "phonenumber", "subscribernumber", "number"]),
    macAddress: fromEntry.macAddress ?? getFieldValue(node, "MACAddress") ?? readAny(node, ["macaddress", "wifimac", "mac"]),
    bluetoothAddress:
      fromEntry.bluetoothAddress ??
      getFieldValue(node, "BluetoothAddress") ??
      readAny(node, ["bluetoothaddress", "bluetoothmac", "btaddress", "bluetoothdeviceaddress", "bluetoothmacaddress"])
  };
}

function hasAnyDeviceField(device: Partial<NonNullable<NormalizedExtraction["device"]>>): boolean {
  return Boolean(
    device.manufacturer ||
      device.model ||
      device.osVersion ||
      device.imei ||
      device.imei2 ||
      device.serialNumber ||
      device.iccid ||
      device.msisdn ||
      device.macAddress ||
      device.bluetoothAddress
  );
}

function mergeDeviceValues(
  base: Partial<NonNullable<NormalizedExtraction["device"]>> | undefined,
  next: Partial<NonNullable<NormalizedExtraction["device"]>>
): Partial<NonNullable<NormalizedExtraction["device"]>> {
  return {
    manufacturer: next.manufacturer ?? base?.manufacturer,
    model: next.model ?? base?.model,
    osVersion: next.osVersion ?? base?.osVersion,
    imei: next.imei ?? base?.imei,
    imei2: next.imei2 ?? base?.imei2,
    serialNumber: next.serialNumber ?? base?.serialNumber,
    iccid: next.iccid ?? base?.iccid,
    msisdn: next.msisdn ?? base?.msisdn,
    macAddress: next.macAddress ?? base?.macAddress,
    bluetoothAddress: next.bluetoothAddress ?? base?.bluetoothAddress
  };
}

function extractDeviceFromModelGraph(doc: Record<string, unknown>) {
  const models = collectObjectsByKeys(doc, ["model"]);
  let candidate: Partial<NonNullable<NormalizedExtraction["device"]>> | undefined;
  for (const model of models) {
    const fields = readDeviceFields(model);
    if (!hasAnyDeviceField(fields)) continue;
    candidate = mergeDeviceValues(candidate, fields);
  }
  return candidate && hasAnyDeviceField(candidate) ? candidate : undefined;
}

function extractDeviceExtra(deviceSection: Record<string, unknown>) {
  return readDeviceFields(deviceSection);
}

function parseUfdrCaseContextFromRoot(input: {
  root: Record<string, unknown>;
  deviceSection?: Record<string, unknown>;
  chats: NormalizedChat[];
  contactsCount: number;
}) {
  const metaRows = collectObjectsByKeys(input.root, [
    "metadata",
    "case",
    "caseinfo",
    "investigation",
    "project",
    "reportinfo",
    "examiner",
    "organization"
  ]);
  const inquiryType = readAnyFromRows(metaRows, [
    "inquiryType",
    "investigationType",
    "caseType",
    "projectType",
    "type"
  ]);
  const inquiryNumber = readAnyFromRows(metaRows, [
    "inquiryNumber",
    "investigationNumber",
    "caseNumber",
    "projectNumber",
    "projectId",
    "fileNumber"
  ]);
  const policeUnit = readAnyFromRows(metaRows, [
    "policeUnit",
    "unit",
    "agency",
    "organization",
    "department",
    "labName"
  ]);
  const examinerName = readAnyFromRows(metaRows, ["examiner", "examinerName", "investigator", "operator"]);
  const ownerName = readAnyFromRows(metaRows, ["owner", "deviceOwner", "subscriber", "suspect", "target"]);
  const legalFraming = readAnyFromRows(metaRows, ["legalFraming", "crimeType", "offense", "offence", "charges"]);
  const extractionDate =
    readAny(input.root, ["extractionDate", "createdAt", "reportDate"]) ??
    readAny((input.root.Metadata as Record<string, unknown> | undefined) ?? {}, ["date", "extractionDate"]);
  const sourceApps = uniqueNonEmpty(input.chats.map((chat) => chat.sourceApp)).slice(0, 6);
  const deviceText = input.deviceSection
    ? uniqueNonEmpty([
        readAny(input.deviceSection, ["manufacturer", "vendor", "brand"]),
        readAny(input.deviceSection, ["model", "modelName"]),
        readAny(input.deviceSection, ["imei", "imei1"]),
        readAny(input.deviceSection, ["serialNumber", "serial"])
      ]).join(" ")
    : undefined;

  const extractionReportSummary = buildUfdrSummary([
    readAnyFromRows(metaRows, ["reportName", "name", "title"]),
    extractionDate ? `Data da extracao: ${extractionDate}` : undefined,
    examinerName ? `Responsavel: ${examinerName}` : undefined,
    policeUnit ? `Unidade: ${policeUnit}` : undefined,
    deviceText ? `Dispositivo: ${deviceText}` : undefined
  ]);

  const inquiryMainFacts = buildUfdrSummary([
    deviceText,
    `Contatos identificados: ${String(input.contactsCount)}`,
    `Chats identificados: ${String(input.chats.length)}`
  ]);

  const inquiryInvestigativeFocus =
    sourceApps.length > 0 ? `Aplicativos com conversas na extracao: ${sourceApps.join(", ")}` : undefined;

  return {
    inquiryType,
    inquiryNumber,
    policeUnit,
    inquiryLegalFraming: legalFraming,
    inquirySummaryText:
      readAnyFromRows(metaRows, ["summary", "description", "notes", "comment", "remarks"]) ?? extractionReportSummary,
    inquiryMainFacts,
    inquiryInvestigativeFocus,
    extractionReportSummary,
    inquiryInvolvedPeople: uniqueNonEmpty([ownerName, examinerName])
  };
}

export function parseUfdrReportXml(xml: string): NormalizedExtraction {
  const parsed = xmlParser.parse(sanitizeXmlEntities(xml)) as Record<string, unknown>;
  const root = (parsed.report as Record<string, unknown> | undefined) ?? parsed;
  const deviceSection =
    collectObjectsByKeys(root, ["device", "deviceinfo", "handset", "phone"])[0] ??
    (isRecord(root.Device) ? root.Device : undefined);

  const chatsFromModels = parseChatsFromModelGraph(root);
  const chats = chatsFromModels.length > 0 ? chatsFromModels : parseChats(root);
  const contacts = parseContacts(root);
  const filesTyped = parseFiles(root);
  const audioFromChats = parseAudioArtifactsFromChats(chats);
  const audioFromFiles = parseAudioArtifactsFromFiles(filesTyped);
  const locations = parseLocationsFromModelGraph(root);
  const userAccounts = parseUserAccountsFromModelGraph(root);
  const modelGraphDevice = extractDeviceFromModelGraph(root);
  const rootDevice = deviceSection ? extractDeviceExtra(deviceSection) : undefined;
  const resolvedDevice =
    rootDevice && modelGraphDevice
      ? mergeDeviceValues(modelGraphDevice, rootDevice)
      : (rootDevice ?? modelGraphDevice);

  const extractionCandidate: NormalizedExtraction = {
    device: resolvedDevice,
    contacts,
    chats,
    userAccounts,
    calls: parseCalls(root),
    files: filesTyped,
    locations,
    audioArtifacts: [...audioFromChats, ...audioFromFiles],
    timeline: [],
    rawMetadata: {
      rootKeys: Object.keys(root),
      extractionDate:
        readAny(root, ["extractionDate", "createdAt", "reportDate"]) ??
        readAny((root.Metadata as Record<string, unknown> | undefined) ?? {}, ["date", "extractionDate"]),
      ufdrCaseContext: parseUfdrCaseContextFromRoot({
        root,
        deviceSection,
        chats,
        contactsCount: contacts.length
      })
    }
  };

  return normalizedExtractionSchema.parse(extractionCandidate);
}

function stripNamespace(tagName: string) {
  const idx = tagName.lastIndexOf(":");
  return (idx >= 0 ? tagName.slice(idx + 1) : tagName).toLowerCase();
}

function appendChildNode(parent: Record<string, unknown>, key: string, child: Record<string, unknown>) {
  const existing = parent[key];
  if (!existing) {
    parent[key] = child;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(child);
    return;
  }
  parent[key] = [existing, child];
}

function appendRootNode(root: Record<string, unknown>, key: string, child: Record<string, unknown>) {
  const existing = root[key];
  if (!existing) {
    root[key] = [child];
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(child);
    return;
  }
  root[key] = [existing, child];
}

type CaptureFrame = {
  tagName: string;
  capture: boolean;
  node?: Record<string, unknown>;
  textParts: string[];
};

const CAPTURED_ROOT_TAGS = new Set([
  "chat",
  "conversation",
  "thread",
  "contact",
  "addressbookcontact",
  "call",
  "calllog",
  "callrecord",
  "file",
  "media",
  "attachment",
  "device",
  "deviceinfo",
  "handset",
  "phone",
  "model"
]);

const CAPTURED_MODEL_TYPES = new Set([
  "chat",
  "instantmessage",
  "party",
  "useraccount",
  "attachment",
  "call",
  "contact",
  "project",
  "investigation",
  "caseinfo",
  "forensiccase",
  "device",
  "deviceinfo",
  "deviceinfoentry",
  "mobiledevice",
  "cellularphone",
  "handset",
  "phone",
  "sim",
  "simcard",
  "examiner",
  "location",
  "celltower",
  "journeypathentry",
  "wirelessnetwork"
]);

const ROOT_DEVICE_TAGS = new Set([
  "device",
  "deviceinfo",
  "handset",
  "phone"
]);

function normalizeDeviceItemKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const DEVICE_ITEM_FIELD_MAP: Record<string, keyof NonNullable<NormalizedExtraction["device"]>> = {
  imei: "imei",
  imei1: "imei",
  imei2: "imei2",
  iccid: "iccid",
  iccid1: "iccid",
  msisdn: "msisdn",
  phonenumber: "msisdn",
  subscribernumber: "msisdn",
  model: "model",
  modelnumber: "model",
  devicename: "model",
  devicenameevidencenumber: "model",
  deviceinfoselecteddevicename: "model",
  deviceinfoselectedmodel: "model",
  devicemodel: "model",
  detectedphonemodel: "model",
  deviceinfodetectedphonemodel: "model",
  vendor: "manufacturer",
  manufacturer: "manufacturer",
  deviceinfoselectedmanufacturer: "manufacturer",
  detectedphonevendor: "manufacturer",
  deviceinfodetectedphonevendor: "manufacturer",
  os: "osVersion",
  osversion: "osVersion",
  deviceinfoostype: "osVersion",
  serialnumber: "serialNumber",
  factorynumber: "serialNumber",
  macaddress: "macAddress",
  bluetoothmac: "bluetoothAddress",
  bluetoothmacaddress: "bluetoothAddress",
  bluetoothdeviceaddress: "bluetoothAddress"
};

const DEVICE_ITEM_KEYS = new Set(Object.keys(DEVICE_ITEM_FIELD_MAP));

function isLikelyMessageTag(tagName: string) {
  return tagName === "message" || tagName === "msg" || tagName === "item" || tagName === "entry";
}

function finalizeCapturedNode(frame: CaptureFrame) {
  if (!frame.node) return;
  const text = frame.textParts.join("").trim();
  if (text.length > 0) {
    frame.node.text = text;
  }
}

export async function parseUfdrReportXmlStream(
  reportXmlAbsolutePath: string,
  options?: {
    onProgress?: (input: { bytesRead: number }) => void;
  }
): Promise<NormalizedExtraction> {
  const chats: NormalizedChat[] = [];
  const contacts: NormalizedExtraction["contacts"] = [];
  const calls: NormalizedExtraction["calls"] = [];
  const streamUserAccounts: NormalizedExtraction["userAccounts"] = [];
  const filesRaw: Record<string, unknown>[] = [];
  let totalMessagesCaptured = 0;
  let droppedChats = 0;
  let droppedMessages = 0;
  let droppedAudioFiles = 0;
  let modelNodesCaptured = 0;
  let fileNodesCaptured = 0;
  const streamContext: {
    inquiryType?: string;
    inquiryNumber?: string;
    policeUnit?: string;
    inquiryLegalFraming?: string;
    inquirySummaryText?: string;
    extractionReportSummary?: string;
    inquiryInvolvedPeople?: string[];
  } = {};
  const streamPeople = new Set<string>();
  let streamDevice: NormalizedExtraction["device"] | undefined;
  const streamLocations: ParsedLocation[] = [];
  let parserRecoveryWarning: string | undefined;

  await new Promise<void>((resolve, reject) => {
    const parser = sax.createStream(true, {
      trim: false,
      normalize: false,
      lowercase: true
    });
    const rs = createReadStream(reportXmlAbsolutePath, {
      encoding: "utf-8",
      highWaterMark: 1024 * 1024
    });
    const sanitizer = createXmlEntitySanitizerStream();
    let settled = false;

    const doneResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const doneReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const stack: CaptureFrame[] = [];
    const mergeContextAndDeviceFromNode = (node: Record<string, unknown>) => {
      streamContext.inquiryType =
        streamContext.inquiryType ??
        getFieldValue(node, "Type") ??
        getFieldValue(node, "InvestigationType") ??
        readAny(node, ["type"]);
      streamContext.inquiryNumber =
        streamContext.inquiryNumber ??
        getFieldValue(node, "CaseNumber") ??
        getFieldValue(node, "ProjectNumber") ??
        getFieldValue(node, "Identifier") ??
        readAny(node, ["id"]);
      streamContext.policeUnit =
        streamContext.policeUnit ??
        getFieldValue(node, "Agency") ??
        getFieldValue(node, "Organization") ??
        getFieldValue(node, "Unit") ??
        readAny(node, ["organization", "agency", "unit"]);
      streamContext.inquiryLegalFraming =
        streamContext.inquiryLegalFraming ??
        getFieldValue(node, "Offense") ??
        getFieldValue(node, "CrimeType") ??
        readAny(node, ["offense", "offence", "crimetype"]);
      streamContext.inquirySummaryText =
        streamContext.inquirySummaryText ??
        getFieldValue(node, "Summary") ??
        getFieldValue(node, "Description") ??
        readAny(node, ["summary", "description", "text"]);
      streamContext.extractionReportSummary =
        streamContext.extractionReportSummary ??
        getFieldValue(node, "Name") ??
        getFieldValue(node, "Title") ??
        readAny(node, ["name", "title"]);

      const examiner = getFieldValue(node, "Name") ?? readAny(node, ["name", "examiner"]);
      if (examiner) streamPeople.add(examiner);

      const owner =
        getFieldValue(node, "Owner") ??
        getFieldValue(node, "Subscriber") ??
        readAny(node, ["owner", "subscriber", "target"]);
      if (owner) streamPeople.add(owner);

      const deviceFields = readDeviceFields(node);
      if (hasAnyDeviceField(deviceFields)) {
        streamDevice = mergeDeviceValues(streamDevice, deviceFields);
      }
    };

    parser.on("opentag", (tag) => {
      const tagName = stripNamespace(tag.name);
      const parent = stack.at(-1);
      let shouldCapture = Boolean(parent?.capture);
      if (!shouldCapture && ROOT_DEVICE_TAGS.has(tagName)) {
        shouldCapture = true;
      }
      if (!shouldCapture && tagName === "item") {
        const attrs = Object.fromEntries(
          Object.entries(tag.attributes).map(([key, value]) => [stripNamespace(key), String(value ?? "")])
        );
        const normalizedName = normalizeDeviceItemKey(String(attrs.name ?? ""));
        if (normalizedName && DEVICE_ITEM_KEYS.has(normalizedName)) {
          shouldCapture = true;
        }
      }
      if (!shouldCapture && tagName === "model") {
        const attrs = Object.fromEntries(
          Object.entries(tag.attributes).map(([key, value]) => [stripNamespace(key), String(value ?? "")])
        );
        const type = attrs.type?.toLowerCase();
        if (type && CAPTURED_MODEL_TYPES.has(type)) {
          shouldCapture = true;
        }
      }
      if (!shouldCapture && tagName === "file") {
        const attrs = Object.fromEntries(
          Object.entries(tag.attributes).map(([key, value]) => [stripNamespace(key), String(value ?? "")])
        );
        const pathCandidate = attrs.path ?? attrs.archivepath ?? attrs.localpath ?? "";
        if (AUDIO_EXT_RE.test(pathCandidate)) {
          shouldCapture = true;
        }
      }
      const node: Record<string, unknown> = {};

      if (shouldCapture) {
        for (const [rawKey, rawValue] of Object.entries(tag.attributes)) {
          const attrKey = stripNamespace(rawKey);
          node[attrKey] = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
        }
      }

      stack.push({
        tagName,
        capture: shouldCapture,
        node: shouldCapture ? node : undefined,
        textParts: []
      });
    });

    parser.on("text", (textChunk: string) => {
      const frame = stack.at(-1);
      if (!frame?.capture) return;
      frame.textParts.push(textChunk);
    });

    parser.on("cdata", (textChunk: string) => {
      const frame = stack.at(-1);
      if (!frame?.capture) return;
      frame.textParts.push(textChunk);
    });

    parser.on("closetag", () => {
      const frame = stack.pop();
      if (!frame?.capture || !frame.node) return;
      finalizeCapturedNode(frame);

      const parent = stack.at(-1);
      if (parent?.capture && parent.node) {
        appendChildNode(parent.node, frame.tagName, frame.node);
        return;
      }

      if (frame.tagName === "model") {
        const type = modelType(frame.node);
        const deviceFields = readDeviceFields(frame.node);
        if (hasAnyDeviceField(deviceFields)) {
          streamDevice = mergeDeviceValues(streamDevice, deviceFields);
        }
        if (type === "chat") {
          if (typeof PARSER_MAX_CHATS === "number" && chats.length >= PARSER_MAX_CHATS) {
            droppedChats += 1;
            return;
          }
          const parsedChat = parseChatFromModelNode(frame.node);
          const chatMessages = parsedChat.messages;
          const remainingTotal =
            typeof PARSER_MAX_TOTAL_MESSAGES === "number"
              ? Math.max(0, PARSER_MAX_TOTAL_MESSAGES - totalMessagesCaptured)
              : Number.POSITIVE_INFINITY;
          const allowedByChat =
            typeof PARSER_MAX_MESSAGES_PER_CHAT === "number" ? PARSER_MAX_MESSAGES_PER_CHAT : Number.POSITIVE_INFINITY;
          const allowedForChat = Math.min(allowedByChat, remainingTotal);
          if (chatMessages.length > allowedForChat) {
            droppedMessages += chatMessages.length - allowedForChat;
            parsedChat.messages = chatMessages.slice(0, allowedForChat);
          }
          totalMessagesCaptured += parsedChat.messages.length;
          chats.push(parsedChat);
          modelNodesCaptured += 1;
          return;
        }
        if (type === "contact") {
          contacts.push({
            externalId: getFieldValue(frame.node, "Identifier") ?? readAny(frame.node, ["id"]),
            name: getFieldValue(frame.node, "Name"),
            phone: getFieldValue(frame.node, "PhoneNumber"),
            email: getFieldValue(frame.node, "Email"),
            handle: getFieldValue(frame.node, "Identifier")
          });
          modelNodesCaptured += 1;
          return;
        }
        if (type === "call") {
          calls.push(frame.node);
          modelNodesCaptured += 1;
          return;
        }
        if (type === "useraccount") {
          streamUserAccounts.push(parseUserAccountModel(frame.node));
          modelNodesCaptured += 1;
          return;
        }
        if (
          type === "project" ||
          type === "investigation" ||
          type === "caseinfo" ||
          type === "forensiccase" ||
          type === "examiner" ||
          type === "device" ||
          type === "deviceinfo"
        ) {
          mergeContextAndDeviceFromNode(frame.node);
          modelNodesCaptured += 1;
          return;
        }
        if (
          type === "location" ||
          type === "celltower" ||
          type === "journeypathentry" ||
          type === "wirelessnetwork"
        ) {
          const loc = parseLocationModel(frame.node);
          if (loc) streamLocations.push(loc);
          modelNodesCaptured += 1;
          return;
        }
      }

      if (frame.tagName === "file") {
        if (typeof PARSER_MAX_AUDIO_FILES === "number" && filesRaw.length >= PARSER_MAX_AUDIO_FILES) {
          droppedAudioFiles += 1;
          return;
        }
        filesRaw.push(frame.node);
        fileNodesCaptured += 1;
        return;
      }

      if (ROOT_DEVICE_TAGS.has(frame.tagName)) {
        mergeContextAndDeviceFromNode(frame.node);
        return;
      }

      if (frame.tagName === "item") {
        const itemNameRaw = String(frame.node.name ?? "");
        const itemValue = String(frame.node.text ?? "").trim();
        if (!itemNameRaw || !itemValue) return;
        const normalizedItemName = normalizeDeviceItemKey(itemNameRaw);
        const mappedField = DEVICE_ITEM_FIELD_MAP[normalizedItemName];
        if (!mappedField) return;
        streamDevice = {
          ...(streamDevice ?? {}),
          [mappedField]: streamDevice?.[mappedField] ?? itemValue
        };
        return;
      }
    });

    parser.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (PARSER_TOLERATE_TRUNCATED_XML && isRecoverableStreamXmlError(message)) {
        parserRecoveryWarning = message;
        try {
          rs.unpipe(sanitizer);
          sanitizer.unpipe(parser);
          rs.destroy();
        } catch {
          // no-op
        }
        doneResolve();
        return;
      }
      doneReject(error);
    });
    parser.on("end", doneResolve);

    let bytesRead = 0;
    rs.on("data", (chunk) => {
      bytesRead += Buffer.byteLength(chunk, "utf-8");
      options?.onProgress?.({ bytesRead });
    });
    rs.on("error", doneReject);
    rs.pipe(sanitizer).pipe(parser);
  });
  const audioFromChats = parseAudioArtifactsFromChats(chats);
  const audioFromFiles = parseAudioArtifactsFromFiles(filesRaw);

  const extractionCandidate: NormalizedExtraction = {
    device: streamDevice,
    contacts,
    chats,
    userAccounts: streamUserAccounts,
    calls,
    files: [],
    locations: streamLocations,
    audioArtifacts: [...audioFromChats, ...audioFromFiles],
    timeline: [],
    rawMetadata: {
      parser: "sax-stream-incremental",
      capturedChatModels: modelNodesCaptured,
      capturedAudioFileNodes: fileNodesCaptured,
      parserLimits: {
        maxChats: PARSER_MAX_CHATS ?? null,
        maxMessagesPerChat: PARSER_MAX_MESSAGES_PER_CHAT ?? null,
        maxTotalMessages: PARSER_MAX_TOTAL_MESSAGES ?? null,
        maxAudioFiles: PARSER_MAX_AUDIO_FILES ?? null
      },
      parserDropped: {
        chats: droppedChats,
        messages: droppedMessages,
        audioFiles: droppedAudioFiles
      },
      parserWarnings: parserRecoveryWarning ? [parserRecoveryWarning] : undefined,
      parserRecoveredFromMalformedXml: Boolean(parserRecoveryWarning),
      ufdrCaseContext: {
        ...streamContext,
        inquiryMainFacts:
          streamDevice && (streamDevice.manufacturer || streamDevice.model)
            ? `Dispositivo: ${[streamDevice.manufacturer, streamDevice.model].filter(Boolean).join(" ")}`
            : undefined,
        inquiryInvestigativeFocus:
          chats.length > 0
            ? `Aplicativos com conversas na extracao: ${uniqueNonEmpty(chats.map((chat) => chat.sourceApp))
                .slice(0, 6)
                .join(", ")}`
            : undefined,
        inquiryInvolvedPeople: uniqueNonEmpty([...streamPeople])
      }
    }
  };

  return normalizedExtractionSchema.parse(extractionCandidate);
}
