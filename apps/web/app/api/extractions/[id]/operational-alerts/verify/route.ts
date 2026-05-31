import { createHash, createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { addCustodyEvent, getExtractionById } from "@core/cases";
import { getSessionUser } from "@/lib/session";

function sha256Hex(input: Buffer | string) {
  return createHash("sha256").update(input).digest("hex");
}

function computeSignature(input: { digest: string; extractionId: string; generatedAtIso: string; secret: string }) {
  const payload = `${input.digest}|${input.extractionId}|${input.generatedAtIso}`;
  return createHmac("sha256", input.secret).update(payload).digest("hex");
}

function getSigningSecret() {
  return process.env.EXPORT_SIGNING_SECRET ?? process.env.SESSION_SECRET ?? null;
}

function verifyCsvContent(input: { raw: string; extractionIdExpected: string }) {
  const normalized = input.raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const metadata = new Map<string, string>();
  let firstBodyIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.startsWith("#")) {
      firstBodyIndex = i;
      break;
    }
    const clean = line.replace(/^#\s*/, "");
    const sep = clean.indexOf(",");
    if (sep <= 0) continue;
    const key = clean.slice(0, sep).trim().toLowerCase();
    const value = clean.slice(sep + 1).trim();
    metadata.set(key, value);
  }

  const extractionIdInFile = metadata.get("extraction_id") ?? "";
  const generatedAt = metadata.get("generated_at") ?? "";
  const bodyShaInFile = metadata.get("body_sha256") ?? "";
  const signatureInFile = metadata.get("signature_hmac_sha256") ?? "UNSIGNED";
  const body = lines.slice(firstBodyIndex).join("\n");
  const bodyShaComputed = sha256Hex(body);
  const fileShaComputed = sha256Hex(Buffer.from(input.raw, "utf-8"));
  const bodyHashMatches = bodyShaInFile.length > 0 && bodyShaInFile === bodyShaComputed;
  const extractionMatches = extractionIdInFile === input.extractionIdExpected;

  const secret = getSigningSecret();
  let signatureValid: boolean | null = null;
  let signatureExpected: string | null = null;
  if (signatureInFile === "UNSIGNED") {
    signatureValid = true;
  } else if (secret && generatedAt && extractionIdInFile && bodyShaInFile) {
    signatureExpected = computeSignature({
      digest: bodyShaInFile,
      extractionId: extractionIdInFile,
      generatedAtIso: generatedAt,
      secret
    });
    signatureValid = signatureExpected === signatureInFile;
  }

  return {
    format: "csv" as const,
    extractionIdInFile,
    generatedAt,
    bodyShaInFile,
    bodyShaComputed,
    fileShaComputed,
    bodyHashMatches,
    extractionMatches,
    signatureInFile,
    signatureExpected,
    signatureValid
  };
}

function extractFirstMatch(text: string, regex: RegExp) {
  return text.match(regex)?.[1]?.trim() ?? "";
}

function verifyPdfContent(input: { bytes: Buffer; extractionIdExpected: string }) {
  const text = input.bytes.toString("latin1");
  const extractionIdInFile = extractFirstMatch(text, /Extraction ID:\s*([^\r\n)]+)/i);
  const generatedAt = extractFirstMatch(text, /Generated at:\s*([^\r\n)]+)/i);
  const bodyShaInFile = extractFirstMatch(text, /Body SHA-256:\s*([a-f0-9]{64})/i);
  const signatureInFile = extractFirstMatch(text, /Signature HMAC-SHA256:\s*([A-Fa-f0-9]{64}|UNSIGNED)/i) || "UNSIGNED";
  const fileShaComputed = sha256Hex(input.bytes);
  const extractionMatches = extractionIdInFile === input.extractionIdExpected;

  const secret = getSigningSecret();
  let signatureValid: boolean | null = null;
  let signatureExpected: string | null = null;
  if (signatureInFile === "UNSIGNED") {
    signatureValid = true;
  } else if (secret && generatedAt && extractionIdInFile && bodyShaInFile) {
    signatureExpected = computeSignature({
      digest: bodyShaInFile,
      extractionId: extractionIdInFile,
      generatedAtIso: generatedAt,
      secret
    });
    signatureValid = signatureExpected === signatureInFile;
  }

  return {
    format: "pdf" as const,
    extractionIdInFile,
    generatedAt,
    bodyShaInFile,
    bodyShaComputed: null,
    fileShaComputed,
    bodyHashMatches: null,
    extractionMatches,
    signatureInFile,
    signatureExpected,
    signatureValid
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const extraction = await getExtractionById(params.id);
  if (!extraction) {
    return NextResponse.json({ error: "Extraction not found." }, { status: 404 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Arquivo não enviado." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const name = (file.name ?? "").toLowerCase();
  const formatHint = String(form.get("format") ?? "").toLowerCase();
  const detectedFormat =
    formatHint === "csv" || formatHint === "pdf"
      ? formatHint
      : name.endsWith(".pdf")
        ? "pdf"
        : "csv";

  let result:
    | ReturnType<typeof verifyCsvContent>
    | ReturnType<typeof verifyPdfContent>;

  try {
    if (detectedFormat === "pdf") {
      result = verifyPdfContent({ bytes, extractionIdExpected: extraction.id });
    } else {
      const text = bytes.toString("utf-8");
      result = verifyCsvContent({ raw: text, extractionIdExpected: extraction.id });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao validar arquivo." },
      { status: 422 }
    );
  }

  const verificationOk =
    result.extractionMatches &&
    (result.signatureValid === true || result.signatureValid === null) &&
    (result.format === "pdf" ? true : result.bodyHashMatches === true);

  const session = await getSessionUser();
  await addCustodyEvent({
    caseId: extraction.caseId,
    evidenceId: extraction.evidenceId,
    actorId: session?.id,
    action: "OPERATIONAL_ALERTS_VERIFY",
    source: "api/extractions/operational-alerts/verify",
    details: {
      extractionId: extraction.id,
      format: result.format,
      fileName: file.name,
      verificationOk,
      extractionMatches: result.extractionMatches,
      signatureValid: result.signatureValid,
      bodyHashMatches: result.bodyHashMatches,
      fileSha256: result.fileShaComputed,
      bodyShaInFile: result.bodyShaInFile,
      bodyShaComputed: result.bodyShaComputed
    }
  });

  return NextResponse.json({
    ok: verificationOk,
    extractionId: extraction.id,
    verification: result
  });
}
