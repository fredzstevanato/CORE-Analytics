import { Queue } from "bullmq";
import { transcriptionJobSchema, type TranscriptionJob } from "@core/shared";
import { redisConnection } from "./connection";
import { QUEUE_NAMES } from "./constants";

export const transcriptionQueue = new Queue<TranscriptionJob>(QUEUE_NAMES.audioTranscription, {
  connection: redisConnection
});

const RUNNABLE_JOB_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

async function removeOrphanJobHash(jobId: string) {
  await redisConnection.del(transcriptionQueue.toKey(jobId));
}

async function removeExistingJobIfNotRunnable(jobId: string) {
  const existing = await transcriptionQueue.getJob(jobId);
  if (!existing?.id) return;

  const state = await existing.getState().catch(() => "unknown");
  if (RUNNABLE_JOB_STATES.has(state)) {
    return String(existing.id);
  }

  const removed = await existing
    .remove()
    .then(() => true)
    .catch(() => false);

  if (!removed && state === "unknown") {
    await removeOrphanJobHash(jobId);
  }

  return undefined;
}

export async function enqueueAudioTranscription(payload: TranscriptionJob): Promise<string> {
  const parsed = transcriptionJobSchema.parse(payload);
  const existingRunnableJobId = await removeExistingJobIfNotRunnable(parsed.transcriptionId);
  if (existingRunnableJobId) {
    return existingRunnableJobId;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const job = await transcriptionQueue.add("transcribe-audio", parsed, {
      jobId: parsed.transcriptionId,
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 2,
      backoff: { type: "exponential", delay: 3000 }
    });

    const state = await job.getState().catch(() => "unknown");
    if (RUNNABLE_JOB_STATES.has(state)) {
      return job.id ?? "";
    }

    if (state !== "unknown" || attempt >= 2) {
      return job.id ?? "";
    }

    await removeOrphanJobHash(parsed.transcriptionId);
  }

  return "";
}
