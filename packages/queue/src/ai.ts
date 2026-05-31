import { Queue } from "bullmq";
import {
  aiClassificationJobSchema,
  ocrJobSchema,
  type AiClassificationJob,
  type OcrJob
} from "@core/shared";
import { redisConnection } from "./connection";
import { QUEUE_NAMES } from "./constants";

export const ocrQueue = new Queue<OcrJob>(QUEUE_NAMES.ocrDocuments, {
  connection: redisConnection
});

export const classificationQueue = new Queue<AiClassificationJob>(QUEUE_NAMES.aiClassification, {
  connection: redisConnection
});

export async function enqueueOcrDocument(payload: OcrJob) {
  const parsed = ocrJobSchema.parse(payload);
  const job = await ocrQueue.add("ocr-document", parsed, {
    removeOnComplete: 100,
    removeOnFail: 300
  });
  return job.id ?? "";
}

export async function enqueueAiClassification(payload: AiClassificationJob) {
  const parsed = aiClassificationJobSchema.parse(payload);
  const job = await classificationQueue.add("classify-text", parsed, {
    removeOnComplete: 100,
    removeOnFail: 300
  });
  return job.id ?? "";
}
