import { Client } from "@opensearch-project/opensearch";

const node = process.env.OPENSEARCH_URL ?? "http://localhost:9200";

export const opensearchClient = new Client({
  node
});
