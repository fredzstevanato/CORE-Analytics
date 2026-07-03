import { ensureRole, requireSession } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OperationsUpdatePanel } from "@/components/operations-update-panel";

export const dynamic = "force-dynamic";

export default async function UpdatesSettingsPage() {
  const session = await requireSession();
  ensureRole(session.role, ["ADMIN"]);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Configuracoes / Atualizacao do Sistema</h2>
      <Card>
        <CardHeader>
          <CardTitle>Atualizacao e console</CardTitle>
        </CardHeader>
        <CardContent>
          <OperationsUpdatePanel />
        </CardContent>
      </Card>
    </section>
  );
}
