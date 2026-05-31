import { Queue } from "bullmq";
import {
  audioRecoveryBatchJobSchema,
  audioRecoveryFinalizeJobSchema,
  type AudioRecoveryBatchJob,
  type AudioRecoveryFinalizeJob
} from "@core/shared";
import { redisConnection } from "./connection";
import { QUEUE_NAMES } from "./constants";

export const audioRecoveryBatchQueue = new Queue<AudioRecoveryBatchJob>(QUEUE_NAMES.audioRecoveryBatch, {
  connection: redisConnection
});

export const audioRecoveryFinalizeQueue = new Queue<AudioRecoveryFinalizeJob>(QUEUE_NAMES.audioRecoveryFinalize, {
  connection: redisConnection
});

async function addUniqueJob<T extends { extractionId: string }, N extends string>(input: {
  queue: Queue<T, unknown, N>;
  name: N;
  payload: T;
  jobId: string;
  delayMs?: number;
}) {
  const existing = await input.queue.getJob(input.jobId);
  if (existing?.id) {
    const state = await existing.getState().catch(() => "");
    if (["waiting", "active", "delayed", "prioritized", "waiting-children"].includes(state)) {
      return String(existing.id);
    }
    await existing.remove().catch(() => undefined);
  }

  const job = await input.queue.add(input.name as any, input.payload as any, {
    jobId: input.jobId,
    delay: Math.max(0, input.delayMs ?? 0),
    removeOnComplete: 500,
    removeOnFail: 1000,
    attempts: 1
  });

  return String(job.id ?? "");
}

export async function enqueueAudioRecoveryBatch(payload: AudioRecoveryBatchJob): Promise<string> {
  const parsed = audioRecoveryBatchJobSchema.parse(payload);
  const jobId = `${parsed.extractionId}__batch__${parsed.batchIndex}`;
  return addUniqueJob({
    queue: audioRecoveryBatchQueue,
    name: "recover-audio-batch",
    payload: parsed,
    jobId
  });
}

export async function enqueueAudioRecoveryFinalize(
  payload: AudioRecoveryFinalizeJob,
  options?: { delayMs?: number; forceUnique?: boolean; deferred?: boolean }
): Promise<string> {
  const parsed = audioRecoveryFinalizeJobSchema.parse(payload);
  const delayMs = Math.max(0, options?.delayMs ?? 0);
  const deferredSlot = Math.floor((Date.now() + delayMs) / Math.max(delayMs, 1));
  const jobId = options?.forceUnique
    ? `${parsed.extractionId}__finalize__${Date.now()}__${Math.floor(Math.random() * 1_000_000)}`
    : options?.deferred
      ? `${parsed.extractionId}__finalize__deferred__${deferredSlot}`
    : `${parsed.extractionId}__finalize`;
  return addUniqueJob({
    queue: audioRecoveryFinalizeQueue,
    name: "finalize-audio-recovery",
    payload: parsed,
    jobId,
    delayMs
  });
}
