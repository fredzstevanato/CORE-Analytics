import { NextResponse } from "next/server";
import { prisma } from "@core/db";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

const querySchema = z.object({
  caseId: z.string().uuid(),
  groupId: z.string().min(8).max(128)
});

export async function GET(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      caseId: url.searchParams.get("caseId") ?? "",
      groupId: url.searchParams.get("groupId") ?? ""
    });

    if (!parsed.success) {
      return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
    }

    const chat = await prisma.chat.findFirst({
      where: {
        id: parsed.data.groupId,
        caseId: parsed.data.caseId
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
          take: 180,
          select: {
            id: true,
            senderId: true,
            body: true,
            timestamp: true,
            attachments: {
              select: {
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
      }
    });

    if (!chat) {
      return NextResponse.json({ error: "Grupo nao encontrado." }, { status: 404 });
    }

    return NextResponse.json({
      caseId: parsed.data.caseId,
      group: {
        id: chat.id,
        label: chat.title?.trim() || `Grupo ${chat.id.slice(0, 8)}`,
        sourceApp: chat.sourceApp ?? "origem-indefinida",
        participants: chat.participants,
        messages: chat.messages.map((message) => ({
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
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao carregar contexto do grupo." },
      { status: 500 }
    );
  }
}
