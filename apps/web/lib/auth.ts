import { redirect } from "next/navigation";
import { ensureDefaultUserAndCase } from "@core/cases";
import { getSessionUser } from "./session";

export async function getMockSession() {
  const sessionUser = await getSessionUser();
  const { user, investigationCase } = await ensureDefaultUserAndCase();
  const effectiveUser = sessionUser
    ? { ...user, ...sessionUser }
    : user;

  return {
    user: {
      id: effectiveUser.id,
      email: effectiveUser.email,
      name: effectiveUser.name,
      role: effectiveUser.role
    },
    defaultCaseId: investigationCase?.id ?? null
  };
}

export async function requireSession() {
  const session = await getSessionUser();
  if (!session) {
    redirect("/login");
  }
  return session;
}

export function ensureRole(role: string, allowed: string[]) {
  if (!allowed.includes(role)) {
    throw new Error("Access denied for role.");
  }
}
