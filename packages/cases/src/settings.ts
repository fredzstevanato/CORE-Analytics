import { prisma, Prisma } from "@core/db";
import { decryptText, encryptText } from "@core/shared";

function buildSettingsSecrets() {
  const primary = process.env.SETTINGS_ENCRYPTION_KEY?.trim() || process.env.SESSION_SECRET?.trim();
  if (primary) {
    const candidates = [
      primary,
      process.env.SETTINGS_ENCRYPTION_KEY?.trim(),
      process.env.SESSION_SECRET?.trim(),
      // Legacy/dev fallback secrets kept for backward-compatible decryption.
      "dev-settings-secret",
      "dev-settings-secret-change-me",
      "dev-insecure-session-secret"
    ].filter((value): value is string => Boolean(value && value.trim().length > 0));
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const secret of candidates) {
      if (seen.has(secret)) continue;
      seen.add(secret);
      unique.push(secret);
    }
    return {
      primary,
      candidates: unique
    };
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SETTINGS_ENCRYPTION_KEY obrigatorio em producao para proteger segredos.");
  }
  return {
    primary: "dev-settings-secret-change-me",
    candidates: ["dev-settings-secret-change-me", "dev-settings-secret", "dev-insecure-session-secret"]
  };
}

function decryptSettingValue(encryptedValue: string) {
  const secrets = buildSettingsSecrets();
  let lastError: Error | null = null;
  for (const secret of secrets.candidates) {
    try {
      return decryptText(encryptedValue, secret);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Falha ao descriptografar configuracao.");
    }
  }
  if (lastError) throw lastError;
  throw new Error("Falha ao descriptografar configuracao.");
}

export type UpsertAppSettingInput = {
  key: string;
  category?: string;
  label?: string;
  description?: string;
  isSecret?: boolean;
  valueText?: string;
  valueJson?: Prisma.InputJsonValue;
  fileName?: string;
  mimeType?: string;
  metadata?: Prisma.InputJsonValue;
  updatedById?: string;
};

function normalizeKey(value: string) {
  return value.replace(/\s+/g, "_").trim().toUpperCase();
}

export async function upsertAppSetting(input: UpsertAppSettingInput) {
  const key = normalizeKey(input.key);
  const isSecret = input.isSecret === true;
  const valueText = typeof input.valueText === "string" ? input.valueText : undefined;
  const encryptedValue = isSecret && valueText ? encryptText(valueText, buildSettingsSecrets().primary) : undefined;
  return prisma.appSetting.upsert({
    where: { key },
    update: {
      category: input.category ?? undefined,
      label: input.label ?? undefined,
      description: input.description ?? undefined,
      isSecret,
      valueText: isSecret ? null : valueText ?? null,
      valueJson: input.valueJson ?? Prisma.JsonNull,
      encryptedValue: isSecret ? encryptedValue ?? null : null,
      fileName: input.fileName ?? null,
      mimeType: input.mimeType ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
      updatedById: input.updatedById
    },
    create: {
      key,
      category: input.category ?? "GENERAL",
      label: input.label,
      description: input.description,
      isSecret,
      valueText: isSecret ? null : valueText,
      valueJson: input.valueJson,
      encryptedValue: isSecret ? encryptedValue : null,
      fileName: input.fileName,
      mimeType: input.mimeType,
      metadata: input.metadata,
      updatedById: input.updatedById
    }
  });
}

export async function listAppSettings() {
  const rows = await prisma.appSetting.findMany({
    orderBy: [{ category: "asc" }, { key: "asc" }]
  });
  return rows.map((row) => ({
    ...row,
    valueText: row.isSecret ? null : row.valueText,
    encryptedValue: row.isSecret ? "__masked__" : null,
    hasValue: row.isSecret ? !!row.encryptedValue : !!row.valueText || !!row.valueJson
  }));
}

export async function getAppSettingValue(key: string, options?: { fallbackEnv?: boolean }) {
  const normalizedKey = normalizeKey(key);
  const row = await prisma.appSetting.findUnique({
    where: { key: normalizedKey }
  });
  if (row) {
    if (row.isSecret) {
      if (!row.encryptedValue) return undefined;
      return decryptSettingValue(row.encryptedValue);
    }
    if (typeof row.valueText === "string" && row.valueText.trim().length > 0) {
      return row.valueText;
    }
  }
  if (options?.fallbackEnv !== false) {
    return process.env[normalizedKey];
  }
  return undefined;
}

export async function getAppSettingRecord(key: string, options?: { includeSecretValue?: boolean }) {
  const normalizedKey = normalizeKey(key);
  const row = await prisma.appSetting.findUnique({
    where: { key: normalizedKey }
  });
  if (!row) return null;
  const secretValue =
    options?.includeSecretValue && row.isSecret && row.encryptedValue
      ? decryptSettingValue(row.encryptedValue)
      : undefined;
  return {
    ...row,
    secretValue
  };
}
