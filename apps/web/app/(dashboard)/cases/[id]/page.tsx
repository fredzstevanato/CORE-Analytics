import { prisma } from "@core/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CasePdfEnrichmentForm } from "@/components/case-pdf-enrichment-form";
import { CaseDocumentsPanel } from "@/components/case-documents-panel";
import { CaseExpertReportsPanel } from "@/components/case-expert-reports-panel";
import { CaseInvolvedPeoplePanel } from "@/components/case-involved-people-panel";
import { CaseUfdrAliasForm } from "@/components/case-ufdr-alias-form";
import { CaseUfdrHardResetButton } from "@/components/case-ufdr-hard-reset-button";
import { UfdrUploadForm } from "@/components/ufdr-upload-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type InvolvedCategoryKey = "SUSPECT" | "VICTIM" | "WITNESS" | "OTHER";

function normalizeInvolvedPeople(raw: unknown) {
  const result: Array<{
    name: string;
    category: InvolvedCategoryKey;
    confidence: "AUTO_EXTRACTED" | "REVIEW_RECOMMENDED";
    reason: string;
    evidenceExcerpt?: string;
    sourceReference?: string;
    sourceDocuments: Array<{ documentId?: string; fileName: string }>;
  }> = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const name = item.trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      const category: InvolvedCategoryKey = /(suspeit|investigad|indiciad|acusad|autor|reu|réu)/i.test(lower)
        ? "SUSPECT"
        : /(vitima|vítima|ofendid|lesad)/i.test(lower)
          ? "VICTIM"
          : /(testemunh|declarante)/i.test(lower)
            ? "WITNESS"
            : "OTHER";
      result.push({
        name,
        category,
        confidence: category === "OTHER" ? "REVIEW_RECOMMENDED" : "AUTO_EXTRACTED",
        reason:
          category === "SUSPECT"
            ? "Classificação automática por termo de suspeição."
            : category === "VICTIM"
              ? "Classificação automática por termo de vítima/ofendido."
              : category === "WITNESS"
                ? "Classificação automática por termo de testemunha."
                : "Citado no contexto e classificado como outro relacionado.",
        sourceDocuments: []
      });
    }
    return result;
  }

  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const categorized = Array.isArray(record.involvedPeopleCategorized)
      ? record.involvedPeopleCategorized
      : Array.isArray(record.people)
        ? record.people
        : [];
    for (const item of categorized) {
      if (typeof item === "string") {
        const name = item.trim();
        if (!name) continue;
        result.push({
          name,
          category: "OTHER",
          confidence: "REVIEW_RECOMMENDED",
          reason: "Relacionado ao caso por citação em documento.",
          sourceDocuments: []
        });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!name) continue;
      const categoryValue = typeof row.category === "string" ? row.category.toUpperCase() : "OTHER";
      const category: InvolvedCategoryKey =
        categoryValue === "SUSPECT" ||
        categoryValue === "VICTIM" ||
        categoryValue === "WITNESS" ||
        categoryValue === "OTHER"
          ? (categoryValue as InvolvedCategoryKey)
          : "OTHER";
      const confidenceRaw = typeof row.confidence === "string" ? row.confidence.toUpperCase() : "REVIEW_RECOMMENDED";
      const confidence = confidenceRaw === "AUTO_EXTRACTED" ? "AUTO_EXTRACTED" : "REVIEW_RECOMMENDED";
      const sourceDocuments: Array<{ documentId?: string; fileName: string }> = [];
      if (Array.isArray(row.sourceDocuments)) {
        for (const entry of row.sourceDocuments) {
          if (!entry || typeof entry !== "object") continue;
          const doc = entry as Record<string, unknown>;
          const fileName = typeof doc.fileName === "string" ? doc.fileName.trim() : "";
          if (!fileName) continue;
          sourceDocuments.push({
            documentId: typeof doc.documentId === "string" ? doc.documentId : undefined,
            fileName
          });
        }
      }

      result.push({
        name,
        category,
        confidence,
        reason:
          typeof row.reason === "string" && row.reason.trim()
            ? row.reason.trim()
            : "Relacionado ao caso por citação em documento.",
        evidenceExcerpt: typeof row.evidenceExcerpt === "string" ? row.evidenceExcerpt : undefined,
        sourceReference: typeof row.sourceReference === "string" ? row.sourceReference : undefined,
        sourceDocuments
      });
    }
  }

  return result;
}

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [item, intake] = await Promise.all([
    prisma.case.findUnique({
      where: { id },
      include: { evidences: { include: { extraction: true } }, timeline: true }
    }),
    prisma.aiInsight.findFirst({
      where: { caseId: id, type: "CASE_INTAKE" },
      orderBy: { createdAt: "desc" }
    })
  ]);

  if (!item) return notFound();
  const documents = await prisma.caseDocument.findMany({
    where: { caseId: item.id },
    orderBy: { createdAt: "desc" }
  });
  const [expertReports, seizedObjects] = await Promise.all([
    prisma.expertReport.findMany({
      where: { caseId: item.id },
      orderBy: { createdAt: "desc" },
      include: {
        seizedObjects: true,
        expertIdentifiers: true,
        caseDocument: {
          select: {
            id: true,
            fileName: true,
            sha256: true,
            createdAt: true
          }
        }
      }
    }),
    prisma.seizedObject.findMany({
      where: { caseId: item.id },
      orderBy: { createdAt: "desc" },
      include: {
        expertReport: {
          select: {
            id: true,
            title: true
          }
        }
      }
    })
  ]);
  const inquiryDocs = documents
    .filter((document) => document.type === "INQUIRY_PDF")
    .map((document) => ({ id: document.id, fileName: document.fileName }));
  const normalizedPeople = normalizeInvolvedPeople(item.inquiryInvolvedPeople);
  const groupedPeople: Record<InvolvedCategoryKey, typeof normalizedPeople> = {
    SUSPECT: [],
    VICTIM: [],
    WITNESS: [],
    OTHER: []
  };
  for (const person of normalizedPeople) {
    const withSources =
      person.sourceDocuments.length > 0
        ? person
        : { ...person, sourceDocuments: inquiryDocs };
    groupedPeople[withSources.category].push(withSources);
  }

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-bold">{item.title}</h2>
      <Card>
        <CardHeader>
          <CardTitle>Resumo do Caso</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p>Numero: {item.caseNumber}</p>
          <p>Status: {item.status}</p>
          <p>Status operacional: {item.operationalStatus}</p>
          <p>Origem: {item.sourceType}</p>
          <p>Evidencias: {item.evidences.length}</p>
          <p>Documentos: {documents.length}</p>
          <p>Eventos timeline: {item.timeline.length}</p>
          <p>Tipo inquerito: {item.inquiryType ?? "N/D"}</p>
          <p>Numero inquerito: {item.inquiryNumber ?? "N/D"}</p>
          <p>Unidade policial: {item.policeUnit ?? "N/D"}</p>
          <p>Enquadramento legal: {item.inquiryLegalFraming ?? "N/D"}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>UFDR Vinculadas ao Caso</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-zinc-500">
            Este inquerito pode receber varias extracoes UFDR, uma para cada item apreendido.
          </p>
          {item.evidences.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma UFDR vinculada ainda.</p> : null}
          {item.evidences.map((evidence) => (
            <div key={evidence.id} className="rounded border border-zinc-200 p-3 text-sm">
              <p className="font-medium">{evidence.fileName}</p>
              <p className="text-xs text-zinc-500">Nome de exibicao: {evidence.label}</p>
              <p className="text-xs text-zinc-500">Fonte: {evidence.source ?? "UFDR"}</p>
              <p className="text-xs text-zinc-500">Extracao: {evidence.extraction?.status ?? "PENDING"}</p>
              {evidence.extraction?.id ? (
                <Link className="text-xs text-blue-700 hover:underline" href={`/extractions/${evidence.extraction.id}`}>
                  Abrir extracao
                </Link>
              ) : null}
              <CaseUfdrAliasForm evidenceId={evidence.id} fileName={evidence.fileName} currentLabel={evidence.label} />
              <CaseUfdrHardResetButton
                evidenceId={evidence.id}
                evidenceFileName={evidence.fileName}
                extractionStatus={evidence.extraction?.status ?? null}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vincular Nova UFDR ao Caso</CardTitle>
        </CardHeader>
        <CardContent>
          <UfdrUploadForm
            caseOptions={[
              {
                id: item.id,
                caseNumber: item.caseNumber,
                title: item.title
              }
            ]}
            preselectedCaseId={item.id}
            lockCaseSelection
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documentos do Caso</CardTitle>
        </CardHeader>
        <CardContent>
          <CaseDocumentsPanel
            caseId={item.id}
            documents={documents.map((document) => ({
              id: document.id,
              title: document.title,
              type: document.type,
              mimeType: document.mimeType,
              fileName: document.fileName,
              metadata: document.metadata,
              createdAt: document.createdAt
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dados Estruturados do Inquerito</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <p className="font-medium">Resumo</p>
            <p className="text-zinc-700">{item.inquirySummaryText ?? "N/D"}</p>
          </div>
          <div>
            <p className="font-medium">Fatos principais</p>
            <p className="text-zinc-700">{item.inquiryMainFacts ?? "N/D"}</p>
          </div>
          <div>
            <p className="font-medium">Foco investigativo</p>
            <p className="text-zinc-700">{item.inquiryInvestigativeFocus ?? "N/D"}</p>
          </div>
          <div>
            <p className="font-medium">Resumo do relatorio da extracao</p>
            <p className="text-zinc-700">{item.extractionReportSummary ?? "N/D"}</p>
          </div>
          <div>
            <p className="font-medium">Envolvidos</p>
            <CaseInvolvedPeoplePanel
              people={[
                ...groupedPeople.SUSPECT,
                ...groupedPeople.VICTIM,
                ...groupedPeople.WITNESS,
                ...groupedPeople.OTHER
              ]}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Laudo Pericial e Objetos Apreendidos</CardTitle>
        </CardHeader>
        <CardContent>
          <CaseExpertReportsPanel caseId={item.id} reports={expertReports} seizedObjects={seizedObjects} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inclusao Tardia de PDF e Contextualizacao</CardTitle>
        </CardHeader>
        <CardContent>
          <CasePdfEnrichmentForm caseId={item.id} />
        </CardContent>
      </Card>

      {intake ? (
        <Card>
          <CardHeader>
            <CardTitle>Resumo do Intake IA</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-zinc-700">{intake.summary}</p>
            <pre className="max-h-80 overflow-auto rounded bg-zinc-50 p-2 text-xs">
              {JSON.stringify(intake.metadata, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
