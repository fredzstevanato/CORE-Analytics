import { prisma } from "@core/db";
import { getConsolidatedSyncConfig, listConsolidatedSyncPackages } from "@core/cases";
import { ensureRole, requireSession } from "@/lib/auth";
import { ConsolidatedSyncPanel } from "@/components/consolidated-sync-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function SyncSettingsPage() {
  const session = await requireSession();
  ensureRole(session.role, ["ADMIN"]);

  const [cases, extractions, chats, attachments, packages] = await Promise.all([
    prisma.case.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        caseNumber: true,
        title: true
      }
    }),
    prisma.extraction.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        status: true,
        sourceFormat: true,
        evidence: {
          select: {
            label: true,
            fileName: true
          }
        }
      }
    }),
    prisma.chat.findMany({
      orderBy: { updatedAt: "desc" },
      take: 300,
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        title: true,
        sourceApp: true,
        _count: {
          select: {
            messages: true
          }
        }
      }
    }),
    prisma.attachment.findMany({
      orderBy: { createdAt: "desc" },
      take: 400,
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        fileName: true,
        mimeType: true,
        path: true,
        message: {
          select: {
            chatId: true
          }
        }
      }
    }),
    listConsolidatedSyncPackages(50)
  ]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Sincronizacao consolidada</h2>
        <p className="text-sm text-zinc-600">
          Envie ou importe apenas informacoes selecionadas: chats, mensagens, imagens, documentos, OCR, transcricoes e
          insights. UFDR bruto nao faz parte deste fluxo.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pacotes selecionados</CardTitle>
        </CardHeader>
        <CardContent>
          <ConsolidatedSyncPanel
            config={getConsolidatedSyncConfig()}
            cases={cases}
            extractions={extractions.map((item) => ({
              id: item.id,
              caseId: item.caseId,
              evidenceId: item.evidenceId,
              status: item.status,
              sourceFormat: item.sourceFormat,
              evidenceLabel: item.evidence.label,
              evidenceFileName: item.evidence.fileName
            }))}
            chats={chats.map((item) => ({
              id: item.id,
              caseId: item.caseId,
              evidenceId: item.evidenceId,
              title: item.title ?? "",
              sourceApp: item.sourceApp ?? "",
              messageCount: item._count.messages
            }))}
            attachments={attachments.map((item) => ({
              id: item.id,
              caseId: item.caseId,
              evidenceId: item.evidenceId,
              messageChatId: item.message?.chatId ?? null,
              fileName: item.fileName ?? "",
              mimeType: item.mimeType ?? "",
              hasRecoveredFile: Boolean(item.path)
            }))}
            packages={packages.map((item) => ({
              packageId: item.packageId,
              direction: item.direction,
              status: item.status,
              sourceNodeId: item.sourceNodeId,
              caseNumber: item.caseNumber,
              itemCounts: item.itemCounts,
              errorMessage: item.errorMessage,
              createdAt: item.createdAt.toISOString(),
              importedAt: item.importedAt?.toISOString() ?? null
            }))}
          />
        </CardContent>
      </Card>
    </section>
  );
}
