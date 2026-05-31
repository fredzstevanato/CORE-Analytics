import { listCustodyEvents } from "@core/cases";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function ChainOfCustodyPage() {
  const rows = await listCustodyEvents(undefined, 300);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Evidencias / Cadeia de Custodia</h2>
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
