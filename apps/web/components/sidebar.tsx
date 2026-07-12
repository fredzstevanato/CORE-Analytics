"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  BrainCircuit,
  Clock,
  MapPin,
  Network,
  Settings,
  FileText,
  FolderKanban,
  LayoutDashboard,
  MessageSquare,
  Cpu,
  UserRound,
  Search,
  Shield,
  ShieldCheck
} from "lucide-react";

const navSections = [
  {
    title: "Principal",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/cases", label: "Casos", icon: FolderKanban },
      { href: "/pdf-processing", label: "Tratamento PDF", icon: FileText }
    ]
  },
  {
    title: "Evidencias",
    items: [
      { href: "/evidences", label: "Visao Geral", icon: Shield },
      { href: "/evidences/processing", label: "Processamento", icon: Activity },
      { href: "/evidences/devices", label: "Aparelhos", icon: Cpu },
      { href: "/evidences/accounts", label: "Contas", icon: UserRound },
      { href: "/evidences/custody", label: "Custodia", icon: Shield },
      { href: "/evidences/chain-of-custody", label: "Cadeia de Custodia", icon: ShieldCheck }
    ]
  },
  {
    title: "Analise",
    items: [
      { href: "/analysis", label: "Visao Geral", icon: Search },
      { href: "/analysis/search", label: "Buscas", icon: Search },
      { href: "/analysis/messages", label: "Mensagens", icon: MessageSquare },
      { href: "/analysis/ai", label: "Analise de IA", icon: BrainCircuit },
      { href: "/analysis/timeline", label: "Timeline", icon: Clock },
      { href: "/analysis/locations", label: "Localizacoes", icon: MapPin }
    ]
  },
  {
    title: "Saida",
    items: [
      { href: "/reports", label: "Relatorios", icon: FileText },
      { href: "/graph", label: "Grafo Telefonico", icon: Network }
    ]
  },
  {
    title: "Administracao",
    items: [
      { href: "/settings", label: "Configuracoes", icon: Settings },
      { href: "/settings/sync", label: "Sincronizacao", icon: Network },
      { href: "/settings/operations", label: "Saude Operacional", icon: Activity },
      { href: "/settings/updates", label: "Atualizacao", icon: Settings }
    ]
  }
];

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefWithSelection(href: string) {
    if (!href.startsWith("/analysis")) return href;
    const params = new URLSearchParams();
    for (const key of ["caseId", "evidenceId", "extractionId"]) {
      const value = searchParams.get(key);
      if (value) params.set(key, value);
    }
    const query = params.toString();
    return query ? `${href}?${query}` : href;
  }

  return (
    <aside className="w-64 border-r border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-8">
        <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">CORE Analytics</p>
        <h1 className="text-lg font-bold">Investigative Console</h1>
      </div>
      <nav className="space-y-4">
        {navSections.map((section) => (
          <div key={section.title} className="space-y-1">
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{section.title}</p>
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={hrefWithSelection(item.href)}
                  className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                    active
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950"
                      : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
