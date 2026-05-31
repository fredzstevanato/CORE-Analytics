import { getExtractionById, listExtractionOperationalAlertHistory } from "@core/cases";
import { prisma } from "@core/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExtractionProgressLive } from "@/components/extraction-progress-live";
import { buildOperationalAlertsFromDetails } from "@/lib/extraction-alerts";

export const dynamic = "force-dynamic";

export default async function ExtractionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [extraction, alertHistory, transcriptionCount, transcriptionRows] = await Promise.all([
    getExtractionById(id),
    listExtractionOperationalAlertHistory(id, 80),
    prisma.audioTranscription.count({ where: { extractionId: id } }),
    prisma.audioTranscription.findMany({
      where: { extractionId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, status: true, error: true }
    })
  ]);
  if (!extraction) return notFound();

  const details = (extraction.processingDetails ?? {}) as Record<string, unknown>;
  const operationalAlerts = buildOperationalAlertsFromDetails(details);
  const hasBackgroundWork = false;
  const effectiveStatus =
    (extraction.status === "COMPLETED" || extraction.status === "FAILED") && hasBackgroundWork
      ? "PROCESSING"
      : extraction.status;
  const progress =
    typeof details.progress === "number"
      ? (extraction.status === "COMPLETED" || extraction.status === "FAILED") && hasBackgroundWork
        ? Math.min(details.progress, 99)
        : details.progress
      : effectiveStatus === "COMPLETED"
        ? 100
        : 0;
  const rawPhase = typeof details.phase === "string" ? details.phase : extraction.status;
  const phase =
    (extraction.status === "COMPLETED" || extraction.status === "FAILED") &&
    hasBackgroundWork &&
    (rawPhase === "completed" || rawPhase === "failed")
      ? "background-processing"
      : rawPhase;

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Processamento da Extracao</h2>
      <Card>
        <CardHeader>
          <CardTitle>Extraction {extraction.id}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <span>Status:</span>
            <Badge>{effectiveStatus}</Badge>
          </div>
          <p>Report localizado: {extraction.reportFound ? "Sim" : "Nao"}</p>
          <p>Report path: {extraction.reportPath ?? "N/D"}</p>
          <p>Erro: {extraction.reportError ?? "N/D"}</p>
          <p>Iniciado em: {extraction.startedAt?.toISOString() ?? "N/D"}</p>
          <p>Finalizado em: {extraction.finishedAt?.toISOString() ?? "N/D"}</p>

          <ExtractionProgressLive
            extractionId={extraction.id}
            evidenceId={extraction.evidence.id}
            initial={{
              status: effectiveStatus,
              phase,
              progress,
              reportError: extraction.reportError,
              alerts: operationalAlerts.map((row) => row.message),
              operationalAlerts
            }}
          />

          <p>Transcricoes de audio: {transcriptionCount}</p>

          <div className="space-y-1 rounded border border-zinc-200 p-2">
            {transcriptionRows.map((row) => (
              <div key={row.id} className="text-xs">
                <span className="font-medium">{row.status}</span> - {row.error ?? "ok"}
              </div>
            ))}
            {transcriptionCount === 0 ? <p className="text-xs text-zinc-500">Sem transcricoes ainda.</p> : null}
          </div>

          {alertHistory.length > 0 ? (
            <div className="space-y-2 rounded border border-zinc-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">Histórico de alertas operacionais</p>
                <div className="flex items-center gap-2 text-xs">
                  <Link
                    href={`/api/extractions/${extraction.id}/operational-alerts/export?format=csv`}
                    className="rounded border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-50"
                  >
                    Exportar CSV
                  </Link>
                  <Link
                    href={`/api/extractions/${extraction.id}/operational-alerts/export?format=pdf`}
                    className="rounded border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-50"
                  >
                    Exportar PDF
                  </Link>
                </div>
              </div>
              <form
                action={`/api/extractions/${extraction.id}/operational-alerts/verify`}
                method="post"
                encType="multipart/form-data"
                className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 p-2 text-xs"
              >
                <input type="file" name="file" required className="max-w-xs" />
                <button type="submit" className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50">
                  Verificar arquivo exportado
                </button>
                <span className="text-zinc-500">Aceita CSV e PDF do módulo de alertas operacionais.</span>
              </form>
              {alertHistory.map((event) => (
                <div key={event.id} className="rounded border border-zinc-200 p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">
                      {event.action} - {new Date(event.createdAt).toLocaleString()}
                    </div>
                    <Badge>{event.highestSeverity}</Badge>
                  </div>
                  <p className="text-zinc-500">Fonte: {event.source ?? "N/D"}</p>
                  <div className="mt-1 space-y-1">
                    {event.alerts.map((alert) => (
                      <div key={`${event.id}-${alert.code}-${alert.message}`} className="flex items-center gap-2">
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
                </div>
              ))}
            </div>
          ) : null}

          <pre className="overflow-x-auto rounded bg-zinc-900 p-3 text-xs text-zinc-100">
            {JSON.stringify(extraction.processingDetails ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </section>
  );
}
