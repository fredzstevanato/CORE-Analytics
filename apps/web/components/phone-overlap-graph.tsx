"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type PhoneCategory = "GREEN" | "YELLOW" | "RED";

type PhoneNode = {
  phone: string;
  evidenceIds: string[];
  evidenceCount: number;
  hasCalls: boolean;
  hasMessages: boolean;
  category: PhoneCategory;
  triageSelected: boolean;
  triageChats: Array<{
    chatId: string;
    label: string;
    sourceApp: string;
    rationale: string;
    excerpt: string;
    relevanceLevel: string;
    relevanceScore: number;
  }>;
  callSummaries: Array<{
    evidenceId: string;
    evidenceLabel: string;
    summary: string;
  }>;
  sourceCounts: {
    participantPhone: number;
    participantHandle: number;
    senderId: number;
    messageBody: number;
    transcription: number;
  };
};

type EvidenceNode = {
  id: string;
  label: string;
};

type UfdrLink = {
  id: string;
  evidenceId: string;
  targetKind: "PHONE" | "GROUP";
  targetId: string;
  triageSelected: boolean;
  category: PhoneCategory;
};

type GroupNode = {
  id: string;
  label: string;
  sourceApp: string;
  evidenceId: string;
  participantPhones: string[];
  messageCount: number;
  triageSelected: boolean;
};

type CaseOption = {
  id: string;
  label: string;
};

type Props = {
  caseId: string;
  caseOptions: CaseOption[];
  currentLimit: number;
  triageInsightId: string | null;
  phones: PhoneNode[];
  evidences: EvidenceNode[];
  links: UfdrLink[];
  groups: GroupNode[];
};

type Selection =
  | { kind: "phone"; id: string }
  | { kind: "group"; id: string }
  | { kind: "evidence"; id: string }
  | null;

type CategoryFilter = "ALL" | "GREEN" | "YELLOW" | "RED";

type TriageChatModal = {
  chatId: string;
  label: string;
  sourceApp: string;
  assessment?: {
    rationale: string;
    excerpt: string;
    relevanceLevel: string;
    relevanceScore: number;
  };
  messages: Array<{
    id: string;
    senderId: string | null;
    body: string | null;
    transcriptions: string[];
  }>;
};

type PhoneContextChat = {
  chatId: string;
  label: string;
  sourceApp: string;
  participantMatch: boolean;
  participants: Array<{
    id: string;
    name: string | null;
    handle: string | null;
    phone: string | null;
  }>;
  messages: Array<{
    id: string;
    senderId: string | null;
    body: string | null;
    timestamp: string | null;
    transcriptions: string[];
  }>;
};

type GroupContextPayload = {
  group?: {
    id: string;
    label: string;
    sourceApp: string;
    participants: Array<{
      id: string;
      name: string | null;
      handle: string | null;
      phone: string | null;
    }>;
    messages: Array<{
      id: string;
      senderId: string | null;
      body: string | null;
      timestamp: string | null;
      transcriptions: string[];
    }>;
  };
  error?: string;
};

const palette: Record<PhoneCategory, { fill: string; stroke: string; label: string }> = {
  GREEN: {
    fill: "#2E8B57",
    stroke: "#18603A",
    label: "Vinculo sem ligacoes e sem mensagens"
  },
  YELLOW: {
    fill: "#D6A400",
    stroke: "#8B6A00",
    label: "Vinculo com ligacoes"
  },
  RED: {
    fill: "#C53030",
    stroke: "#7B1D1D",
    label: "Vinculo com ligacoes e mensagens"
  }
};

function phoneLabel(phone: string) {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 4)}...${phone.slice(-4)}`;
}

export function PhoneOverlapGraph({
  caseId,
  caseOptions,
  currentLimit,
  triageInsightId,
  phones,
  evidences,
  links,
  groups
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const svgRef = useRef<SVGSVGElement | null>(null);

  const [onlyRed, setOnlyRed] = useState(false);
  const [caseSearch, setCaseSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("ALL");
  const [onlyTriageSelected, setOnlyTriageSelected] = useState(false);
  const [selection, setSelection] = useState<Selection>(phones[0] ? { kind: "phone", id: phones[0].phone } : null);

  const [triageModalOpen, setTriageModalOpen] = useState(false);
  const [triageModalBusy, setTriageModalBusy] = useState(false);
  const [triageModalError, setTriageModalError] = useState<string | null>(null);
  const [triageModalChats, setTriageModalChats] = useState<TriageChatModal[]>([]);

  const [phoneChatsModalOpen, setPhoneChatsModalOpen] = useState(false);
  const [phoneChatsModalBusy, setPhoneChatsModalBusy] = useState(false);
  const [phoneChatsModalError, setPhoneChatsModalError] = useState<string | null>(null);
  const [phoneChatsModalPhone, setPhoneChatsModalPhone] = useState<string | null>(null);
  const [phoneChatsModalChats, setPhoneChatsModalChats] = useState<PhoneContextChat[]>([]);

  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupModalBusy, setGroupModalBusy] = useState(false);
  const [groupModalError, setGroupModalError] = useState<string | null>(null);
  const [groupModalData, setGroupModalData] = useState<GroupContextPayload["group"] | null>(null);

  const filteredCaseOptions = useMemo(() => {
    const normalized = caseSearch.trim().toLowerCase();
    if (!normalized) return caseOptions;
    return caseOptions.filter((option) => option.label.toLowerCase().includes(normalized) || option.id.includes(normalized));
  }, [caseOptions, caseSearch]);

  const evidenceById = useMemo(() => new Map(evidences.map((item) => [item.id, item.label])), [evidences]);

  function handleCaseChange(nextCaseId: string) {
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("caseId", nextCaseId);
    if (!nextParams.get("limit")) nextParams.set("limit", String(currentLimit));
    router.push(`${pathname}?${nextParams.toString()}`);
  }

  function handleLimitChange(nextLimit: number) {
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("limit", String(nextLimit));
    nextParams.set("caseId", caseId);
    router.push(`${pathname}?${nextParams.toString()}`);
  }

  const visiblePhones = useMemo(() => {
    let rows = onlyRed ? phones.filter((phone) => phone.category === "RED") : phones;
    if (categoryFilter !== "ALL") {
      rows = rows.filter((phone) => phone.category === categoryFilter);
    }
    if (onlyTriageSelected) {
      rows = rows.filter((phone) => phone.triageSelected);
    }
    return rows;
  }, [phones, onlyRed, categoryFilter, onlyTriageSelected]);

  const visibleGroups = useMemo(() => {
    if (!onlyTriageSelected) return groups;
    return groups.filter((group) => group.triageSelected);
  }, [groups, onlyTriageSelected]);

  const orderedPhones = useMemo(
    () => [...visiblePhones].sort((a, b) => b.evidenceCount - a.evidenceCount || a.phone.localeCompare(b.phone)),
    [visiblePhones]
  );

  const orderedGroups = useMemo(
    () => [...visibleGroups].sort((a, b) => b.participantPhones.length - a.participantPhones.length || a.label.localeCompare(b.label)),
    [visibleGroups]
  );

  const visiblePhoneSet = useMemo(() => new Set(orderedPhones.map((item) => item.phone)), [orderedPhones]);
  const visibleGroupSet = useMemo(() => new Set(orderedGroups.map((item) => item.id)), [orderedGroups]);
  const visibleEvidenceSet = useMemo(() => new Set(evidences.map((item) => item.id)), [evidences]);

  const visibleLinks = useMemo(
    () =>
      links.filter((link) => {
        if (!visibleEvidenceSet.has(link.evidenceId)) return false;
        if (link.targetKind === "PHONE") return visiblePhoneSet.has(link.targetId);
        return visibleGroupSet.has(link.targetId);
      }),
    [links, visibleEvidenceSet, visiblePhoneSet, visibleGroupSet]
  );

  const orderedEvidences = useMemo(() => {
    const linkedIds = new Set(visibleLinks.map((link) => link.evidenceId));
    return evidences.filter((item) => linkedIds.has(item.id));
  }, [evidences, visibleLinks]);

  useEffect(() => {
    if (!selection) return;
    if (selection.kind === "phone" && !orderedPhones.some((phone) => phone.phone === selection.id)) {
      setSelection(orderedPhones[0] ? { kind: "phone", id: orderedPhones[0].phone } : null);
      return;
    }
    if (selection.kind === "group" && !orderedGroups.some((group) => group.id === selection.id)) {
      setSelection(orderedGroups[0] ? { kind: "group", id: orderedGroups[0].id } : null);
      return;
    }
    if (selection.kind === "evidence" && !orderedEvidences.some((evidence) => evidence.id === selection.id)) {
      setSelection(orderedEvidences[0] ? { kind: "evidence", id: orderedEvidences[0].id } : null);
    }
  }, [selection, orderedPhones, orderedGroups, orderedEvidences]);

  const graphSize = useMemo(() => {
    const minHeight = 680;
    const entityCount = orderedPhones.length + orderedGroups.length;
    const rowCount = Math.max(entityCount, orderedEvidences.length);
    return {
      width: 1260,
      height: Math.max(minHeight, 120 + rowCount * 42)
    };
  }, [orderedPhones.length, orderedGroups.length, orderedEvidences.length]);

  const positions = useMemo(() => {
    const entityX = 260;
    const evidenceX = 980;
    const topY = 70;
    const usableHeight = Math.max(220, graphSize.height - 140);

    const totalEntities = orderedPhones.length + orderedGroups.length;
    const entityMap = new Map<string, { x: number; y: number }>();

    orderedPhones.forEach((phone, index) => {
      const step = totalEntities <= 1 ? 0 : usableHeight / (totalEntities - 1);
      entityMap.set(`P:${phone.phone}`, { x: entityX, y: topY + index * step });
    });

    orderedGroups.forEach((group, index) => {
      const row = orderedPhones.length + index;
      const step = totalEntities <= 1 ? 0 : usableHeight / (totalEntities - 1);
      entityMap.set(`G:${group.id}`, { x: entityX, y: topY + row * step });
    });

    const evidenceMap = new Map<string, { x: number; y: number }>();
    orderedEvidences.forEach((evidence, index) => {
      const step = orderedEvidences.length <= 1 ? 0 : usableHeight / (orderedEvidences.length - 1);
      evidenceMap.set(evidence.id, { x: evidenceX, y: topY + index * step });
    });

    return { entityMap, evidenceMap };
  }, [graphSize.height, orderedPhones, orderedGroups, orderedEvidences]);

  const selectedPhone = selection?.kind === "phone" ? orderedPhones.find((phone) => phone.phone === selection.id) ?? null : null;
  const selectedGroup = selection?.kind === "group" ? orderedGroups.find((group) => group.id === selection.id) ?? null : null;
  const selectedEvidence =
    selection?.kind === "evidence" ? orderedEvidences.find((evidence) => evidence.id === selection.id) ?? null : null;

  const evidencePhoneLinks = useMemo(() => {
    if (!selectedEvidence) return [] as PhoneNode[];
    const linkedPhoneIds = new Set(
      visibleLinks
        .filter((link) => link.evidenceId === selectedEvidence.id && link.targetKind === "PHONE")
        .map((link) => link.targetId)
    );
    return orderedPhones.filter((phone) => linkedPhoneIds.has(phone.phone));
  }, [selectedEvidence, visibleLinks, orderedPhones]);

  const evidenceGroupLinks = useMemo(() => {
    if (!selectedEvidence) return [] as GroupNode[];
    const linkedGroupIds = new Set(
      visibleLinks
        .filter((link) => link.evidenceId === selectedEvidence.id && link.targetKind === "GROUP")
        .map((link) => link.targetId)
    );
    return orderedGroups.filter((group) => linkedGroupIds.has(group.id));
  }, [selectedEvidence, visibleLinks, orderedGroups]);

  async function openTriageModal() {
    if (!selectedPhone) return;
    if (selectedPhone.triageChats.length === 0) return;

    setTriageModalOpen(true);
    setTriageModalBusy(true);
    setTriageModalError(null);
    setTriageModalChats([]);

    try {
      const chats = await Promise.all(
        selectedPhone.triageChats.slice(0, 8).map(async (chat) => {
          const params = new URLSearchParams({ caseId, relevantOnly: "1" });
          if (triageInsightId) params.set("triageInsightId", triageInsightId);
          const response = await fetch(`/api/investigation/chats/${chat.chatId}?${params.toString()}`);
          const payload = (await response.json()) as {
            chat?: {
              chatId: string;
              label: string;
              sourceApp: string;
              assessment?: {
                rationale: string;
                excerpt: string;
                relevanceLevel: string;
                relevanceScore: number;
              };
              messages: Array<{
                id: string;
                senderId: string | null;
                body: string | null;
                transcriptions: string[];
              }>;
            };
            error?: string;
          };

          if (!response.ok || !payload.chat) {
            throw new Error(payload.error ?? `Falha ao carregar chat ${chat.chatId}.`);
          }

          return {
            chatId: payload.chat.chatId,
            label: payload.chat.label,
            sourceApp: payload.chat.sourceApp,
            assessment: payload.chat.assessment
              ? {
                  rationale: payload.chat.assessment.rationale,
                  excerpt: payload.chat.assessment.excerpt,
                  relevanceLevel: payload.chat.assessment.relevanceLevel,
                  relevanceScore: payload.chat.assessment.relevanceScore
                }
              : {
                  rationale: chat.rationale,
                  excerpt: chat.excerpt,
                  relevanceLevel: chat.relevanceLevel,
                  relevanceScore: chat.relevanceScore
                },
            messages: payload.chat.messages
          } satisfies TriageChatModal;
        })
      );

      setTriageModalChats(chats);
    } catch (error) {
      setTriageModalError(error instanceof Error ? error.message : "Falha ao carregar justificativa da triagem.");
    } finally {
      setTriageModalBusy(false);
    }
  }

  async function openPhoneChatsModal(phone: string) {
    setPhoneChatsModalOpen(true);
    setPhoneChatsModalBusy(true);
    setPhoneChatsModalError(null);
    setPhoneChatsModalPhone(phone);
    setPhoneChatsModalChats([]);

    try {
      const params = new URLSearchParams({ caseId, phone });
      const response = await fetch(`/api/graph/phone-context?${params.toString()}`);
      const payload = (await response.json()) as {
        chats?: PhoneContextChat[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao carregar chats relacionados.");
      }

      setPhoneChatsModalChats(payload.chats ?? []);
    } catch (error) {
      setPhoneChatsModalError(error instanceof Error ? error.message : "Falha ao carregar chats relacionados.");
    } finally {
      setPhoneChatsModalBusy(false);
    }
  }

  async function openGroupModal(groupId: string) {
    setGroupModalOpen(true);
    setGroupModalBusy(true);
    setGroupModalError(null);
    setGroupModalData(null);

    try {
      const params = new URLSearchParams({ caseId, groupId });
      const response = await fetch(`/api/graph/group-context?${params.toString()}`);
      const payload = (await response.json()) as GroupContextPayload;

      if (!response.ok || !payload.group) {
        throw new Error(payload.error ?? "Falha ao carregar contexto do grupo.");
      }

      setGroupModalData(payload.group);
    } catch (error) {
      setGroupModalError(error instanceof Error ? error.message : "Falha ao carregar contexto do grupo.");
    } finally {
      setGroupModalBusy(false);
    }
  }

  async function exportAsPng() {
    const svg = svgRef.current;
    if (!svg) return;

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svg);
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    try {
      const image = new Image();
      image.crossOrigin = "anonymous";

      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Falha ao renderizar SVG para exportacao PNG."));
        image.src = url;
      });

      const canvas = document.createElement("canvas");
      canvas.width = graphSize.width;
      canvas.height = graphSize.height;
      const context = canvas.getContext("2d");
      if (!context) return;

      context.fillStyle = "#FAFAFA";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);

      const pngUrl = canvas.toDataURL("image/png");
      const anchor = document.createElement("a");
      anchor.href = pngUrl;
      anchor.download = `grafo-telefonico-${caseId}.png`;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-3 z-20 rounded-lg border border-zinc-200 bg-white/95 p-3 backdrop-blur">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label htmlFor="graph-case-selector" className="text-sm text-zinc-700">
            Caso
          </label>
          <input
            type="search"
            value={caseSearch}
            onChange={(event) => setCaseSearch(event.target.value)}
            placeholder="Buscar por numero ou titulo"
            className="w-full max-w-[280px] rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800"
          />
          <select
            id="graph-case-selector"
            value={caseId}
            onChange={(event) => handleCaseChange(event.target.value)}
            className="max-w-[520px] rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800"
          >
            {filteredCaseOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <label htmlFor="graph-limit-selector" className="text-sm text-zinc-700">
            Limite
          </label>
          <select
            id="graph-limit-selector"
            value={String(currentLimit)}
            onChange={(event) => handleLimitChange(Number(event.target.value))}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800"
          >
            {[60, 100, 140, 200, 300, 500].map((limit) => (
              <option key={limit} value={String(limit)}>
                {limit}
              </option>
            ))}
          </select>
          <label htmlFor="graph-category-selector" className="text-sm text-zinc-700">
            Categoria
          </label>
          <select
            id="graph-category-selector"
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value as CategoryFilter)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800"
          >
            <option value="ALL">Todas</option>
            <option value="GREEN">Verde</option>
            <option value="YELLOW">Amarelo</option>
            <option value="RED">Vermelho</option>
          </select>
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button type="button" variant={onlyRed ? "default" : "outline"} size="sm" onClick={() => setOnlyRed((value) => !value)}>
            {onlyRed ? "Mostrando apenas vermelhos" : "Filtrar apenas vermelhos"}
          </Button>
          <label className="inline-flex items-center gap-2 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700">
            <input type="checkbox" checked={onlyTriageSelected} onChange={(event) => setOnlyTriageSelected(event.target.checked)} />
            Somente vinculos selecionados na triagem
          </label>
          <Button type="button" variant="outline" size="sm" onClick={exportAsPng}>
            Exportar PNG
          </Button>
        </div>

        <div className="flex flex-wrap gap-3 text-xs text-zinc-700">
          {(["GREEN", "YELLOW", "RED"] as const).map((key) => (
            <span key={key} className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-2 py-1">
              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: palette[key].fill }} />
              {palette[key].label}
            </span>
          ))}
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-2 py-1">
            <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">G</span>
            Grupo de conversa
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-2 py-1">
            <span className="h-3 w-3 rounded border border-zinc-600 bg-zinc-700" />
            UFDR
          </span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardTitle>Mapa de Vínculos UFDR x Telefones/Grupos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-auto rounded-md border border-zinc-200 bg-zinc-50">
              <svg ref={svgRef} width={graphSize.width} height={graphSize.height} className="block">
                <rect x={0} y={0} width={graphSize.width} height={graphSize.height} fill="#FAFAFA" />
                <text x={140} y={28} fontSize={13} fontWeight={600} fill="#111827">
                  Entidades ({orderedPhones.length + orderedGroups.length})
                </text>
                <text x={910} y={28} fontSize={13} fontWeight={600} fill="#111827">
                  UFDR ({orderedEvidences.length})
                </text>

                {visibleLinks.map((link) => {
                  const entityKey = link.targetKind === "PHONE" ? `P:${link.targetId}` : `G:${link.targetId}`;
                  const from = positions.entityMap.get(entityKey);
                  const to = positions.evidenceMap.get(link.evidenceId);
                  if (!from || !to) return null;

                  const stroke = link.targetKind === "PHONE" ? palette[link.category].stroke : "#1D4ED8";
                  const selected =
                    (selection?.kind === "phone" && link.targetKind === "PHONE" && selection.id === link.targetId) ||
                    (selection?.kind === "group" && link.targetKind === "GROUP" && selection.id === link.targetId) ||
                    (selection?.kind === "evidence" && selection.id === link.evidenceId);

                  return (
                    <line
                      key={link.id}
                      x1={from.x + 10}
                      y1={from.y}
                      x2={to.x - 10}
                      y2={to.y}
                      stroke={stroke}
                      strokeWidth={link.triageSelected ? 2.6 : selected ? 2 : 1.2}
                      opacity={selected ? 0.96 : 0.52}
                      strokeDasharray={link.targetKind === "GROUP" ? "5 4" : ""}
                    />
                  );
                })}

                {orderedPhones.map((phone) => {
                  const position = positions.entityMap.get(`P:${phone.phone}`);
                  if (!position) return null;
                  const color = palette[phone.category];
                  const selected = selection?.kind === "phone" && selection.id === phone.phone;
                  return (
                    <g
                      key={phone.phone}
                      onClick={() => {
                        setSelection({ kind: "phone", id: phone.phone });
                        if (phone.category === "RED") {
                          void openPhoneChatsModal(phone.phone);
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <circle
                        cx={position.x}
                        cy={position.y}
                        r={selected ? 10 : 8}
                        fill={color.fill}
                        stroke={phone.triageSelected ? "#1D4ED8" : color.stroke}
                        strokeWidth={selected ? 3 : 1.5}
                      />
                      <text x={position.x - 14} y={position.y + 4} textAnchor="end" fontSize={11} fill="#1F2937">
                        {phoneLabel(phone.phone)}
                      </text>
                    </g>
                  );
                })}

                {orderedGroups.map((group) => {
                  const position = positions.entityMap.get(`G:${group.id}`);
                  if (!position) return null;
                  const selected = selection?.kind === "group" && selection.id === group.id;
                  return (
                    <g
                      key={group.id}
                      onClick={() => {
                        setSelection({ kind: "group", id: group.id });
                        void openGroupModal(group.id);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <circle
                        cx={position.x}
                        cy={position.y}
                        r={selected ? 12 : 10}
                        fill={selected ? "#1D4ED8" : "#2563EB"}
                        stroke={group.triageSelected ? "#1E3A8A" : "#1D4ED8"}
                        strokeWidth={selected ? 3 : 1.6}
                      />
                      <text x={position.x} y={position.y + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill="#FFFFFF">
                        G
                      </text>
                      <text x={position.x - 14} y={position.y + 4} textAnchor="end" fontSize={11} fill="#1F2937">
                        {group.label}
                      </text>
                    </g>
                  );
                })}

                {orderedEvidences.map((evidence) => {
                  const position = positions.evidenceMap.get(evidence.id);
                  if (!position) return null;
                  const selected = selection?.kind === "evidence" && selection.id === evidence.id;
                  return (
                    <g
                      key={evidence.id}
                      onClick={() => setSelection({ kind: "evidence", id: evidence.id })}
                      style={{ cursor: "pointer" }}
                    >
                      <rect
                        x={position.x - 11}
                        y={position.y - 11}
                        width={22}
                        height={22}
                        rx={4}
                        fill={selected ? "#111827" : "#334155"}
                      />
                      <text x={position.x + 16} y={position.y + 4} textAnchor="start" fontSize={11} fill="#111827">
                        {evidence.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Detalhes do Nó</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-zinc-500">Caso: {caseId}</p>

            {!selection && <p className="text-zinc-600">Clique em um nó para ver os vínculos específicos.</p>}

            {selectedPhone && (
              <div className="space-y-2">
                <p className="font-semibold">Telefone {selectedPhone.phone}</p>
                <p>
                  Categoria: <span className="font-medium">{palette[selectedPhone.category].label}</span>
                </p>
                <p>
                  Vinculo selecionado na triagem: <span className="font-medium">{selectedPhone.triageSelected ? "sim" : "nao"}</span>
                </p>
                <p>UFDRs vinculadas: {selectedPhone.evidenceCount}</p>
                <p>
                  Indicadores: ligacoes {selectedPhone.hasCalls ? "sim" : "nao"} | mensagens {selectedPhone.hasMessages ? "sim" : "nao"}
                </p>
                <p>
                  Fontes: sender-id {selectedPhone.sourceCounts.senderId}, body {selectedPhone.sourceCounts.messageBody}, transcricao {selectedPhone.sourceCounts.transcription}
                </p>
                <div>
                  <p className="mb-1 font-medium">UFDRs vinculadas</p>
                  <ul className="max-h-52 space-y-1 overflow-auto rounded-md border border-zinc-200 p-2 text-xs">
                    {selectedPhone.evidenceIds.map((evidenceId) => (
                      <li key={evidenceId} className="rounded bg-zinc-100 px-2 py-1">
                        {evidenceById.get(evidenceId) ?? evidenceId}
                      </li>
                    ))}
                  </ul>
                </div>
                {selectedPhone.triageSelected ? (
                  <Button type="button" size="sm" variant="outline" onClick={openTriageModal}>
                    Ver justificativa da triagem
                  </Button>
                ) : null}
                <div>
                  <p className="mb-1 font-medium">Ligacoes relacionadas (conteudo)</p>
                  {selectedPhone.callSummaries.length === 0 ? (
                    <p className="text-xs text-zinc-500">Sem conteudo de ligacoes associado a este telefone.</p>
                  ) : (
                    <ul className="max-h-44 space-y-1 overflow-auto rounded-md border border-zinc-200 p-2 text-xs">
                      {selectedPhone.callSummaries.slice(0, 12).map((item, index) => (
                        <li key={`${item.evidenceId}-${index}`} className="rounded bg-zinc-100 px-2 py-1">
                          <p className="font-medium">{item.evidenceLabel}</p>
                          <p className="text-zinc-700">{item.summary}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {selectedGroup && (
              <div className="space-y-2">
                <p className="font-semibold">Grupo {selectedGroup.label}</p>
                <p>Origem: {selectedGroup.sourceApp}</p>
                <p>Participantes no grafo: {selectedGroup.participantPhones.length}</p>
                <p>Mensagens no grupo: {selectedGroup.messageCount}</p>
                <p>UFDR: {evidenceById.get(selectedGroup.evidenceId) ?? selectedGroup.evidenceId}</p>
                <div>
                  <p className="mb-1 font-medium">Telefones neste grupo</p>
                  <ul className="max-h-60 space-y-1 overflow-auto rounded-md border border-zinc-200 p-2 text-xs">
                    {selectedGroup.participantPhones.map((phone) => (
                      <li key={phone} className="rounded bg-zinc-100 px-2 py-1">
                        {phone}
                      </li>
                    ))}
                  </ul>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => void openGroupModal(selectedGroup.id)}>
                  Ver mensagens e participantes do grupo
                </Button>
              </div>
            )}

            {selectedEvidence && (
              <div className="space-y-2">
                <p className="font-semibold">UFDR {selectedEvidence.label}</p>
                <p>Telefones vinculados: {evidencePhoneLinks.length}</p>
                <p>Grupos vinculados: {evidenceGroupLinks.length}</p>
                <div>
                  <p className="mb-1 font-medium">Numeros individuais</p>
                  <ul className="max-h-44 space-y-1 overflow-auto rounded-md border border-zinc-200 p-2 text-xs">
                    {evidencePhoneLinks.map((phone) => (
                      <li key={phone.phone} className="rounded bg-zinc-100 px-2 py-1">
                        {phone.phone}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-1 font-medium">Grupos de conversa</p>
                  <ul className="max-h-44 space-y-1 overflow-auto rounded-md border border-zinc-200 p-2 text-xs">
                    {evidenceGroupLinks.map((group) => (
                      <li key={group.id} className="rounded bg-zinc-100 px-2 py-1">
                        {group.label} ({group.participantPhones.length} participantes)
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {triageModalOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[88vh] w-full max-w-4xl overflow-auto rounded-lg border border-zinc-300 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Justificativa do vinculo selecionado na triagem</h3>
              <Button type="button" size="sm" variant="outline" onClick={() => setTriageModalOpen(false)}>
                Fechar
              </Button>
            </div>
            {selectedPhone ? <p className="mb-3 text-sm text-zinc-700">Telefone analisado: {selectedPhone.phone}</p> : null}

            {triageModalBusy ? <p className="text-sm text-zinc-600">Carregando chats e justificativas...</p> : null}
            {triageModalError ? <p className="text-sm text-red-700">{triageModalError}</p> : null}

            {!triageModalBusy && !triageModalError ? (
              <div className="space-y-3">
                {triageModalChats.map((chat) => (
                  <div key={chat.chatId} className="rounded border border-zinc-200 p-3">
                    <p className="font-medium">
                      {chat.label} ({chat.sourceApp})
                    </p>
                    {chat.assessment ? (
                      <>
                        <p className="text-xs text-zinc-700">
                          Relevancia: {chat.assessment.relevanceLevel} (score {chat.assessment.relevanceScore})
                        </p>
                        <p className="mt-1 text-sm text-zinc-800">Motivo: {chat.assessment.rationale}</p>
                        {chat.assessment.excerpt ? (
                          <p className="mt-1 rounded bg-zinc-100 p-2 text-xs text-zinc-700">Trecho: {chat.assessment.excerpt}</p>
                        ) : null}
                      </>
                    ) : null}

                    <div className="mt-2">
                      <p className="mb-1 text-xs font-medium uppercase text-zinc-500">Mensagens relacionadas</p>
                      {chat.messages.length === 0 ? (
                        <p className="text-xs text-zinc-500">Sem mensagens retornadas para este chat.</p>
                      ) : (
                        <ul className="space-y-1 text-xs">
                          {chat.messages.slice(0, 8).map((message) => (
                            <li key={message.id} className="rounded bg-zinc-50 px-2 py-1">
                              <p className="font-medium">{message.senderId ?? "interlocutor"}</p>
                              {message.body ? <p>{message.body}</p> : null}
                              {message.transcriptions.length > 0 ? (
                                <p className="text-zinc-600">Transcricao: {message.transcriptions.join(" | ")}</p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}

                {selectedPhone?.callSummaries?.length ? (
                  <div className="rounded border border-zinc-200 p-3">
                    <p className="mb-1 font-medium">Ligacoes relacionadas ao vinculo</p>
                    <ul className="space-y-1 text-xs">
                      {selectedPhone.callSummaries.slice(0, 12).map((item, index) => (
                        <li key={`${item.evidenceId}-${index}`} className="rounded bg-zinc-50 px-2 py-1">
                          <p className="font-medium">{item.evidenceLabel}</p>
                          <p>{item.summary}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {phoneChatsModalOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4">
          <div className="max-h-[90vh] w-full max-w-[1500px] overflow-auto rounded-lg border border-zinc-300 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Chats relacionados ao vinculo</h3>
              <Button type="button" size="sm" variant="outline" onClick={() => setPhoneChatsModalOpen(false)}>
                Fechar
              </Button>
            </div>
            <p className="mb-3 text-sm text-zinc-700">Telefone: {phoneChatsModalPhone ?? "N/D"}</p>

            {phoneChatsModalBusy ? <p className="text-sm text-zinc-600">Carregando chats...</p> : null}
            {phoneChatsModalError ? <p className="text-sm text-red-700">{phoneChatsModalError}</p> : null}

            {!phoneChatsModalBusy && !phoneChatsModalError ? (
              phoneChatsModalChats.length === 0 ? (
                <p className="text-sm text-zinc-600">Nenhum chat relacionado encontrado para este telefone.</p>
              ) : (
                <div className="overflow-x-auto">
                  <div className="grid min-w-[980px] grid-flow-col auto-cols-[320px] gap-3">
                    {phoneChatsModalChats.map((chat) => (
                      <div key={chat.chatId} className="rounded border border-zinc-200 bg-zinc-50 p-3">
                        <p className="font-medium">{chat.label}</p>
                        <p className="text-xs text-zinc-600">Origem: {chat.sourceApp}</p>
                        <p className="text-xs text-zinc-600">Participante com match direto: {chat.participantMatch ? "sim" : "nao"}</p>

                        <div className="mt-2">
                          <p className="mb-1 text-xs font-medium uppercase text-zinc-500">Participantes</p>
                          <ul className="space-y-1 text-xs">
                            {chat.participants.slice(0, 8).map((participant) => (
                              <li key={participant.id} className="rounded bg-white px-2 py-1">
                                {(participant.name ?? "sem-nome")} | {participant.phone ?? participant.handle ?? "sem-contato"}
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div className="mt-2">
                          <p className="mb-1 text-xs font-medium uppercase text-zinc-500">O que falam</p>
                          <ul className="max-h-[420px] space-y-1 overflow-auto text-xs">
                            {chat.messages.map((message) => (
                              <li key={message.id} className="rounded bg-white px-2 py-1">
                                <p className="font-medium">{message.senderId ?? "interlocutor"}</p>
                                {message.timestamp ? <p className="text-zinc-500">{message.timestamp}</p> : null}
                                {message.body ? <p>{message.body}</p> : <p className="text-zinc-500">(sem texto)</p>}
                                {message.transcriptions.length > 0 ? (
                                  <p className="text-zinc-600">Transcricao: {message.transcriptions.join(" | ")}</p>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            ) : null}
          </div>
        </div>
      ) : null}

      {groupModalOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4">
          <div className="max-h-[90vh] w-full max-w-[1500px] overflow-auto rounded-lg border border-zinc-300 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Contexto do grupo</h3>
              <Button type="button" size="sm" variant="outline" onClick={() => setGroupModalOpen(false)}>
                Fechar
              </Button>
            </div>

            {groupModalBusy ? <p className="text-sm text-zinc-600">Carregando grupo...</p> : null}
            {groupModalError ? <p className="text-sm text-red-700">{groupModalError}</p> : null}

            {!groupModalBusy && !groupModalError && groupModalData ? (
              <div className="space-y-3">
                <p className="text-sm text-zinc-700">
                  <span className="font-medium">Grupo:</span> {groupModalData.label} ({groupModalData.sourceApp})
                </p>

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded border border-zinc-200 p-3">
                    <p className="mb-1 text-xs font-medium uppercase text-zinc-500">Participantes</p>
                    <ul className="max-h-[420px] space-y-1 overflow-auto text-xs">
                      {groupModalData.participants.map((participant) => (
                        <li key={participant.id} className="rounded bg-zinc-50 px-2 py-1">
                          {(participant.name ?? "sem-nome")} | {participant.phone ?? participant.handle ?? "sem-contato"}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded border border-zinc-200 p-3">
                    <p className="mb-1 text-xs font-medium uppercase text-zinc-500">Mensagens</p>
                    <ul className="max-h-[420px] space-y-1 overflow-auto text-xs">
                      {groupModalData.messages.map((message) => (
                        <li key={message.id} className="rounded bg-zinc-50 px-2 py-1">
                          <p className="font-medium">{message.senderId ?? "interlocutor"}</p>
                          {message.timestamp ? <p className="text-zinc-500">{message.timestamp}</p> : null}
                          {message.body ? <p>{message.body}</p> : <p className="text-zinc-500">(sem texto)</p>}
                          {message.transcriptions.length > 0 ? (
                            <p className="text-zinc-600">Transcricao: {message.transcriptions.join(" | ")}</p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
