import Link from "next/link";
import type { Prisma } from "@core/db";
import { prisma } from "@core/db";
import { listCases } from "@core/cases";
import { AnalysisSubnav } from "@/components/analysis-subnav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

type PageProps = {
  searchParams: Promise<{
    caseId?: string;
    extractionId?: string;
    q?: string;
    page?: string;
    excludedOnly?: string;
    transcribedOnly?: string;
  }>;
};

function parsePage(input?: string) {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function baseName(fileName?: string | null, archivePath?: string | null) {
  if (fileName && fileName.trim().length > 0) return fileName;
  if (!archivePath) return "audio-sem-nome";
  const normalized = archivePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || archivePath;
}

function audioContentType(fileName?: string | null, archivePath?: string | null, mimeType?: string | null) {
  const normalizedMime = (mimeType ?? "").toLowerCase();
  if (normalizedMime.startsWith("audio/")) return normalizedMime;

  const name = (fileName ?? archivePath ?? "").toLowerCase();
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".aac")) return "audio/aac";
  if (name.endsWith(".flac")) return "audio/flac";
  if (name.endsWith(".amr")) return "audio/amr";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".wma")) return "audio/x-ms-wma";
  if (name.endsWith(".ogg") || name.endsWith(".opus")) return "audio/ogg";
  return undefined;
}

function buildPageHref(input: {
  caseId?: string;
  extractionId?: string;
  q?: string;
  page: number;
  excludedOnly?: boolean;
  transcribedOnly?: boolean;
}) {
  const params = new URLSearchParams();
  if (input.caseId) params.set("caseId", input.caseId);
  if (input.extractionId) params.set("extractionId", input.extractionId);
  if (input.q) params.set("q", input.q);
  if (input.excludedOnly) params.set("excludedOnly", "1");
  if (input.transcribedOnly) params.set("transcribedOnly", "1");
  params.set("page", String(input.page));
  return `/analysis/audios?${params.toString()}`;
}

function audioWhereFilter(): Prisma.AttachmentWhereInput {
  return {
    OR: [
      { mimeType: { startsWith: "audio/", mode: "insensitive" } },
      { fileName: { endsWith: ".opus", mode: "insensitive" } },
      { fileName: { endsWith: ".ogg", mode: "insensitive" } },
      { fileName: { endsWith: ".mp3", mode: "insensitive" } },
      { fileName: { endsWith: ".wav", mode: "insensitive" } },
      { fileName: { endsWith: ".m4a", mode: "insensitive" } },
      { fileName: { endsWith: ".amr", mode: "insensitive" } },
      { fileName: { endsWith: ".aac", mode: "insensitive" } },
      { fileName: { endsWith: ".flac", mode: "insensitive" } },
      { fileName: { endsWith: ".wma", mode: "insensitive" } },
      { archivePath: { endsWith: ".opus", mode: "insensitive" } },
      { archivePath: { endsWith: ".ogg", mode: "insensitive" } },
      { archivePath: { endsWith: ".mp3", mode: "insensitive" } },
      { archivePath: { endsWith: ".wav", mode: "insensitive" } },
      { archivePath: { endsWith: ".m4a", mode: "insensitive" } },
      { archivePath: { endsWith: ".amr", mode: "insensitive" } },
      { archivePath: { endsWith: ".aac", mode: "insensitive" } },
      { archivePath: { endsWith: ".flac", mode: "insensitive" } },
      { archivePath: { endsWith: ".wma", mode: "insensitive" } }
    ]
  };
}

export default async function AnalysisAudiosPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page = parsePage(params.page);
  const q = (params.q ?? "").trim();
  const caseId = params.caseId?.trim() || undefined;
  const extractionId = params.extractionId?.trim() || undefined;
  const excludedOnly = params.excludedOnly === "1";
  const transcribedOnly = params.transcribedOnly === "1";
  const [cases, extractions] = await Promise.all([
    listCases(),
    prisma.extraction.findMany({
      where: caseId ? { caseId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        caseId: true,
        evidenceId: true,
        evidence: { select: { fileName: true } }
      }
    })
  ]);
  const selectedExtraction = extractionId ? extractions.find((row) => row.id === extractionId) : null;
  const selectedEvidenceId = selectedExtraction?.evidenceId;

  const where: Prisma.AttachmentWhereInput = {
    AND: [
      { messageId: { not: null } },
      audioWhereFilter(),
      caseId ? { caseId } : {},
      selectedEvidenceId ? { evidenceId: selectedEvidenceId } : {},
      excludedOnly
        ? {
            metadata: {
              path: ["recovery", "excluded"],
              equals: true
            }
          }
        : {},
      transcribedOnly
        ? {
            transcriptions: {
              some: {
                status: "COMPLETED",
                text: { not: null }
              }
            }
          }
        : {},
      q
        ? {
            OR: [
              { fileName: { contains: q, mode: "insensitive" } },
              { archivePath: { contains: q, mode: "insensitive" } },
              { message: { body: { contains: q, mode: "insensitive" } } },
              { transcriptions: { some: { text: { contains: q, mode: "insensitive" } } } }
            ]
          }
        : {}
    ]
  };

  const [total, withTranscription, rows] = await Promise.all([
    prisma.attachment.count({ where }),
    prisma.attachment.count({
      where: {
        AND: [
          where,
          {
            transcriptions: {
              some: {
                status: "COMPLETED",
                text: { not: null }
              }
            }
          }
        ]
      }
    }),
    prisma.attachment.findMany({
      where,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fileName: true,
        archivePath: true,
        mimeType: true,
        createdAt: true,
        message: {
          select: {
            id: true,
            body: true,
            timestamp: true,
            chat: {
              select: {
                id: true,
                title: true,
                sourceApp: true
              }
            }
          }
        },
        transcriptions: {
          where: {
            status: "COMPLETED",
            text: { not: null }
          },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            text: true,
            createdAt: true,
            engine: true
          }
        }
      }
    })
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const withoutTranscription = Math.max(0, total - withTranscription);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Audios da Analise</h2>
      <AnalysisSubnav />

      <Card>
        <CardHeader>
          <CardTitle>Filtro e Resumo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form method="GET" className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
            <select
              name="caseId"
              defaultValue={caseId ?? ""}
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
              defaultValue={extractionId ?? ""}
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="">Todas as extracoes</option>
              {extractions
                .filter((row) => !caseId || row.caseId === caseId)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.id} - {row.evidence.fileName}
                  </option>
                ))}
            </select>
            <input
              name="q"
              defaultValue={q}
              placeholder="Buscar por nome do arquivo, caminho, texto da mensagem ou transcricao"
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" variant="outline">
                Atualizar lista
              </Button>
            </div>

            <label className="inline-flex items-center gap-2 rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-700">
              <input type="checkbox" name="excludedOnly" value="1" defaultChecked={excludedOnly} />
              Somente excluidos/nao recuperados
            </label>

            <label className="inline-flex items-center gap-2 rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-700">
              <input type="checkbox" name="transcribedOnly" value="1" defaultChecked={transcribedOnly} />
              Com transcricoes
            </label>
          </form>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Total de audios vinculados</p>
              <p className="text-lg font-semibold text-zinc-900">{total}</p>
            </div>
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Com transcricao</p>
              <p className="text-lg font-semibold text-zinc-900">{withTranscription}</p>
            </div>
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Sem transcricao</p>
              <p className="text-lg font-semibold text-zinc-900">{withoutTranscription}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Lista de Audios (pagina {clampedPage} de {totalPages})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 ? <p className="text-sm text-zinc-500">Nenhum audio encontrado com este filtro.</p> : null}

          {rows.map((row) => {
            const transcript = row.transcriptions[0]?.text?.trim();
            const chatTitle = row.message?.chat?.title?.trim() || "Chat sem titulo";
            const displayName = baseName(row.fileName, row.archivePath);
            return (
              <article key={row.id} className="space-y-2 rounded-lg border border-zinc-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">{displayName}</p>
                    <p className="text-xs text-zinc-600">
                      {chatTitle} | {row.message?.timestamp ? new Date(row.message.timestamp).toLocaleString("pt-BR") : "Sem data"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={`/api/attachments/${row.id}/content?download=1`}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      Baixar audio
                    </a>
                    <a
                      href={`/api/attachments/${row.id}/content`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      Abrir arquivo
                    </a>
                    <Link
                      href={`/analysis/messages?${caseId ? `caseId=${encodeURIComponent(caseId)}&` : ""}${extractionId ? `extractionId=${encodeURIComponent(extractionId)}&` : ""}chatId=${row.message?.chat?.id ?? ""}`}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      Abrir chat
                    </Link>
                  </div>
                </div>

                <audio controls preload="none" className="w-full">
                  <source
                    src={`/api/attachments/${row.id}/content`}
                    type={audioContentType(row.fileName, row.archivePath, row.mimeType)}
                  />
                  Seu navegador nao suporta audio.
                </audio>

                {transcript ? (
                  <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide">Transcricao</p>
                    <p className="whitespace-pre-wrap break-words">{transcript}</p>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">Sem transcricao concluida para este audio. Use o player para escutar.</p>
                )}
              </article>
            );
          })}

          <div className="flex items-center justify-between pt-2">
            {clampedPage > 1 ? (
              <Link
                href={buildPageHref({
                  caseId,
                  extractionId,
                  q,
                  page: clampedPage - 1,
                  excludedOnly,
                  transcribedOnly
                })}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                Pagina anterior
              </Link>
            ) : (
              <span />
            )}

            {clampedPage < totalPages ? (
              <Link
                href={buildPageHref({
                  caseId,
                  extractionId,
                  q,
                  page: clampedPage + 1,
                  excludedOnly,
                  transcribedOnly
                })}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                Proxima pagina
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
