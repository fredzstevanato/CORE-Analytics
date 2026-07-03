import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@core/db";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

const paramsSchema = z.object({
  id: z.string().uuid()
});

const bodySchema = z.object({
  alias: z.string().max(120).optional().default("")
});

function processingDetailsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const params = paramsSchema.parse(await context.params);
    const parsedBody = bodySchema.parse(await request.json());
    const alias = parsedBody.alias.trim();

    const evidence = await prisma.evidence.findUnique({
      where: { id: params.id },
      include: { extraction: true }
    });

    if (!evidence) {
      return NextResponse.json({ error: "Evidencia nao encontrada." }, { status: 404 });
    }

    const nextLabel = alias || evidence.fileName;

    await prisma.evidence.update({
      where: { id: evidence.id },
      data: {
        label: nextLabel
      }
    });

    if (evidence.extraction) {
      const details = processingDetailsRecord(evidence.extraction.processingDetails);
      const nextDetails = {
        ...details,
        ufdrAlias: alias || null
      };

      await prisma.extraction.update({
        where: { id: evidence.extraction.id },
        data: {
          processingDetails: nextDetails
        }
      });
    }

    return NextResponse.json({
      ok: true,
      evidenceId: evidence.id,
      alias: alias || null,
      label: nextLabel
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao salvar nome opcional da UFDR." },
      { status: 500 }
    );
  }
}
