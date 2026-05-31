import { NextResponse } from "next/server";
import { prisma } from "@core/db";
import { redisConnection } from "@core/queue";
import { opensearchClient } from "@core/search";

export async function GET() {
  const checks = {
    database: false,
    redis: false,
    opensearch: false
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {}

  try {
    const pong = await redisConnection.ping();
    checks.redis = pong === "PONG";
  } catch {}

  try {
    const health = await opensearchClient.cluster.health();
    checks.opensearch = Boolean(health.body?.status);
  } catch {}

  const ok = checks.database && checks.redis && checks.opensearch;
  return NextResponse.json(
    {
      ok,
      timestamp: new Date().toISOString(),
      checks
    },
    { status: ok ? 200 : 503 }
  );
}
