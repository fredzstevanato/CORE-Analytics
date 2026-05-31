import Link from "next/link";
import { listCases } from "@core/cases";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CaseIntakeForm } from "@/components/case-intake-form";

export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const cases = await listCases();
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Casos</h2>
      <Card>
        <CardHeader>
          <CardTitle>Entrada do Modulo de Casos</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Link href="/cases/new" className="rounded bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800">
            Novo caso manual
          </Link>
          <Link href="/cases/import" className="rounded border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50">
            Importar PDF do inquerito
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Intake IA Legado</CardTitle>
        </CardHeader>
        <CardContent>
          <CaseIntakeForm />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Lista de Casos</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {cases.map((item: any) => (
              <div key={item.id} className="rounded border border-zinc-200 p-3">
                <p className="text-sm text-zinc-500">{item.caseNumber}</p>
                <Link className="font-medium hover:underline" href={`/cases/${item.id}`}>
                  {item.title}
                </Link>
                <p className="text-xs text-zinc-500">Evidências: {item.evidences.length}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
