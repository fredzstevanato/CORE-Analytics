import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import { addCustodyEvent, getReportById } from "@core/cases";
import { prisma } from "@core/db";
import { assessCaseFinalReportReadiness } from "@core/reports";
import { requireApiSession } from "@/lib/api-auth";

function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function markdownToHtml(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const chunks: string[] = [];
  let inList = false;
  let inPre = false;

  const closeList = () => {
    if (inList) {
      chunks.push("</ul>");
      inList = false;
    }
  };

  const closePre = () => {
    if (inPre) {
      chunks.push("</pre>");
      inPre = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      closeList();
      if (inPre) {
        closePre();
      } else {
        chunks.push("<pre>");
        inPre = true;
      }
      continue;
    }

    if (inPre) {
      chunks.push(htmlEscape(line));
      continue;
    }

    if (trimmed.length === 0) {
      closeList();
      chunks.push("<p>&nbsp;</p>");
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (!inList) {
        chunks.push("<ul>");
        inList = true;
      }
      chunks.push(`<li>${htmlEscape(trimmed.slice(2))}</li>`);
      continue;
    }

    closeList();

    if (trimmed.startsWith("### ")) {
      chunks.push(`<h3>${htmlEscape(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      chunks.push(`<h2>${htmlEscape(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith("# ")) {
      chunks.push(`<h1>${htmlEscape(trimmed.slice(2))}</h1>`);
      continue;
    }

    chunks.push(`<p>${htmlEscape(trimmed)}</p>`);
  }

  closeList();
  closePre();
  return chunks.join("\n");
}

async function tryLoadLogoDataUri(filename: string) {
  const absolutePath = path.resolve(process.cwd(), "public", "branding", filename);
  try {
    await access(absolutePath);
    const bytes = await readFile(absolutePath);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function resolveChromeExecutablePath() {
  const fromEnv = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find((value) => existsSync(value));
}

async function renderHtmlToPdf(input: { html: string }) {
  const executablePath = resolveChromeExecutablePath();
  if (!executablePath) {
    throw new Error("Navegador Chromium/Chrome nao encontrado para renderizacao HTML->PDF.");
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage();
    await page.setContent(input.html, { waitUntil: "networkidle0" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "18mm",
        right: "14mm",
        bottom: "18mm",
        left: "14mm"
      }
    });
  } finally {
    await browser.close();
  }
}

function buildPdfHtml(input: {
  isFinal: boolean;
  report: { title: string; content: string; caseLabel: string; generatedAtIso: string };
  caseMetadata: {
    inquiryType?: string | null;
    inquiryNumber?: string | null;
    policeUnit?: string | null;
  };
  readinessChecks?: {
    evidenceCount: number;
    custodyEventsCount: number;
    custodyEventsWithHashCount: number;
    expertReportCount: number;
    messageCount: number;
  };
  logos: {
    left: string | null;
    right: string | null;
  };
}) {
  const inquiryType = (input.caseMetadata.inquiryType ?? "").trim() || "N/D";
  const inquiryNumber = (input.caseMetadata.inquiryNumber ?? "").trim() || "N/D";
  const policeUnit = (input.caseMetadata.policeUnit ?? "").trim() || "N/D";

  const bodyHtml = markdownToHtml(input.report.content);

  const readinessHtml =
    input.isFinal && input.readinessChecks
      ? `
      <section class="readiness">
        <h3>Resumo de Completude</h3>
        <ul>
          <li>Evidencias: ${input.readinessChecks.evidenceCount}</li>
          <li>Eventos de custodia: ${input.readinessChecks.custodyEventsCount}</li>
          <li>Eventos de custodia com hash: ${input.readinessChecks.custodyEventsWithHashCount}</li>
          <li>Laudos periciais: ${input.readinessChecks.expertReportCount}</li>
          <li>Mensagens processadas: ${input.readinessChecks.messageCount}</li>
        </ul>
      </section>
      `
      : "";

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 16mm 14mm 18mm 14mm; }
      body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; line-height: 1.4; }
      .header-wrap { border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 14px; }
      .header { display: grid; grid-template-columns: 110px 1fr 110px; align-items: center; gap: 10px; }
      .logo-box { width: 100px; height: 100px; display: flex; align-items: center; justify-content: center; }
      .logo-box img { max-width: 100%; max-height: 100%; object-fit: contain; }
      .logo-fallback { width: 84px; height: 84px; border: 1px dashed #999; font-size: 10px; color: #666; display: flex; align-items: center; justify-content: center; text-align: center; padding: 4px; }
      .header-title { text-align: center; }
      .header-title .line { font-size: 18px; font-weight: 700; text-transform: uppercase; line-height: 1.25; }
      .header-meta { margin-top: 6px; text-align: center; font-size: 12px; font-weight: 600; }
      h1 { font-size: 18px; margin: 8px 0 6px; }
      h2 { font-size: 15px; margin: 10px 0 5px; }
      h3 { font-size: 13px; margin: 8px 0 4px; }
      p { margin: 2px 0; }
      ul { margin: 4px 0 6px 16px; padding: 0; }
      pre { background: #f6f6f6; padding: 8px; border-radius: 4px; white-space: pre-wrap; }
      .doc-meta { margin: 8px 0 12px; font-size: 12px; }
      .readiness { background: #f7faf7; border: 1px solid #d6ead8; border-radius: 6px; padding: 8px; margin-bottom: 10px; }
    </style>
  </head>
  <body>
    <section class="header-wrap">
      <div class="header">
        <div class="logo-box">
          ${input.logos.left ? `<img src="${input.logos.left}" alt="Brasao Estado de Mato Grosso" />` : '<div class="logo-fallback">Logo Estado</div>'}
        </div>
        <div class="header-title">
          <div class="line">ESTADO DE MATO GROSSO</div>
          <div class="line">SECRETARIA DE ESTADO DE SEGURANCA PUBLICA</div>
          <div class="line">POLICIA JUDICIARIA CIVIL</div>
          <div class="line">DELEGACIA DE POLICIA DE ${htmlEscape(policeUnit)}</div>
          <div class="header-meta">Inquerito: ${htmlEscape(inquiryType)} ${htmlEscape(inquiryNumber)}</div>
        </div>
        <div class="logo-box">
          ${input.logos.right ? `<img src="${input.logos.right}" alt="Distintivo Policia Civil MT" />` : '<div class="logo-fallback">Logo PJC</div>'}
        </div>
      </div>
    </section>

    <section class="doc-meta">
      <p><strong>Caso:</strong> ${htmlEscape(input.report.caseLabel)}</p>
      <p><strong>Relatorio:</strong> ${htmlEscape(input.report.title)}</p>
      <p><strong>Data de emissao:</strong> ${htmlEscape(input.report.generatedAtIso)}</p>
      <p><strong>Modo:</strong> ${input.isFinal ? "Final" : "Preview"}</p>
    </section>

    ${readinessHtml}

    <main>${bodyHtml}</main>
  </body>
</html>`;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if ("error" in auth) return auth.error;
  const session = auth.session;

  const params = await context.params;
  const report = await getReportById(params.id);
  if (!report) {
    return NextResponse.json({ error: "Relatorio nao encontrado." }, { status: 404 });
  }

  const requestUrl = new URL(_request.url);
  const mode = (requestUrl.searchParams.get("mode") ?? "preview").toLowerCase();
  const isFinal = mode === "final";

  let readinessChecks = {
    evidenceCount: 0,
    custodyEventsCount: 0,
    custodyEventsWithHashCount: 0,
    expertReportCount: 0,
    messageCount: 0
  };
  if (isFinal) {
    const metadataRecord =
      report.metadata && typeof report.metadata === "object" && !Array.isArray(report.metadata)
        ? (report.metadata as Record<string, unknown>)
        : null;
    const workflowRecord =
      metadataRecord?.workflow && typeof metadataRecord.workflow === "object" && !Array.isArray(metadataRecord.workflow)
        ? (metadataRecord.workflow as Record<string, unknown>)
        : null;
    const workflowStatus = workflowRecord?.status;
    if (workflowStatus !== "APPROVED") {
      return NextResponse.json(
        {
          error: "Relatorio final exige workflow aprovado.",
          workflowStatus: workflowStatus ?? "DRAFT"
        },
        { status: 409 }
      );
    }

    const readiness = await assessCaseFinalReportReadiness(report.caseId);
    readinessChecks = readiness.checks;
    if (!readiness.ready) {
      return NextResponse.json(
        {
          error: "Relatorio final bloqueado por pendencias de completude.",
          issues: readiness.issues,
          checks: readiness.checks
        },
        { status: 409 }
      );
    }
  }

  const generatedAtIso = new Date().toISOString();
  const caseLabel = `${report.case.caseNumber} - ${report.case.title}`;
  const reportPayload = {
    title: report.title,
    content: report.content,
    caseLabel,
    generatedAtIso
  };

  const [leftLogo, rightLogo] = await Promise.all([
    tryLoadLogoDataUri("estado-mt.png"),
    tryLoadLogoDataUri("policia-civil-mt.png")
  ]);

  const html = buildPdfHtml({
    isFinal,
    report: reportPayload,
    caseMetadata: {
      inquiryType: report.case.inquiryType,
      inquiryNumber: report.case.inquiryNumber,
      policeUnit: report.case.policeUnit
    },
    readinessChecks,
    logos: {
      left: leftLogo,
      right: rightLogo
    }
  });

  const pdfBytes = await renderHtmlToPdf({ html });
  const fileSha256 = createHash("sha256").update(pdfBytes).digest("hex");

  await addCustodyEvent({
    caseId: report.caseId,
    evidenceId: report.evidenceId ?? undefined,
    actorId: session.id,
    action: "REPORT_PDF_EXPORTED",
    source: "api/reports/[id]/pdf",
    details: {
      reportId: report.id,
      reportTitle: report.title,
      reportFormat: report.format,
      mode: isFinal ? "final" : "preview",
      generatedAt: generatedAtIso,
      fileSha256
    }
  });

  if (isFinal) {
    await prisma.case.update({
      where: { id: report.caseId },
      data: {
        operationalStatus: "CLOSED",
        reviewedAt: new Date(),
        reviewedById: session.id
      }
    });

    await addCustodyEvent({
      caseId: report.caseId,
      actorId: session.id,
      action: "CASE_OPERATIONAL_STATUS_UPDATED",
      source: "api/reports/[id]/pdf",
      details: {
        reportId: report.id,
        operationalStatus: "CLOSED",
        reason: "Final report issued"
      }
    });
  }

  const safeTitle = report.title.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || report.id;

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safeTitle}${isFinal ? "-final" : ""}.pdf"`,
      "Cache-Control": "no-store",
      "X-CORE-Report-File-SHA256": fileSha256
    }
  });
}
