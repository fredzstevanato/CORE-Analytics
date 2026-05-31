import { NextResponse } from "next/server";
import {
  getConsolidatedSyncConfig,
  importConsolidatedSyncPackage,
  listConsolidatedSyncPackages,
  type ConsolidatedSyncPackage
} from "@core/cases";
import { requireApiSession } from "@/lib/api-auth";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

async function authorizeInboundPackage(request: Request) {
  const expected = process.env.SYNC_API_TOKEN?.trim() || process.env.CORE_SYNC_API_TOKEN?.trim();
  const received = bearerToken(request);
  if (expected && received && received === expected) {
    return { actorId: undefined };
  }

  const session = await getSessionUser();
  if (session) return { actorId: session.id };

  return null;
}

export async function GET() {
  const auth = await requireApiSession();
  if ("error" in auth) return auth.error;

  const packages = await listConsolidatedSyncPackages(50);
  return NextResponse.json({
    ok: true,
    config: getConsolidatedSyncConfig(),
    packages
  });
}

export async function POST(request: Request) {
  try {
    const config = getConsolidatedSyncConfig();
    if (!config.canReceiveExternalPackages) {
      return NextResponse.json(
        { error: "Esta instancia nao esta configurada como CENTRALIZER para receber pacotes externos." },
        { status: 403 }
      );
    }

    const auth = await authorizeInboundPackage(request);
    if (!auth) {
      return NextResponse.json({ error: "Token de sincronizacao invalido ou sessao ausente." }, { status: 401 });
    }

    const pkg = (await request.json()) as ConsolidatedSyncPackage;
    const result = await importConsolidatedSyncPackage(pkg, { actorId: auth.actorId });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao importar pacote consolidado."
      },
      { status: 500 }
    );
  }
}
