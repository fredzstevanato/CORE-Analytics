import { NextResponse } from "next/server";
import { createGeneratedReport } from "@core/cases";
import { prisma } from "@core/db";
import { getSessionUser } from "@/lib/session";

export async function POST(request: Request) {
  const form = await request.formData();
  const caseId = String(form.get("caseId") ?? "");
  const extractionId = String(form.get("extractionId") ?? "") || undefined;
  const title = String(form.get("title") ?? "Relatorio Tecnico");
  if (!caseId) {
    return NextResponse.json({ error: "caseId e obrigatorio" }, { status: 400 });
  }
  if (!extractionId) {
    return NextResponse.json({ error: "extractionId e obrigatorio" }, { status: 400 });
  }

  const extraction = await prisma.extraction.findFirst({
    where: { id: extractionId, caseId },
    select: { evidenceId: true }
  });
  if (!extraction) {
    return NextResponse.json({ error: "Extracao nao encontrada para o caso informado." }, { status: 404 });
  }
  const evidenceId = extraction.evidenceId;

  const [caseRow, evidences, messages, transcriptions] = await Promise.all([
    prisma.case.findUnique({ where: { id: caseId } }),
    prisma.evidence.count({ where: { caseId, id: evidenceId } }),
    prisma.message.count({ where: { caseId, evidenceId } }),
    prisma.audioTranscription.count({ where: { caseId, evidenceId } })
  ]);

  if (!caseRow) {
    return NextResponse.json({ error: "Caso nao encontrado." }, { status: 404 });
  }

  const body = `# ${title}

## Caso
- Numero: ${caseRow.caseNumber}
- Titulo: ${caseRow.title}

## Resumo quantitativo
- Evidencias: ${evidences}
- Mensagens: ${messages}
- Transcricoes de audio: ${transcriptions}

## Observacoes tecnicas
- Relatorio gerado automaticamente para etapa inicial de consolidacao.
- Validar manualmente os achados antes de emissao final.
`;

  const session = await getSessionUser();
  const report = await createGeneratedReport({
    caseId,
    evidenceId,
    authorId: session?.id,
    title,
    format: "MARKDOWN",
    content: body,
    metadata: {
      generatedBy: "api/reports/generate",
      reportType: "TECHNICAL_SUMMARY",
      extractionId
    }
  });

  return NextResponse.redirect(new URL(`/reports?caseId=${caseId}&extractionId=${extractionId}`, request.url), 303);
}
