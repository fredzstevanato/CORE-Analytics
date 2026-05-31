import { ensureRole, requireSession } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OperationsHealthPanel } from "@/components/operations-health-panel";
import { OperationsJobsPanel } from "@/components/operations-jobs-panel";

export const dynamic = "force-dynamic";

export default async function OperationsSettingsPage() {
  const session = await requireSession();
  ensureRole(session.role, ["ADMIN"]);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Configuracoes / Saude Operacional</h2>
      <Card>
        <CardHeader>
          <CardTitle>Status de infraestrutura e filas</CardTitle>
        </CardHeader>
        <CardContent>
          <OperationsHealthPanel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Controle manual de jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <OperationsJobsPanel />
        </CardContent>
      </Card>
    </section>
  );
}

