import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppSettingRecord } from "@core/cases";
import { getSessionUser } from "@/lib/session";

const paramsSchema = z.object({
  key: z.string().min(2)
});

function ensureAdmin(role?: string) {
  return role === "ADMIN";
}

export async function GET(_: Request, context: { params: Promise<{ key: string }> }) {
  try {
    const session = await getSessionUser();
    if (!ensureAdmin(session?.role)) {
      return NextResponse.json({ error: "Acesso restrito a administradores." }, { status: 403 });
    }

    const params = paramsSchema.parse(await context.params);
    const row = await getAppSettingRecord(params.key, { includeSecretValue: true });
    if (!row) {
      return NextResponse.json({ error: "Configuração não encontrada." }, { status: 404 });
    }
    const content = row.isSecret ? row.secretValue ?? "" : row.valueText ?? JSON.stringify(row.valueJson ?? {}, null, 2);
    const fileName = row.fileName ?? `${row.key}.txt`;
    const mimeType = row.mimeType ?? "text/plain; charset=utf-8";
    return new NextResponse(content, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${fileName}"`
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao baixar configuração." },
      { status: 500 }
    );
  }
}
