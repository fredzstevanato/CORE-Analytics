import { NextResponse } from "next/server";
import { z } from "zod";
import { createSeizedObject, listCaseSeizedObjects } from "@core/cases";
import { prisma } from "@core/db";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z.object({
  label: z.string().min(3),
  objectType: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  imei: z.string().optional(),
  imei2: z.string().optional(),
  iccid1: z.string().optional(),
  iccid2: z.string().optional(),
  serialNumber: z.string().optional(),
  custodyTag: z.string().optional(),
  expertReportId: z.string().uuid().optional()
});

const deleteSchema = z.object({
  objectId: z.string().uuid()
});

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const objects = await listCaseSeizedObjects(params.id);
    return NextResponse.json({ objects });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao listar objetos apreendidos." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const caseRow = await prisma.case.findUnique({ where: { id: params.id }, select: { id: true } });
    if (!caseRow) {
      return NextResponse.json({ error: "Caso nao encontrado." }, { status: 404 });
    }

    const parsed = bodySchema.parse(await request.json());
    const object = await createSeizedObject({
      caseId: params.id,
      expertReportId: parsed.expertReportId,
      label: parsed.label,
      objectType: parsed.objectType,
      manufacturer: parsed.manufacturer,
      model: parsed.model,
      imei: parsed.imei,
      imei2: parsed.imei2,
      iccid1: parsed.iccid1,
      iccid2: parsed.iccid2,
      serialNumber: parsed.serialNumber,
      custodyTag: parsed.custodyTag,
      metadata: {
        source: "manual"
      }
    });

    return NextResponse.json({ object });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao cadastrar objeto apreendido." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const parsed = deleteSchema.parse(await request.json());

    const object = await prisma.seizedObject.findUnique({
      where: { id: parsed.objectId },
      select: {
        id: true,
        caseId: true,
        label: true,
        expertReportId: true
      }
    });

    if (!object || object.caseId !== params.id) {
      return NextResponse.json({ error: "Objeto apreendido nao encontrado para este caso." }, { status: 404 });
    }

    await prisma.seizedObject.delete({ where: { id: object.id } });

    return NextResponse.json({
      ok: true,
      deletedObjectId: object.id,
      deletedObjectLabel: object.label,
      detachedFromReport: Boolean(object.expertReportId)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao excluir objeto apreendido." },
      { status: 500 }
    );
  }
}
