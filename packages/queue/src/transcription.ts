import { Queue } from "bullmq";
import { transcriptionJobSchema, type TranscriptionJob } from "@core/shared";
import { redisConnection } from "./connection";
import { QUEUE_NAMES } from "./constants";

export const transcriptionQueue = new Queue<TranscriptionJob>(QUEUE_NAMES.audioTranscription, {
  connection: redisConnection
});

export async function enqueueAudioTranscription(payload: TranscriptionJob): Promise<string> {
  const parsed = transcriptionJobSchema.parse(payload);
  const existing = await transcriptionQueue.getJob(parsed.transcriptionId);
  if (existing?.id) {
    const state = await existing.getState().catch(() => "");
    if (["waiting", "active", "delayed", "prioritized", "waiting-children"].includes(state)) {
      return String(existing.id);
    }
    await existing.remove().catch(() => undefined);
  }
  const job = await transcriptionQueue.add("transcribe-audio", parsed, {
    jobId: parsed.transcriptionId,
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 2,
    backoff: { type: "exponential", delay: 3000 }
  });
  return job.id ?? "";
}
