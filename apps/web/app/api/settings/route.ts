import { NextResponse } from "next/server";
import { z } from "zod";
import { listAppSettings, upsertAppSetting } from "@core/cases";
import { Prisma } from "@core/db";
import { getSessionUser } from "@/lib/session";

const bodySchema = z.object({
  key: z.string().min(2),
  category: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  isSecret: z.boolean().optional(),
  valueText: z.string().optional(),
  valueJson: z.unknown().optional()
});

function ensureAdmin(role?: string) {
  return role === "ADMIN";
}

export async function GET() {
  try {
    const session = await getSessionUser();
    if (!ensureAdmin(session?.role)) {
      return NextResponse.json({ error: "Acesso restrito a administradores." }, { status: 403 });
    }
    const settings = await listAppSettings();
    return NextResponse.json({ settings });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao listar configurações." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!ensureAdmin(session?.role)) {
      return NextResponse.json({ error: "Acesso restrito a administradores." }, { status: 403 });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const key = String(form.get("key") ?? "");
      const category = String(form.get("category") ?? "GENERAL");
      const label = String(form.get("label") ?? "");
      const description = String(form.get("description") ?? "");
      const isSecret = String(form.get("isSecret") ?? "false") === "true";
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "Arquivo de configuração não enviado." }, { status: 400 });
      }
      const text = Buffer.from(await file.arrayBuffer()).toString("utf-8");
      const setting = await upsertAppSetting({
        key,
        category,
        label: label || undefined,
        description: description || undefined,
        isSecret,
        valueText: text,
        fileName: file.name,
        mimeType: file.type || "text/plain",
        metadata: {
          source: "settings-upload",
          uploadedAt: new Date().toISOString()
        } as Prisma.InputJsonValue,
        updatedById: session?.id
      });
      return NextResponse.json({ setting });
    }

    const parsed = bodySchema.parse(await request.json());
    const setting = await upsertAppSetting({
      key: parsed.key,
      category: parsed.category,
      label: parsed.label,
      description: parsed.description,
      isSecret: parsed.isSecret,
      valueText: parsed.valueText,
      valueJson: parsed.valueJson as Prisma.InputJsonValue,
      updatedById: session?.id
    });
    return NextResponse.json({ setting });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao salvar configuração." },
      { status: 500 }
    );
  }
}
