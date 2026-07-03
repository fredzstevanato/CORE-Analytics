import Link from "next/link";
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

type SearchHitSource = Record<string, unknown> & {
  caseId?: string;
  evidenceId?: string;
  extractionId?: string;
  type?: string;
  artifactType?: string;
  sourceApp?: string;
  value?: string;
  text?: string;
  title?: string;
  filename?: string;
  metadata?: unknown;
};

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function buildHref(path: string, params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value?.trim()) query.set(key, value.trim());
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function hitType(source: SearchHitSource) {
  return firstString(source.type, source.artifactType) ?? "RESULTADO";
}

function hitLabel(source: SearchHitSource) {
  const metadata = metadataObject(source.metadata);
  return (
    firstString(
      source.value,
      source.title,
      source.filename,
      source.text,
      metadata.name,
      metadata.fileName,
      metadata.path,
      metadata.body
    ) ?? "Resultado sem titulo"
  );
}

function normalizeLookup(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function phoneFromText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const whatsapp = value.match(/(\d{8,15})@s\.whatsapp\.net/i)?.[1];
  if (whatsapp) return whatsapp;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : undefined;
}

function extractPhoneCandidates(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    const direct = phoneFromText(item);
    if (direct) found.add(direct);
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    Object.values(item as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return [...found];
}

type RelatedContactInfo = {
  phones: string[];
  chats: Array<{ id: string; title: string | null; sourceApp: string | null; evidenceId: string }>;
};

async function buildRelatedContactInfo(hits: Array<{ _source?: SearchHitSource }>) {
  const contactHits = hits
    .map((hit) => hit._source)
    .filter((source): source is SearchHitSource => Boolean(source))
    .filter((source) => ["CONTACT", "ENTITY"].includes(hitType(source).toUpperCase()))
    .map((source) => ({
      caseId: source.caseId,
      label: hitLabel(source),
      key: `${source.caseId ?? ""}|${normalizeLookup(hitLabel(source))}`
    }))
    .filter((item) => item.caseId && item.label.length > 0);

  const unique = [...new Map(contactHits.map((item) => [item.key, item])).values()];
  if (unique.length === 0) return new Map<string, RelatedContactInfo>();

  const caseIds = [...new Set(unique.map((item) => item.caseId as string))];
  const labels = [...new Set(unique.map((item) => item.label))].slice(0, 30);
  const nameOr = labels.flatMap((label) => [
    { name: { contains: label, mode: "insensitive" as const } },
    { handle: { contains: label, mode: "insensitive" as const } },
    { phone: { contains: label, mode: "insensitive" as const } },
    { externalId: { contains: label, mode: "insensitive" as const } }
  ]);

  const [participants, artifacts] = await Promise.all([
    prisma.participant.findMany({
      where: {
        chat: { caseId: { in: caseIds } },
        OR: nameOr
      },
      take: 500,
      select: {
        name: true,
        phone: true,
        handle: true,
        externalId: true,
        chat: { select: { id: true, title: true, sourceApp: true, caseId: true, evidenceId: true } }
      }
    }),
    prisma.artifact.findMany({
      where: {
        caseId: { in: caseIds },
        OR: labels.map((label) => ({ title: { contains: label, mode: "insensitive" as const } }))
      },
      take: 500,
      select: { caseId: true, title: true, metadata: true }
    })
  ]);

  const map = new Map<string, RelatedContactInfo>();
  const add = (key: string, phoneValues: unknown[], chat?: RelatedContactInfo["chats"][number]) => {
    const current = map.get(key) ?? { phones: [], chats: [] };
    const phones = new Set(current.phones);
    phoneValues.flatMap(extractPhoneCandidates).forEach((phone) => phones.add(phone));
    if (chat && !current.chats.some((item) => item.id === chat.id)) current.chats.push(chat);
    current.phones = [...phones].sort();
    map.set(key, current);
  };

  for (const target of unique) {
    const targetLabel = normalizeLookup(target.label);
    for (const participant of participants) {
      if (participant.chat.caseId !== target.caseId) continue;
      const participantLabel = normalizeLookup([participant.name, participant.handle, participant.phone, participant.externalId].filter(Boolean).join(" "));
      if (!participantLabel.includes(targetLabel) && !targetLabel.includes(participantLabel)) continue;
      add(
        target.key,
        [participant.phone, participant.handle, participant.externalId],
        {
          id: participant.chat.id,
          title: participant.chat.title,
          sourceApp: participant.chat.sourceApp,
          evidenceId: participant.chat.evidenceId
        }
      );
    }
    for (const artifact of artifacts) {
      if (artifact.caseId !== target.caseId) continue;
      const artifactLabel = normalizeLookup(artifact.title ?? "");
      if (!artifactLabel.includes(targetLabel) && !targetLabel.includes(artifactLabel)) continue;
      add(target.key, [artifact.metadata]);
    }
  }

  return map;
}

function contextualAnalysisLink(source: SearchHitSource, query: string) {
  const metadata = metadataObject(source.metadata);
  const phones = extractPhoneCandidates([source, metadata]);
  const type = hitType(source).toUpperCase();
  const chatId = firstString(metadata.chatId, metadata.chat_id);
  const attachmentId = firstString(metadata.attachmentId, metadata.attachment_id, metadata.id);
  const sourceApp = firstString(source.sourceApp)?.toLowerCase() ?? "";
  const common = {
    caseId: source.caseId,
    extractionId: source.extractionId,
    q: query.trim() || hitLabel(source)
  };

  if (type === "MESSAGE" || type === "CHAT" || type === "CONTACT" || sourceApp.includes("whatsapp")) {
    return {
      href: buildHref("/analysis/messages", {
        ...common,
        platform: sourceApp.includes("whatsapp") ? "whatsapp" : undefined,
        chatId,
        q: phones[0] ?? common.q
      }),
      label: chatId ? "Abrir chat" : "Buscar em mensagens"
    };
  }

  const filename = firstString(source.filename, metadata.fileName, metadata.name, metadata.path)?.toLowerCase() ?? "";
  if (type === "ATTACHMENT" || filename.match(/\.(opus|ogg|mp3|wav|m4a|amr|aac|flac|wma)$/)) {
    return {
      href: buildHref("/analysis/audios", {
        ...common,
        transcribedOnly: "1"
      }),
      label: attachmentId ? "Abrir audios" : "Buscar em audios"
    };
  }

  if (type === "FILE" || type === "ATTACHMENT") {
    return {
      href: buildHref("/analysis/attachments", common),
      label: "Buscar em arquivos"
    };
  }

  return {
    href: buildHref("/analysis/search", {
      q: query.trim() || hitLabel(source),
      scope: "all",
      caseId: source.caseId,
      evidenceId: source.evidenceId,
      extractionId: source.extractionId
    }),
    label: "Abrir busca filtrada"
  };
}

function ResultAction({
  href,
  children
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </Link>
    </Button>
  );
}

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

  let hits: Array<{ _id?: string; _source?: SearchHitSource }> = [];
  let searchError: string | null = null;

  if (q.trim().length > 0) {
    try {
      hits = (await investigativeSearch({
        query: q,
        filters,
        scope: scopedIndices
      })) as Array<{ _id?: string; _source?: SearchHitSource }>;
    } catch (error) {
      searchError = error instanceof Error ? error.message : "Falha na busca.";
    }
  }
  const relatedContactInfo = await buildRelatedContactInfo(hits);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Busca Investigativa</h2>
      <AnalysisSubnav />
      <Card>
        <CardHeader>
          <CardTitle>Consulta Full-Text</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="grid min-w-0 gap-2 lg:grid-cols-[minmax(180px,1fr)_minmax(160px,1fr)_minmax(220px,1.2fr)_minmax(180px,1fr)] xl:grid-cols-[minmax(180px,1fr)_minmax(160px,1fr)_minmax(220px,1.2fr)_minmax(180px,1fr)_minmax(260px,1.4fr)]" method="GET">
            <Input className="min-w-0" name="q" defaultValue={q} placeholder="texto, numero, contato..." />
            <Input
              className="min-w-0"
              name="scope"
              defaultValue={scope}
              placeholder="all ou messages,chats,entities,attachments,calls,files"
            />
            <select
              name="caseId"
              defaultValue={params.caseId ?? ""}
              className="h-10 min-w-0 rounded-md border border-zinc-300 px-3 text-sm"
            >
              <option value="">Todos os casos</option>
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caseNumber} - {item.title}
                </option>
              ))}
            </select>
            <Input className="min-w-0" name="evidenceId" defaultValue={params.evidenceId ?? ""} placeholder="evidenceId opcional" />
            <div className="flex min-w-0 gap-2 max-sm:flex-col">
              <select
                name="extractionId"
                defaultValue={params.extractionId ?? ""}
                className="h-10 min-w-0 flex-1 rounded-md border border-zinc-300 px-3 text-sm"
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
              <Button className="shrink-0" type="submit">Buscar</Button>
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
          {hits.map((hit, index) => {
            const source = hit._source ?? {};
            const analysisLink = contextualAnalysisLink(source, q);
            const directPhones = extractPhoneCandidates(source);
            const relatedInfo = relatedContactInfo.get(`${source.caseId ?? ""}|${normalizeLookup(hitLabel(source))}`);
            const phones = [...new Set([...directPhones, ...(relatedInfo?.phones ?? [])])];
            const firstRelatedChat = relatedInfo?.chats[0];
            return (
              <article key={hit._id ?? `${index}`} className="rounded border border-zinc-200 bg-white p-3">
                <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-zinc-900 px-2 py-1 text-xs font-semibold uppercase text-white">
                        {hitType(source)}
                      </span>
                      {source.sourceApp ? (
                        <span className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-700">
                          {String(source.sourceApp)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 break-words text-sm font-semibold text-zinc-900">{hitLabel(source)}</p>
                    <p className="mt-1 break-all text-xs text-zinc-500">
                      Caso: {source.caseId ?? "N/D"} | Evidencia: {source.evidenceId ?? "N/D"} | Extracao:{" "}
                      {source.extractionId ?? "N/D"}
                    </p>
                    <p className="mt-1 text-xs text-zinc-700">
                      Telefone/WhatsApp:{" "}
                      {phones.length > 0 ? (
                        <span className="font-semibold text-zinc-900">{phones.join(" | ")}</span>
                      ) : (
                        <span className="text-zinc-500">nao informado no indice</span>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ResultAction href={analysisLink.href}>{analysisLink.label}</ResultAction>
                    {firstRelatedChat ? (
                      <ResultAction
                        href={buildHref("/analysis/messages", {
                          caseId: source.caseId,
                          extractionId: source.extractionId,
                          platform: firstRelatedChat.sourceApp?.toLowerCase().includes("whatsapp") ? "whatsapp" : undefined,
                          chatId: firstRelatedChat.id,
                          q: phones[0] ?? q
                        })}
                      >
                        Abrir chat relacionado
                      </ResultAction>
                    ) : null}
                    {source.caseId ? <ResultAction href={`/cases/${source.caseId}`}>Abrir caso</ResultAction> : null}
                    {source.evidenceId ? (
                      <ResultAction href={`/evidences/${source.evidenceId}`}>Abrir evidencia</ResultAction>
                    ) : null}
                    {source.extractionId ? (
                      <ResultAction href={`/extractions/${source.extractionId}`}>Abrir extracao</ResultAction>
                    ) : null}
                  </div>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-zinc-600">Ver dados tecnicos do indice</summary>
                  <pre className="mt-2 overflow-x-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-xs">
                    {JSON.stringify(source, null, 2)}
                  </pre>
                </details>
              </article>
            );
          })}
          {hits.length === 0 ? <p className="text-sm text-zinc-500">Sem resultados.</p> : null}
        </CardContent>
      </Card>
    </section>
  );
}
