"use client";

import { useMemo, useState } from "react";

type InvolvedCategoryKey = "SUSPECT" | "VICTIM" | "WITNESS" | "OTHER";

type InvolvedPerson = {
  name: string;
  category: InvolvedCategoryKey;
  confidence: "AUTO_EXTRACTED" | "REVIEW_RECOMMENDED";
  reason: string;
  evidenceExcerpt?: string;
  sourceReference?: string;
  sourceDocuments: Array<{ documentId?: string; fileName: string }>;
};

function categoryLabel(category: InvolvedCategoryKey) {
  if (category === "SUSPECT") return "Suspeitos";
  if (category === "VICTIM") return "Vítimas";
  if (category === "WITNESS") return "Testemunhas";
  return "Outros relacionados";
}

type FilterKey = "SUSPECT" | "VICTIM" | "OTHER";

export function CaseInvolvedPeoplePanel({ people }: { people: InvolvedPerson[] }) {
  const [filter, setFilter] = useState<FilterKey>("SUSPECT");

  const filtered = useMemo(() => {
    return people.filter((p) => {
      if (filter === "OTHER") return p.category === "OTHER" || p.category === "WITNESS";
      return p.category === filter;
    });
  }, [people, filter]);

  const counts = useMemo(() => {
    return {
      SUSPECT: people.filter((item) => item.category === "SUSPECT").length,
      VICTIM: people.filter((item) => item.category === "VICTIM").length,
      OTHER: people.filter((item) => item.category === "OTHER" || item.category === "WITNESS").length
    };
  }, [people]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {(["SUSPECT", "VICTIM", "OTHER"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className={`rounded px-2 py-1 text-xs ${
              filter === option ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
            }`}
          >
            {option === "SUSPECT" ? "Suspeitos" : option === "VICTIM" ? "Vítimas" : "Outros"} ({counts[option]})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-xs text-zinc-500 p-2">Nenhum envolvido nesta categoria.</p>
      ) : (
        <div className="space-y-1">
          {filtered.map((person, index) => (
            <div key={`${person.category}-${person.name}-${index}`} className="rounded border border-zinc-200 bg-white p-2">
              <p className="text-xs font-medium text-zinc-800">{person.name}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <span className="rounded bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-700">
                  {person.confidence === "AUTO_EXTRACTED" ? "Extração automática" : "Revisão manual recomendada"}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-600">{person.reason}</p>
              {person.evidenceExcerpt ? (
                <p className="mt-1 rounded bg-zinc-50 p-1 text-[11px] text-zinc-700">
                  Trecho: {person.evidenceExcerpt}
                </p>
              ) : null}
              {person.sourceReference ? (
                <p className="mt-1 text-[11px] text-zinc-500">Referência textual: {person.sourceReference}</p>
              ) : null}
              {person.sourceDocuments.length > 0 ? (
                <p className="mt-1 text-[11px] text-zinc-500">
                  Documentos: {person.sourceDocuments.map((doc) => doc.fileName).join(" • ")}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
