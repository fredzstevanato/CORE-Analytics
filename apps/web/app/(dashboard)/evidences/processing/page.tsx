import Link from "next/link";
import { prisma } from "@core/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  buildOperationalAlertsFromDetails,
  severityRank,
  type OperationalAlertSeverity
} from "@/lib/extraction-alerts";

export const dynamic = "force-dynamic";

const severityFilters = ["all", "warn", "critical"] as const;
type SeverityFilter = (typeof severityFilters)[number];

function minSeverityForFilter(filter: SeverityFilter): OperationalAlertSeverity | null {
  if (filter === "critical") return "CRITICAL";
  if (filter === "warn") return "WARN";
  return null;
}

export default async function EvidenceProcessingPage({
  searchParams
}: {
  searchParams: Promise<{ severity?: string }>;
}) {
  const params = await searchParams;
  const severityFilter = severityFilters.includes((params.severity ?? "").toLowerCase() as SeverityFilter)
    ? ((params.severity ?? "all").toLowerCase() as SeverityFilter)
    : "all";
  const minSeverity = minSeverityForFilter(severityFilter);

  const extractions = await prisma.extraction.findMany({
    orderBy: { createdAt: "desc" },
    include: { evidence: { include: { case: true } } },
    take: 200
  });

  const rows = extractions
    .map((item: any) => {
      const details = (item.processingDetails ?? {}) as Record<string, unknown>;
      const alerts = buildOperationalAlertsFromDetails(details);
      const maxSeverity = alerts.reduce<OperationalAlertSeverity | null>((current, alert) => {
        if (!current) return alert.severity;
        return severityRank(alert.severity) > severityRank(current) ? alert.severity : current;
      }, null);

      return { item, details, alerts, maxSeverity };
    })
    .filter((row) => {
      if (!minSeverity) return true;
      if (!row.maxSeverity) return false;
      return severityRank(row.maxSeverity) >= severityRank(minSeverity);
    });

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Evidencias / Processamento</h2>
      <Card>
        <CardHeader>
          <CardTitle>Status das Extracoes</CardTitle>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link
              className={severityFilter === "all" ? "rounded bg-zinc-900 px-2 py-1 text-white" : "rounded bg-zinc-100 px-2 py-1 text-zinc-700"}
              href="/evidences/processing?severity=all"
            >
              Todas
            </Link>
            <Link
              className={severityFilter === "warn" ? "rounded bg-amber-600 px-2 py-1 text-white" : "rounded bg-amber-100 px-2 py-1 text-amber-800"}
              href="/evidences/processing?severity=warn"
            >
              WARN+
            </Link>
            <Link
              className={severityFilter === "critical" ? "rounded bg-red-600 px-2 py-1 text-white" : "rounded bg-red-100 px-2 py-1 text-red-800"}
              href="/evidences/processing?severity=critical"
            >
              CRITICAL
            </Link>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma extração para o filtro atual.</p> : null}
          {rows.map(({ item, details, alerts, maxSeverity }) => {
            const progress = typeof details.progress === "number" ? details.progress : item.status === "COMPLETED" ? 100 : 0;
            const phase = typeof details.phase === "string" ? details.phase : item.status;

            return (
              <div key={item.id} className="rounded border border-zinc-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Link className="font-medium hover:underline" href={`/extractions/${item.id}`}>
                    {item.evidence.fileName}
                  </Link>
                  <div className="flex items-center gap-2">
                    {maxSeverity ? <Badge>{maxSeverity}</Badge> : null}
                    <Badge>{item.status}</Badge>
                  </div>
                </div>
                <p className="text-xs text-zinc-500">Caso: {item.evidence.case.title}</p>
                <p className="text-xs text-zinc-500">Extraction ID: {item.id}</p>
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span>Fase: {phase}</span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
                {alerts.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {alerts.map((alert) => (
                      <div key={alert.code} className="flex items-center gap-2 text-xs">
                        <Badge>{alert.severity}</Badge>
                        <span
                          className={
                            alert.severity === "CRITICAL"
                              ? "text-red-700"
                              : alert.severity === "WARN"
                                ? "text-amber-700"
                                : "text-blue-700"
                          }
                        >
                          {alert.message}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex gap-3 text-xs">
                  <Link href={`/evidences/${item.evidence.id}`} className="text-blue-700 hover:underline">
                    Ver evidencia
                  </Link>
                  <Link href={`/cases/${item.evidence.case.id}`} className="text-blue-700 hover:underline">
                    Ver caso
                  </Link>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </section>
  );
}
