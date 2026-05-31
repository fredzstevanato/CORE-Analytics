import { NextResponse } from "next/server";
import { z } from "zod";
import { relinkAudioAttachmentsForEvidence } from "@core/cases";
import { prisma } from "@core/db";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  chatId: z.string().uuid()
});

export async function POST(request: Request) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;

    const payload = bodySchema.parse(await request.json());

    const chat = await prisma.chat.findUnique({
      where: { id: payload.chatId },
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        evidence: {
          select: {
            extraction: {
              select: { id: true }
            }
          }
        }
      }
    });

    if (!chat) {
      return NextResponse.json({ error: "Chat nao encontrado." }, { status: 404 });
    }

    const relink = await relinkAudioAttachmentsForEvidence({ evidenceId: chat.evidenceId });

    const [messageCount, attachmentCount, messagesWithAttachments, messagesWithCompletedTranscriptions, orphanCompletedTranscriptions] =
      await Promise.all([
        prisma.message.count({ where: { chatId: chat.id } }),
        prisma.attachment.count({ where: { message: { chatId: chat.id } } }),
        prisma.message.count({ where: { chatId: chat.id, attachments: { some: {} } } }),
        prisma.message.count({
          where: {
            chatId: chat.id,
            attachments: { some: { transcriptions: { some: { status: "COMPLETED" } } } }
          }
        }),
        prisma.audioTranscription.count({
          where: {
            evidenceId: chat.evidenceId,
            status: "COMPLETED",
            attachment: { messageId: null }
          }
        })
      ]);

    return NextResponse.json({
      ok: true,
      chatId: chat.id,
      relink,
      updated: {
        messagesUpdated: 0,
        transcriptionsInjected: 0,
        attachmentsWithTranscription: 0
      },
      queued: {
        queuedMissingTranscriptions: 0,
        queuedForSelectedChat: 0,
        unresolvedAudioPaths: 0
      },
      stats: {
        messages: messageCount,
        attachments: attachmentCount,
        messagesWithAttachments,
        messagesWithCompletedTranscriptions,
        orphanCompletedTranscriptions
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao atualizar mensagens com transcricoes."
      },
      { status: 500 }
    );
  }
}
