import { listCases } from "@core/cases";
import { Prisma, prisma } from "@core/db";
import { assessCaseFinalReportReadiness } from "@core/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  searchParams
}: {
  searchParams: Promise<{ caseId?: string; extractionId?: string; workflow?: string }>;
}) {
  const params = await searchParams;
  const [cases, allExtractions, consolidatedReports] = await Promise.all([
    listCases(),
    prisma.extraction.findMany({
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        createdAt: true,
        evidence: {
          select: {
            fileName: true
          }
        }
      },
      orderBy: { createdAt: "desc" },
      take: 1000
    }),
    prisma.generatedReport.findMany({
      where: { evidenceId: { not: null } },
      select: {
        evidenceId: true,
        metadata: true
      },
      take: 2000
    })
  ]);

  function getReportTypeFromMetadata(metadata: Prisma.JsonValue | null | undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const reportType = (metadata as Record<string, unknown>).reportType;
    if (typeof reportType === "string") return reportType;
    return null;
  }

  const evidenceIdsWithConsolidatedReport = new Set(
    consolidatedReports
      .filter((report) => report.evidenceId && getReportTypeFromMetadata(report.metadata) === "CONSOLIDATED_CASE_REPORT")
      .map((report) => report.evidenceId!)
  );

  const selectedExtraction = params.extractionId
    ? allExtractions.find((item) => item.id === params.extractionId) ?? null
    : null;
  const selectedCaseId = params.caseId ?? selectedExtraction?.caseId ?? "";

  const filteredExtractions = selectedCaseId
    ? allExtractions.filter((item) => item.caseId === selectedCaseId)
    : allExtractions;
  const filteredExtractionsWithoutConsolidatedReport = filteredExtractions.filter(
    (item) => !evidenceIdsWithConsolidatedReport.has(item.evidenceId)
  );
  const selectedConsolidatedExtractionId = filteredExtractionsWithoutConsolidatedReport.some(
    (item) => item.id === params.extractionId
  )
    ? (params.extractionId ?? "")
    : "";

  const reportsWhere: Prisma.GeneratedReportWhereInput = {
    ...(selectedCaseId ? { caseId: selectedCaseId } : {}),
    ...(selectedExtraction ? { evidenceId: selectedExtraction.evidenceId } : {})
  };

  const reports = await prisma.generatedReport.findMany({
    where: reportsWhere,
    take: 100,
    orderBy: { createdAt: "desc" },
    include: { author: true, case: true, evidence: true }
  });

  function getWorkflowStatus(report: (typeof reports)[number]) {
    const metadata =
      report.metadata && typeof report.metadata === "object" && !Array.isArray(report.metadata)
        ? (report.metadata as Record<string, unknown>)
        : null;
    const workflow =
      metadata?.workflow && typeof metadata.workflow === "object" && !Array.isArray(metadata.workflow)
        ? (metadata.workflow as Record<string, unknown>)
        : null;
    const status = workflow?.status;
    if (status === "UNDER_REVIEW" || status === "APPROVED" || status === "DRAFT") return status;
    return "DRAFT";
  }

  function getWorkflowLabel(status: "DRAFT" | "UNDER_REVIEW" | "APPROVED") {
    if (status === "UNDER_REVIEW") return "Em Revisao";
    if (status === "APPROVED") return "Aprovado";
    return "Rascunho";
  }

  function getReportTypeLabel(report: (typeof reports)[number]) {
    const metadata =
      report.metadata && typeof report.metadata === "object" && !Array.isArray(report.metadata)
        ? (report.metadata as Record<string, unknown>)
        : null;
    const reportType = typeof metadata?.reportType === "string" ? metadata.reportType : null;
    if (reportType === "CONSOLIDATED_CASE_REPORT") return "Consolidado";
    if (reportType === "TECHNICAL_SUMMARY") return "Tecnico";
    if (typeof metadata?.module === "string" && metadata.module === "investigation") return "IA";
    return "Outro";
  }

  const selectedWorkflow = (params.workflow ?? "ALL").toUpperCase();
  const filteredReports =
    selectedWorkflow === "ALL"
      ? reports
      : reports.filter((report) => getWorkflowStatus(report) === selectedWorkflow);

  const caseIds = [...new Set(filteredReports.map((report) => report.caseId))];
  const readinessByCaseId = new Map(
    await Promise.all(caseIds.map(async (caseId) => [caseId, await assessCaseFinalReportReadiness(caseId)] as const))
  );

  return (
    <section className="max-w-full space-y-4 overflow-x-hidden">
      <h2 className="text-2xl font-bold">Relatorios</h2>

      <Card className="max-w-full overflow-hidden">
        <CardHeader>
          <CardTitle>Gerar relatorio consolidado</CardTitle>
        </CardHeader>
        <CardContent>
          <form action="/api/reports/consolidated" method="post" className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
            <select
              name="caseId"
              defaultValue={selectedCaseId}
              required
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="" disabled>
                Selecione um caso
              </option>
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caseNumber} - {item.title}
                </option>
              ))}
            </select>
            <select
              name="extractionId"
              defaultValue={selectedConsolidatedExtractionId}
              required
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="" disabled>
                {filteredExtractionsWithoutConsolidatedReport.length > 0
                  ? "Selecione a extracao (UFDR)"
                  : "Nenhuma extracao sem relatorio consolidado"}
              </option>
              {filteredExtractionsWithoutConsolidatedReport.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id.slice(0, 8)}... - {item.evidence.fileName}
                </option>
              ))}
            </select>
            <Input name="title" placeholder="Titulo opcional" />
            <Button type="submit">Gerar consolidado</Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-full overflow-hidden">
        <CardHeader>
          <CardTitle>Gerar relatorio tecnico simples</CardTitle>
        </CardHeader>
        <CardContent>
          <form action="/api/reports/generate" method="post" className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
            <select
              name="caseId"
              defaultValue={selectedCaseId}
              required
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="" disabled>
                Selecione um caso
              </option>
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caseNumber} - {item.title}
                </option>
              ))}
            </select>
            <select
              name="extractionId"
              defaultValue={params.extractionId ?? ""}
              required
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="" disabled>
                Selecione a extracao (UFDR)
              </option>
              {filteredExtractions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id.slice(0, 8)}... - {item.evidence.fileName}
                </option>
              ))}
            </select>
            <Input name="title" placeholder="Titulo" />
            <Button type="submit" variant="outline">
              Gerar markdown
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-full overflow-hidden">
        <CardHeader>
          <CardTitle>Historico</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form method="GET" className="flex flex-wrap gap-2">
            <select
              name="caseId"
              defaultValue={selectedCaseId}
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
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
              defaultValue={params.extractionId ?? ""}
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="">Todas as extracoes</option>
              {filteredExtractions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id.slice(0, 8)}... - {item.evidence.fileName}
                </option>
              ))}
            </select>
            <select
              name="workflow"
              defaultValue={selectedWorkflow}
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="ALL">Todos os status</option>
              <option value="DRAFT">Rascunho</option>
              <option value="UNDER_REVIEW">Em Revisao</option>
              <option value="APPROVED">Aprovado</option>
            </select>
            <Button type="submit" variant="outline">
              Filtrar
            </Button>
          </form>

          {filteredReports.map((report) => (
            <div key={report.id} className="max-w-full overflow-hidden rounded border border-zinc-200 p-3">
              {(() => {
                const workflowStatus = getWorkflowStatus(report);
                return (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{report.title}</p>
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex h-8 items-center rounded-md px-2 text-xs font-medium ${
                          workflowStatus === "APPROVED"
                            ? "bg-emerald-100 text-emerald-800"
                            : workflowStatus === "UNDER_REVIEW"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-zinc-100 text-zinc-700"
                        }`}
                      >
                        {getWorkflowLabel(workflowStatus)}
                      </span>
                      <p className="text-xs text-zinc-500">{report.createdAt.toISOString()}</p>
                      <a
                        href={`/api/reports/${report.id}/pdf`}
                        className="inline-flex h-8 items-center rounded-md border border-zinc-300 px-2 text-xs font-medium hover:bg-zinc-100"
                      >
                        Gerar PDF
                      </a>
                      <a
                        href={`/api/reports/${report.id}/pdf?mode=final`}
                        className="inline-flex h-8 items-center rounded-md border border-emerald-300 bg-emerald-50 px-2 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                      >
                        Emitir PDF Final
                      </a>
                      {workflowStatus === "DRAFT" ? (
                        <form action={`/api/reports/${report.id}/workflow`} method="post">
                          <input type="hidden" name="action" value="SUBMIT_REVIEW" />
                          {selectedCaseId ? <input type="hidden" name="caseId" value={selectedCaseId} /> : null}
                          {params.extractionId ? <input type="hidden" name="extractionId" value={params.extractionId} /> : null}
                          <input type="hidden" name="workflow" value={selectedWorkflow} />
                          <Button type="submit" size="sm" variant="outline" className="h-8 text-xs">
                            Enviar Revisao
                          </Button>
                        </form>
                      ) : null}
                      {workflowStatus === "UNDER_REVIEW" ? (
                        <form action={`/api/reports/${report.id}/workflow`} method="post">
                          <input type="hidden" name="action" value="APPROVE" />
                          {selectedCaseId ? <input type="hidden" name="caseId" value={selectedCaseId} /> : null}
                          {params.extractionId ? <input type="hidden" name="extractionId" value={params.extractionId} /> : null}
                          <input type="hidden" name="workflow" value={selectedWorkflow} />
                          <Button type="submit" size="sm" className="h-8 bg-emerald-600 text-xs text-white hover:bg-emerald-700">
                            Aprovar
                          </Button>
                        </form>
                      ) : null}
                      {workflowStatus === "APPROVED" ? (
                        <form action={`/api/reports/${report.id}/workflow`} method="post">
                          <input type="hidden" name="action" value="REOPEN_REVIEW" />
                          {selectedCaseId ? <input type="hidden" name="caseId" value={selectedCaseId} /> : null}
                          {params.extractionId ? <input type="hidden" name="extractionId" value={params.extractionId} /> : null}
                          <input type="hidden" name="workflow" value={selectedWorkflow} />
                          <Button type="submit" size="sm" variant="outline" className="h-8 text-xs">
                            Reabrir Revisao
                          </Button>
                        </form>
                      ) : null}
                      <form action={`/api/reports/${report.id}/delete`} method="post">
                        {selectedCaseId ? <input type="hidden" name="caseId" value={selectedCaseId} /> : null}
                        {params.extractionId ? <input type="hidden" name="extractionId" value={params.extractionId} /> : null}
                        <input type="hidden" name="workflow" value={selectedWorkflow} />
                        <Button
                          type="submit"
                          size="sm"
                          variant="outline"
                          className="h-8 border-red-300 text-xs text-red-700 hover:bg-red-50"
                        >
                          Excluir
                        </Button>
                      </form>
                    </div>
                  </div>
                );
              })()}
              <p className="text-xs text-zinc-500">
                Caso: {report.case.caseNumber} | Formato: {report.format} | Tipo: {getReportTypeLabel(report)}
              </p>
              {report.evidenceId ? <p className="text-xs text-zinc-500">Evidencia: {report.evidenceId}</p> : null}
              {(() => {
                const readiness = readinessByCaseId.get(report.caseId);
                if (!readiness) return null;
                return readiness.ready ? (
                  <p className="mt-1 text-xs text-emerald-700">Prontidao final: OK.</p>
                ) : (
                  <p className="mt-1 text-xs text-amber-700">
                    Prontidao final pendente: {readiness.issues.join(" | ")}
                  </p>
                );
              })()}
              <pre className="mt-2 max-h-40 max-w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 text-xs">{report.content.slice(0, 1200)}</pre>
            </div>
          ))}
          {filteredReports.length === 0 ? <p className="text-sm text-zinc-500">Nenhum relatorio para o filtro selecionado.</p> : null}
        </CardContent>
      </Card>
    </section>
  );
}
