import { NextResponse } from "next/server";
import { investigativeSearch } from "@core/search";
import { investigativeSearchFiltersSchema } from "@core/shared";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const filters = investigativeSearchFiltersSchema.parse({
    caseId: url.searchParams.get("caseId") ?? undefined,
    evidenceId: url.searchParams.get("evidenceId") ?? undefined,
    extractionId: url.searchParams.get("extractionId") ?? undefined,
    sourceApp: url.searchParams.get("sourceApp") ?? undefined,
    participant: url.searchParams.get("participant") ?? undefined,
    phoneOrEmail: url.searchParams.get("phoneOrEmail") ?? undefined,
    dateFrom: url.searchParams.get("dateFrom") ?? undefined,
    dateTo: url.searchParams.get("dateTo") ?? undefined,
    artifactType: url.searchParams.get("artifactType") ?? undefined
  });

  try {
    const scopeRaw = url.searchParams.get("scope");
    const scope =
      scopeRaw && scopeRaw !== "all"
        ? (scopeRaw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean) as Array<"messages" | "chats" | "entities" | "attachments" | "calls" | "files">)
        : undefined;
    const results = await investigativeSearch({
      query,
      filters,
      scope
    });
    return NextResponse.json({ hits: results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao buscar." },
      { status: 500 }
    );
  }
}
