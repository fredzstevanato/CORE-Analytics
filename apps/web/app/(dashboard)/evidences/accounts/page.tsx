import Link from "next/link";
import { prisma } from "@core/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export default async function EvidenceAccountsPage({
  searchParams
}: {
  searchParams: Promise<{ caseId?: string; extractionId?: string }>;
}) {
  const params = await searchParams;

  const [cases, extractions] = await Promise.all([
    prisma.case.findMany({
      select: { id: true, caseNumber: true, title: true },
      orderBy: { createdAt: "desc" },
      take: 200
    }),
    prisma.extraction.findMany({
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        evidence: { select: { fileName: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 1000
    })
  ]);

  const selectedExtraction = params.extractionId
    ? extractions.find((item) => item.id === params.extractionId) ?? null
    : null;
  const selectedCaseId = params.caseId ?? selectedExtraction?.caseId ?? "";

  const filteredExtractions = selectedCaseId
    ? extractions.filter((item) => item.caseId === selectedCaseId)
    : extractions;

  const accounts = await prisma.artifact.findMany({
    where: {
      type: "ENTITY",
      metadata: { path: ["source"], equals: "ufdr-user-account" },
      ...(selectedCaseId ? { caseId: selectedCaseId } : {}),
      ...(selectedExtraction ? { evidenceId: selectedExtraction.evidenceId } : {})
    },
    include: {
      case: { select: { id: true, title: true } },
      evidence: { select: { id: true, fileName: true, extraction: { select: { id: true } } } }
    },
    orderBy: { createdAt: "desc" },
    take: 1000
  });

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Evidencias / Contas</h2>
      <Card>
        <CardHeader>
          <CardTitle>Contas de usuario detectadas (UFDR UserAccount)</CardTitle>
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
            <button type="submit" className="h-10 rounded-md border border-zinc-300 px-3 text-sm hover:bg-zinc-100">
              Filtrar
            </button>
          </form>

          <p className="text-sm text-zinc-600">Total detectado: {accounts.length}</p>
          {accounts.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma conta detectada ainda.</p> : null}
          {accounts.map((artifact) => {
            const meta = (artifact.metadata ?? {}) as Record<string, unknown>;
            const entriesRaw = Array.isArray(meta.entries) ? meta.entries : [];
            const entries = entriesRaw
              .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
              .filter((entry): entry is Record<string, unknown> => Boolean(entry));
            return (
              <div key={artifact.id} className="rounded border border-zinc-200 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{artifact.title ?? "Conta sem identificacao"}</p>
                  {artifact.evidence.extraction?.id ? (
                    <Link className="text-xs text-blue-700 hover:underline" href={`/extractions/${artifact.evidence.extraction.id}`}>
                      Abrir extracao
                    </Link>
                  ) : null}
                </div>
                <p className="text-xs text-zinc-500">Caso: {artifact.case.title}</p>
                <p className="text-xs text-zinc-500">Evidencia: {artifact.evidence.fileName}</p>
                <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">Aplicativo</p>
                    <p>{artifact.sourceApp ?? "N/D"}</p>
                  </div>
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">Username</p>
                    <p>{readString(meta, "username") ?? "N/D"}</p>
                  </div>
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">Service Type</p>
                    <p>{readString(meta, "serviceType") ?? "N/D"}</p>
                  </div>
                  <div className="rounded border border-zinc-200 p-2">
                    <p className="text-xs text-zinc-500">Service Identifier</p>
                    <p>{readString(meta, "serviceIdentifier") ?? artifact.externalId ?? "N/D"}</p>
                  </div>
                </div>
                {entries.length > 0 ? (
                  <div className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-700">
                    <p className="font-medium text-zinc-800">Entradas detectadas</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {entries.slice(0, 12).map((entry, index) => {
                        const label = [
                          readString(entry, "category"),
                          readString(entry, "value"),
                          readString(entry, "domain")
                        ]
                          .filter(Boolean)
                          .join(" | ");
                        return (
                          <span key={`${artifact.id}-${index}`} className="rounded border border-zinc-300 px-2 py-0.5">
                            {label || "Entrada"}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </section>
  );
}
