import { PdfTemporaryProcessingForm } from "@/components/pdf-temporary-processing-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PdfProcessingPage() {
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">Tratamento de PDF</h2>
      <Card>
        <CardHeader>
          <CardTitle>Processamento temporario</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-zinc-700">
          <p>
            Este modulo processa PDF sem persistir em evidencias/casos. O arquivo tratado fica disponivel
            temporariamente para download.
          </p>
          <p>Recursos: deteccao de paginas em branco, paginas duplicadas, analise de OCR e OCR seletivo.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Enviar PDF</CardTitle>
        </CardHeader>
        <CardContent>
          <PdfTemporaryProcessingForm />
        </CardContent>
      </Card>
    </section>
  );
}
