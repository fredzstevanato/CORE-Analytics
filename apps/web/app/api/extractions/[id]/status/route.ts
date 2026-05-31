import { NextResponse } from "next/server";
import { getExtractionProgressPayload } from "@/lib/extraction-progress";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const payload = await getExtractionProgressPayload(params.id);
  if (!payload) {
    return NextResponse.json({ error: "Extraction not found." }, { status: 404 });
  }
  return NextResponse.json(payload);
}
