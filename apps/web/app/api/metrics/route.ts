import { NextResponse } from "next/server";
import { prisma } from "@core/db";

export async function GET() {
  const [cases, evidences, extractions, transcriptions, failedExtractions, failedTranscriptions] = await Promise.all([
    prisma.case.count(),
    prisma.evidence.count(),
    prisma.extraction.count(),
    prisma.audioTranscription.count(),
    prisma.extraction.count({ where: { status: "FAILED" } }),
    prisma.audioTranscription.count({ where: { status: "FAILED" } })
  ]);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    totals: {
      cases,
      evidences,
      extractions,
      transcriptions
    },
    failures: {
      extractions: failedExtractions,
      transcriptions: failedTranscriptions
    }
  });
}
