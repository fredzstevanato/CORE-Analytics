import { NextResponse } from "next/server";
import { z } from "zod";
import { listDeviceMatches, upsertDeviceMatch } from "@core/cases";
import { prisma } from "@core/db";
import { getSessionUser } from "@/lib/session";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z.object({
  seizedObjectId: z.string().uuid(),
  expertReportId: z.string().uuid().optional(),
  status: z.enum(["SUGGESTED", "CONFIRMED", "REJECTED"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  justification: z.string().optional()
});

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const device = await prisma.device.findUnique({
      where: { id: params.id },
      include: {
        extraction: {
          include: {
            evidence: true
          }
        }
      }
    });
    if (!device) {
      return NextResponse.json({ error: "Dispositivo nao encontrado." }, { status: 404 });
    }

    const matches = await listDeviceMatches(device.extraction.evidence.caseId);
    return NextResponse.json({
      matches: matches.filter((match) => match.deviceId === params.id)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao listar matches do dispositivo." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const parsed = bodySchema.parse(await request.json());
    const sessionUser = await getSessionUser();

    const match = await upsertDeviceMatch({
      deviceId: params.id,
      seizedObjectId: parsed.seizedObjectId,
      expertReportId: parsed.expertReportId,
      status: parsed.status,
      confidence: parsed.confidence,
      justification: parsed.justification,
      reviewedById: sessionUser?.id,
      metadata: {
        source: "device-match-form"
      }
    });

    return NextResponse.json({ match });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao registrar match do dispositivo." },
      { status: 500 }
    );
  }
}
