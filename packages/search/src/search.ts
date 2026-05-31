import type { InvestigativeSearchFilters } from "@core/shared";
import { opensearchClient } from "./client";
import { INDICES } from "./indices";

export async function investigativeSearch(input: {
  query: string;
  filters: InvestigativeSearchFilters;
  scope?: Array<"messages" | "chats" | "entities" | "attachments" | "calls" | "files">;
}) {
  const must: object[] = [];
  const filter: object[] = [];

  if (input.query.trim().length > 0) {
    must.push({
      multi_match: {
        query: input.query,
        fields: ["text^3", "metadata.*", "sourceApp", "participant"]
      }
    });
  }

  const exactFilters: Array<[keyof InvestigativeSearchFilters, string]> = [
    ["caseId", "caseId"],
    ["evidenceId", "evidenceId"],
    ["extractionId", "extractionId"],
    ["sourceApp", "sourceApp"],
    ["participant", "participant"],
    ["phoneOrEmail", "phoneOrEmail"],
    ["artifactType", "artifactType"]
  ];

  for (const [field, target] of exactFilters) {
    const value = input.filters[field];
    if (value) {
      filter.push({ term: { [target]: value } });
    }
  }

  if (input.filters.dateFrom || input.filters.dateTo) {
    filter.push({
      range: {
        date: {
          gte: input.filters.dateFrom,
          lte: input.filters.dateTo
        }
      }
    });
  }

  const indexScope = input.scope?.length
    ? input.scope.map((scope) => INDICES[scope])
    : [INDICES.messages, INDICES.chats, INDICES.entities, INDICES.attachments, INDICES.calls, INDICES.files];

  const result = await opensearchClient.search({
    index: indexScope,
    size: 100,
    body: {
      query: {
        bool: {
          must,
          filter
        }
      }
    }
  });

  return result.body.hits?.hits ?? [];
}
