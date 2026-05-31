import { getCaseImportSessionById } from "@core/cases";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CaseImportSessionReview } from "@/components/case-import-session-review";

export const dynamic = "force-dynamic";

export default async function CaseImportSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const session = await getCaseImportSessionById(sessionId);
  if (!session) return notFound();

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Revisao do Rascunho do Caso</h2>
      <Card>
        <CardHeader>
          <CardTitle>Sessao de importacao</CardTitle>
        </CardHeader>
        <CardContent>
          <CaseImportSessionReview
            session={{
              id: session.id,
              status: session.status,
              draftPayload: (session.draftPayload as Record<string, unknown> | null) ?? null,
              pipelineSummary: (session.pipelineSummary as Record<string, unknown> | null) ?? null,
              document: session.document
                ? {
                    id: session.document.id,
                    fileName: session.document.fileName
                  }
                : null
            }}
          />
        </CardContent>
      </Card>
    </section>
  );
}
