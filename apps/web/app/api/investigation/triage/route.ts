import { NextResponse } from "next/server";
import { getLatestCaseInvestigativeTriage, registerInvestigationSelectedMessagePhones } from "@core/cases";
import { prisma, Prisma } from "@core/db";
import { enqueueInvestigationTriage, investigationTriageQueue } from "@core/queue";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const postSchema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  maxChats: z.number().int().min(1).optional(),
  contextHint: z.string().min(20).optional(),
  aiEngine: z.enum(["local", "openai"]).optional(),
  analysisModel: z.string().min(1),
  openaiApiKey: z.string().min(20).optional()
});

const getSchema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional()
});

const patchSchema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  triageInsightId: z.string().uuid().optional(),
  selectedChatIds: z.array(z.string().uuid()).default([])
});

type CompletedTriageReturnValue = {
  insightId?: string;
  summary?: string;
  payload?: {
    caseId?: string;
    evidenceId?: string | null;
    generatedAt?: string;
    assessments?: Array<{ relevanceLevel?: string | null }>;
    [key: string]: unknown;
  };
};

function sanitizeTextForDatabase(value: string) {
  return value.replace(/\u0000/g, "").replace(/[\uD800-\uDFFF]/g, "");
}

function sanitizeJsonForDatabase(value: unknown): unknown {
  if (typeof value === "string") return sanitizeTextForDatabase(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonForDatabase(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [sanitizeTextForDatabase(key), sanitizeJsonForDatabase(item)])
    );
  }
  return value;
}

function isCompletedTriageReturnValue(value: unknown): value is CompletedTriageReturnValue {
  if (!value || typeof value !== "object") return false;
  const payload = (value as CompletedTriageReturnValue).payload;
  return Boolean(payload && typeof payload === "object" && typeof payload.caseId === "string");
}

function scoreFromAssessments(payload: CompletedTriageReturnValue["payload"]) {
  const assessments = Array.isArray(payload?.assessments) ? payload.assessments : [];
  const highCount = assessments.filter((item) => item.relevanceLevel === "alta").length;
  const mediumCount = assessments.filter((item) => item.relevanceLevel === "media").length;
  return {
    highCount,
    mediumCount,
    score: highCount + mediumCount / 2,
    assessedCount: assessments.length
  };
}

async function resolveDynamicMaxChats(input: { caseId: string; evidenceId?: string }) {
  const totalChats = await prisma.chat.count({
    where: {
      caseId: input.caseId,
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {})
    }
  });
  return Math.max(0, totalChats);
}

async function resolveEvidenceId(input: { caseId: string; extractionId?: string; evidenceId?: string }) {
  if (input.extractionId) {
    const extraction = await prisma.extraction.findFirst({
      where: { id: input.extractionId, caseId: input.caseId },
      select: { evidenceId: true }
    });
    if (!extraction) {
      throw new Error("Extracao nao encontrada para o caso informado.");
    }
    return extraction.evidenceId;
  }
  return input.evidenceId;
}

async function findCurrentTriageJob(input: { caseId: string; evidenceId?: string }) {
  const jobs = await investigationTriageQueue.getJobs(["active", "waiting", "delayed", "prioritized", "paused"], 0, 100, true);
  const matching = [];
  for (const job of jobs) {
    if (job.data?.caseId !== input.caseId) continue;
    if (input.evidenceId && job.data?.evidenceId !== input.evidenceId) continue;
    matching.push({
      id: String(job.id ?? ""),
      state: await job.getState(),
      progress: typeof job.progress === "number" ? job.progress : 0,
      timestamp: job.timestamp,
      processedOn: job.processedOn ?? null,
      evidenceId: job.data?.evidenceId ?? null
    });
  }

  matching.sort((a, b) => {
    const stateRank = (state: string) => (state === "active" ? 0 : state === "waiting" ? 1 : 2);
    return stateRank(a.state) - stateRank(b.state) || (b.processedOn ?? b.timestamp) - (a.processedOn ?? a.timestamp);
  });

  return matching[0] ?? null;
}

async function recoverLatestCompletedTriage(input: { caseId: string; evidenceId?: string }) {
  const jobs = await investigationTriageQueue.getJobs(["completed"], 0, 200, true);
  const matching = jobs
    .filter((job) => {
      if (job.data?.caseId !== input.caseId) return false;
      if (input.evidenceId && job.data?.evidenceId !== input.evidenceId) return false;
      return isCompletedTriageReturnValue(job.returnvalue);
    })
    .sort((a, b) => (b.finishedOn ?? b.processedOn ?? b.timestamp) - (a.finishedOn ?? a.processedOn ?? a.timestamp));

  const job = matching[0];
  if (!job || !isCompletedTriageReturnValue(job.returnvalue)) return null;

  const returnvalue = job.returnvalue;
  const payload = returnvalue.payload;
  if (!payload) return null;
  if (payload.caseId !== input.caseId) return null;
  if (input.evidenceId && payload.evidenceId && payload.evidenceId !== input.evidenceId) return null;

  const existing = returnvalue.insightId
    ? await prisma.aiInsight.findFirst({
        where: {
          id: returnvalue.insightId,
          caseId: input.caseId,
          type: "INVESTIGATION_TRIAGE"
        }
      })
    : null;

  if (existing) {
    return {
      insightId: existing.id,
      createdAt: existing.createdAt,
      summary: existing.summary,
      payload: existing.metadata,
      recoveredFromJobId: String(job.id ?? "")
    };
  }

  const counts = scoreFromAssessments(payload);
  const insightId = returnvalue.insightId ?? randomUUID();
  const summary =
    returnvalue.summary ??
    `Chats avaliados: ${counts.assessedCount}. Alta: ${counts.highCount}. Media: ${counts.mediumCount}.`;
  const metadata = sanitizeJsonForDatabase({
    ...payload,
    recoveredFromCompletedJobId: String(job.id ?? ""),
    recoveredAt: new Date().toISOString()
  }) as Prisma.InputJsonValue;

  const insight = await prisma.aiInsight.upsert({
    where: { id: insightId },
    create: {
      id: insightId,
      caseId: input.caseId,
      evidenceId: input.evidenceId ?? payload.evidenceId ?? undefined,
      type: "INVESTIGATION_TRIAGE",
      title: sanitizeTextForDatabase(`Triagem investigativa recuperada (${new Date().toLocaleString("pt-BR")})`),
      summary: sanitizeTextForDatabase(summary),
      score: counts.score,
      metadata
    },
    update: {
      evidenceId: input.evidenceId ?? payload.evidenceId ?? undefined,
      summary: sanitizeTextForDatabase(summary),
      score: counts.score,
      metadata
    }
  });

  return {
    insightId: insight.id,
    createdAt: insight.createdAt,
    summary: insight.summary,
    payload: insight.metadata,
    recoveredFromJobId: String(job.id ?? "")
  };
}

export async function GET(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const url = new URL(request.url);
    const parsed = getSchema.safeParse({
      caseId: url.searchParams.get("caseId") ?? "",
      extractionId: url.searchParams.get("extractionId") ?? undefined,
      evidenceId: url.searchParams.get("evidenceId") ?? undefined
    });

    if (!parsed.success) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    const evidenceId = await resolveEvidenceId(parsed.data);
    const [latest, currentJob] = await Promise.all([
      getLatestCaseInvestigativeTriage({ caseId: parsed.data.caseId, evidenceId }),
      findCurrentTriageJob({ caseId: parsed.data.caseId, evidenceId })
    ]);
    const recoveredLatest = latest || currentJob ? null : await recoverLatestCompletedTriage({ caseId: parsed.data.caseId, evidenceId });

    return NextResponse.json(
      { latest: latest ?? recoveredLatest, currentJob, recoveredFromCompletedJob: recoveredLatest?.recoveredFromJobId ?? null },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
        }
      }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao carregar triagem." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const body = postSchema.parse(await request.json());
    const evidenceId = await resolveEvidenceId(body);
    const maxChatsResolved =
      typeof body.maxChats === "number"
        ? body.maxChats
        : await resolveDynamicMaxChats({ caseId: body.caseId, evidenceId });
    const maxChatsForJob = maxChatsResolved > 0 ? maxChatsResolved : undefined;

    const jobId = await enqueueInvestigationTriage({
      ...body,
      evidenceId,
      maxChats: maxChatsForJob
    });

    return NextResponse.json({
      jobId,
      queue: "triage",
      maxChatsResolved,
      dynamicMaxChats: typeof body.maxChats !== "number"
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao enfileirar triagem." },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    const evidenceId = await resolveEvidenceId(parsed.data);
    const { caseId, triageInsightId } = parsed.data;
    const selectedChatIds = [...new Set(parsed.data.selectedChatIds.filter(Boolean))];

    const insight = triageInsightId
      ? await prisma.aiInsight.findFirst({
          where: {
            id: triageInsightId,
            caseId,
            type: "INVESTIGATION_TRIAGE"
          }
        })
      : await prisma.aiInsight.findFirst({
          where: {
            caseId,
            type: "INVESTIGATION_TRIAGE",
            ...(evidenceId ? { evidenceId } : {})
          },
          orderBy: { createdAt: "desc" }
        });

    if (!insight) {
      return NextResponse.json({ error: "Triagem nao encontrada para salvar selecao." }, { status: 404 });
    }

    const metadata =
      insight.metadata && typeof insight.metadata === "object" && !Array.isArray(insight.metadata)
        ? (insight.metadata as Record<string, unknown>)
        : {};

    const nextMetadata = {
      ...metadata,
      selectedChatIds,
      selectedChatIdsUpdatedAt: new Date().toISOString()
    };

    await prisma.aiInsight.update({
      where: { id: insight.id },
      data: { metadata: nextMetadata }
    });

    const phoneRegistry = await registerInvestigationSelectedMessagePhones({
      caseId,
      evidenceId,
      triageInsightId: insight.id,
      selectedChatIds,
      relevantOnly: true
    });

    return NextResponse.json({
      triageInsightId: insight.id,
      selectedChatIds,
      selectedCount: selectedChatIds.length,
      phoneRegistry
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao salvar selecao da triagem." },
      { status: 500 }
    );
  }
}
