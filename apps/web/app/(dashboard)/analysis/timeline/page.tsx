import { listCases } from "@core/cases";
import { prisma } from "@core/db";
import { AnalysisSubnav } from "@/components/analysis-subnav";
import { AnalysisSyncActions } from "@/components/analysis-sync-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function AnalysisTimelinePage({
  searchParams
}: {
  searchParams: Promise<{ caseId?: string; evidenceId?: string; extractionId?: string; category?: string }>;
}) {
  const params = await searchParams;
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
      evidence: { select: { fileName: true } }
    }
  });
  const selectedExtraction = extractionId ? extractions.find((row) => row.id === extractionId) : null;
  const selectedEvidenceId = selectedExtraction?.evidenceId;
  const effectiveEvidenceId = selectedEvidenceId ?? (params.evidenceId?.trim() || undefined);

  const events = await prisma.timelineEvent.findMany({
    take: 100,
    where: {
      caseId,
      evidenceId: effectiveEvidenceId,
      category: params.category || undefined
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    include: {
      case: true,
      evidence: true
    }
  });

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Timeline</h2>
      <AnalysisSubnav />
      <Card>
        <CardHeader>
          <CardTitle>Eventos Iniciais</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="grid gap-2 md:grid-cols-3" method="GET">
            <select
              name="caseId"
              defaultValue={caseId ?? ""}
              className="rounded border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">Todos os casos</option>
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caseNumber} - {item.title}
                </option>
              ))}
            </select>
            <input
              name="evidenceId"
              defaultValue={effectiveEvidenceId ?? ""}
              placeholder="evidenceId opcional"
              className="rounded border border-zinc-300 px-3 py-2 text-sm"
            />
            <select
              name="extractionId"
              defaultValue={extractionId ?? ""}
              className="rounded border border-zinc-300 px-3 py-2 text-sm"
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
            <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white" type="submit">
              Filtrar
            </button>
          </form>
          <AnalysisSyncActions caseId={caseId} evidenceId={effectiveEvidenceId} />
          {events.length === 0 ? <p className="text-sm text-zinc-500">Sem eventos no momento.</p> : null}
          {events.map((event: any) => (
            <div key={event.id} className="rounded border border-zinc-200 p-2">
              <p className="font-medium">{event.title}</p>
              <p className="text-xs text-zinc-500">
                {event.case?.caseNumber ?? "Sem caso"} • {event.evidence?.fileName ?? "Sem evidência"} •{" "}
                {event.occurredAt?.toISOString() ?? "Sem data"}
              </p>
              <p className="text-xs text-zinc-600">{event.category}</p>
              {event.description ? <p className="mt-1 text-sm text-zinc-700">{event.description}</p> : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
