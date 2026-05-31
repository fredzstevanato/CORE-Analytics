export function sanitizeTextForDatabase(value: string) {
  let sanitized = "";

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code === 0) {
      continue;
    }

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        sanitized += value.charAt(i) + value.charAt(i + 1);
        i += 1;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }

    sanitized += value.charAt(i);
  }

  return sanitized;
}

export function sanitizeJsonForDatabase(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return sanitizeTextForDatabase(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonForDatabase(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const sanitized = sanitizeJsonForDatabase(item);
      if (sanitized !== undefined) {
        output[sanitizeTextForDatabase(key)] = sanitized;
      }
    }
    return output;
  }

  return sanitizeTextForDatabase(String(value));
}
