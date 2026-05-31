import { NextResponse } from "next/server";
import { getAppSettingValue } from "@core/cases";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;

    const openAiKey =
      (await getAppSettingValue("OPENAI_API_KEY"))?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
    const assemblyAiKey =
      (await getAppSettingValue("ASSEMBLYAI_API_KEY"))?.trim() || process.env.ASSEMBLYAI_API_KEY?.trim() || "";

    return NextResponse.json({
      transcriptionProviders: {
        local: true,
        openai: openAiKey.length >= 20,
        assemblyai: assemblyAiKey.length >= 20
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao verificar disponibilidade de providers." },
      { status: 500 }
    );
  }
}
