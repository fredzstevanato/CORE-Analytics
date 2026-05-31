import { prisma, Prisma } from "@core/db";

type ConsolidatedCaseReportInput = {
  caseId: string;
  extractionId?: string;
  title?: string;
};

export type FinalReportReadiness = {
  ready: boolean;
  issues: string[];
  checks: {
    hasInquiryType: boolean;
    hasInquiryNumber: boolean;
    hasPoliceUnit: boolean;
    evidenceCount: number;
    custodyEventsCount: number;
    custodyEventsWithHashCount: number;
    expertReportCount: number;
    messageCount: number;
    aiInsightCount: number;
  };
};

function jsonArrayToLines(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function line(value?: string | null) {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return clean || "N/D";
}

function formatSection(title: string, items: string[]) {
  return [`## ${title}`, ...items.map((item) => `- ${item}`), ""].join("\n");
}

function normalize(value: string) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function truncate(value: string, max = 320) {
  const clean = (value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}...`;
}

function parseJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tokenizeTerms(value: string) {
  const normalized = normalize(value);
  const tokens = normalized.match(/[a-z0-9]{4,}/g) ?? [];
  return [...new Set(tokens)];
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

type TriageAssessmentLite = {
  chatId: string;
  relevanceLevel: string;
  relevanceScore: number;
  rationale: string;
  excerpt: string;
  matchedTerms: string[];
};

function parseTriageAssessments(metadata: Prisma.JsonValue | null | undefined): TriageAssessmentLite[] {
  const metadataRecord = parseJsonObject(metadata);
  const assessmentsRaw = metadataRecord?.assessments;
  if (!Array.isArray(assessmentsRaw)) return [];

  const rows: TriageAssessmentLite[] = [];
  for (const row of assessmentsRaw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const obj = row as Record<string, unknown>;
    const chatId = typeof obj.chatId === "string" ? obj.chatId : "";
    if (!chatId) continue;
    rows.push({
      chatId,
      relevanceLevel: typeof obj.relevanceLevel === "string" ? obj.relevanceLevel : "baixa",
      relevanceScore: typeof obj.relevanceScore === "number" ? obj.relevanceScore : 0,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "Sem racional informado.",
      excerpt: typeof obj.excerpt === "string" ? obj.excerpt : "",
      matchedTerms: parseStringArray(obj.matchedTerms)
    });
  }
  return rows;
}

function parseSelectedChatIdsFromMetadata(metadata: Prisma.JsonValue | null | undefined): string[] {
  const metadataRecord = parseJsonObject(metadata);
  return parseStringArray(metadataRecord?.selectedChatIds);
}

function buildChatTopicSection(input: {
  selectedChatIds: string[];
  selectedChats: Array<{
    id: string;
    sourceApp: string | null;
    title: string | null;
    participants: Array<{ name: string | null; handle: string | null; phone: string | null; email: string | null }>;
    messages: Array<{ senderId: string | null; body: string | null; timestamp: Date | null }>;
  }>;
  triageByChatId: Map<string, TriageAssessmentLite>;
}) {
  const lines: string[] = ["## Mensagens Selecionadas", ""];
  if (input.selectedChats.length === 0 && input.selectedChatIds.length === 0) {
    lines.push("- Nenhum chat selecionado encontrado na triagem investigativa.", "");
    return lines.join("\n");
  }

  if (input.selectedChats.length === 0 && input.selectedChatIds.length > 0) {
    for (const [index, chatId] of input.selectedChatIds.entries()) {
      const triage = input.triageByChatId.get(chatId);
      lines.push(`### Topico ${index + 1}`);
      lines.push(`- Identificacao do chat: ${chatId}`);
      lines.push("- Interlocutores: N/D (chat nao disponivel no banco no momento da consolidacao)");
      lines.push(`- Contexto geral do chat: ${triage?.rationale ?? "Sem racional de triagem disponivel."}`);
      lines.push(
        `- Textos relevantes do jeito que estao no chat: ${triage?.excerpt ? truncate(triage.excerpt, 380) : "Sem excerpt registrado na triagem."}`
      );
      lines.push(
        `- Conclusao: relevancia ${String(triage?.relevanceLevel ?? "nao-classificada").toUpperCase()}${typeof triage?.relevanceScore === "number" ? ` (score ${triage.relevanceScore})` : ""}.`
      );
      lines.push("");
    }
    return lines.join("\n");
  }

  for (const [index, chat] of input.selectedChats.entries()) {
    const triage = input.triageByChatId.get(chat.id);
    const participantNames = [...new Set(
      chat.participants
        .map((participant) => [participant.name, participant.handle, participant.phone, participant.email].find((value) => Boolean(value?.trim())) ?? null)
        .filter((value): value is string => Boolean(value))
    )];

    const terms = new Set([
      ...tokenizeTerms(triage?.excerpt ?? ""),
      ...(triage?.matchedTerms ?? []).map((term) => normalize(term))
    ]);

    const rankedMessages = chat.messages
      .map((message) => {
        const text = (message.body ?? "").trim();
        if (!text) return null;
        const normalizedText = normalize(text);
        let score = 0;
        for (const term of terms) {
          if (term && normalizedText.includes(term)) score += 2;
        }
        if (text.length > 80) score += 1;
        if (text.length > 180) score += 1;
        return {
          score,
          sender: (message.senderId ?? "interlocutor").trim() || "interlocutor",
          timestamp: message.timestamp,
          text: truncate(text, 380)
        };
      })
      .filter((row): row is { score: number; sender: string; timestamp: Date | null; text: string } => Boolean(row))
      .sort((a, b) => b.score - a.score || (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));

    const selectedTexts = rankedMessages.slice(0, 5);

    lines.push(`### Topico ${index + 1}`);
    lines.push(`- Identificacao do chat: ${chat.title ?? chat.id} (${chat.id})`);
    lines.push(`- Interlocutores: ${participantNames.length > 0 ? participantNames.join(" | ") : "N/D"}`);
    lines.push(
      `- Contexto geral do chat: ${triage?.rationale ?? `Conversa originada em ${chat.sourceApp ?? "origem nao identificada"}, com ${chat.messages.length} mensagens registradas.`}`
    );

    if (selectedTexts.length > 0) {
      lines.push("- Textos relevantes do jeito que estao no chat:");
      for (const [messageIndex, message] of selectedTexts.entries()) {
        const when = message.timestamp ? message.timestamp.toISOString() : "sem-horario";
        lines.push(`  ${messageIndex + 1}. [${when}] ${message.sender}: ${message.text}`);
      }
    } else {
      lines.push("- Textos relevantes do jeito que estao no chat: sem mensagens textuais disponiveis.");
    }

    lines.push(
      `- Conclusao: relevancia ${String(triage?.relevanceLevel ?? "nao-classificada").toUpperCase()}${typeof triage?.relevanceScore === "number" ? ` (score ${triage.relevanceScore})` : ""}. ${triage?.excerpt ? `Trecho-chave: ${truncate(triage.excerpt, 220)}` : ""}`.trim()
    );
    lines.push("");
  }

  return lines.join("\n");
}

export async function buildConsolidatedCaseReport(input: ConsolidatedCaseReportInput) {
  const scopedExtraction = input.extractionId
    ? await prisma.extraction.findFirst({
        where: { id: input.extractionId, caseId: input.caseId },
        select: { id: true, evidenceId: true }
      })
    : null;

  if (input.extractionId && !scopedExtraction) {
    throw new Error("Extracao nao encontrada para o caso informado.");
  }

  const scopedEvidenceId = scopedExtraction?.evidenceId;
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    include: {
      evidences: {
        ...(scopedEvidenceId ? { where: { id: scopedEvidenceId } } : {}),
        include: {
          extraction: {
            include: {
              devices: true
            }
          }
        }
      },
      expertReports: {
        include: {
          seizedObjects: true
        }
      },
      seizedObjects: true
    }
  });

  if (!caseRow) {
    throw new Error("Caso nao encontrado.");
  }

  const [
    messagesCount,
    transcriptionsCount,
    timelineEvents,
    locationArtifacts,
    custodyEvents,
    aiInsights,
    deviceMatches,
    generatedReports,
    socialAccountArtifacts,
    latestTriageInsight,
    latestInvestigationReportInsight
  ] = await Promise.all([
    prisma.message.count({
      where: { caseId: input.caseId, ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) }
    }),
    prisma.audioTranscription.count({
      where: { caseId: input.caseId, ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) }
    }),
    prisma.timelineEvent.findMany({
      where: { caseId: input.caseId, ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 20
    }),
    prisma.artifact.findMany({
      where: { caseId: input.caseId, type: "LOCATION", ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 20
    }),
    prisma.custodyEvent.findMany({
      where: { caseId: input.caseId, ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { actor: true, evidence: true }
    }),
    prisma.aiInsight.findMany({
      where: { caseId: input.caseId, ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) },
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      take: 20
    }),
    prisma.deviceMatch.findMany({
      where: { caseId: input.caseId },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: {
        device: true,
        seizedObject: true,
        expertReport: true
      }
    }),
    prisma.generatedReport.findMany({
      where: { caseId: input.caseId, ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 20
    }),
    prisma.artifact.findMany({
      where: {
        caseId: input.caseId,
        ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}),
        type: "ENTITY",
        metadata: { path: ["source"], equals: "ufdr-user-account" }
      },
      orderBy: { createdAt: "desc" },
      take: 40
    }),
    prisma.aiInsight.findFirst({
      where: { caseId: input.caseId, type: "INVESTIGATION_TRIAGE", ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) },
      orderBy: { createdAt: "desc" }
    }),
    prisma.aiInsight.findFirst({
      where: { caseId: input.caseId, type: "INVESTIGATION_REPORT", ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}) },
      orderBy: { createdAt: "desc" }
    })
  ]);

  const title = input.title?.trim() || `Relatorio Consolidado - ${caseRow.caseNumber}`;
  const involvedPeople = jsonArrayToLines(caseRow.inquiryInvolvedPeople as Prisma.JsonValue | null | undefined);

  const selectedChatIdsFromReports = (() => {
    for (const report of generatedReports) {
      const metadataRecord = parseJsonObject(report.metadata);
      if (!metadataRecord || metadataRecord.module !== "investigation") continue;
      const selected = parseSelectedChatIdsFromMetadata(report.metadata);
      if (selected.length > 0) return selected;
    }
    return [] as string[];
  })();

  const selectedChatIdsFromLatestInvestigationInsight = parseSelectedChatIdsFromMetadata(
    latestInvestigationReportInsight?.metadata ?? null
  );
  const selectedChatIdsFromLatestTriageInsight = parseSelectedChatIdsFromMetadata(latestTriageInsight?.metadata ?? null);

  const triageAssessments = parseTriageAssessments(latestTriageInsight?.metadata ?? null);
  const triageByChatId = new Map(triageAssessments.map((assessment) => [assessment.chatId, assessment]));

  const selectedChatIds =
    selectedChatIdsFromLatestTriageInsight.length > 0
      ? selectedChatIdsFromLatestTriageInsight
      : selectedChatIdsFromLatestInvestigationInsight.length > 0
      ? selectedChatIdsFromLatestInvestigationInsight
      : selectedChatIdsFromReports.length > 0
        ? selectedChatIdsFromReports
      : triageAssessments
          .filter((item) => item.relevanceLevel === "alta" || item.relevanceLevel === "media")
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, 10)
          .map((item) => item.chatId);

  const selectedChats =
    selectedChatIds.length > 0
      ? await prisma.chat.findMany({
          where: {
            caseId: input.caseId,
            ...(scopedEvidenceId ? { evidenceId: scopedEvidenceId } : {}),
            id: { in: selectedChatIds }
          },
          include: {
            participants: {
              select: {
                name: true,
                handle: true,
                phone: true,
                email: true
              }
            },
            messages: {
              orderBy: [{ timestamp: "asc" }, { createdAt: "asc" }],
              select: {
                senderId: true,
                body: true,
                timestamp: true
              },
              take: 120
            }
          }
        })
      : [];

  const orderedSelectedChats = selectedChatIds
    .map((chatId) => selectedChats.find((chat) => chat.id === chatId))
    .filter((chat): chat is (typeof selectedChats)[number] => Boolean(chat));

  const totalDevices = caseRow.evidences.reduce((acc, evidence) => acc + (evidence.extraction?.devices.length ?? 0), 0);
  const custodyHashesCount = custodyEvents.filter((event) => Boolean(event.currentHash)).length;

  const extractionDetails = caseRow.evidences.length
    ? caseRow.evidences.map((evidence) => {
        const extraction = evidence.extraction;
        const deviceSummary = extraction?.devices.length
          ? extraction.devices
              .map((device) => [device.manufacturer, device.model, device.imei, device.serialNumber].filter(Boolean).join(" / "))
              .filter((item) => item.length > 0)
              .slice(0, 4)
              .join(" ; ")
          : "sem aparelhos vinculados";
        return `Evidencia ${evidence.fileName} | sha256=${evidence.sha256} | extracao=${extraction?.status ?? "N/D"} | aparelhos=${deviceSummary}`;
      })
    : ["Nenhuma evidencia cadastrada."];

  const simplifiedSocialAccounts =
    socialAccountArtifacts.length > 0
      ? socialAccountArtifacts.map((artifact) => {
          const metadata = parseJsonObject(artifact.metadata);
          const service = line(typeof metadata?.serviceType === "string" ? metadata.serviceType : null);
          const username = line(typeof metadata?.username === "string" ? metadata.username : null);
          const accountName = line(typeof metadata?.name === "string" ? metadata.name : null);
          const identifier = line(typeof metadata?.serviceIdentifier === "string" ? metadata.serviceIdentifier : null);
          return `${service} | usuario=${username} | nome=${accountName} | identificador=${identifier}`;
        })
      : ["Nenhuma conta de rede social extraida."];

  const locationLines =
    locationArtifacts.length > 0
      ? locationArtifacts.map((artifact) => {
          const metadata = (artifact.metadata ?? {}) as Record<string, unknown>;
          const lat = String(metadata.latitude ?? metadata.lat ?? "N/D");
          const lng = String(metadata.longitude ?? metadata.lng ?? "N/D");
          return `${artifact.occurredAt?.toISOString() ?? artifact.createdAt.toISOString()} | ${artifact.title ?? "Localizacao"} | lat=${lat} | lng=${lng}`;
        })
      : ["Nenhuma localizacao encontrada."];

  const sections = [
    formatSection("Dados do Inquerito", [
      `Numero do caso: ${caseRow.caseNumber}`,
      `Titulo: ${caseRow.title}`,
      `Tipo de inquerito: ${line(caseRow.inquiryType)}`,
      `Numero do inquerito: ${line(caseRow.inquiryNumber)}`,
      `Unidade policial: ${line(caseRow.policeUnit)}`,
      `Tipificacao: ${line(caseRow.inquiryLegalFraming)}`,
      `Resumo: ${line(caseRow.inquirySummaryText)}`,
      `Fatos principais: ${line(caseRow.inquiryMainFacts)}`,
      `Foco investigativo: ${line(caseRow.inquiryInvestigativeFocus)}`,
      `Envolvidos: ${involvedPeople.length > 0 ? involvedPeople.join(" | ") : "N/D"}`
    ]),
    formatSection("Informacoes sobre Extracao Analisada", [
      `Total de evidencias: ${caseRow.evidences.length}`,
      `Total de aparelhos detectados: ${totalDevices}`,
      `Mensagens processadas: ${messagesCount}`,
      `Transcricoes processadas: ${transcriptionsCount}`,
      `Eventos de custodia com hash: ${custodyHashesCount}`,
      ...extractionDetails
    ]),
    formatSection("Contas das Redes Sociais (Leitura Simplificada)", simplifiedSocialAccounts),
    formatSection("Localizacoes Encontradas", locationLines),
    formatSection("Vinculacao Caso-Evidencias-Analises", [
      `CaseId: ${caseRow.id}`,
      `Evidencias vinculadas (${caseRow.evidences.length}): ${
        caseRow.evidences.length > 0 ? caseRow.evidences.map((evidence) => evidence.id).join(" | ") : "N/D"
      }`,
      `Analise de triagem vinculada: ${latestTriageInsight?.id ?? "N/D"}`,
      `Relatorios de analise vinculados: ${
        generatedReports.filter((report) => parseJsonObject(report.metadata)?.module === "investigation").length > 0
          ? generatedReports
              .filter((report) => parseJsonObject(report.metadata)?.module === "investigation")
              .map((report) => report.id)
              .join(" | ")
          : "N/D"
      }`,
      `Chats selecionados na analise: ${selectedChatIds.length > 0 ? selectedChatIds.join(" | ") : "N/D"}`
    ]),
    buildChatTopicSection({
      selectedChatIds,
      selectedChats: orderedSelectedChats,
      triageByChatId
    }),
    formatSection("Conclusao Geral", [
      `Foram consolidados ${orderedSelectedChats.length} chats selecionados para suporte investigativo.`,
      `A base contem ${messagesCount} mensagens e ${transcriptionsCount} transcricoes vinculadas ao caso.`,
      `Ha ${caseRow.evidences.length} evidencias e ${custodyHashesCount} registros de custodia com hash, preservando rastreabilidade.`,
      `Recomenda-se validacao final pelo analista responsavel antes da emissao do PDF final aprovado.`
    ])
  ];

  const content = [`# ${title}`, "", ...sections].join("\n");

  const linkedInvestigationReports = generatedReports
    .filter((report) => parseJsonObject(report.metadata)?.module === "investigation")
    .map((report) => report.id);
  const linkedEvidenceIds = caseRow.evidences.map((evidence) => evidence.id);
  const primaryEvidenceId =
    latestTriageInsight?.evidenceId ??
    scopedEvidenceId ??
    linkedEvidenceIds[0] ??
    null;

  return {
    title,
    content,
    primaryEvidenceId,
    linkage: {
      caseId: caseRow.id,
      extractionId: scopedExtraction?.id ?? null,
      evidenceIds: linkedEvidenceIds,
      analysis: {
        triageInsightId: latestTriageInsight?.id ?? null,
        triageEvidenceId: latestTriageInsight?.evidenceId ?? null,
        investigationReportIds: linkedInvestigationReports,
        selectedChatIds
      }
    } as Prisma.InputJsonValue,
    snapshot: {
      caseId: caseRow.id,
      extractionId: scopedExtraction?.id ?? null,
      evidenceCount: caseRow.evidences.length,
      deviceMatchCount: deviceMatches.length,
      expertReportCount: caseRow.expertReports.length,
      seizedObjectCount: caseRow.seizedObjects.length,
      timelineCount: timelineEvents.length,
      locationCount: locationArtifacts.length,
      aiInsightCount: aiInsights.length
    } as Prisma.InputJsonValue
  };
}

export async function assessCaseFinalReportReadiness(caseId: string): Promise<FinalReportReadiness> {
  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    select: {
      inquiryType: true,
      inquiryNumber: true,
      policeUnit: true
    }
  });

  if (!caseRow) {
    return {
      ready: false,
      issues: ["Caso nao encontrado."],
      checks: {
        hasInquiryType: false,
        hasInquiryNumber: false,
        hasPoliceUnit: false,
        evidenceCount: 0,
        custodyEventsCount: 0,
        custodyEventsWithHashCount: 0,
        expertReportCount: 0,
        messageCount: 0,
        aiInsightCount: 0
      }
    };
  }

  const [evidenceCount, custodyEventsCount, custodyEventsWithHashCount, expertReportCount, messageCount, aiInsightCount] = await Promise.all([
    prisma.evidence.count({ where: { caseId } }),
    prisma.custodyEvent.count({ where: { caseId } }),
    prisma.custodyEvent.count({
      where: {
        caseId,
        currentHash: { not: null }
      }
    }),
    prisma.expertReport.count({ where: { caseId } }),
    prisma.message.count({ where: { caseId } }),
    prisma.aiInsight.count({ where: { caseId } })
  ]);

  const hasInquiryType = Boolean((caseRow.inquiryType ?? "").trim());
  const hasInquiryNumber = Boolean((caseRow.inquiryNumber ?? "").trim());
  const hasPoliceUnit = Boolean((caseRow.policeUnit ?? "").trim());

  const issues: string[] = [];
  if (!hasInquiryType) issues.push("Campo obrigatorio ausente: tipo de inquerito.");
  if (!hasInquiryNumber) issues.push("Campo obrigatorio ausente: numero do inquerito.");
  if (!hasPoliceUnit) issues.push("Campo obrigatorio ausente: unidade policial.");
  if (evidenceCount < 1) issues.push("Nenhuma evidencia cadastrada para emissao final.");
  if (custodyEventsCount < 1) issues.push("Nenhum evento de cadeia de custodia registrado.");
  if (custodyEventsWithHashCount < 1) issues.push("Nao ha eventos de custodia com hash corrente registrado.");
  if (messageCount < 1 && aiInsightCount < 1) {
    issues.push("Nao ha mensagens processadas nem insights de IA para consolidacao investigativa.");
  }

  return {
    ready: issues.length === 0,
    issues,
    checks: {
      hasInquiryType,
      hasInquiryNumber,
      hasPoliceUnit,
      evidenceCount,
      custodyEventsCount,
      custodyEventsWithHashCount,
      expertReportCount,
      messageCount,
      aiInsightCount
    }
  };
}
