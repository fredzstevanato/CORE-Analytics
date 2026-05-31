import { listAudioTranscriptions } from "@core/cases";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function TranscriptionsPage() {
  const rows = await listAudioTranscriptions(200);
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Transcricoes</h2>
      <Card>
        <CardHeader>
          <CardTitle>Audios processados</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rows.length === 0 ? <p className="text-sm text-zinc-500">Sem transcricoes ainda.</p> : null}
          {rows.map((row) => (
            <div key={row.id} className="rounded border border-zinc-200 p-2">
              <p className="text-xs text-zinc-500">{row.status}</p>
              <p className="text-sm">{row.text?.slice(0, 240) ?? "(sem texto)"}</p>
              <p className="text-xs text-zinc-500">{row.attachment.fileName ?? row.sourceFilePath}</p>
              <div className="mt-2">
                <audio controls preload="metadata" className="w-full max-w-md">
                  <source src={`/api/attachments/${row.attachment.id}/content`} />
                </audio>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
