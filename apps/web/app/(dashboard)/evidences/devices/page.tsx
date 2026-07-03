import Link from "next/link";
import { prisma } from "@core/db";
import { DeviceMatchForm } from "@/components/device-match-form";
import { SeizedObjectDeleteButton } from "@/components/seized-object-delete-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function buildFilterHref(pathname: string, input: { caseId?: string; extractionId?: string }) {
  const params = new URLSearchParams();
  if (input.caseId) params.set("caseId", input.caseId);
  if (input.extractionId) params.set("extractionId", input.extractionId);
  return `${pathname}?${params.toString()}`;
}

export default async function EvidenceDevicesPage({
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

  const [devices, seizedObjects] = await Promise.all([
    prisma.device.findMany({
      where: {
        extraction: {
          ...(selectedCaseId ? { caseId: selectedCaseId } : {}),
          ...(extractionId ? { id: extractionId } : {}),
          ...(selectedEvidenceId ? { evidenceId: selectedEvidenceId } : {})
        }
      },
      orderBy: { createdAt: "desc" },
      include: {
        matchedSeizedObject: true,
        deviceMatches: {
          orderBy: { updatedAt: "desc" },
          take: 5
        },
        extraction: {
          include: {
            evidence: {
              include: {
                case: {
                  include: {
                    seizedObjects: true,
                    expertReports: true
                  }
                }
              }
            }
          }
        }
      },
      take: 200
    }),
    prisma.seizedObject.findMany({
      where: selectedCaseId ? { caseId: selectedCaseId } : undefined,
      orderBy: { createdAt: "desc" },
      include: {
        case: true,
        expertReport: {
          select: {
            id: true,
            title: true
          }
        },
        deviceMatches: {
          orderBy: { updatedAt: "desc" },
          take: 1
        }
      },
      take: 200
    })
  ]);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Evidencias / Aparelhos</h2>
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
              <Link className="rounded border border-zinc-300 px-4 py-2 text-sm" href="/evidences/devices">
                Limpar
              </Link>
            </div>
          </form>
          {selectedCaseId ? (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <Link
                className="text-blue-700 hover:underline"
                href={buildFilterHref("/evidences/custody", { caseId: selectedCaseId, extractionId })}
              >
                Ver custodia filtrada
              </Link>
              <Link
                className="text-blue-700 hover:underline"
                href={buildFilterHref("/evidences/chain-of-custody", { caseId: selectedCaseId, extractionId })}
              >
                Ver cadeia filtrada
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Dispositivos detectados nas extracoes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {devices.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Nenhum dispositivo detectado nas extrações ainda.
            </p>
          ) : null}
          {devices.map((device) => {
            const meta = (device.metadata ?? {}) as Record<string, unknown>;
            return (
            <div key={device.id} className="rounded border border-zinc-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {[device.manufacturer, device.model].filter(Boolean).join(" ") || "Dispositivo sem rotulo"}
                </p>
                <Link className="text-xs text-blue-700 hover:underline" href={`/extractions/${device.extractionId}`}>
                  Abrir extracao
                </Link>
              </div>
              <p className="text-xs text-zinc-500">Caso: {device.extraction.evidence.case.title}</p>
              <p className="text-xs text-zinc-500">Evidencia: {device.extraction.evidence.fileName}</p>
              <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded border border-zinc-200 p-2">
                  <p className="text-xs text-zinc-500">Fabricante</p>
                  <p>{device.manufacturer ?? "N/D"}</p>
                </div>
                <div className="rounded border border-zinc-200 p-2">
                  <p className="text-xs text-zinc-500">Modelo</p>
                  <p>{device.model ?? "N/D"}</p>
                </div>
                <div className="rounded border border-zinc-200 p-2">
                  <p className="text-xs text-zinc-500">SO</p>
                  <p>{device.osVersion ?? "N/D"}</p>
                </div>
                <div className="rounded border border-zinc-200 p-2">
                  <p className="text-xs text-zinc-500">IMEI</p>
                  <p>{device.imei ?? "N/D"}</p>
                </div>
                {typeof meta.imei2 === "string" && meta.imei2 ? (
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">IMEI 2</p>
                    <p>{meta.imei2}</p>
                  </div>
                ) : null}
                <div className="rounded border border-zinc-200 p-2">
                  <p className="text-xs text-zinc-500">Serial</p>
                  <p>{device.serialNumber ?? "N/D"}</p>
                </div>
                {typeof meta.iccid === "string" && meta.iccid ? (
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">ICCID</p>
                    <p>{meta.iccid}</p>
                  </div>
                ) : null}
                {typeof meta.msisdn === "string" && meta.msisdn ? (
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">Telefone</p>
                    <p>{meta.msisdn}</p>
                  </div>
                ) : null}
                {typeof meta.macAddress === "string" && meta.macAddress ? (
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">MAC</p>
                    <p>{meta.macAddress}</p>
                  </div>
                ) : null}
                {typeof meta.bluetoothAddress === "string" && meta.bluetoothAddress ? (
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">Bluetooth</p>
                    <p>{meta.bluetoothAddress}</p>
                  </div>
                ) : null}
              </div>
              <div className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600">
                <p>
                  Objeto vinculado: {device.matchedSeizedObject?.label ?? "Nenhum confirmado"}
                </p>
                <p>
                  Matches registrados: {device.deviceMatches.length}
                </p>
                {device.deviceMatches[0] ? (
                  <p>
                    Ultimo status: {device.deviceMatches[0].status}
                    {typeof device.deviceMatches[0].confidence === "number"
                      ? ` • confianca ${device.deviceMatches[0].confidence.toFixed(2)}`
                      : ""}
                  </p>
                ) : null}
              </div>
              {device.extraction.evidence.case.seizedObjects.length > 0 ? (
                <DeviceMatchForm
                  deviceId={device.id}
                  seizedObjects={device.extraction.evidence.case.seizedObjects}
                  expertReports={device.extraction.evidence.case.expertReports.map((report) => ({
                    id: report.id,
                    title: report.title
                  }))}
                  currentMatchedSeizedObjectId={device.matchedSeizedObjectId}
                  currentMatchStatus={device.deviceMatches[0]?.status}
                />
              ) : (
                <p className="mt-2 text-xs text-zinc-500">
                  Cadastre objetos apreendidos ou importe um laudo pericial no caso para habilitar o match.
                </p>
              )}
            </div>
            );
          })}
        </CardContent>
      </Card>

      {devices.length === 0 && seizedObjects.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Celulares identificados em objetos apreendidos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {seizedObjects.map((object) => (
              <div key={object.id} className="rounded border border-zinc-200 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {[object.objectType, object.manufacturer, object.model].filter(Boolean).join(" ") || object.label}
                  </p>
                  <div className="flex items-center gap-2">
                    <Link className="text-xs text-blue-700 hover:underline" href={`/cases/${object.caseId}`}>
                      Abrir caso
                    </Link>
                    <SeizedObjectDeleteButton
                      caseId={object.caseId}
                      objectId={object.id}
                      label={object.label}
                      className="h-7 px-2 text-[11px]"
                    />
                  </div>
                </div>
                <p className="text-xs text-zinc-500">Caso: {object.case.title}</p>
                {object.expertReport ? (
                  <p className="text-xs text-zinc-500">Laudo: {object.expertReport.title}</p>
                ) : null}
                <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">IMEI</p>
                    <p>{object.imei ?? "N/D"}</p>
                  </div>
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">IMEI 2</p>
                    <p>{object.imei2 ?? "N/D"}</p>
                  </div>
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">ICCID 1</p>
                    <p>{object.iccid1 ?? "N/D"}</p>
                  </div>
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">ICCID 2</p>
                    <p>{object.iccid2 ?? "N/D"}</p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-zinc-600">
                  {object.deviceMatches[0]
                    ? `Ultimo match: ${object.deviceMatches[0].status}`
                    : "Sem match com dispositivo de extração ainda."}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
