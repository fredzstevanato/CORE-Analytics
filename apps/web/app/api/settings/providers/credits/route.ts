import { NextResponse } from "next/server";
import { getAppSettingValue } from "@core/cases";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type ProviderCreditsResponse = {
  provider: "openai" | "assemblyai";
  configured: boolean;
  ok: boolean;
  creditsUsd: number | null;
  source: string;
  message?: string;
};

function ensureAdmin(role?: string) {
  return role === "ADMIN";
}

async function fetchOpenAiCredits(apiKey: string): Promise<ProviderCreditsResponse> {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - 60 * 60 * 24;

  // Try credit grants endpoint first (available on some org setups).
  try {
    const creditsResponse = await fetch("https://api.openai.com/dashboard/billing/credit_grants", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      cache: "no-store"
    });
    const creditsRaw = await creditsResponse.text();
    if (creditsResponse.ok) {
      const parsed = JSON.parse(creditsRaw) as { total_available?: unknown };
      const totalAvailable =
        typeof parsed.total_available === "number" && Number.isFinite(parsed.total_available)
          ? parsed.total_available
          : null;
      return {
        provider: "openai",
        configured: true,
        ok: true,
        creditsUsd: totalAvailable,
        source: "credit_grants"
      };
    }
  } catch {
    // Fall through to usage costs probe.
  }

  // Fallback to usage costs endpoint to verify key and provide observability.
  try {
    const costsResponse = await fetch(`https://api.openai.com/v1/organization/costs?start_time=${startTime}&end_time=${now}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      cache: "no-store"
    });
    const costsRaw = await costsResponse.text();
    if (!costsResponse.ok) {
      let message = `HTTP ${costsResponse.status}`;
      try {
        const parsed = JSON.parse(costsRaw) as { error?: { message?: string } };
        if (typeof parsed.error?.message === "string" && parsed.error.message.trim().length > 0) {
          message = parsed.error.message;
        }
      } catch {
        // Ignore parse errors.
      }
      return {
        provider: "openai",
        configured: true,
        ok: false,
        creditsUsd: null,
        source: "organization_costs",
        message
      };
    }

    return {
      provider: "openai",
      configured: true,
      ok: true,
      creditsUsd: null,
      source: "organization_costs",
      message: "Endpoint ativo; credito liquido nao retornado diretamente por esta API."
    };
  } catch (error) {
    return {
      provider: "openai",
      configured: true,
      ok: false,
      creditsUsd: null,
      source: "organization_costs",
      message: error instanceof Error ? error.message : "Falha ao consultar OpenAI."
    };
  }
}

async function fetchAssemblyAiCredits(apiKey: string): Promise<ProviderCreditsResponse> {
  try {
    const response = await fetch("https://api.assemblyai.com/v2/account", {
      method: "GET",
      headers: {
        authorization: apiKey
      },
      cache: "no-store"
    });
    const raw = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(raw) as { error?: string };
        if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
          message = parsed.error;
        }
      } catch {
        // Ignore parse errors.
      }
      return {
        provider: "assemblyai",
        configured: true,
        ok: false,
        creditsUsd: null,
        source: "account",
        message
      };
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const creditsRaw = parsed.account_balance ?? parsed.balance ?? parsed.credits;
    const creditsUsd = typeof creditsRaw === "number" && Number.isFinite(creditsRaw) ? creditsRaw : null;

    return {
      provider: "assemblyai",
      configured: true,
      ok: true,
      creditsUsd,
      source: "account",
      message: creditsUsd === null ? "Conta acessivel; saldo nao exposto explicitamente pela API atual." : undefined
    };
  } catch (error) {
    return {
      provider: "assemblyai",
      configured: true,
      ok: false,
      creditsUsd: null,
      source: "account",
      message: error instanceof Error ? error.message : "Falha ao consultar AssemblyAI."
    };
  }
}

export async function GET() {
  try {
    const session = await getSessionUser();
    if (!ensureAdmin(session?.role)) {
      return NextResponse.json({ error: "Acesso restrito a administradores." }, { status: 403 });
    }

    const openAiKey = (await getAppSettingValue("OPENAI_API_KEY"))?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
    const assemblyAiKey =
      (await getAppSettingValue("ASSEMBLYAI_API_KEY"))?.trim() || process.env.ASSEMBLYAI_API_KEY?.trim() || "";

    const [openai, assemblyai] = await Promise.all([
      openAiKey
        ? fetchOpenAiCredits(openAiKey)
        : Promise.resolve({
            provider: "openai" as const,
            configured: false,
            ok: false,
            creditsUsd: null,
            source: "missing_key",
            message: "OPENAI_API_KEY nao configurada."
          }),
      assemblyAiKey
        ? fetchAssemblyAiCredits(assemblyAiKey)
        : Promise.resolve({
            provider: "assemblyai" as const,
            configured: false,
            ok: false,
            creditsUsd: null,
            source: "missing_key",
            message: "ASSEMBLYAI_API_KEY nao configurada."
          })
    ]);

    return NextResponse.json({
      providers: {
        openai,
        assemblyai
      },
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao consultar creditos dos provedores." },
      { status: 500 }
    );
  }
}
