import { prisma } from "../packages/db/src/client";
import { Queue } from "bullmq";
import { QUEUE_NAMES, redisConnection } from "../packages/queue/src";

async function main() {
  const caseId = "864fb1b3-76e8-4dae-b2cf-5adce67011af";

  const transcriptionQueue = new Queue(QUEUE_NAMES.audioTranscription, { connection: redisConnection });
  const counts = await transcriptionQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused");

  const statusCounts = await prisma.audioTranscription.groupBy({
    by: ["status"],
    where: { caseId },
    _count: { _all: true }
  });

  const recentCompleted = await prisma.audioTranscription.count({
    where: {
      caseId,
      status: "COMPLETED",
      finishedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) }
    }
  });

  const recentFailedPolicy = await prisma.audioTranscription.count({
    where: {
      caseId,
      status: "FAILED",
      updatedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      error: { contains: "Descartado" }
    }
  });

  console.log("queue_counts", JSON.stringify(counts));
  console.log("status_counts", JSON.stringify(statusCounts));
  console.log("completed_last_5m", recentCompleted);
  console.log("failed_policy_last_5m", recentFailedPolicy);

  await transcriptionQueue.close();
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
