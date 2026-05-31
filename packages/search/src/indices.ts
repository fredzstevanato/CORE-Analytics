import { opensearchClient } from "./client";

export const INDICES = {
  messages: "invest_messages_v1",
  chats: "invest_chats_v1",
  entities: "invest_entities_v1",
  attachments: "invest_attachments_v1",
  calls: "invest_calls_v1",
  files: "invest_files_v1"
} as const;

const mappings: Record<string, object> = {
  [INDICES.messages]: {
    mappings: {
      properties: {
        caseId: { type: "keyword" },
        evidenceId: { type: "keyword" },
        extractionId: { type: "keyword" },
        sourceApp: { type: "keyword" },
        participant: { type: "keyword" },
        phoneOrEmail: { type: "keyword" },
        artifactType: { type: "keyword" },
        date: { type: "date" },
        text: { type: "text" },
        metadata: { type: "object", enabled: true }
      }
    }
  },
  [INDICES.chats]: {
    mappings: {
      properties: {
        caseId: { type: "keyword" },
        evidenceId: { type: "keyword" },
        extractionId: { type: "keyword" },
        sourceApp: { type: "keyword" },
        participant: { type: "keyword" },
        title: { type: "text" },
        metadata: { type: "object", enabled: true }
      }
    }
  },
  [INDICES.entities]: {
    mappings: {
      properties: {
        caseId: { type: "keyword" },
        evidenceId: { type: "keyword" },
        extractionId: { type: "keyword" },
        type: { type: "keyword" },
        value: { type: "text" },
        phoneOrEmail: { type: "keyword" },
        metadata: { type: "object", enabled: true }
      }
    }
  },
  [INDICES.attachments]: {
    mappings: {
      properties: {
        caseId: { type: "keyword" },
        evidenceId: { type: "keyword" },
        extractionId: { type: "keyword" },
        artifactType: { type: "keyword" },
        filename: { type: "text" },
        text: { type: "text" },
        metadata: { type: "object", enabled: true }
      }
    }
  },
  [INDICES.calls]: {
    mappings: {
      properties: {
        caseId: { type: "keyword" },
        evidenceId: { type: "keyword" },
        extractionId: { type: "keyword" },
        sourceApp: { type: "keyword" },
        participant: { type: "keyword" },
        phoneOrEmail: { type: "keyword" },
        date: { type: "date" },
        artifactType: { type: "keyword" },
        text: { type: "text" },
        metadata: { type: "object", enabled: true }
      }
    }
  },
  [INDICES.files]: {
    mappings: {
      properties: {
        caseId: { type: "keyword" },
        evidenceId: { type: "keyword" },
        extractionId: { type: "keyword" },
        sourceApp: { type: "keyword" },
        artifactType: { type: "keyword" },
        filename: { type: "text" },
        text: { type: "text" },
        metadata: { type: "object", enabled: true }
      }
    }
  }
};

export async function ensureSearchIndices() {
  for (const [index, body] of Object.entries(mappings)) {
    const exists = await opensearchClient.indices.exists({ index });
    if (!exists.body) {
      await opensearchClient.indices.create({
        index,
        body
      });
    }
  }
}
