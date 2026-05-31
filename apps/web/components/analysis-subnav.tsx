"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const items = [
  { href: "/analysis", label: "Visao Geral" },
  { href: "/analysis/search", label: "Buscas" },
  { href: "/analysis/messages", label: "Mensagens" },
  { href: "/analysis/attachments", label: "Arquivos" },
  { href: "/analysis/audios", label: "Audios" },
  { href: "/analysis/ai", label: "Analise de IA" },
  { href: "/analysis/timeline", label: "Timeline" },
  { href: "/analysis/locations", label: "Localizacoes" }
];

export function AnalysisSubnav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefWithSelection(href: string) {
    const params = new URLSearchParams();
    for (const key of ["caseId", "evidenceId", "extractionId"]) {
      const value = searchParams.get(key);
      if (value) params.set(key, value);
    }
    const query = params.toString();
    return query ? `${href}?${query}` : href;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={hrefWithSelection(item.href)}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${
              active
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
