import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LegacyMessagesRedirect({
  searchParams
}: {
  searchParams: Promise<{ platform?: string; q?: string; chatId?: string; caseId?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.platform) query.set("platform", params.platform);
  if (params.q) query.set("q", params.q);
  if (params.chatId) query.set("chatId", params.chatId);
  if (params.caseId) query.set("caseId", params.caseId);
  redirect(`/analysis/messages${query.toString() ? `?${query.toString()}` : ""}`);
}
