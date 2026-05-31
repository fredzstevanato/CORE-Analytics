import { listCases } from "@core/cases";
import { prisma } from "@core/db";
import { AnalysisSubnav } from "@/components/analysis-subnav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvestigationModule } from "@/components/investigation-module";

export const dynamic = "force-dynamic";

export default async function AnalysisAiPage({
  searchParams
}: {
  searchParams: Promise<{ caseId?: string; extractionId?: string }>;
}) {
  const params = await searchParams;
  const [cases, extractions] = await Promise.all([
    listCases(),
    prisma.extraction.findMany({
      orderBy: { createdAt: "desc" },
      take: 1000,
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        evidence: { select: { fileName: true } }
      }
    })
  ]);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Analise Investigativa</h2>
      <AnalysisSubnav />
      <Card>
        <CardHeader>
          <CardTitle>Triagem, Correlacao e Relatorio Consolidado</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-zinc-600">
            Use esta etapa depois de revisar mensagens e contexto do caso. A IA prioriza conversas, explica a relevância
            e prepara o relatório investigativo.
          </p>
          <InvestigationModule
            initialCaseId={params.caseId?.trim() || undefined}
            initialExtractionId={params.extractionId?.trim() || undefined}
            cases={cases.map((item) => ({
              id: item.id,
              caseNumber: item.caseNumber,
              title: item.title
            }))}
            extractions={extractions.map((row) => ({
              id: row.id,
              caseId: row.caseId,
              evidenceId: row.evidenceId,
              fileName: row.evidence.fileName
            }))}
          />
        </CardContent>
      </Card>
    </section>
  );
}
