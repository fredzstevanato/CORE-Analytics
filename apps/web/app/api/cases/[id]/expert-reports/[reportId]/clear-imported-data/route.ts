import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent } from "@core/cases";
import { prisma, Prisma } from "@core/db";
import { getSessionUser } from "@/lib/session";

const paramsSchema = z.object({
  id: z.string().uuid(),
  reportId: z.string().uuid()
});

function isManualObject(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return false;
  const row = metadata as Record<string, unknown>;
  return row.source === "manual";
}

export async function POST(_: Request, context: { params: Promise<{ id: string; reportId: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const sessionUser = await getSessionUser();

    const report = await prisma.expertReport.findFirst({
      where: {
        id: params.reportId,
        caseId: params.id
      },
      include: {
        seizedObjects: {
          select: {
            id: true,
            metadata: true
          }
        }
      }
    });

    if (!report) {
      return NextResponse.json({ error: "Laudo nao encontrado para este caso." }, { status: 404 });
    }

    const deletableObjectIds = report.seizedObjects
      .filter((item) => !isManualObject(item.metadata))
      .map((item) => item.id);

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let deletedObjectsCount = 0;
      if (deletableObjectIds.length > 0) {
        await tx.deviceMatch.deleteMany({
          where: {
            seizedObjectId: {
              in: deletableObjectIds
            }
          }
        });

        await tx.device.updateMany({
          where: {
            matchedSeizedObjectId: {
              in: deletableObjectIds
            }
          },
          data: {
            matchedSeizedObjectId: null
          }
        });

        await tx.expertReportIdentifier.deleteMany({
          where: {
            seizedObjectId: {
              in: deletableObjectIds
            }
          }
        });

        const deletedObjects = await tx.seizedObject.deleteMany({
          where: {
            id: {
              in: deletableObjectIds
            }
          }
        });
        deletedObjectsCount = deletedObjects.count;
      }

      const deletedIdentifiers = await tx.expertReportIdentifier.deleteMany({
        where: {
          expertReportId: report.id
        }
      });

      const updatedReport = await tx.expertReport.update({
        where: {
          id: report.id
        },
        data: {
          status: "UPLOADED",
          reportNumber: null,
          issuingAgency: null,
          examinerName: null,
          summary: null,
          parsedPayload: Prisma.JsonNull,
          metadata: {
            clearedImportedDataAt: new Date().toISOString(),
            clearedImportedDataById: sessionUser?.id ?? null,
            clearReason: "manual-clear-imported-data"
          } as Prisma.InputJsonValue
        }
      });

      return {
        deletedObjectsCount,
        deletedIdentifiersCount: deletedIdentifiers.count,
        reportId: updatedReport.id
      };
    });

    await addCustodyEvent({
      caseId: params.id,
      actorId: sessionUser?.id,
      action: "EXPERT_REPORT_IMPORTED_DATA_CLEARED",
      source: "api/cases/expert-reports/clear-imported-data",
      details: {
        reportId: report.id,
        deletedObjectsCount: result.deletedObjectsCount,
        deletedIdentifiersCount: result.deletedIdentifiersCount
      } as Prisma.InputJsonValue
    });

    return NextResponse.json({
      success: true,
      ...result
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao limpar dados importados do laudo." },
      { status: 500 }
    );
  }
}
