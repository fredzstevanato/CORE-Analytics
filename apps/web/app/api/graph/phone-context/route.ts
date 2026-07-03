import { NextResponse } from "next/server";
import { prisma } from "@core/db";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

const querySchema = z.object({
  caseId: z.string().uuid(),
  phone: z.string().min(8).max(20)
});

const PHONE_RE = /(?:[+]?[0-9][0-9\s().-]{6,}[0-9])/g;

function normalizePhone(raw: string) {
  const digits = raw.replace(/[^0-9]+/g, "").trim();
  if (digits.length < 8 || digits.length > 16) return null;
  if (digits.startsWith("00") && digits.length > 2) return digits.slice(2);
  return digits;
}

function textContainsPhone(text: string | null | undefined, targetPhone: string) {
  if (!text) return false;
  const matches = text.match(PHONE_RE) ?? [];
  for (const candidate of matches) {
    if (normalizePhone(candidate) === targetPhone) return true;
  }
  return false;
}

export async function GET(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      caseId: url.searchParams.get("caseId") ?? "",
      phone: url.searchParams.get("phone") ?? ""
    });

    if (!parsed.success) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    const normalizedPhone = normalizePhone(parsed.data.phone);
    if (!normalizedPhone) {
      return NextResponse.json({ error: "Telefone invalido para correlacao." }, { status: 400 });
    }

    const phoneSuffix = normalizedPhone.slice(-8);

    const chats = await prisma.chat.findMany({
      where: {
        caseId: parsed.data.caseId,
        OR: [
          { participants: { some: { phone: { contains: phoneSuffix } } } },
          { participants: { some: { handle: { contains: phoneSuffix } } } },
          { messages: { some: { senderId: { contains: phoneSuffix } } } },
          { messages: { some: { body: { contains: phoneSuffix } } } }
        ]
      },
      select: {
        id: true,
        title: true,
        sourceApp: true,
        participants: {
          select: {
            id: true,
            name: true,
            handle: true,
            phone: true
          }
        },
        messages: {
          orderBy: [{ timestamp: "asc" }, { createdAt: "asc" }],
          take: 60,
          select: {
            id: true,
            senderId: true,
            body: true,
            timestamp: true,
            attachments: {
              select: {
                id: true,
                transcriptions: {
                  where: { status: "COMPLETED" },
                  select: { text: true },
                  orderBy: { createdAt: "desc" },
                  take: 2
                }
              }
            }
          }
        }
      },
      take: 120
    });

    const relatedChats = chats
      .map((chat) => {
        const participantMatch = chat.participants.some(
          (participant) =>
            normalizePhone(participant.phone ?? "") === normalizedPhone ||
            normalizePhone(participant.handle ?? "") === normalizedPhone
        );

        const messageMatches = chat.messages.filter((message) => {
          const senderMatch = normalizePhone(message.senderId ?? "") === normalizedPhone;
          const bodyMatch = textContainsPhone(message.body, normalizedPhone);
          const transcriptionMatch = message.attachments.some((attachment) =>
            attachment.transcriptions.some((transcription) => textContainsPhone(transcription.text, normalizedPhone))
          );
          return senderMatch || bodyMatch || transcriptionMatch;
        });

        if (!participantMatch && messageMatches.length === 0) return null;

        return {
          chatId: chat.id,
          label: chat.title ?? `Chat ${chat.id.slice(0, 8)}`,
          sourceApp: chat.sourceApp ?? "origem-indefinida",
          participantMatch,
          participants: chat.participants,
          messages: messageMatches.map((message) => ({
            id: message.id,
            senderId: message.senderId,
            body: message.body,
            timestamp: message.timestamp?.toISOString() ?? null,
            transcriptions: message.attachments.flatMap((attachment) =>
              attachment.transcriptions
                .map((transcription) => transcription.text)
                .filter((text): text is string => Boolean(text && text.trim().length > 0))
            )
          }))
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    return NextResponse.json({
      caseId: parsed.data.caseId,
      phone: normalizedPhone,
      chats: relatedChats
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao carregar chats relacionados ao telefone." },
      { status: 500 }
    );
  }
}
