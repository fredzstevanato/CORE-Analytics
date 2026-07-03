import { Queue } from "bullmq";
import {
  investigationReportJobSchema,
  investigationTriageJobSchema,
  type InvestigationReportJob,
  type InvestigationTriageJob
} from "@core/shared";
import { redisConnection } from "./connection";
import { QUEUE_NAMES } from "./constants";

export const investigationTriageQueue = new Queue<InvestigationTriageJob>(QUEUE_NAMES.investigationTriage, {
  connection: redisConnection
});

export const investigationReportQueue = new Queue<InvestigationReportJob>(QUEUE_NAMES.investigationReport, {
  connection: redisConnection
});

export async function enqueueInvestigationTriage(payload: InvestigationTriageJob) {
  const parsed = investigationTriageJobSchema.parse(payload);
  const job = await investigationTriageQueue.add("run-investigation-triage", parsed, {
    removeOnComplete: 200,
    removeOnFail: 400
  });
  return String(job.id ?? "");
}

export async function enqueueInvestigationReport(payload: InvestigationReportJob) {
  const parsed = investigationReportJobSchema.parse(payload);
  const job = await investigationReportQueue.add("run-investigation-report", parsed, {
    removeOnComplete: 200,
    removeOnFail: 400
  });
  return String(job.id ?? "");
}

export async function getInvestigationJobStatus(input: { type: "triage" | "report"; jobId: string }) {
  const queue = input.type === "triage" ? investigationTriageQueue : investigationReportQueue;
  const job = await queue.getJob(input.jobId);
  if (!job) return null;
  const state = await job.getState();
  return {
    id: String(job.id ?? ""),
    state,
    progress: (job.progress as number) ?? 0,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason ?? null
  };
}
