import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LegacyTimelineRedirect({
  searchParams
}: {
  searchParams: Promise<{ caseId?: string; evidenceId?: string; category?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.caseId) query.set("caseId", params.caseId);
  if (params.evidenceId) query.set("evidenceId", params.evidenceId);
  if (params.category) query.set("category", params.category);
  redirect(`/analysis/timeline${query.toString() ? `?${query.toString()}` : ""}`);
}
