import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/session";

export async function requireApiSession(): Promise<{ session: SessionUser } | { error: NextResponse }> {
  const session = await getSessionUser();
  if (!session) {
    return {
      error: NextResponse.json({ error: "Nao autenticado. Faca login para continuar." }, { status: 401 })
    };
  }
  return { session };
}

export function requireApiRole(session: SessionUser, allowedRoles: string[]): { ok: true } | { error: NextResponse } {
  if (!allowedRoles.includes(session.role)) {
    return {
      error: NextResponse.json({ error: "Acesso restrito para este perfil." }, { status: 403 })
    };
  }
  return { ok: true };
}
