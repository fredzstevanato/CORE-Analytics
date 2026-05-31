import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CaseManualForm } from "@/components/case-manual-form";

export const dynamic = "force-dynamic";

export default function NewCasePage() {
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Novo Caso Manual</h2>
      <Card>
        <CardHeader>
          <CardTitle>Cadastro manual do caso</CardTitle>
        </CardHeader>
        <CardContent>
          <CaseManualForm />
        </CardContent>
      </Card>
    </section>
  );
}
