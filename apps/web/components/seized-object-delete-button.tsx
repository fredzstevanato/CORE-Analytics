"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SeizedObjectDeleteButton(input: {
  caseId: string;
  objectId: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    const confirmed = window.confirm(
      `Deseja excluir este objeto apreendido${input.label ? ` (${input.label})` : ""}? O laudo vinculado sera mantido.`
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const response = await fetch(`/api/cases/${input.caseId}/seized-objects`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectId: input.objectId })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Falha ao excluir objeto apreendido.");
      }
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Falha ao excluir objeto apreendido.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className={input.className}
      onClick={onDelete}
      disabled={busy}
    >
      {busy ? "Excluindo..." : "Excluir objeto"}
    </Button>
  );
}
