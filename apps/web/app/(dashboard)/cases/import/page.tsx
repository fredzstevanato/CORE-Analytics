import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CasePdfImportForm } from "@/components/case-pdf-import-form";

export const dynamic = "force-dynamic";

export default function ImportCasePage() {
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Importar Caso por PDF</h2>
      <Card>
        <CardHeader>
          <CardTitle>Upload do PDF do inquerito</CardTitle>
        </CardHeader>
        <CardContent>
          <CasePdfImportForm />
        </CardContent>
      </Card>
    </section>
  );
}
