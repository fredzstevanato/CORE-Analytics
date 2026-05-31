import { prisma } from "@core/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [cases, evidences, extractions] = await Promise.all([
    prisma.case.count(),
    prisma.evidence.count(),
    prisma.extraction.count()
  ]);

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Dashboard</h2>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Casos</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{cases}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Evidências</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{evidences}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Extrações</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{extractions}</p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
