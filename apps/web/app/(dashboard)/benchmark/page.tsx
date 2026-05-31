import { prisma } from "@core/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BenchmarkTranscriptionRunner } from "@/components/benchmark-transcription-runner";

export const dynamic = "force-dynamic";

export default async function BenchmarkPage() {
  const rows = await prisma.attachment.findMany({
    where: {
      OR: [{ mimeType: { startsWith: "audio/" } }, { fileName: { contains: ".opus", mode: "insensitive" } }]
    },
    take: 800,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      fileName: true,
      archivePath: true,
      evidence: { select: { label: true, fileName: true } }
    }
  });

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Benchmark de Transcricao</h2>
      <Card>
        <CardHeader>
          <CardTitle>Comparativo Local vs API OpenAI</CardTitle>
        </CardHeader>
        <CardContent>
          <BenchmarkTranscriptionRunner
            rows={rows.map((row) => ({
              attachmentId: row.id,
              fileName: row.fileName ?? "audio-sem-nome",
              evidenceLabel: row.evidence.label ?? row.evidence.fileName,
              hasArchivePath: Boolean(row.archivePath)
            }))}
          />
        </CardContent>
      </Card>
    </section>
  );
}

