import { NextResponse } from "next/server";
import { createHash, createHmac } from "node:crypto";
import { addCustodyEvent, getExtractionById, listExtractionOperationalAlertHistory } from "@core/cases";
import { getSessionUser } from "@/lib/session";

function toSafeFileBase(value: string) {
  const clean = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean || "extraction";
}

function csvEscape(value: string) {
  const escaped = value.replace(/"/g, "\"\"");
  return `"${escaped}"`;
}

function sha256Hex(input: Buffer | string) {
  return createHash("sha256").update(input).digest("hex");
}

function signDigest(input: { digest: string; extractionId: string; generatedAtIso: string }) {
  const secret = process.env.EXPORT_SIGNING_SECRET ?? process.env.SESSION_SECRET;
  if (!secret) return null;
  const payload = `${input.digest}|${input.extractionId}|${input.generatedAtIso}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function buildCsv(rows: Array<{
  eventId: string;
  createdAtIso: string;
  action: string;
  source: string;
  highestSeverity: string;
  code: string;
  severity: string;
  message: string;
}>, meta: { extractionId: string; generatedAtIso: string; bodySha256: string; signatureHex: string | null }) {
  const header = [
    "event_id",
    "created_at_iso",
    "action",
    "source",
    "highest_severity",
    "alert_code",
    "alert_severity",
    "alert_message"
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.eventId,
        row.createdAtIso,
        row.action,
        row.source,
        row.highestSeverity,
        row.code,
        row.severity,
        row.message
      ]
        .map((value) => csvEscape(value))
        .join(",")
    );
  }
  const metadataLines = [
    `# core_export_version,1`,
    `# extraction_id,${meta.extractionId}`,
    `# generated_at,${meta.generatedAtIso}`,
    `# body_sha256,${meta.bodySha256}`,
    `# signature_hmac_sha256,${meta.signatureHex ?? "UNSIGNED"}`
  ];
  return `\uFEFF${metadataLines.join("\n")}\n${lines.join("\n")}`;
}

function sanitizePdfText(input: string) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function createMinimalPdf(lines: string[]) {
  const maxLines = 60;
  const trimmed = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    trimmed.push(`... truncated (${lines.length - maxLines} more lines)`);
  }

  const contentLines = [
    "BT",
    "/F1 10 Tf",
    "36 806 Td",
    "12 TL",
    ...trimmed.map((line, index) => `${index === 0 ? "" : "T* "}( ${sanitizePdfText(line)} ) Tj`).map((row) => row.trim()),
    "ET"
  ];
  const content = `${contentLines.join("\n")}\n`;
  const contentBytes = Buffer.from(content, "ascii");

  const objects: string[] = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
  );
  objects.push("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  objects.push(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n${content}endstream\nendobj\n`);

  let offset = 0;
  const parts: Buffer[] = [];
  const push = (chunk: string | Buffer) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "ascii") : chunk;
    parts.push(buffer);
    offset += buffer.length;
  };

  push("%PDF-1.4\n");
  const xrefOffsets: number[] = [0];
  for (const object of objects) {
    xrefOffsets.push(offset);
    push(object);
  }
  const xrefStart = offset;
  push(`xref\n0 ${objects.length + 1}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i < xrefOffsets.length; i += 1) {
    push(`${String(xrefOffsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  return Buffer.concat(parts);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const extraction = await getExtractionById(params.id);
  if (!extraction) {
    return NextResponse.json({ error: "Extraction not found." }, { status: 404 });
  }

  const history = await listExtractionOperationalAlertHistory(params.id, 500);
  const rows = history.flatMap((event) =>
    event.alerts.map((alert) => ({
      eventId: event.id,
      createdAtIso: event.createdAt.toISOString(),
      action: event.action,
      source: event.source ?? "",
      highestSeverity: event.highestSeverity,
      code: alert.code,
      severity: alert.severity,
      message: alert.message
    }))
  );

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  const base = toSafeFileBase(`${extraction.evidence.fileName}-${extraction.id}-operational-alerts`);
  const generatedAtIso = new Date().toISOString();
  const session = await getSessionUser();

  if (format === "pdf") {
    const reportLines = [
      "CORE Analytics - Operational Alerts Report",
      `Extraction ID: ${extraction.id}`,
      `Evidence: ${extraction.evidence.fileName}`,
      `Generated at: ${generatedAtIso}`,
      `Events: ${history.length} | Alerts: ${rows.length}`,
      "----------------------------------------",
      ...rows.map(
        (row) =>
          `${row.createdAtIso} | ${row.action} | ${row.severity} (${row.code}) | ${row.message.replace(/\s+/g, " ").trim()}`
      )
    ];
    const reportBody = reportLines.join("\n");
    const bodySha = sha256Hex(reportBody);
    const signature = signDigest({
      digest: bodySha,
      extractionId: extraction.id,
      generatedAtIso
    });
    const pdf = createMinimalPdf([
      ...reportLines.slice(0, 5),
      `Body SHA-256: ${bodySha}`,
      `Signature HMAC-SHA256: ${signature ?? "UNSIGNED"}`,
      "----------------------------------------",
      ...reportLines.slice(6)
    ]);
    const fileSha = sha256Hex(pdf);
    await addCustodyEvent({
      caseId: extraction.caseId,
      evidenceId: extraction.evidenceId,
      actorId: session?.id,
      action: "OPERATIONAL_ALERTS_EXPORT",
      source: "api/extractions/operational-alerts/export",
      details: {
        extractionId: extraction.id,
        format: "pdf",
        fileSha256: fileSha,
        bodySha256: bodySha,
        signatureHmacSha256: signature,
        alertsCount: rows.length,
        generatedAt: generatedAtIso
      }
    });
    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${base}.pdf"`,
        "Cache-Control": "no-store",
        "X-CORE-Export-File-SHA256": fileSha,
        "X-CORE-Export-Body-SHA256": bodySha,
        "X-CORE-Export-Signature-HMAC-SHA256": signature ?? "UNSIGNED"
      }
    });
  }

  const csvBodyRowsOnly = rows
    .map((row) =>
      [row.eventId, row.createdAtIso, row.action, row.source, row.highestSeverity, row.code, row.severity, row.message]
        .map((value) => csvEscape(value))
        .join(",")
    )
    .join("\n");
  const csvBodyHeader =
    "event_id,created_at_iso,action,source,highest_severity,alert_code,alert_severity,alert_message";
  const csvBody = `${csvBodyHeader}\n${csvBodyRowsOnly}`;
  const bodySha = sha256Hex(csvBody);
  const signature = signDigest({
    digest: bodySha,
    extractionId: extraction.id,
    generatedAtIso
  });
  const csv = buildCsv(rows, {
    extractionId: extraction.id,
    generatedAtIso,
    bodySha256: bodySha,
    signatureHex: signature
  });
  const fileSha = sha256Hex(csv);
  await addCustodyEvent({
    caseId: extraction.caseId,
    evidenceId: extraction.evidenceId,
    actorId: session?.id,
    action: "OPERATIONAL_ALERTS_EXPORT",
    source: "api/extractions/operational-alerts/export",
    details: {
      extractionId: extraction.id,
      format: "csv",
      fileSha256: fileSha,
      bodySha256: bodySha,
      signatureHmacSha256: signature,
      alertsCount: rows.length,
      generatedAt: generatedAtIso
    }
  });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.csv"`,
      "Cache-Control": "no-store",
      "X-CORE-Export-File-SHA256": fileSha,
      "X-CORE-Export-Body-SHA256": bodySha,
      "X-CORE-Export-Signature-HMAC-SHA256": signature ?? "UNSIGNED"
    }
  });
}
