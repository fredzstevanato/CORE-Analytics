import { listCustodyEvents } from "@core/cases";
import { prisma } from "@core/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function ChainOfCustodyPage({
  searchParams
}: {
  searchParams: Promise<{ caseId?: string; extractionId?: string }>;
}) {
  const params = await searchParams;
  const caseId = params.caseId?.trim() || undefined;
  const extractionId = params.extractionId?.trim() || undefined;

  const [cases, extractions] = await Promise.all([
    prisma.case.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, caseNumber: true, title: true }
    }),
    prisma.extraction.findMany({
      where: caseId ? { caseId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        evidence: { select: { fileName: true } }
      }
    })
  ]);

  const selectedExtraction = extractionId ? extractions.find((row) => row.id === extractionId) : null;
  const selectedEvidenceId = selectedExtraction?.evidenceId;
  const selectedCaseId = caseId ?? selectedExtraction?.caseId;
  const rows = await listCustodyEvents(selectedCaseId, 300, selectedEvidenceId);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Evidencias / Cadeia de Custodia</h2>
      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_minmax(260px,1.2fr)_auto]" method="GET">
            <select name="caseId" defaultValue={selectedCaseId ?? ""} className="min-w-0 rounded border border-zinc-300 px-3 py-2 text-sm">
              <option value="">Todos os casos</option>
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caseNumber} - {item.title}
                </option>
              ))}
            </select>
            <select name="extractionId" defaultValue={extractionId ?? ""} className="min-w-0 rounded border border-zinc-300 px-3 py-2 text-sm">
              <option value="">Todas as extracoes</option>
              {extractions.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id} - {row.evidence.fileName}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white" type="submit">
                Filtrar
              </button>
              <a className="rounded border border-zinc-300 px-4 py-2 text-sm" href="/evidences/chain-of-custody">
                Limpar
              </a>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Eventos forenses auditaveis</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded border border-zinc-200 p-2 text-sm">
              <p className="font-medium">{row.action}</p>
              <p className="text-xs text-zinc-500">{row.evidence?.fileName ?? "Sem evidencia vinculada"}</p>
              <p className="text-xs text-zinc-500">{row.actor?.name ?? "Sistema"}</p>
              <p className="text-xs text-zinc-500">{row.createdAt.toISOString()}</p>
              <p className="text-xs text-zinc-600">{row.currentHash ?? "sem hash"}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
