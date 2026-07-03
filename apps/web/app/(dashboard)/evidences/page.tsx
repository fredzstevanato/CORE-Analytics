import { listCases, listEvidences } from "@core/cases";
import Link from "next/link";
import { EvidenceProgressList } from "@/components/evidence-progress-list";
import { PdfImportForm } from "@/components/pdf-import-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UfdrUploadForm } from "@/components/ufdr-upload-form";
import { buildOperationalAlertsFromDetails } from "@/lib/extraction-alerts";

export const dynamic = "force-dynamic";

export default async function EvidencesPage() {
  const [evidences, cases] = await Promise.all([listEvidences(), listCases()]);

  const items = evidences.map((item: any) => {
    const details = (item.extraction?.processingDetails ?? {}) as Record<string, unknown>;
    const progress =
      typeof details.progress === "number"
        ? details.progress
        : item.extraction?.status === "COMPLETED"
          ? 100
          : 0;
    const phase = typeof details.phase === "string" ? details.phase : item.extraction?.status ?? "PENDING";
    const operationalAlerts = buildOperationalAlertsFromDetails(details);

    return {
      id: item.id,
      fileName: item.fileName,
      caseTitle: item.case.title,
      extraction: item.extraction
        ? {
            id: item.extraction.id,
            status: item.extraction.status,
            phase,
            progress,
            reportError: item.extraction.reportError,
            alerts: operationalAlerts.map((row) => row.message),
            operationalAlerts
          }
        : null
    };
  });

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Evidencias</h2>
      <Card>
        <CardHeader>
          <CardTitle>Organizacao do Modulo</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Link href="/evidences/processing" className="rounded border border-zinc-200 p-3 hover:bg-zinc-50">
            <p className="font-medium">Processamento</p>
            <p className="text-xs text-zinc-500">Importacoes, status, OCR, parsing e logs operacionais.</p>
          </Link>
          <Link href="/evidences/devices" className="rounded border border-zinc-200 p-3 hover:bg-zinc-50">
            <p className="font-medium">Aparelhos</p>
            <p className="text-xs text-zinc-500">Dispositivos detectados nas extracoes e seu contexto.</p>
          </Link>
          <Link href="/evidences/accounts" className="rounded border border-zinc-200 p-3 hover:bg-zinc-50">
            <p className="font-medium">Contas</p>
            <p className="text-xs text-zinc-500">Contas de usuario extraidas do UFDR (UserAccount).</p>
          </Link>
          <Link href="/evidences/custody" className="rounded border border-zinc-200 p-3 hover:bg-zinc-50">
            <p className="font-medium">Custodia</p>
            <p className="text-xs text-zinc-500">Visao resumida da guarda fisica/logica dos itens.</p>
          </Link>
          <Link href="/evidences/chain-of-custody" className="rounded border border-zinc-200 p-3 hover:bg-zinc-50">
            <p className="font-medium">Cadeia de Custodia</p>
            <p className="text-xs text-zinc-500">Trilha cronologica auditavel dos eventos forenses.</p>
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Upload UFDR</CardTitle>
        </CardHeader>
        <CardContent>
          <UfdrUploadForm
            caseOptions={cases.map((item) => ({
              id: item.id,
              caseNumber: item.caseNumber,
              title: item.title
            }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Triagem de PDF</CardTitle>
        </CardHeader>
        <CardContent>
          <PdfImportForm />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Lista de Evidencias</CardTitle>
        </CardHeader>
        <CardContent>
          <EvidenceProgressList items={items} />
        </CardContent>
      </Card>
    </section>
  );
}
