import { NextResponse } from "next/server";
import { prisma } from "@core/db";
import { verifyPassword } from "@core/shared";
import { setSessionCookie } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return NextResponse.json({ error: "Email e senha obrigatorios." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      return NextResponse.json({ error: "Credenciais invalidas." }, { status: 401 });
    }

    await setSessionCookie({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("auth.login.error", error);
    return NextResponse.json({ error: "Erro interno no login." }, { status: 500 });
  }
}
