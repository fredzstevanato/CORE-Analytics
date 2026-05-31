import Link from "next/link";
import { prisma } from "@core/db";
import { AnalysisSubnav } from "@/components/analysis-subnav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function AnalysisHomePage({
  searchParams
}: {
  searchParams: Promise<{ caseId?: string; evidenceId?: string; extractionId?: string }>;
}) {
  const params = await searchParams;
  const selectedQuery = new URLSearchParams();
  if (params.caseId) selectedQuery.set("caseId", params.caseId);
  if (params.evidenceId) selectedQuery.set("evidenceId", params.evidenceId);
  if (params.extractionId) selectedQuery.set("extractionId", params.extractionId);
  const selectedSuffix = selectedQuery.toString() ? `?${selectedQuery.toString()}` : "";
  const [chatCount, messageCount, insightCount, timelineCount, locationCount] = await Promise.all([
    prisma.chat.count(),
    prisma.message.count(),
    prisma.aiInsight.count({ where: { type: { contains: "INVESTIGATION", mode: "insensitive" } } }).catch(() => 0),
    prisma.timelineEvent.count(),
    prisma.artifact.count({ where: { type: "LOCATION" } })
  ]);

  const cards = [
    {
      href: "/analysis/search",
      title: "Buscas",
      description: "Consulta full-text com filtros por caso, evidência e extração.",
      value: messageCount
    },
    {
      href: "/analysis/messages",
      title: "Mensagens",
      description: "Console de conversas agrupado por plataforma e contexto do caso.",
      value: chatCount
    },
    {
      href: "/analysis/ai",
      title: "Analise de IA",
      description: "Triagem investigativa, relevância e geração assistida de relatório.",
      value: insightCount
    },
    {
      href: "/analysis/timeline",
      title: "Timeline",
      description: "Eventos cronológicos relevantes do caso e das evidências.",
      value: timelineCount
    },
    {
      href: "/analysis/locations",
      title: "Localizacoes",
      description: "Dados de localização extraídos e preparados para correlação futura.",
      value: locationCount
    }
  ];

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Analise</h2>
      <AnalysisSubnav />
      <Card>
        <CardHeader>
          <CardTitle>Fluxo operacional da analise</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-zinc-700">
          <p>1. Busque conteúdos indexados.</p>
          <p>2. Revise mensagens e conversas por caso.</p>
          <p>3. Rode triagem investigativa por IA.</p>
          <p>4. Cruze eventos na timeline.</p>
          <p>5. Consolide localizações e achados para relatório.</p>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <Link key={card.href} href={`${card.href}${selectedSuffix}`}>
            <Card className="h-full transition hover:border-zinc-400">
              <CardHeader>
                <CardTitle>{card.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-zinc-700">{card.description}</p>
                <p className="text-xs text-zinc-500">Itens disponíveis: {card.value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
