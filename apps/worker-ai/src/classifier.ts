export function classifyInvestigativeText(text: string): {
  title: string;
  summary: string;
  score: number;
  tags: string[];
} {
  const normalized = text.toLowerCase();
  const tags: string[] = [];

  if (/(arma|gun|pistola|rifle)/.test(normalized)) tags.push("weapon");
  if (/(droga|coca|maconha|trafic)/.test(normalized)) tags.push("drug");
  if (/(ameaça|matar|kill|morte)/.test(normalized)) tags.push("threat");
  if (/(pix|transfer|bank|depósito|deposito)/.test(normalized)) tags.push("financial");

  const score = Math.min(1, 0.25 + tags.length * 0.2);
  const title = tags.length > 0 ? `Potential signals: ${tags.join(", ")}` : "No critical signals detected";
  const summary = text.slice(0, 600);

  return { title, summary, score, tags };
}
