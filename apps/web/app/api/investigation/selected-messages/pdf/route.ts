import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import { addCustodyEvent, getLatestCaseInvestigativeTriage } from "@core/cases";
import { prisma } from "@core/db";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

const postSchema = z.object({
  caseId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  evidenceId: z.string().uuid().optional(),
  triageInsightId: z.string().uuid().optional(),
  selectedChatIds: z.array(z.string().uuid()).optional(),
  relevantOnly: z.boolean().optional()
});

type AssessmentIndexValue = {
  relevanceLevel: string;
  relevanceScore: number;
  rationale: string;
  matchedTerms: string[];
  positiveSignals: string[];
  excerpt: string;
};

const STOPWORDS = new Set([
  "para",
  "com",
  "uma",
  "que",
  "por",
  "dos",
  "das",
  "esse",
  "essa",
  "este",
  "esta",
  "chat",
  "mensagem",
  "mensagens",
  "audio",
  "transcricao",
  "inquerito",
  "investigacao"
]);

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

function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalize(value: string) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenizeTerms(value: string) {
  return [...new Set((normalize(value).match(/[a-z0-9]{4,}/g) ?? []).filter((term) => !STOPWORDS.has(term)))];
}

function resolveChromeExecutablePath() {
  const fromEnv = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;

  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find((value) => value.length > 0);
}

async function renderHtmlToPdf(input: { html: string }) {
  const executablePath = resolveChromeExecutablePath();
  if (!executablePath) {
    throw new Error("Navegador Chromium/Chrome nao encontrado para renderizacao HTML->PDF.");
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage();
    await page.setContent(input.html, { waitUntil: "networkidle0" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "16mm",
        right: "12mm",
        bottom: "16mm",
        left: "12mm"
      }
    });
  } finally {
    await browser.close();
  }
}

async function tryLoadLogoDataUri(filename: string) {
  const absolutePath = path.resolve(process.cwd(), "public", "branding", filename);
  try {
    await access(absolutePath);
    const bytes = await readFile(absolutePath);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function getAssessmentIndex(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return new Map<string, AssessmentIndexValue>();
  }

  const record = metadata as Record<string, unknown>;
  const assessments = Array.isArray(record.assessments) ? record.assessments : [];
  const output = new Map<string, AssessmentIndexValue>();

  for (const row of assessments) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const obj = row as Record<string, unknown>;
    const chatId = typeof obj.chatId === "string" ? obj.chatId : "";
    if (!chatId) continue;
    output.set(chatId, {
      relevanceLevel: typeof obj.relevanceLevel === "string" ? obj.relevanceLevel : "nao-classificada",
      relevanceScore: typeof obj.relevanceScore === "number" ? obj.relevanceScore : 0,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "Sem racional informado.",
      matchedTerms: parseStringArray(obj.matchedTerms),
      positiveSignals: parseStringArray(obj.positiveSignals),
      excerpt: typeof obj.excerpt === "string" ? obj.excerpt : ""
    });
  }

  return output;
}

function hasExcerptOverlap(text: string, excerpt: string) {
  const normalizedText = normalize(text).replace(/\s+/g, " ").trim();
  const normalizedExcerpt = normalize(excerpt).replace(/\s+/g, " ").trim();
  if (!normalizedText || !normalizedExcerpt) return false;

  if (normalizedText.length >= 24 && normalizedExcerpt.includes(normalizedText.slice(0, 120))) return true;
  if (normalizedExcerpt.length >= 24 && normalizedText.includes(normalizedExcerpt.slice(0, 120))) return true;

  const textTerms = new Set(tokenizeTerms(normalizedText));
  const excerptTerms = tokenizeTerms(normalizedExcerpt);
  if (excerptTerms.length === 0) return false;
  const overlap = excerptTerms.filter((term) => textTerms.has(term)).length;
  return overlap >= Math.min(4, Math.max(2, Math.ceil(excerptTerms.length * 0.35)));
}

function isRelevantMessageForAssessment(
  message: {
    body: string | null;
    attachments: Array<{ transcriptions: Array<{ text: string | null }> }>;
  },
  assessment?: AssessmentIndexValue
) {
  if (!assessment) return false;

  const contentParts = [
    message.body ?? "",
    ...message.attachments.flatMap((attachment) => attachment.transcriptions.map((row) => row.text ?? ""))
  ].filter((value) => value.trim().length > 0);
  if (contentParts.length === 0) return false;
  if (contentParts.every((part) => normalize(part).includes("messages and calls are end-to-end encrypted"))) return false;

  const content = contentParts.join("\n");
  if (assessment.excerpt && hasExcerptOverlap(content, assessment.excerpt)) return true;

  const primaryTerms = new Set([
    ...assessment.matchedTerms.map((term) => normalize(term)).filter((term) => term.length >= 4 && !STOPWORDS.has(term)),
    ...tokenizeTerms(assessment.excerpt)
  ]);
  const secondaryTerms = new Set([
    ...tokenizeTerms(assessment.rationale),
    ...tokenizeTerms(assessment.positiveSignals.join(" "))
  ]);
  const textTerms = new Set(tokenizeTerms(content));

  const primaryMatches = [...primaryTerms].filter((term) => textTerms.has(term)).length;
  if (primaryMatches >= 2) return true;
  if (primaryMatches >= 1 && assessment.excerpt.length < 30) return true;

  const secondaryMatches = [...secondaryTerms].filter((term) => textTerms.has(term)).length;
  return secondaryMatches >= 3 && primaryMatches >= 1;
}

function selectRelevantMessagesWithContext<T extends {
  body: string | null;
  attachments: Array<{ transcriptions: Array<{ text: string | null }> }>;
}>(messages: T[], assessment?: AssessmentIndexValue) {
  if (!assessment) return [];

  const directRelevantIndexes = messages
    .map((message, index) => (isRelevantMessageForAssessment(message, assessment) ? index : -1))
    .filter((index) => index >= 0);

  if (directRelevantIndexes.length === 0) return [];

  const include = new Set<number>();
  const contextRadius = 2;
  const bridgeGap = 8;

  for (const index of directRelevantIndexes) {
    for (let cursor = Math.max(0, index - contextRadius); cursor <= Math.min(messages.length - 1, index + contextRadius); cursor += 1) {
      include.add(cursor);
    }
  }

  for (let i = 0; i < directRelevantIndexes.length - 1; i += 1) {
    const current = directRelevantIndexes[i];
    const next = directRelevantIndexes[i + 1];
    if (current === undefined || next === undefined) continue;
    if (next - current <= bridgeGap) {
      for (let cursor = current; cursor <= next; cursor += 1) {
        include.add(cursor);
      }
    }
  }

  return [...include]
    .sort((a, b) => a - b)
    .map((index) => messages[index])
    .filter((message): message is T => Boolean(message));
}

function resolveSelectedChatIds(input: {
  payloadSelectedChatIds: string[];
  triageMetadata: unknown;
}): string[] {
  const selectedFromBody = [...new Set(input.payloadSelectedChatIds.filter(Boolean))];
  if (selectedFromBody.length > 0) return selectedFromBody;

  if (input.triageMetadata && typeof input.triageMetadata === "object" && !Array.isArray(input.triageMetadata)) {
    const triageRecord = input.triageMetadata as Record<string, unknown>;
    const selectedFromMetadata = [...new Set(parseStringArray(triageRecord.selectedChatIds))];
    if (selectedFromMetadata.length > 0) return selectedFromMetadata;

    const assessments = Array.isArray(triageRecord.assessments) ? triageRecord.assessments : [];
    const fallbackFromAssessment = assessments
      .filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const row = item as Record<string, unknown>;
        return row.relevanceLevel === "alta" || row.relevanceLevel === "media";
      })
      .sort((a, b) => {
        const scoreA = typeof (a as Record<string, unknown>).relevanceScore === "number" ? (a as Record<string, unknown>).relevanceScore as number : 0;
        const scoreB = typeof (b as Record<string, unknown>).relevanceScore === "number" ? (b as Record<string, unknown>).relevanceScore as number : 0;
        return scoreB - scoreA;
      })
      .slice(0, 40)
      .map((item) => ((item as Record<string, unknown>).chatId as string) || "")
      .filter(Boolean);

    if (fallbackFromAssessment.length > 0) {
      return [...new Set(fallbackFromAssessment)];
    }
  }

  return [];
}

function buildPdfHtml(input: {
  caseNumber: string;
  caseTitle: string;
  generatedAtIso: string;
  selectedCount: number;
  messageCount: number;
  logos: { left: string | null; right: string | null };
  sectionsHtml: string;
  relevantOnly: boolean;
}) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 14mm 12mm 16mm 12mm; }
      body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11px; line-height: 1.35; }
      .header-wrap { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
      .header { display: grid; grid-template-columns: 88px 1fr 88px; align-items: center; gap: 8px; }
      .logo-box { width: 82px; height: 82px; display: flex; align-items: center; justify-content: center; }
      .logo-box img { max-width: 100%; max-height: 100%; object-fit: contain; }
      .logo-fallback { width: 72px; height: 72px; border: 1px dashed #999; font-size: 9px; color: #666; display: flex; align-items: center; justify-content: center; text-align: center; padding: 3px; }
      .title-main { text-align: center; }
      .title-main .line { font-size: 16px; font-weight: 700; text-transform: uppercase; line-height: 1.2; }
      .title-main .sub { margin-top: 5px; font-size: 12px; font-weight: 700; }
      .meta { margin: 8px 0; border: 1px solid #ddd; border-radius: 6px; padding: 8px; background: #fafafa; }
      .meta p { margin: 2px 0; }
      .chat { border: 1px solid #ddd; border-radius: 6px; margin: 8px 0 10px; overflow: hidden; }
      .chat-head { background: #f4f4f5; border-bottom: 1px solid #ddd; padding: 7px 8px; }
      .chat-head p { margin: 2px 0; }
      .label { font-weight: 700; }
      .rationale { padding: 6px 8px; background: #fcfcfd; border-bottom: 1px solid #eee; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      th, td { border-bottom: 1px solid #ececec; padding: 6px; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
      th { background: #f9fafb; text-align: left; font-size: 10px; }
      .col-idx { width: 34px; }
      .col-time { width: 128px; }
      .col-sender { width: 150px; }
      .col-direction { width: 68px; }
      .msg { white-space: pre-wrap; }
      .transcription { margin-top: 4px; color: #1f2937; background: #f8fafc; border-left: 2px solid #cbd5e1; padding: 4px 6px; border-radius: 3px; }
      .small { font-size: 10px; color: #52525b; }
    </style>
  </head>
  <body>
    <section class="header-wrap">
      <div class="header">
        <div class="logo-box">
          ${input.logos.left ? `<img src="${input.logos.left}" alt="Brasao Estado de Mato Grosso" />` : '<div class="logo-fallback">Logo Estado</div>'}
        </div>
        <div class="title-main">
          <div class="line">ESTADO DE MATO GROSSO</div>
          <div class="line">POLICIA JUDICIARIA CIVIL</div>
          <div class="sub">ANEXO - ${input.relevantOnly ? "MENSAGENS RELEVANTES DA TRIAGEM" : "MENSAGENS SELECIONADAS"}</div>
        </div>
        <div class="logo-box">
          ${input.logos.right ? `<img src="${input.logos.right}" alt="Distintivo Policia Civil MT" />` : '<div class="logo-fallback">Logo PJC</div>'}
        </div>
      </div>
    </section>

    <section class="meta">
      <p><span class="label">Caso:</span> ${htmlEscape(input.caseNumber)} - ${htmlEscape(input.caseTitle)}</p>
      <p><span class="label">Gerado em:</span> ${htmlEscape(input.generatedAtIso)}</p>
      <p><span class="label">Chats selecionados:</span> ${input.selectedCount}</p>
      <p><span class="label">Mensagens incluídas:</span> ${input.messageCount}</p>
      <p><span class="label">Filtro aplicado:</span> ${input.relevantOnly ? "Somente mensagens que sustentam contexto/relevancia da IA" : "Chat completo dos selecionados"}</p>
    </section>

    ${input.sectionsHtml}
  </body>
</html>`;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const parsed = postSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    const caseRow = await prisma.case.findUnique({
      where: { id: parsed.data.caseId },
      select: { id: true, caseNumber: true, title: true }
    });
    if (!caseRow) {
      return NextResponse.json({ error: "Caso nao encontrado." }, { status: 404 });
    }

    const evidenceId = await resolveEvidenceId(parsed.data);
    const triageInsight = parsed.data.triageInsightId
      ? await prisma.aiInsight.findFirst({
          where: {
            id: parsed.data.triageInsightId,
            caseId: parsed.data.caseId,
            type: "INVESTIGATION_TRIAGE",
            ...(evidenceId ? { evidenceId } : {})
          }
        })
      : await (async () => {
          const latest = await getLatestCaseInvestigativeTriage({ caseId: parsed.data.caseId, evidenceId });
          if (!latest?.insightId) return null;
          return prisma.aiInsight.findFirst({
            where: {
              id: latest.insightId,
              caseId: parsed.data.caseId,
              type: "INVESTIGATION_TRIAGE",
              ...(evidenceId ? { evidenceId } : {})
            }
          });
        })();

    if (!triageInsight) {
      return NextResponse.json({ error: "Triagem investigativa nao encontrada." }, { status: 404 });
    }

    const selectedChatIds = resolveSelectedChatIds({
      payloadSelectedChatIds: parsed.data.selectedChatIds ?? [],
      triageMetadata: triageInsight.metadata
    });

    if (selectedChatIds.length === 0) {
      return NextResponse.json({ error: "Nenhum chat selecionado para gerar o anexo em PDF." }, { status: 400 });
    }

    const chats = await prisma.chat.findMany({
      where: {
        caseId: parsed.data.caseId,
        ...(evidenceId ? { evidenceId } : {}),
        id: { in: selectedChatIds }
      },
      include: {
        participants: {
          select: { id: true, name: true, handle: true, phone: true, email: true }
        },
        messages: {
          orderBy: [{ timestamp: "asc" }, { createdAt: "asc" }],
          include: {
            attachments: {
              include: {
                transcriptions: {
                  where: { status: "COMPLETED" },
                  orderBy: { createdAt: "desc" },
                  take: 1
                }
              }
            }
          },
          take: 500
        }
      }
    });

    const chatById = new Map(chats.map((chat) => [chat.id, chat]));
    const orderedChats = selectedChatIds.map((chatId) => chatById.get(chatId)).filter(Boolean);
    const assessmentByChatId = getAssessmentIndex(triageInsight.metadata ?? null);

    let totalMessages = 0;
    let includedChatCount = 0;
    const sections: string[] = [];

    for (const [index, chat] of orderedChats.entries()) {
      if (!chat) continue;
      const assessment = assessmentByChatId.get(chat.id);
      const participants = [...new Set(
        chat.participants
          .map((participant) => [participant.name, participant.handle, participant.phone, participant.email].find((value) => Boolean(value?.trim())) ?? null)
          .filter((value): value is string => Boolean(value))
      )];

      const messagesForPdf = parsed.data.relevantOnly
        ? selectRelevantMessagesWithContext(chat.messages, assessment)
        : chat.messages;

      if (parsed.data.relevantOnly && messagesForPdf.length === 0) {
        continue;
      }

      includedChatCount += 1;
      const rows = messagesForPdf.map((message, rowIndex) => {
        const timestamp = message.timestamp ?? message.createdAt;
        const when = timestamp ? timestamp.toISOString() : "sem-horario";
        const sender = (message.senderId ?? "interlocutor").trim() || "interlocutor";
        const direction = normalize(message.direction ?? "").includes("out") ? "OUT" : "IN";
        const body = (message.body ?? "").trim() || "(mensagem sem texto)";
        const transcriptionText = message.attachments
          .flatMap((attachment) => attachment.transcriptions)
          .map((row) => row.text)
          .filter((value): value is string => Boolean(value?.trim()))
          .slice(0, 2)
          .join("\n");

        totalMessages += 1;

        return `
          <tr>
            <td class="col-idx">${rowIndex + 1}</td>
            <td class="col-time">${htmlEscape(when)}</td>
            <td class="col-sender">${htmlEscape(sender)}</td>
            <td class="col-direction">${htmlEscape(direction)}</td>
            <td>
              <div class="msg">${htmlEscape(body)}</div>
              ${transcriptionText ? `<div class="transcription"><span class="small">Transcricao</span><br/>${htmlEscape(transcriptionText).replace(/\n/g, "<br/>")}</div>` : ""}
            </td>
          </tr>
        `;
      });

      sections.push(`
        <section class="chat">
          <div class="chat-head">
            <p><span class="label">Chat ${includedChatCount}:</span> ${htmlEscape(chat.title ?? chat.externalId ?? chat.id)}</p>
            <p class="small">ID: ${htmlEscape(chat.id)} | Fonte: ${htmlEscape(chat.sourceApp ?? "OUTROS")}</p>
            <p class="small">Participantes: ${htmlEscape(participants.length > 0 ? participants.join(" | ") : "N/D")}</p>
            <p class="small">Relevancia: ${htmlEscape(String(assessment?.relevanceLevel ?? "nao-classificada").toUpperCase())} (${assessment?.relevanceScore ?? 0})</p>
          </div>
          <div class="rationale">
            <span class="label">Racional da triagem:</span> ${htmlEscape(assessment?.rationale ?? "Sem racional registrado na triagem.")}
          </div>
          <table>
            <thead>
              <tr>
                <th class="col-idx">#</th>
                <th class="col-time">Data/Hora</th>
                <th class="col-sender">Remetente</th>
                <th class="col-direction">Dir.</th>
                <th>Conteudo da mensagem</th>
              </tr>
            </thead>
            <tbody>
              ${rows.join("\n")}
            </tbody>
          </table>
        </section>
      `);
    }

    const generatedAtIso = new Date().toISOString();
    const [leftLogo, rightLogo] = await Promise.all([
      tryLoadLogoDataUri("estado-mt.png"),
      tryLoadLogoDataUri("policia-civil-mt.png")
    ]);

    const html = buildPdfHtml({
      caseNumber: caseRow.caseNumber,
      caseTitle: caseRow.title,
      generatedAtIso,
      selectedCount: includedChatCount,
      messageCount: totalMessages,
      logos: { left: leftLogo, right: rightLogo },
      sectionsHtml: sections.length > 0
        ? sections.join("\n")
        : '<section class="meta"><p>Nenhuma mensagem relevante foi identificada para os chats selecionados.</p></section>',
      relevantOnly: Boolean(parsed.data.relevantOnly)
    });

    const pdfBytes = await renderHtmlToPdf({ html });
    const fileSha256 = createHash("sha256").update(pdfBytes).digest("hex");

    await addCustodyEvent({
      caseId: caseRow.id,
      actorId: auth.session.id,
      action: "INVESTIGATION_SELECTED_MESSAGES_PDF_EXPORTED",
      source: "api/investigation/selected-messages/pdf",
      details: {
        triageInsightId: triageInsight.id,
        extractionId: parsed.data.extractionId ?? null,
        evidenceId: evidenceId ?? null,
        selectedChatIds,
        selectedCount: includedChatCount,
        messageCount: totalMessages,
        relevantOnly: Boolean(parsed.data.relevantOnly),
        generatedAt: generatedAtIso,
        fileSha256
      }
    });

    const safeCaseLabel = `${caseRow.caseNumber}-${caseRow.title}`
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || caseRow.caseNumber;

    return new NextResponse(Buffer.from(pdfBytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeCaseLabel}-${parsed.data.relevantOnly ? "mensagens-relevantes" : "mensagens-selecionadas"}.pdf"`,
        "Cache-Control": "no-store",
        "X-CORE-Report-File-SHA256": fileSha256
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao gerar PDF das mensagens selecionadas." },
      { status: 500 }
    );
  }
}
