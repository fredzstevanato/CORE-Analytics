"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function LiveDataControls() {
  const router = useRouter();
  const pathname = usePathname();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const hasOwnLiveStream = pathname.startsWith("/evidences") || pathname.startsWith("/extractions");
  const isHeavyGraphPage = pathname.startsWith("/graph");
  const canAutoRefresh = !hasOwnLiveStream && !isHeavyGraphPage;

  useEffect(() => {
    if (!autoRefresh || !canAutoRefresh) return;
    const timer = setInterval(() => {
      router.refresh();
      setLastRefresh(new Date());
    }, 8000);
    return () => clearInterval(timer);
  }, [autoRefresh, canAutoRefresh, router]);

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          router.refresh();
          setLastRefresh(new Date());
        }}
      >
        Atualizar dados
      </Button>
      <label className="flex items-center gap-1 text-xs text-zinc-600">
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={(event) => setAutoRefresh(event.target.checked)}
          disabled={!canAutoRefresh}
        />
        Auto
      </label>
      <span className="text-xs text-zinc-500">
        {!canAutoRefresh
          ? isHeavyGraphPage
            ? "Auto pausado no grafo para evitar recargas concorrentes"
            : "Auto pausado nesta tela com atualizacao em tempo real"
          : lastRefresh
            ? `Atualizado: ${lastRefresh.toLocaleTimeString()}`
            : "Sem atualizacao manual"}
      </span>
    </div>
  );
}
