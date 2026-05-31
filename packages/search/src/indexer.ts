import type { NormalizedExtraction } from "@core/shared";
import { opensearchClient } from "./client";
import { INDICES } from "./indices";

export async function indexExtractionSummary(input: {
  caseId: string;
  evidenceId: string;
  extractionId: string;
  normalized: NormalizedExtraction;
}) {
  const { caseId, evidenceId, extractionId, normalized } = input;

  const messageDocs = normalized.chats.flatMap((chat) =>
    chat.messages.map((message) => ({
      caseId,
      evidenceId,
      extractionId,
      sourceApp: chat.sourceApp,
      participant: message.senderExternalId,
      date: message.timestamp,
      artifactType: "MESSAGE",
      text: message.body,
      metadata: message.metadata ?? {}
    }))
  );

  const chatDocs = normalized.chats.map((chat) => ({
    caseId,
    evidenceId,
    extractionId,
    sourceApp: chat.sourceApp,
    participant: chat.participants.map((p) => p.handle ?? p.phone ?? p.email).filter(Boolean),
    title: chat.title,
    metadata: chat.metadata ?? {}
  }));

  const entityDocs = normalized.contacts.map((contact) => ({
    caseId,
    evidenceId,
    extractionId,
    type: "CONTACT",
    value: contact.name ?? contact.phone ?? contact.email ?? contact.handle ?? "contact",
    phoneOrEmail: contact.phone ?? contact.email,
    metadata: contact
  }));

  const attachmentDocs = normalized.audioArtifacts.map((audio) => ({
    caseId,
    evidenceId,
    extractionId,
    artifactType: "ATTACHMENT",
    filename: audio.fileName,
    text: audio.fileName,
    metadata: audio
  }));

  const callDocs = normalized.calls.map((call) => ({
    caseId,
    evidenceId,
    extractionId,
    sourceApp: "UFDR",
    artifactType: "CALL",
    date: (call.timestamp as string | undefined) ?? (call.date as string | undefined),
    text: (call.type as string | undefined) ?? "call",
    metadata: call
  }));

  const fileDocs = normalized.files.map((file) => ({
    caseId,
    evidenceId,
    extractionId,
    sourceApp: "UFDR",
    artifactType: "FILE",
    filename: (file.name as string | undefined) ?? (file.fileName as string | undefined),
    text: (file.path as string | undefined) ?? (file.name as string | undefined),
    metadata: file
  }));

  async function bulkIndex(index: string, docs: Array<Record<string, unknown>>) {
    if (docs.length === 0) return;
    const body = docs.slice(0, 10000).flatMap((doc) => [{ index: { _index: index } }, doc]);
    await opensearchClient.bulk({
      refresh: false,
      body
    });
  }

  await Promise.all([
    bulkIndex(INDICES.messages, messageDocs),
    bulkIndex(INDICES.chats, chatDocs),
    bulkIndex(INDICES.entities, entityDocs),
    bulkIndex(INDICES.attachments, attachmentDocs),
    bulkIndex(INDICES.calls, callDocs),
    bulkIndex(INDICES.files, fileDocs)
  ]);
}
