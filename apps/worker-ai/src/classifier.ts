export function classifyInvestigativeText(text: string): {
  title: string;
  summary: string;
  score: number;
  tags: string[];
} {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const tags: string[] = [];

  if (/(arma|armado|municao|pistola|revolver|rifle|fuzil|espingarda|tiro|atirar|gun)/.test(normalized)) {
    tags.push("weapon");
  }
  if (/(droga|entorpecente|coca|cocaina|maconha|crack|trafic|biqueira|boca de fumo|fornecedor)/.test(normalized)) {
    tags.push("drug");
  }
  if (/(ameaca|ameacar|matar|morte|homicidio|kill|sequestro|tortura|agredir|agressao)/.test(normalized)) {
    tags.push("threat");
  }
  if (/(pix|transfer|bank|banco|deposito|dinheiro|laranja|lavagem|pagamento|cobranca)/.test(normalized)) {
    tags.push("financial");
  }
  if (/(roubo|furto|assalto|receptacao|extorsao|golpe|fraude|estelionato|quadrilha|organizacao criminosa)/.test(normalized)) {
    tags.push("crime");
  }

  const score = Math.min(1, 0.25 + tags.length * 0.2);
  const title = tags.length > 0 ? `Potential signals: ${tags.join(", ")}` : "No critical signals detected";
  const summary = text.slice(0, 600);

  return { title, summary, score, tags };
}
