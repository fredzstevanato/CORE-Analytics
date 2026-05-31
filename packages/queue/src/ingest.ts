import { Queue } from "bullmq";
import { ingestJobSchema, type IngestJob } from "@core/shared";
import { redisConnection } from "./connection";
import { QUEUE_NAMES } from "./constants";

export const ingestQueue = new Queue<IngestJob>(QUEUE_NAMES.ingestUfdr, {
  connection: redisConnection
});

const IN_FLIGHT_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

function isInFlightState(state: string) {
  return IN_FLIGHT_STATES.has(state);
}

export async function enqueueUfdrIngestion(payload: IngestJob): Promise<string> {
  const parsed = ingestJobSchema.parse(payload);

  const existingById = await ingestQueue.getJob(parsed.extractionId);
  if (existingById?.id) {
    const state = await existingById.getState().catch(() => "");
    if (isInFlightState(state)) {
      return String(existingById.id);
    }

    // Reprocess uses the same extractionId as jobId; old terminal jobs must be removed before requeue.
    await existingById.remove().catch(() => undefined);
  }

  const queuedJobs = await ingestQueue.getJobs(["waiting", "active", "delayed", "prioritized", "waiting-children"], 0, -1);
  const duplicate = queuedJobs.find((job) => job.data?.extractionId === parsed.extractionId);
  if (duplicate?.id) {
    return String(duplicate.id);
  }

  const job = await ingestQueue.add("process-ufdr", parsed, {
    jobId: parsed.extractionId,
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 }
  });

  // Defensive check: if Redis returned a stale terminal job with same jobId, retry once after cleanup.
  const addedState = await job.getState().catch(() => "");
  if (!isInFlightState(addedState)) {
    await job.remove().catch(() => undefined);
    const retried = await ingestQueue.add("process-ufdr", parsed, {
      jobId: parsed.extractionId,
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 2,
      backoff: { type: "exponential", delay: 2000 }
    });
    const retriedState = await retried.getState().catch(() => "");
    if (!isInFlightState(retriedState)) {
      throw new Error(
        `Nao foi possivel reenfileirar ingestao para extractionId=${parsed.extractionId}; estado final do job=${retriedState || "desconhecido"}.`
      );
    }
    return retried.id ?? "";
  }

  return job.id ?? "";
}
