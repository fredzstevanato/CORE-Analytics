import { NextResponse } from "next/server";
import { getLatestCaseInvestigativeTriage, registerInvestigationSelectedMessagePhones } from "@core/cases";
import { prisma } from "@core/db";
import { enqueueInvestigationTriage } from "@core/queue";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

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
    const latest = await getLatestCaseInvestigativeTriage({ caseId: parsed.data.caseId, evidenceId });
    return NextResponse.json({ latest });
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
