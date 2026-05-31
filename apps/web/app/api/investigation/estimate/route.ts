import { NextResponse } from "next/server";
import { getLatestCaseInvestigativeTriage } from "@core/cases";
import { prisma } from "@core/db";
import { z } from "zod";
import { estimateTextCostUsd } from "@/lib/ai-estimation";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const schema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  mode: z.enum(["triage", "report"]),
  aiEngine: z.enum(["local", "openai"]).optional(),
  model: z.string().min(1),
  maxChats: z.number().int().min(1).optional(),
  selectedChatIds: z.array(z.string().uuid()).optional(),
  triageInsightId: z.string().uuid().optional()
});

function clampTokenEstimate(value: number) {
  return Math.max(0, Math.round(value));
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

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const body = schema.parse(await request.json());
    const evidenceId = await resolveEvidenceId(body);
    const aiEngine = body.aiEngine ?? "openai";
    const caseRow = await prisma.case.findUnique({
      where: { id: body.caseId },
      select: {
        id: true,
        inquirySummaryText: true,
        inquiryMainFacts: true,
        inquiryInvestigativeFocus: true,
        extractionReportSummary: true
      }
    });
    if (!caseRow) {
      return NextResponse.json({ error: "Caso nao encontrado." }, { status: 404 });
    }

    const contextChars = [
      caseRow.inquirySummaryText ?? "",
      caseRow.inquiryMainFacts ?? "",
      caseRow.inquiryInvestigativeFocus ?? "",
      caseRow.extractionReportSummary ?? ""
    ]
      .join("\n")
      .length;
    const contextTokens = clampTokenEstimate(contextChars / 4);

    if (body.mode === "triage") {
      const maxChatsResolved =
        typeof body.maxChats === "number"
          ? body.maxChats
          : await resolveDynamicMaxChats({ caseId: body.caseId, evidenceId });
      const takeChats = maxChatsResolved > 0 ? maxChatsResolved : undefined;
      const chats = await prisma.chat.findMany({
        where: {
          caseId: body.caseId,
          ...(evidenceId ? { evidenceId } : {})
        },
        select: {
          id: true,
          _count: { select: { messages: true } }
        },
        take: takeChats
      });

      const chatsPlanned = chats.length;
      const messageCount = chats.reduce((sum, row) => sum + row._count.messages, 0);
      const avgMessageTokens = 18;
      const inputTokensPerChat = contextTokens + 140;
      const inputTokensMessages = clampTokenEstimate(messageCount * avgMessageTokens);
      const inputTokens = clampTokenEstimate(chatsPlanned * inputTokensPerChat + inputTokensMessages);
      const outputTokens = clampTokenEstimate(chatsPlanned * 180);
      const totalTokens = inputTokens + outputTokens;

      const estimatedCostUsd =
        aiEngine === "openai"
          ? estimateTextCostUsd({
              model: body.model,
              inputTokens,
              outputTokens
            })
          : 0;

      const estimatedTimeSeconds =
        aiEngine === "openai"
          ? Math.round(chatsPlanned * 1.4 + totalTokens / 260)
          : Math.round(chatsPlanned * 0.08 + totalTokens / 4000);

      return NextResponse.json({
        mode: "triage",
        aiEngine,
        model: body.model,
        workload: {
          chatsPlanned,
          messagesCount: messageCount,
          maxChatsResolved
        },
        tokens: {
          contextTokens,
          inputTokens,
          outputTokens,
          totalTokens
        },
        estimate: {
          estimatedCostUsd,
          estimatedTimeSeconds,
          estimatedTimeMinutes: Number((estimatedTimeSeconds / 60).toFixed(2))
        },
        notes: [
          "Estimativa heuristica baseada em volume de mensagens e contexto do caso.",
          typeof body.maxChats === "number"
            ? `Max chats manual aplicado: ${body.maxChats}.`
            : `Max chats automatico (todos os chats) aplicado: ${maxChatsResolved}.`,
          aiEngine === "openai"
            ? "Custo depende da tabela por modelo (OPENAI_MODEL_PRICING_JSON para override)."
            : "Modo local nao considera custo de API."
        ]
      });
    }

    let selectedCount = body.selectedChatIds?.length ?? 0;
    if (selectedCount === 0) {
      if (body.triageInsightId) {
        const insight = await prisma.aiInsight.findFirst({
          where: {
            id: body.triageInsightId,
            caseId: body.caseId,
            type: "INVESTIGATION_TRIAGE",
            ...(evidenceId ? { evidenceId } : {})
          },
          select: { metadata: true }
        });
        const payload = (insight?.metadata ?? {}) as Record<string, unknown>;
        const assessments = Array.isArray(payload.assessments) ? payload.assessments : [];
        selectedCount = assessments.length;
      } else {
        const latest = await getLatestCaseInvestigativeTriage({ caseId: body.caseId, evidenceId });
        selectedCount = latest?.payload?.assessments?.length ?? 0;
      }
    }

    const inputTokens = clampTokenEstimate(contextTokens + selectedCount * 350 + 700);
    const outputTokens = clampTokenEstimate(Math.max(900, selectedCount * 220));
    const totalTokens = inputTokens + outputTokens;
    const estimatedCostUsd =
      aiEngine === "openai"
        ? estimateTextCostUsd({
            model: body.model,
            inputTokens,
            outputTokens
          })
        : 0;
    const estimatedTimeSeconds =
      aiEngine === "openai"
        ? Math.round(4 + totalTokens / 320)
        : Math.round(2 + totalTokens / 5000);

    return NextResponse.json({
      mode: "report",
      aiEngine,
      model: body.model,
      workload: {
        selectedChats: selectedCount
      },
      tokens: {
        contextTokens,
        inputTokens,
        outputTokens,
        totalTokens
      },
      estimate: {
        estimatedCostUsd,
        estimatedTimeSeconds,
        estimatedTimeMinutes: Number((estimatedTimeSeconds / 60).toFixed(2))
      },
      notes: [
        "Estimativa heuristica baseada em quantidade de chats selecionados e contexto do inquerito.",
        aiEngine === "openai"
          ? "Custo depende da tabela por modelo (OPENAI_MODEL_PRICING_JSON para override)."
          : "Modo local nao considera custo de API."
      ]
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao estimar analise investigativa." },
      { status: 500 }
    );
  }
}
