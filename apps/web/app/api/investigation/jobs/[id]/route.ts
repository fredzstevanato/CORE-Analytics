import { NextResponse } from "next/server";
import { getInvestigationJobStatus } from "@core/queue";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Ctx) {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;
    const roleCheck = requireApiRole(auth.session, ["ADMIN", "ANALYST", "REVIEWER"]);
    if ("error" in roleCheck) return roleCheck.error;

    const params = await context.params;
    const url = new URL(request.url);
    const typeParam = url.searchParams.get("type");
    const type = typeParam === "report" ? "report" : "triage";

    const status = await getInvestigationJobStatus({ type, jobId: params.id });
    if (!status) {
      return NextResponse.json({ error: "Job nao encontrado." }, { status: 404 });
    }

    return NextResponse.json(status, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao consultar job." },
      { status: 500 }
    );
  }
}
