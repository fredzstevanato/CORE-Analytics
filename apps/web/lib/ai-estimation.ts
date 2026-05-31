type PricePerMillion = {
  inputPer1M: number;
  outputPer1M: number;
};

const DEFAULT_TEXT_MODEL_PRICING: Record<string, PricePerMillion> = {
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-4o": { inputPer1M: 5, outputPer1M: 15 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 }
};

const DEFAULT_AUDIO_PRICE_PER_MINUTE: Record<string, number> = {
  "whisper-1": 0.006,
  "gpt-4o-transcribe": 0.006,
  "gpt-4o-mini-transcribe": 0.003
};

function normalizeModel(model: string) {
  return model.trim().toLowerCase();
}

export function resolveTextModelPricing(model: string): PricePerMillion | null {
  const key = normalizeModel(model);
  const envRaw = process.env.OPENAI_MODEL_PRICING_JSON;
  if (envRaw) {
    try {
      const parsed = JSON.parse(envRaw) as Record<string, { inputPer1M?: number; outputPer1M?: number }>;
      const row = parsed[key];
      if (
        row &&
        typeof row.inputPer1M === "number" &&
        Number.isFinite(row.inputPer1M) &&
        typeof row.outputPer1M === "number" &&
        Number.isFinite(row.outputPer1M)
      ) {
        return {
          inputPer1M: row.inputPer1M,
          outputPer1M: row.outputPer1M
        };
      }
    } catch {
      // noop
    }
  }
  return DEFAULT_TEXT_MODEL_PRICING[key] ?? null;
}

export function estimateTextCostUsd(input: { model: string; inputTokens: number; outputTokens: number }) {
  const pricing = resolveTextModelPricing(input.model);
  if (!pricing) return null;
  const inCost = (Math.max(0, input.inputTokens) / 1_000_000) * pricing.inputPer1M;
  const outCost = (Math.max(0, input.outputTokens) / 1_000_000) * pricing.outputPer1M;
  return Number((inCost + outCost).toFixed(6));
}

export function resolveAudioPricePerMinute(model: string) {
  const key = normalizeModel(model);
  const envRaw = process.env.OPENAI_AUDIO_PRICE_PER_MINUTE_JSON;
  if (envRaw) {
    try {
      const parsed = JSON.parse(envRaw) as Record<string, number>;
      const fromEnv = parsed[key];
      if (typeof fromEnv === "number" && Number.isFinite(fromEnv)) {
        return fromEnv;
      }
    } catch {
      // noop
    }
  }
  return DEFAULT_AUDIO_PRICE_PER_MINUTE[key] ?? null;
}

export function estimateAudioCostUsd(input: { model: string; totalMinutes: number }) {
  const pricePerMinute = resolveAudioPricePerMinute(input.model);
  if (pricePerMinute === null) return null;
  return Number((Math.max(0, input.totalMinutes) * pricePerMinute).toFixed(6));
}

