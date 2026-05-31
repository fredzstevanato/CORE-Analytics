import { NextResponse } from "next/server";
import type { JobType } from "bullmq";
import { prisma } from "@core/db";
import {
  classificationQueue,
  ingestQueue,
  investigationReportQueue,
  investigationTriageQueue,
  ocrQueue,
  redisConnection,
  transcriptionQueue
} from "@core/queue";
import { opensearchClient } from "@core/search";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

type ServiceStatus = "ok" | "degraded" | "down";

function normalizeStatus(ok: boolean): ServiceStatus {
  return ok ? "ok" : "down";
}

function deriveOverallStatus(parts: Array<ServiceStatus>): ServiceStatus {
  if (parts.some((part) => part === "down")) return "down";
  if (parts.some((part) => part === "degraded")) return "degraded";
  return "ok";
}

async function queueSnapshot(
  name: string,
  queue: { getJobCounts: (...args: JobType[]) => Promise<Record<string, number>>; getWorkersCount: () => Promise<number> }
) {
  const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused");
  const workers = await queue.getWorkersCount();
  const status: ServiceStatus = workers > 0 ? "ok" : (counts.active ?? 0) > 0 || (counts.waiting ?? 0) > 0 ? "degraded" : "down";
  return {
    name,
    status,
    workers,
    counts
  };
}

export async function GET() {
  const auth = await requireApiSession();
  if ("error" in auth) return auth.error;
  if (auth.session.role !== "ADMIN") {
    return NextResponse.json({ error: "Acesso restrito a administradores." }, { status: 403 });
  }

  let dbStatus: ServiceStatus = "down";
  let redisStatus: ServiceStatus = "down";
  let searchStatus: ServiceStatus = "down";
  let opensearchClusterStatus: string | null = null;
  let redisPingMs: number | null = null;
  let dbPingMs: number | null = null;
  let searchPingMs: number | null = null;

  try {
    const started = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbPingMs = Date.now() - started;
    dbStatus = "ok";
  } catch {
    dbStatus = "down";
  }

  try {
    const started = Date.now();
    const pong = await redisConnection.ping();
    redisPingMs = Date.now() - started;
    redisStatus = normalizeStatus(pong === "PONG");
  } catch {
    redisStatus = "down";
  }

  try {
    const started = Date.now();
    const response = await opensearchClient.cluster.health();
    searchPingMs = Date.now() - started;
    const body = response.body as { status?: string } | undefined;
    opensearchClusterStatus = body?.status ?? null;
    if (body?.status === "green") searchStatus = "ok";
    else if (body?.status === "yellow") searchStatus = "degraded";
    else searchStatus = "down";
  } catch {
    searchStatus = "down";
  }

  const queues = await Promise.all([
    queueSnapshot("ingest-ufdr", ingestQueue),
    queueSnapshot("audio-transcription", transcriptionQueue),
    queueSnapshot("ocr-documents", ocrQueue),
    queueSnapshot("ai-classification", classificationQueue),
    queueSnapshot("investigation-triage", investigationTriageQueue),
    queueSnapshot("investigation-report", investigationReportQueue)
  ]);

  const extractions = await prisma.extraction.groupBy({
    by: ["status"],
    _count: { _all: true }
  });

  const transcriptions = await prisma.audioTranscription.groupBy({
    by: ["status"],
    _count: { _all: true }
  });

  const queueStatus = deriveOverallStatus(queues.map((row) => row.status));
  const overall = deriveOverallStatus([dbStatus, redisStatus, searchStatus, queueStatus]);

  return NextResponse.json(
    {
      ok: overall !== "down",
      overallStatus: overall,
      timestamp: new Date().toISOString(),
      services: {
        database: { status: dbStatus, pingMs: dbPingMs },
        redis: { status: redisStatus, pingMs: redisPingMs },
        opensearch: { status: searchStatus, pingMs: searchPingMs, clusterStatus: opensearchClusterStatus },
        queues: { status: queueStatus, items: queues }
      },
      workload: {
        extractions,
        transcriptions
      }
    },
    { status: overall === "down" ? 503 : 200 }
  );
}
