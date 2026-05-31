import Link from "next/link";
import { prisma } from "@core/db";
import { DeviceMatchForm } from "@/components/device-match-form";
import { SeizedObjectDeleteButton } from "@/components/seized-object-delete-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function EvidenceDevicesPage() {
  const devices = await prisma.device.findMany({
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
  });

  const seizedObjects = await prisma.seizedObject.findMany({
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
  });

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Evidencias / Aparelhos</h2>
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
