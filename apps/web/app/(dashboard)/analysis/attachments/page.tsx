import Link from "next/link";
import type { Prisma } from "@core/db";
import { prisma } from "@core/db";
import { listCases } from "@core/cases";
import { AnalysisSubnav } from "@/components/analysis-subnav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 80;

type MediaFilter = "all" | "documents" | "images" | "videos";
type StatusFilter = "all" | "indexed" | "excluded" | "pending";

type PageProps = {
  searchParams: Promise<{
    caseId?: string;
    extractionId?: string;
    q?: string;
    media?: string;
    status?: string;
    page?: string;
  }>;
};

function parsePage(input?: string) {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function parseMedia(input?: string): MediaFilter {
  if (input === "documents" || input === "images" || input === "videos") return input;
  return "all";
}

function parseStatus(input?: string): StatusFilter {
  if (input === "indexed" || input === "excluded" || input === "pending") return input;
  return "all";
}

function baseName(fileName?: string | null, archivePath?: string | null) {
  if (fileName && fileName.trim().length > 0) return fileName;
  if (!archivePath) return "arquivo-sem-nome";
  const normalized = archivePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || archivePath;
}

function documentWhereFilter(): Prisma.AttachmentWhereInput {
  return {
    OR: [
      { mimeType: { contains: "pdf", mode: "insensitive" } },
      { mimeType: { startsWith: "application/", mode: "insensitive" } },
      { fileName: { endsWith: ".pdf", mode: "insensitive" } },
      { fileName: { endsWith: ".doc", mode: "insensitive" } },
      { fileName: { endsWith: ".docx", mode: "insensitive" } },
      { fileName: { endsWith: ".xls", mode: "insensitive" } },
      { fileName: { endsWith: ".xlsx", mode: "insensitive" } },
      { fileName: { endsWith: ".ppt", mode: "insensitive" } },
      { fileName: { endsWith: ".pptx", mode: "insensitive" } },
      { fileName: { endsWith: ".txt", mode: "insensitive" } },
      { archivePath: { endsWith: ".pdf", mode: "insensitive" } },
      { archivePath: { endsWith: ".doc", mode: "insensitive" } },
      { archivePath: { endsWith: ".docx", mode: "insensitive" } },
      { archivePath: { endsWith: ".xls", mode: "insensitive" } },
      { archivePath: { endsWith: ".xlsx", mode: "insensitive" } },
      { archivePath: { endsWith: ".ppt", mode: "insensitive" } },
      { archivePath: { endsWith: ".pptx", mode: "insensitive" } },
      { archivePath: { endsWith: ".txt", mode: "insensitive" } }
    ]
  };
}

function imageWhereFilter(): Prisma.AttachmentWhereInput {
  return {
    OR: [
      { mimeType: { startsWith: "image/", mode: "insensitive" } },
      { fileName: { endsWith: ".png", mode: "insensitive" } },
      { fileName: { endsWith: ".jpg", mode: "insensitive" } },
      { fileName: { endsWith: ".jpeg", mode: "insensitive" } },
      { fileName: { endsWith: ".webp", mode: "insensitive" } },
      { fileName: { endsWith: ".bmp", mode: "insensitive" } },
      { fileName: { endsWith: ".heic", mode: "insensitive" } },
      { fileName: { endsWith: ".heif", mode: "insensitive" } },
      { fileName: { endsWith: ".gif", mode: "insensitive" } },
      { archivePath: { endsWith: ".png", mode: "insensitive" } },
      { archivePath: { endsWith: ".jpg", mode: "insensitive" } },
      { archivePath: { endsWith: ".jpeg", mode: "insensitive" } },
      { archivePath: { endsWith: ".webp", mode: "insensitive" } },
      { archivePath: { endsWith: ".bmp", mode: "insensitive" } },
      { archivePath: { endsWith: ".heic", mode: "insensitive" } },
      { archivePath: { endsWith: ".heif", mode: "insensitive" } },
      { archivePath: { endsWith: ".gif", mode: "insensitive" } }
    ]
  };
}

function videoWhereFilter(): Prisma.AttachmentWhereInput {
  return {
    OR: [
      { mimeType: { startsWith: "video/", mode: "insensitive" } },
      { fileName: { endsWith: ".mp4", mode: "insensitive" } },
      { fileName: { endsWith: ".mov", mode: "insensitive" } },
      { fileName: { endsWith: ".m4v", mode: "insensitive" } },
      { fileName: { endsWith: ".mkv", mode: "insensitive" } },
      { fileName: { endsWith: ".3gp", mode: "insensitive" } },
      { fileName: { endsWith: ".webm", mode: "insensitive" } },
      { fileName: { endsWith: ".avi", mode: "insensitive" } },
      { archivePath: { endsWith: ".mp4", mode: "insensitive" } },
      { archivePath: { endsWith: ".mov", mode: "insensitive" } },
      { archivePath: { endsWith: ".m4v", mode: "insensitive" } },
      { archivePath: { endsWith: ".mkv", mode: "insensitive" } },
      { archivePath: { endsWith: ".3gp", mode: "insensitive" } },
      { archivePath: { endsWith: ".webm", mode: "insensitive" } },
      { archivePath: { endsWith: ".avi", mode: "insensitive" } }
    ]
  };
}

function mediaWhereFilter(media: MediaFilter): Prisma.AttachmentWhereInput {
  if (media === "documents") return documentWhereFilter();
  if (media === "images") return imageWhereFilter();
  if (media === "videos") return videoWhereFilter();
  return {};
}

function statusWhereFilter(status: StatusFilter): Prisma.AttachmentWhereInput {
  if (status === "indexed") {
    return {
      AND: [{ archivePath: { not: null } }, { archivePath: { not: "" } }]
    };
  }
  if (status === "excluded") {
    return {
      metadata: {
        path: ["recovery", "excluded"],
        equals: true
      }
    };
  }
  if (status === "pending") {
    return {
      AND: [
        {
          OR: [{ archivePath: null }, { archivePath: "" }]
        },
        {
          NOT: {
            metadata: {
              path: ["recovery", "excluded"],
              equals: true
            }
          }
        }
      ]
    };
  }
  return {};
}

function buildPageHref(input: {
  caseId?: string;
  extractionId?: string;
  q?: string;
  media: MediaFilter;
  status: StatusFilter;
  page: number;
}) {
  const params = new URLSearchParams();
  if (input.caseId) params.set("caseId", input.caseId);
  if (input.extractionId) params.set("extractionId", input.extractionId);
  if (input.q) params.set("q", input.q);
  if (input.media !== "all") params.set("media", input.media);
  if (input.status !== "all") params.set("status", input.status);
  params.set("page", String(input.page));
  return `/analysis/attachments?${params.toString()}`;
}

function detectCategory(row: { fileName?: string | null; archivePath?: string | null; mimeType?: string | null }) {
  const mime = (row.mimeType ?? "").toLowerCase();
  const ref = `${row.fileName ?? ""} ${row.archivePath ?? ""}`.toLowerCase();
  if (mime.startsWith("video/") || /\.(mp4|mov|m4v|mkv|3gp|webm|avi)$/.test(ref)) return "Video";
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|bmp|heic|heif|gif)$/.test(ref)) return "Imagem";
  return "Documento";
}

function isPdf(row: { fileName?: string | null; archivePath?: string | null; mimeType?: string | null }) {
  const mime = (row.mimeType ?? "").toLowerCase();
  const ref = `${row.fileName ?? ""} ${row.archivePath ?? ""}`.toLowerCase();
  return mime.includes("pdf") || ref.endsWith(".pdf");
}

function isImage(row: { fileName?: string | null; archivePath?: string | null; mimeType?: string | null }) {
  const mime = (row.mimeType ?? "").toLowerCase();
  const ref = `${row.fileName ?? ""} ${row.archivePath ?? ""}`.toLowerCase();
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|bmp|heic|heif|gif)$/.test(ref);
}

function isVideo(row: { fileName?: string | null; archivePath?: string | null; mimeType?: string | null }) {
  const mime = (row.mimeType ?? "").toLowerCase();
  const ref = `${row.fileName ?? ""} ${row.archivePath ?? ""}`.toLowerCase();
  return mime.startsWith("video/") || /\.(mp4|mov|m4v|mkv|3gp|webm|avi)$/.test(ref);
}

function readRecoveryStatus(metadata: unknown): { excluded: boolean; reason?: string } {
  const row = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  const recovery =
    row.recovery && typeof row.recovery === "object" && !Array.isArray(row.recovery)
      ? (row.recovery as Record<string, unknown>)
      : {};
  return {
    excluded: recovery.excluded === true,
    reason: typeof recovery.reason === "string" ? recovery.reason : undefined
  };
}

export default async function AnalysisAttachmentsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page = parsePage(params.page);
  const q = (params.q ?? "").trim();
  const media = parseMedia(params.media);
  const status = parseStatus(params.status);
  const caseId = params.caseId?.trim() || undefined;
  const extractionId = params.extractionId?.trim() || undefined;

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

  const baseScopeWhere: Prisma.AttachmentWhereInput = {
    AND: [{ messageId: { not: null } }, caseId ? { caseId } : {}, selectedEvidenceId ? { evidenceId: selectedEvidenceId } : {}]
  };

  const where: Prisma.AttachmentWhereInput = {
    AND: [
      baseScopeWhere,
      mediaWhereFilter(media),
      statusWhereFilter(status),
      q
        ? {
            OR: [
              { fileName: { contains: q, mode: "insensitive" } },
              { archivePath: { contains: q, mode: "insensitive" } },
              { message: { body: { contains: q, mode: "insensitive" } } },
              { message: { chat: { is: { title: { contains: q, mode: "insensitive" } } } } }
            ]
          }
        : {}
    ]
  };

  const [total, totalDocuments, totalImages, totalVideos, indexedCount, excludedCount, rows] = await Promise.all([
    prisma.attachment.count({ where }),
    prisma.attachment.count({ where: { AND: [baseScopeWhere, documentWhereFilter()] } }),
    prisma.attachment.count({ where: { AND: [baseScopeWhere, imageWhereFilter()] } }),
    prisma.attachment.count({ where: { AND: [baseScopeWhere, videoWhereFilter()] } }),
    prisma.attachment.count({
      where: {
        AND: [where, { archivePath: { not: null } }, { archivePath: { not: "" } }]
      }
    }),
    prisma.attachment.count({
      where: {
        AND: [
          where,
          {
            metadata: {
              path: ["recovery", "excluded"],
              equals: true
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
        metadata: true,
        createdAt: true,
        message: {
          select: {
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
        }
      }
    })
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pendingCount = Math.max(0, total - indexedCount - excludedCount);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Arquivos da Analise</h2>
      <AnalysisSubnav />

      <Card>
        <CardHeader>
          <CardTitle>Filtros de Arquivos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {([
              { key: "all", label: "Todos", count: total },
              { key: "documents", label: "Documentos", count: totalDocuments },
              { key: "images", label: "Imagens", count: totalImages },
              { key: "videos", label: "Videos", count: totalVideos }
            ] as Array<{ key: MediaFilter; label: string; count: number }>).map((chip) => {
              const active = media === chip.key;
              return (
                <Link
                  key={chip.key}
                  href={buildPageHref({
                    caseId,
                    extractionId,
                    q,
                    media: chip.key,
                    status,
                    page: 1
                  })}
                  className={`rounded-full border px-3 py-1.5 text-sm transition ${
                    active
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  {chip.label} ({chip.count})
                </Link>
              );
            })}
          </div>

          <form method="GET" className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_180px_180px_auto]">
            <select name="caseId" defaultValue={caseId ?? ""} className="h-10 rounded-md border border-zinc-300 px-3 text-sm">
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
              placeholder="Buscar por nome, caminho, chat ou texto da mensagem"
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm"
            />

            <select name="media" defaultValue={media} className="h-10 rounded-md border border-zinc-300 px-3 text-sm">
              <option value="all">Todos os tipos</option>
              <option value="documents">Documentos</option>
              <option value="images">Imagens</option>
              <option value="videos">Videos</option>
            </select>

            <select name="status" defaultValue={status} className="h-10 rounded-md border border-zinc-300 px-3 text-sm">
              <option value="all">Todos os status</option>
              <option value="indexed">Indexados</option>
              <option value="excluded">Excluidos por politica</option>
              <option value="pending">Pendentes</option>
            </select>

            <div className="flex items-center gap-2">
              <Button type="submit" variant="outline">
                Atualizar
              </Button>
            </div>
          </form>

          <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Documentos</p>
              <p className="text-lg font-semibold text-zinc-900">{totalDocuments}</p>
            </div>
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Imagens</p>
              <p className="text-lg font-semibold text-zinc-900">{totalImages}</p>
            </div>
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Videos</p>
              <p className="text-lg font-semibold text-zinc-900">{totalVideos}</p>
            </div>
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Indexados</p>
              <p className="text-lg font-semibold text-zinc-900">{indexedCount}</p>
            </div>
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Excluidos por politica</p>
              <p className="text-lg font-semibold text-zinc-900">{excludedCount}</p>
            </div>
            <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <p className="text-xs text-zinc-500">Pendentes</p>
              <p className="text-lg font-semibold text-zinc-900">{pendingCount}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Lista de Arquivos (pagina {clampedPage} de {totalPages})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 ? <p className="text-sm text-zinc-500">Nenhum arquivo encontrado com este filtro.</p> : null}

          {rows.map((row) => {
            const category = detectCategory(row);
            const recovery = readRecoveryStatus(row.metadata);
            const indexed = Boolean(row.archivePath && row.archivePath.trim().length > 0);
            const canOpen = indexed && !recovery.excluded;
            const statusLabel = recovery.excluded ? "Excluido" : indexed ? "Indexado" : "Pendente";
            return (
              <article key={row.id} className="space-y-2 rounded-lg border border-zinc-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">{baseName(row.fileName, row.archivePath)}</p>
                    <p className="text-xs text-zinc-600">
                      {row.message?.chat?.title ?? "Chat sem titulo"} | {row.message?.chat?.sourceApp ?? "origem desconhecida"}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {row.message?.timestamp ? new Date(row.message.timestamp).toLocaleString("pt-BR") : "Sem data"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded border border-zinc-300 bg-zinc-100 px-2 py-1 text-zinc-700">{category}</span>
                    <span
                      className={`rounded border px-2 py-1 ${
                        recovery.excluded
                          ? "border-rose-300 bg-rose-50 text-rose-700"
                          : indexed
                            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                            : "border-amber-300 bg-amber-50 text-amber-700"
                      }`}
                    >
                      {statusLabel}
                    </span>
                    {canOpen ? (
                      <>
                        <a
                          href={`/api/attachments/${row.id}/content?download=1`}
                          className="rounded border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100"
                        >
                          Baixar
                        </a>
                        <a
                          href={`/api/attachments/${row.id}/content`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100"
                        >
                          Abrir
                        </a>
                      </>
                    ) : (
                      <span className="rounded border border-zinc-200 bg-zinc-100 px-2 py-1 text-zinc-500">
                        Nao recuperavel
                      </span>
                    )}
                    <Link
                      href={`/analysis/messages?${caseId ? `caseId=${encodeURIComponent(caseId)}&` : ""}${extractionId ? `extractionId=${encodeURIComponent(extractionId)}&` : ""}chatId=${row.message?.chat?.id ?? ""}`}
                      className="rounded border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100"
                    >
                      Abrir chat
                    </Link>
                  </div>
                </div>

                {row.archivePath ? <p className="text-xs text-zinc-600">Caminho indexado: {row.archivePath}</p> : null}
                {recovery.reason ? <p className="text-xs text-rose-700">Motivo da exclusao: {recovery.reason}</p> : null}

                {canOpen && isImage(row) ? (
                  <img
                    src={`/api/attachments/${row.id}/content`}
                    alt={baseName(row.fileName, row.archivePath)}
                    className="max-h-56 rounded border border-zinc-200 object-contain"
                    loading="lazy"
                  />
                ) : null}

                {canOpen && isVideo(row) ? (
                  <video controls preload="metadata" className="max-h-64 w-full rounded border border-zinc-200 bg-black">
                    <source src={`/api/attachments/${row.id}/content`} type={row.mimeType ?? undefined} />
                    Seu navegador nao suporta video.
                  </video>
                ) : null}

                {canOpen && isPdf(row) ? (
                  <iframe
                    title={baseName(row.fileName, row.archivePath)}
                    src={`/api/attachments/${row.id}/content`}
                    className="h-64 w-full rounded border border-zinc-200"
                  />
                ) : null}
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
                  media,
                  status,
                  page: clampedPage - 1
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
                  media,
                  status,
                  page: clampedPage + 1
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
