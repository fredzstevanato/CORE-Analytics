import { Queue } from "bullmq";
import { localUfdrImportJobSchema, type LocalUfdrImportJob } from "@core/shared";
import { redisConnection } from "./connection";
import { QUEUE_NAMES } from "./constants";

export const localUfdrImportQueue = new Queue<LocalUfdrImportJob>(QUEUE_NAMES.localUfdrImport, {
  connection: redisConnection
});

const IN_FLIGHT_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

export async function enqueueLocalUfdrImport(payload: LocalUfdrImportJob): Promise<string> {
  const parsed = localUfdrImportJobSchema.parse(payload);
  const existing = await localUfdrImportQueue.getJob(parsed.extractionId);
  if (existing?.id) {
    const state = await existing.getState().catch(() => "");
    if (IN_FLIGHT_STATES.has(state)) return String(existing.id);
    await existing.remove().catch(() => undefined);
  }

  const job = await localUfdrImportQueue.add("prepare-local-ufdr", parsed, {
    jobId: parsed.extractionId,
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 }
  });

  return job.id ?? "";
}
