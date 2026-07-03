import Link from "next/link";
import { prisma } from "@core/db";
import { AnalysisSubnav } from "@/components/analysis-subnav";
import { AnalysisSyncActions } from "@/components/analysis-sync-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

function numberFromMetadata(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function buildKmlHref(input: { caseId?: string; extractionId?: string; evidenceId?: string }) {
  const params = new URLSearchParams();
  if (input.caseId) params.set("caseId", input.caseId);
  if (input.extractionId) params.set("extractionId", input.extractionId);
  if (input.evidenceId) params.set("evidenceId", input.evidenceId);
  return `/api/analysis/locations/kml?${params.toString()}`;
}

function googleMapsHref(lat: number, lng: number) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
}

export default async function AnalysisLocationsPage({
  searchParams
}: {
  searchParams: Promise<{ caseId?: string; extractionId?: string }>;
}) {
  const params = await searchParams;
  const caseId = params.caseId?.trim() || undefined;
  const extractionId = params.extractionId?.trim() || undefined;

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

  const [cases, rows] = await Promise.all([
    prisma.case.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, caseNumber: true }
    }),
    prisma.artifact.findMany({
      where: {
        type: "LOCATION",
        caseId,
        ...(selectedEvidenceId ? { evidenceId: selectedEvidenceId } : {})
      },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        case: true,
        evidence: true
      }
    })
  ]);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Localizacoes</h2>
      <AnalysisSubnav />
      <Card>
        <CardHeader>
          <CardTitle>Dados de localizacao extraidos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="flex flex-wrap gap-2" method="GET">
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
            <Button asChild variant="outline">
              <Link
                href={buildKmlHref({ caseId, extractionId, evidenceId: selectedEvidenceId })}
                target="_blank"
                rel="noopener noreferrer"
              >
                Baixar KML da evidencia
              </Link>
            </Button>
          </form>
          <AnalysisSyncActions caseId={caseId} evidenceId={selectedEvidenceId} />

          {rows.length === 0 ? <p className="text-sm text-zinc-500">Nenhum dado de localização indexado ainda.</p> : null}
          {rows.map((row) => {
            const meta = (row.metadata ?? {}) as Record<string, unknown>;
            const lat = numberFromMetadata(meta.latitude ?? meta.lat);
            const lng = numberFromMetadata(meta.longitude ?? meta.lng ?? meta.lon);
            const category = typeof meta.category === "string" ? meta.category : undefined;
            const categoryLabels: Record<string, string> = {
              CELL_TOWER: "Torre celular",
              WIFI: "Rede Wi-Fi",
              JOURNEY: "Trajeto",
              LOCATION: "Localização"
            };
            return (
            <div key={row.id} className="rounded border border-zinc-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{row.title ?? "Registro de localização"}</p>
                  {category ? (
                    <span className="rounded bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600">
                      {categoryLabels[category] ?? category}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {lat !== undefined && lng !== undefined ? (
                    <Link
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-blue-700 hover:bg-zinc-50"
                      href={googleMapsHref(lat, lng)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Abrir no Google Maps
                    </Link>
                  ) : null}
                  <Link className="rounded border border-zinc-300 px-2 py-1 text-xs text-blue-700 hover:bg-zinc-50" href={`/cases/${row.caseId}`}>
                    Abrir caso
                  </Link>
                </div>
              </div>
              <p className="text-xs text-zinc-500">
                Caso: {row.case.caseNumber} • Evidência: {row.evidence.fileName}
              </p>
              {lat !== undefined && lng !== undefined ? (
                <div className="mt-2 grid gap-2 md:grid-cols-3">
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">Latitude</p>
                    <p className="text-xs">{lat.toFixed(6)}</p>
                  </div>
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">Longitude</p>
                    <p className="text-xs">{lng.toFixed(6)}</p>
                  </div>
                  {row.occurredAt ? (
                    <div className="rounded border border-zinc-200 p-2">
                      <p className="text-xs text-zinc-500">Data/Hora</p>
                      <p className="text-xs">{new Date(row.occurredAt).toLocaleString("pt-BR")}</p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-50 p-2 text-xs">
                  {JSON.stringify(meta, null, 2)}
                </pre>
              )}
            </div>
            );
          })}
        </CardContent>
      </Card>
    </section>
  );
}
