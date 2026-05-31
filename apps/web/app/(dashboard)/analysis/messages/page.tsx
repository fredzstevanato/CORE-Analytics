import Link from "next/link";
import { listCases } from "@core/cases";
import { Prisma, prisma } from "@core/db";
import { AnalysisSubnav } from "@/components/analysis-subnav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  detectChatPlatform,
  getPlatformBadgeClass,
  getPlatformLabel
} from "@/lib/chat-source-theme";
import { resolveMessageBodyForDisplay, resolveSenderPresentation } from "@/lib/message-presenter";
import { MessageAttachmentGallery } from "@/components/message-attachment-gallery";

export const dynamic = "force-dynamic";

type PlatformFilter = "all" | "whatsapp" | "instagram" | "facebook" | "other";

function parsePlatform(value: string | undefined): PlatformFilter {
  if (value === "whatsapp" || value === "instagram" || value === "facebook" || value === "other") return value;
  return "all";
}

function appWhere(platform: PlatformFilter): Prisma.ChatWhereInput {
  if (platform === "whatsapp") {
    return { sourceApp: { contains: "whatsapp", mode: "insensitive" } };
  }
  if (platform === "instagram") {
    return { sourceApp: { contains: "instagram", mode: "insensitive" } };
  }
  if (platform === "facebook") {
    return {
      OR: [
        { sourceApp: { contains: "facebook", mode: "insensitive" } },
        { sourceApp: { contains: "messenger", mode: "insensitive" } }
      ]
    };
  }
  if (platform === "other") {
    return {
      NOT: {
        OR: [
          { sourceApp: { contains: "whatsapp", mode: "insensitive" } },
          { sourceApp: { contains: "instagram", mode: "insensitive" } },
          { sourceApp: { contains: "facebook", mode: "insensitive" } },
          { sourceApp: { contains: "messenger", mode: "insensitive" } }
        ]
      }
    };
  }
  return {};
}

function searchWhere(query: string | undefined): Prisma.ChatWhereInput {
  const q = (query ?? "").trim();
  if (!q) return {};
  return {
    OR: [
      { title: { contains: q, mode: "insensitive" } },
      { participants: { some: { name: { contains: q, mode: "insensitive" } } } },
      { participants: { some: { handle: { contains: q, mode: "insensitive" } } } },
      { participants: { some: { phone: { contains: q, mode: "insensitive" } } } },
      { participants: { some: { email: { contains: q, mode: "insensitive" } } } },
      { messages: { some: { body: { contains: q, mode: "insensitive" } } } }
    ]
  };
}

function firstParticipantName(chat: {
  participants: Array<{ name: string | null; handle: string | null; phone: string | null; email: string | null }>;
}) {
  const named = chat.participants.find((p) => p.name || p.handle || p.phone || p.email);
  return named?.name ?? named?.handle ?? named?.phone ?? named?.email ?? "Interlocutor";
}

function panelHeaderClass(platform: ReturnType<typeof detectChatPlatform>) {
  if (platform === "whatsapp") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (platform === "instagram") return "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-900";
  if (platform === "facebook") return "border-blue-200 bg-blue-50 text-blue-900";
  return "border-zinc-200 bg-zinc-100 text-zinc-900";
}

function outgoingBubbleClass(platform: ReturnType<typeof detectChatPlatform>) {
  if (platform === "whatsapp") return "border border-emerald-200 bg-emerald-100 text-emerald-950";
  if (platform === "instagram") return "border border-fuchsia-200 bg-fuchsia-100 text-fuchsia-950";
  if (platform === "facebook") return "border border-blue-200 bg-blue-100 text-blue-950";
  return "border border-zinc-300 bg-zinc-200 text-zinc-900";
}

function incomingBubbleClass(platform: ReturnType<typeof detectChatPlatform>) {
  if (platform === "whatsapp") return "border border-zinc-200 bg-white text-zinc-900";
  if (platform === "instagram") return "border border-zinc-200 bg-white text-zinc-900";
  if (platform === "facebook") return "border border-zinc-200 bg-white text-zinc-900";
  return "border border-zinc-200 bg-white text-zinc-900";
}

export default async function AnalysisMessagesPage({
  searchParams
}: {
  searchParams: Promise<{ platform?: string; q?: string; chatId?: string; caseId?: string; extractionId?: string }>;
}) {
  const params = await searchParams;
  const platform = parsePlatform(params.platform);
  const q = (params.q ?? "").trim();
  const selectedChatId = params.chatId;
  const caseId = params.caseId?.trim() || undefined;
  const extractionId = params.extractionId?.trim() || undefined;
  const cases = await listCases();
  const extractions = await prisma.extraction.findMany({
    where: caseId ? { caseId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      caseId: true,
      evidenceId: true,
      evidence: {
        select: {
          fileName: true
        }
      }
    }
  });
  const selectedExtraction = extractionId ? extractions.find((row) => row.id === extractionId) : null;
  const selectedEvidenceId = selectedExtraction?.evidenceId;
  const scopeFilter: Prisma.ChatWhereInput = {
    ...(caseId ? { caseId } : {}),
    ...(selectedEvidenceId ? { evidenceId: selectedEvidenceId } : {})
  };

  const where: Prisma.ChatWhereInput = {
    AND: [appWhere(platform), searchWhere(q), scopeFilter]
  };

  const [counts, chats] = await Promise.all([
    Promise.all([
      prisma.chat.count({ where: scopeFilter }),
      prisma.chat.count({ where: { AND: [appWhere("whatsapp"), scopeFilter] } }),
      prisma.chat.count({ where: { AND: [appWhere("instagram"), scopeFilter] } }),
      prisma.chat.count({ where: { AND: [appWhere("facebook"), scopeFilter] } }),
      prisma.chat.count({ where: { AND: [appWhere("other"), scopeFilter] } })
    ]),
    prisma.chat.findMany({
      where,
      take: 250,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        sourceApp: true,
        caseId: true,
        participants: {
          take: 3,
          select: { name: true, handle: true, phone: true, email: true, metadata: true }
        },
        messages: {
          take: 1,
          orderBy: [{ timestamp: "desc" }, { createdAt: "desc" }],
          select: { body: true, timestamp: true }
        },
        _count: { select: { messages: true } }
      }
    })
  ]);

  const [countAll, countWhatsApp, countInstagram, countFacebook, countOther] = counts;
  const activeChatId = selectedChatId && chats.some((c) => c.id === selectedChatId) ? selectedChatId : chats[0]?.id;

  const activeChat = activeChatId
    ? await prisma.chat.findUnique({
        where: { id: activeChatId },
        include: {
          participants: {
            select: { id: true, name: true, handle: true, phone: true, email: true, metadata: true }
          },
          messages: {
            take: 800,
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
            }
          }
        }
      })
    : null;

  const messageScopeWhere: Prisma.MessageWhereInput = {
    chat: { is: where }
  };
  const attachmentScopeWhere: Prisma.AttachmentWhereInput = {
    message: { is: messageScopeWhere }
  };
  const transcriptionScopeWhere: Prisma.AudioTranscriptionWhereInput = {
    status: "COMPLETED",
    attachment: {
      message: { is: messageScopeWhere }
    }
  };

  const [filterMessages, filterAttachments, filterMessagesWithAttachments, filterMessagesWithTranscriptions, filterTranscriptions] =
    await Promise.all([
      prisma.message.count({ where: messageScopeWhere }),
      prisma.attachment.count({ where: attachmentScopeWhere }),
      prisma.message.count({ where: { ...messageScopeWhere, attachments: { some: {} } } }),
      prisma.message.count({
        where: {
          ...messageScopeWhere,
          attachments: { some: { transcriptions: { some: { status: "COMPLETED" } } } }
        }
      }),
      prisma.audioTranscription.count({ where: transcriptionScopeWhere })
    ]);

  const filterDashboard = {
    messages: filterMessages,
    attachments: filterAttachments,
    messagesWithAttachments: filterMessagesWithAttachments,
    messagesWithTranscriptions: filterMessagesWithTranscriptions,
    transcriptionCount: filterTranscriptions
  };

  const appTabs: Array<{ id: PlatformFilter; label: string; count: number }> = [
    { id: "all", label: "Todos", count: countAll },
    { id: "whatsapp", label: "WhatsApp", count: countWhatsApp },
    { id: "instagram", label: "Instagram", count: countInstagram },
    { id: "facebook", label: "Facebook", count: countFacebook },
    { id: "other", label: "Outros", count: countOther }
  ];

  const currentPlatform = detectChatPlatform(activeChat?.sourceApp);
  const dashboard = activeChat
    ? (() => {
        const messages = activeChat.messages.length;
        const attachments = activeChat.messages.reduce((sum, message) => sum + message.attachments.length, 0);
        const messagesWithTranscriptions = activeChat.messages.filter((message) =>
          message.attachments.some((attachment) => attachment.transcriptions.length > 0)
        ).length;
        const messagesWithAttachments = activeChat.messages.filter((message) => message.attachments.length > 0).length;
        const transcriptionCount = activeChat.messages.reduce(
          (sum, message) =>
            sum + message.attachments.reduce((inner, attachment) => inner + attachment.transcriptions.length, 0),
          0
        );
        return {
          messages,
          attachments,
          messagesWithTranscriptions,
          messagesWithAttachments,
          transcriptionCount
        };
      })()
    : null;

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Mensagens</h2>
      <AnalysisSubnav />
      <Card>
        <CardHeader>
          <CardTitle>Console de Conversas</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3">
            <p className="mb-1 text-xs font-medium text-zinc-600">Totais do filtro atual</p>
            <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
                <p className="text-[11px] text-zinc-500">Mensagens</p>
                <p className="text-lg font-semibold text-zinc-900">{filterDashboard.messages}</p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
                <p className="text-[11px] text-zinc-500">Anexos</p>
                <p className="text-lg font-semibold text-zinc-900">{filterDashboard.attachments}</p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
                <p className="text-[11px] text-zinc-500">Mensagens com anexos</p>
                <p className="text-lg font-semibold text-zinc-900">{filterDashboard.messagesWithAttachments}</p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
                <p className="text-[11px] text-zinc-500">Mensagens com transcricao</p>
                <p className="text-lg font-semibold text-zinc-900">{filterDashboard.messagesWithTranscriptions}</p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
                <p className="text-[11px] text-zinc-500">Transcricoes vinculadas</p>
                <p className="text-lg font-semibold text-zinc-900">{filterDashboard.transcriptionCount}</p>
              </div>
            </div>
          </div>
          {dashboard ? (
            <p className="mb-3 text-xs text-zinc-500">
              Chat selecionado: {dashboard.messages} mensagens, {dashboard.attachments} anexos, {dashboard.transcriptionCount} transcricoes vinculadas.
            </p>
          ) : null}
          <div className="grid min-h-[75vh] grid-cols-1 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 md:grid-cols-[72px_340px_1fr]">
            <aside className="border-r border-zinc-200 bg-zinc-100 p-2">
              <nav className="space-y-2">
                {appTabs.map((tab) => {
                  const href = `/analysis/messages?platform=${tab.id}${caseId ? `&caseId=${encodeURIComponent(caseId)}` : ""}${extractionId ? `&extractionId=${encodeURIComponent(extractionId)}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
                  const selected = platform === tab.id;
                  return (
                    <Link
                      key={tab.id}
                      href={href}
                      className={`block rounded-lg px-2 py-2 text-center text-xs transition ${
                        selected ? "bg-zinc-900 font-semibold text-zinc-100" : "bg-white text-zinc-700 hover:bg-zinc-50"
                      }`}
                    >
                      <p>{tab.label}</p>
                      <p className="text-[10px] opacity-80">{tab.count}</p>
                    </Link>
                  );
                })}
              </nav>
            </aside>

            <aside className="border-r border-zinc-200 bg-white">
              <div className="border-b border-zinc-200 p-3">
                <form method="GET" className="space-y-2">
                  <input type="hidden" name="platform" value={platform} />
                  <select
                    name="caseId"
                    defaultValue={caseId ?? ""}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                  >
                    <option value="">Todos os casos</option>
                    {cases.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.caseNumber} - {item.title}
                      </option>
                    ))}
                  </select>
                  <select
                    name="extractionId"
                    defaultValue={extractionId ?? ""}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                  >
                    <option value="">Todas as extrações</option>
                    {extractions
                      .filter((row) => !caseId || row.caseId === caseId)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.id} - {row.evidence.fileName}
                        </option>
                      ))}
                  </select>
                  <input
                    name="q"
                    defaultValue={q}
                    placeholder="Buscar interlocutor ou trecho da mensagem..."
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                  />
                  <Button type="submit" variant="outline" className="w-full">
                    Aplicar filtros
                  </Button>
                </form>
              </div>

              <div className="max-h-[calc(75vh-64px)] space-y-1 overflow-y-auto p-2">
                {chats.length === 0 ? <p className="p-2 text-sm text-zinc-500">Nenhum chat para este filtro.</p> : null}
                {chats.map((chat) => {
                  const isActive = chat.id === activeChatId;
                  const preview = resolveMessageBodyForDisplay(chat.messages[0]?.body, {
                    fallback: "(sem texto)",
                    singleLine: true,
                    maxLength: 180
                  });
                  const timestamp = chat.messages[0]?.timestamp;
                  const title = chat.title ?? firstParticipantName(chat);
                  const app = detectChatPlatform(chat.sourceApp);
                  return (
                    <Link
                      key={chat.id}
                      href={`/analysis/messages?platform=${platform}${caseId ? `&caseId=${encodeURIComponent(caseId)}` : ""}${extractionId ? `&extractionId=${encodeURIComponent(extractionId)}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}&chatId=${chat.id}`}
                      className={`block rounded-lg border px-3 py-2 ${
                        isActive ? "border-zinc-900 bg-zinc-100" : "border-zinc-200 bg-white hover:bg-zinc-50"
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold">{title}</p>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${getPlatformBadgeClass(app)}`}>
                          {getPlatformLabel(app)}
                        </span>
                      </div>
                      <p className="truncate text-xs text-zinc-600">{preview}</p>
                      <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
                        <span>{chat._count.messages} msgs</span>
                        <span>{timestamp ? new Date(timestamp).toLocaleString("pt-BR") : ""}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </aside>

            <main className="bg-zinc-50">
              {activeChat ? (
                <div className="flex h-full flex-col">
                  <header className={`border-b px-4 py-3 ${panelHeaderClass(currentPlatform)}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold">{activeChat.title ?? firstParticipantName(activeChat)}</p>
                        <p className="text-xs opacity-90">
                          {activeChat.participants.length} participantes | {activeChat.messages.length} mensagens carregadas
                        </p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className={`rounded border px-2 py-1 text-xs ${getPlatformBadgeClass(currentPlatform)}`}>
                          {getPlatformLabel(currentPlatform)}
                        </span>
                      </div>
                    </div>
                  </header>

                  <div className="flex-1 space-y-2 overflow-y-auto bg-zinc-50 p-4">
                    {activeChat.messages.map((message: any) => {
                      const outgoing = (message.direction ?? "").toUpperCase() === "OUTGOING";
                      const bubbleClass = outgoing ? outgoingBubbleClass(currentPlatform) : incomingBubbleClass(currentPlatform);
                      const sender = resolveSenderPresentation(message, activeChat.participants);
                      const messageAttachments = message.attachments ?? [];
                      const audioTranscription = message.attachments
                        .flatMap((attachment: any) =>
                          attachment.transcriptions.map((transcription: any) => transcription.text).filter(Boolean)
                        )
                        .find(Boolean);
                      const rawBody = message.body ?? "";
                      const bodyWithoutInjectedTranscription = audioTranscription
                        ? rawBody.replace(/\n?\[Transcricao de audio\]\n[\s\S]*$/i, "").trimEnd()
                        : rawBody;
                      const displayBody = resolveMessageBodyForDisplay(bodyWithoutInjectedTranscription, {
                        fallback: audioTranscription ? "" : "(mensagem sem texto)"
                      });
                      return (
                        <div key={message.id} className={`flex ${outgoing ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-[82%] rounded-2xl px-3 py-2 text-sm shadow ${bubbleClass}`}>
                            <p className="mb-1 text-[11px] font-medium opacity-80">{sender.name}</p>
                            {displayBody ? <p className="whitespace-pre-wrap break-words">{displayBody}</p> : null}
                            {messageAttachments.length > 0 ? <MessageAttachmentGallery attachments={messageAttachments} /> : null}
                            {audioTranscription ? (
                              <p className="mt-1 text-xs italic opacity-90">Transcricao: {audioTranscription}</p>
                            ) : null}
                            <p className="mt-1 text-[11px] opacity-70">
                              {message.timestamp ? new Date(message.timestamp).toLocaleString("pt-BR") : "Sem data"}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-zinc-400">
                  Nenhum chat selecionado. Ajuste os filtros na lateral.
                </div>
              )}
            </main>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
