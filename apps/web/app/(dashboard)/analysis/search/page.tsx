import { listCases } from "@core/cases";
import { prisma } from "@core/db";
import { investigativeSearch } from "@core/search";
import { AnalysisSubnav } from "@/components/analysis-subnav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

type SearchPageProps = {
  searchParams: Promise<{
    q?: string;
    scope?: string;
    caseId?: string;
    evidenceId?: string;
    extractionId?: string;
  }>;
};

export default async function AnalysisSearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const cases = await listCases();
  const caseId = params.caseId?.trim() || undefined;
  const extractions = await prisma.extraction.findMany({
    where: caseId ? { caseId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      caseId: true,
      evidence: { select: { fileName: true } }
    }
  });
  const q = params.q ?? "";
  const scope = params.scope ?? "all";
  const scopedIndices =
    scope === "all"
      ? undefined
      : (scope.split(",").filter(Boolean) as Array<"messages" | "chats" | "entities" | "attachments" | "calls" | "files">);
  const filters = {
    caseId,
    evidenceId: params.evidenceId,
    extractionId: params.extractionId
  };

  let hits: Array<{ _id?: string; _source?: Record<string, unknown> }> = [];
  let searchError: string | null = null;

  if (q.trim().length > 0) {
    try {
      hits = (await investigativeSearch({
        query: q,
        filters,
        scope: scopedIndices
      })) as Array<{ _id?: string; _source?: Record<string, unknown> }>;
    } catch (error) {
      searchError = error instanceof Error ? error.message : "Falha na busca.";
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Busca Investigativa</h2>
      <AnalysisSubnav />
      <Card>
        <CardHeader>
          <CardTitle>Consulta Full-Text</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="grid gap-2 md:grid-cols-2 xl:grid-cols-5" method="GET">
            <Input name="q" defaultValue={q} placeholder="texto, numero, contato..." />
            <Input
              name="scope"
              defaultValue={scope}
              placeholder="all ou messages,chats,entities,attachments,calls,files"
            />
            <select
              name="caseId"
              defaultValue={params.caseId ?? ""}
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="">Todos os casos</option>
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caseNumber} - {item.title}
                </option>
              ))}
            </select>
            <Input name="evidenceId" defaultValue={params.evidenceId ?? ""} placeholder="evidenceId opcional" />
            <div className="flex gap-2">
              <select
                name="extractionId"
                defaultValue={params.extractionId ?? ""}
                className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
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
              <Button type="submit">Buscar</Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {searchError ? <p className="text-sm text-red-700">Erro de busca: {searchError}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>Resultados ({hits.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {hits.map((hit) => (
            <pre key={hit._id} className="overflow-x-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-xs">
              {JSON.stringify(hit._source ?? {}, null, 2)}
            </pre>
          ))}
          {hits.length === 0 ? <p className="text-sm text-zinc-500">Sem resultados.</p> : null}
        </CardContent>
      </Card>
    </section>
  );
}
