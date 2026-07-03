import { NextResponse } from "next/server";
import { prisma } from "@core/db";

export const dynamic = "force-dynamic";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function numberFromMetadata(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function kmlFileName(input: { caseId?: string | null; evidenceId?: string | null }) {
  const suffix = input.evidenceId ?? input.caseId ?? "localizacoes";
  return `localizacoes-${suffix}.kml`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const caseId = url.searchParams.get("caseId")?.trim() || undefined;
    const extractionId = url.searchParams.get("extractionId")?.trim() || undefined;
    let evidenceId = url.searchParams.get("evidenceId")?.trim() || undefined;

    if (extractionId) {
      const extraction = await prisma.extraction.findFirst({
        where: { id: extractionId, ...(caseId ? { caseId } : {}) },
        select: { evidenceId: true, caseId: true }
      });
      if (!extraction) {
        return NextResponse.json({ error: "Extracao nao encontrada." }, { status: 404 });
      }
      evidenceId = extraction.evidenceId;
    }

    const locations = await prisma.artifact.findMany({
      where: {
        type: "LOCATION",
        ...(caseId ? { caseId } : {}),
        ...(evidenceId ? { evidenceId } : {})
      },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      include: {
        case: { select: { caseNumber: true, title: true } },
        evidence: { select: { fileName: true } }
      },
      take: 10000
    });

    const placemarks = locations.flatMap((row) => {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
      const lat = numberFromMetadata(metadata.latitude ?? metadata.lat);
      const lng = numberFromMetadata(metadata.longitude ?? metadata.lng ?? metadata.lon);
      if (lat === undefined || lng === undefined) return [];

      const category = typeof metadata.category === "string" ? metadata.category : "LOCATION";
      const when = row.occurredAt?.toISOString() ?? row.createdAt.toISOString();
      const name = row.title?.trim() || `${category} - ${when}`;
      const description = [
        `Caso: ${row.case.caseNumber} - ${row.case.title}`,
        `Evidencia: ${row.evidence.fileName}`,
        `Data/Hora: ${when}`,
        `Categoria: ${category}`,
        `Artifact ID: ${row.id}`
      ].join("\n");

      return [
        [
          "    <Placemark>",
          `      <name>${escapeXml(name)}</name>`,
          `      <description>${escapeXml(description)}</description>`,
          `      <TimeStamp><when>${escapeXml(when)}</when></TimeStamp>`,
          "      <Point>",
          `        <coordinates>${lng},${lat},0</coordinates>`,
          "      </Point>",
          "    </Placemark>"
        ].join("\n")
      ];
    });

    const title = evidenceId ? `Localizacoes da evidencia ${evidenceId}` : caseId ? `Localizacoes do caso ${caseId}` : "Localizacoes CORE Analytics";
    const kml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      "  <Document>",
      `    <name>${escapeXml(title)}</name>`,
      ...placemarks,
      "  </Document>",
      "</kml>",
      ""
    ].join("\n");

    return new Response(kml, {
      headers: {
        "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${kmlFileName({ caseId, evidenceId })}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao gerar KML." },
      { status: 500 }
    );
  }
}
