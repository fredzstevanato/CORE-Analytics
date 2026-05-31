import { prisma } from "@core/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function EvidenceCustodyPage() {
  const [evidences, recentEvents] = await Promise.all([
    prisma.evidence.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        case: true,
        custodyEvents: {
          orderBy: { createdAt: "desc" },
          take: 1
        }
      },
      take: 100
    }),
    prisma.custodyEvent.findMany({
      orderBy: { createdAt: "desc" },
      include: { evidence: true, actor: true },
      take: 20
    })
  ]);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Evidencias / Custodia</h2>
      <Card>
        <CardHeader>
          <CardTitle>Estado resumido dos itens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {evidences.length === 0 ? <p className="text-sm text-zinc-500">Sem evidencias cadastradas.</p> : null}
          {evidences.map((evidence) => {
            const latest = evidence.custodyEvents[0];
            return (
              <div key={evidence.id} className="rounded border border-zinc-200 p-3 text-sm">
                <p className="font-medium">{evidence.fileName}</p>
                <p className="text-xs text-zinc-500">Caso: {evidence.case.title}</p>
                <p className="text-xs text-zinc-600">Ultimo evento: {latest?.action ?? "Sem eventos"}</p>
                <p className="text-xs text-zinc-500">
                  Atualizado em: {latest ? latest.createdAt.toISOString() : evidence.createdAt.toISOString()}
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Movimentacoes recentes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {recentEvents.map((row) => (
            <div key={row.id} className="rounded border border-zinc-200 p-2 text-sm">
              <p className="font-medium">{row.action}</p>
              <p className="text-xs text-zinc-500">{row.evidence?.fileName ?? "Sem evidencia vinculada"}</p>
              <p className="text-xs text-zinc-500">{row.actor?.name ?? "Sistema"}</p>
              <p className="text-xs text-zinc-500">{row.createdAt.toISOString()}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
