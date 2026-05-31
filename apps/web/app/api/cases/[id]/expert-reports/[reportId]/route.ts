import path from "node:path";
import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { addCustodyEvent } from "@core/cases";
import { prisma, Prisma } from "@core/db";
import { getSessionUser } from "@/lib/session";

const paramsSchema = z.object({
  id: z.string().uuid(),
  reportId: z.string().uuid()
});

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string; reportId: string }> }) {
  try {
    const params = paramsSchema.parse(await context.params);
    const sessionUser = await getSessionUser();

    const report = await prisma.expertReport.findFirst({
      where: {
        id: params.reportId,
        caseId: params.id
      },
      include: {
        caseDocument: {
          select: {
            id: true,
            storagePath: true,
            fileName: true
          }
        },
        seizedObjects: {
          select: {
            id: true
          }
        }
      }
    });

    if (!report) {
      return NextResponse.json({ error: "Laudo nao encontrado para este caso." }, { status: 404 });
    }

    const metadata = report.metadata && typeof report.metadata === "object" ? (report.metadata as Record<string, unknown>) : null;
    const printSimulationDocumentId = asString(metadata?.printSimulationDocumentId);
    const unsignedCopyDocumentId = asString(metadata?.unsignedCopyDocumentId);
    const derivedDocumentId = printSimulationDocumentId ?? unsignedCopyDocumentId;

    const additionalDocument = derivedDocumentId
      ? await prisma.caseDocument.findFirst({
          where: {
            id: derivedDocumentId,
            caseId: params.id
          },
          select: {
            id: true,
            storagePath: true,
            fileName: true
          }
        })
      : null;

    const docRows = [report.caseDocument, additionalDocument].filter(Boolean) as Array<{
      id: string;
      storagePath: string;
      fileName: string;
    }>;

    const seizedObjectIds = report.seizedObjects.map((item) => item.id);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (seizedObjectIds.length > 0) {
        await tx.deviceMatch.deleteMany({
          where: {
            seizedObjectId: {
              in: seizedObjectIds
            }
          }
        });

        await tx.device.updateMany({
          where: {
            matchedSeizedObjectId: {
              in: seizedObjectIds
            }
          },
          data: {
            matchedSeizedObjectId: null
          }
        });

        await tx.seizedObject.deleteMany({
          where: {
            id: {
              in: seizedObjectIds
            }
          }
        });
      }

      await tx.expertReportIdentifier.deleteMany({
        where: {
          expertReportId: report.id
        }
      });

      await tx.deviceMatch.deleteMany({
        where: {
          expertReportId: report.id
        }
      });

      await tx.expertReport.delete({
        where: {
          id: report.id
        }
      });

      if (docRows.length > 0) {
        await tx.caseDocument.deleteMany({
          where: {
            id: {
              in: docRows.map((item) => item.id)
            },
            caseId: params.id
          }
        });
      }
    });

    for (const doc of docRows) {
      const absolutePath = path.resolve(process.env.STORAGE_ROOT ?? "./storage", doc.storagePath);
      await rm(absolutePath, { force: true }).catch(() => undefined);
    }

    await addCustodyEvent({
      caseId: params.id,
      actorId: sessionUser?.id,
      action: "EXPERT_REPORT_DELETED",
      source: "api/cases/expert-reports/[reportId]",
      details: {
        reportId: report.id,
        deletedDocumentIds: docRows.map((item) => item.id),
        deletedSeizedObjects: seizedObjectIds.length
      } as Prisma.InputJsonValue
    });

    return NextResponse.json({
      success: true,
      reportId: report.id,
      deletedDocumentIds: docRows.map((item) => item.id)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao excluir laudo e anexos." },
      { status: 500 }
    );
  }
}
