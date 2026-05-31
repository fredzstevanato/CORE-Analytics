import { ensureRole, requireSession } from "@/lib/auth";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanel } from "@/components/settings-panel";
import { SystemConfigPanel } from "@/components/system-config-panel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireSession();
  ensureRole(session.role, ["ADMIN"]);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Configuracoes</h2>
      <p className="text-sm text-zinc-600">
        Monitoramento operacional:{" "}
        <Link href="/settings/operations" className="text-blue-700 underline">
          abrir painel de saude
        </Link>
        {" · "}
        <Link href="/settings/sync" className="text-blue-700 underline">
          abrir sincronizacao consolidada
        </Link>
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Repositorio central de chaves e parametros</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsPanel />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Configuracao do sistema e hardware</CardTitle>
        </CardHeader>
        <CardContent>
          <SystemConfigPanel />
        </CardContent>
      </Card>
    </section>
  );
}
