import { NextResponse } from "next/server";
import { prisma } from "@core/db";
import { createCase, getAppSettingValue } from "@core/cases";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";

const schema = z.object({
  inquiryCompiledText: z.string().min(20),
  extractionReportText: z.string().min(10).optional().default(""),
  model: z.string().min(1).default("gpt-4.1-mini"),
  openaiApiKey: z.string().min(20).optional()
});

type IntakeAiResult = {
  caseNumber: string;
  title: string;
  description: string;
  inquiryType: string;
  inquiryNumber: string;
  policeUnit: string;
  inquirySummary: string;
  inquiryMainFacts: string;
  inquiryInvestigativeFocus: string;
  extractionSummary: string;
  involvedPeople: string[];
  legalFraming: string;
};

async function analyzeIntakeWithOpenAi(input: {
  apiKey: string;
  model: string;
  inquiryCompiledText: string;
  extractionReportText: string;
}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Extraia e estruture dados de caso policial para cadastro inicial. Responda somente em JSON valido no schema solicitado."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                inquiryCompiledText: input.inquiryCompiledText,
                extractionReportText: input.extractionReportText
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "case_intake",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              caseNumber: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              inquiryType: { type: "string" },
              inquiryNumber: { type: "string" },
              policeUnit: { type: "string" },
              inquirySummary: { type: "string" },
              inquiryMainFacts: { type: "string" },
              inquiryInvestigativeFocus: { type: "string" },
              extractionSummary: { type: "string" },
              involvedPeople: { type: "array", items: { type: "string" } },
              legalFraming: { type: "string" }
            },
            required: [
              "caseNumber",
              "title",
              "description",
              "inquiryType",
              "inquiryNumber",
              "policeUnit",
              "inquirySummary",
              "inquiryMainFacts",
              "inquiryInvestigativeFocus",
              "extractionSummary",
              "involvedPeople",
              "legalFraming"
            ]
          }
        }
      }
    })
  });

  const raw = await response.text();
  let parsedRaw: any = null;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    parsedRaw = null;
  }

  if (!response.ok) {
    const message = parsedRaw?.error?.message ?? raw ?? `OpenAI error ${response.status}`;
    throw new Error(message);
  }

  const outputText =
    parsedRaw?.output_text ??
    parsedRaw?.output?.[0]?.content?.find((item: any) => item?.type === "output_text")?.text ??
    "";

  if (!outputText) {
    throw new Error("OpenAI nao retornou dados para cadastro do caso.");
  }

  const parsed = JSON.parse(outputText) as IntakeAiResult;
  return parsed;
}

function fallbackCaseNumber() {
  return `CASE-${Date.now()}`;
}

async function ensureUniqueCaseNumber(base: string) {
  const normalized = (base || "").trim() || fallbackCaseNumber();
  let current = normalized;
  let suffix = 1;
  for (;;) {
    const found = await prisma.case.findUnique({ where: { caseNumber: current }, select: { id: true } });
    if (!found) return current;
    suffix += 1;
    current = `${normalized}-${suffix}`;
  }
}

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const configuredApiKey = (await getAppSettingValue("OPENAI_API_KEY"))?.trim();
    const apiKey = body.openaiApiKey?.trim() || configuredApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY ausente. Configure em Configuracoes ou informe chave temporaria." },
        { status: 400 }
      );
    }

    const ai = await analyzeIntakeWithOpenAi({
      apiKey,
      model: body.model,
      inquiryCompiledText: body.inquiryCompiledText,
      extractionReportText: body.extractionReportText
    });

    const session = await getSessionUser();
    const caseNumber = await ensureUniqueCaseNumber(ai.caseNumber);

    const created = await createCase({
      caseNumber,
      title: ai.title || "Caso sem titulo",
      description: ai.description,
      ownerId: session?.id,
      inquiryType: ai.inquiryType,
      inquiryNumber: ai.inquiryNumber,
      policeUnit: ai.policeUnit,
      inquiryLegalFraming: ai.legalFraming,
      inquiryInvolvedPeople: ai.involvedPeople,
      inquirySummaryText: ai.inquirySummary,
      inquiryMainFacts: ai.inquiryMainFacts,
      inquiryInvestigativeFocus: ai.inquiryInvestigativeFocus,
      extractionReportSummary: ai.extractionSummary
    });

    await prisma.aiInsight.create({
      data: {
        caseId: created.id,
        type: "CASE_INTAKE",
        title: `Intake do caso (${new Date().toLocaleString("pt-BR")})`,
        summary: ai.inquirySummary,
        metadata: {
          model: body.model,
          legalFraming: ai.legalFraming,
          involvedPeople: ai.involvedPeople,
          inquirySummary: ai.inquirySummary,
          extractionSummary: ai.extractionSummary,
          inquiryCompiledText: body.inquiryCompiledText,
          extractionReportText: body.extractionReportText
        }
      }
    });

    return NextResponse.json({
      caseId: created.id,
      caseNumber: created.caseNumber,
      title: created.title
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao criar caso via intake." },
      { status: 500 }
    );
  }
}
