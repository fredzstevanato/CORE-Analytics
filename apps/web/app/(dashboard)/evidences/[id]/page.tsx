import Link from "next/link";
import { getEvidenceById } from "@core/cases";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function EvidenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const evidence = await getEvidenceById(id);
  if (!evidence) return notFound();

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Detalhe da Evidência</h2>
      <Card>
        <CardHeader>
          <CardTitle>{evidence.fileName}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p>Caso: {evidence.case.title}</p>
          <p>SHA256: {evidence.sha256}</p>
          <p>Tamanho: {evidence.sizeBytes.toString()} bytes</p>
          <p>Caminho: {evidence.originalPath}</p>
          <p>Transcrições: {evidence.transcriptions.length}</p>
          <div>
            Status extração: <Badge className="ml-2">{evidence.extraction?.status ?? "PENDING"}</Badge>
          </div>
          {evidence.extraction ? (
            <Link className="text-sm text-blue-700 hover:underline" href={`/extractions/${evidence.extraction.id}`}>
              Abrir detalhe da extração
            </Link>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
