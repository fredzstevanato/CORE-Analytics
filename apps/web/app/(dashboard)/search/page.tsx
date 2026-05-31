import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LegacySearchRedirect({
  searchParams
}: {
  searchParams: Promise<{ q?: string; scope?: string; caseId?: string; evidenceId?: string; extractionId?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.scope) query.set("scope", params.scope);
  if (params.caseId) query.set("caseId", params.caseId);
  if (params.evidenceId) query.set("evidenceId", params.evidenceId);
  if (params.extractionId) query.set("extractionId", params.extractionId);
  redirect(`/analysis/search${query.toString() ? `?${query.toString()}` : ""}`);
}
