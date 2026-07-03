"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("analista@core.local");
  const [password, setPassword] = useState("Admin@123");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password })
      });

      if (!response.ok) {
        let message = "Falha no login.";
        const raw = await response.text();
        if (raw) {
          try {
            const payload = JSON.parse(raw) as { error?: string };
            if (payload.error) message = payload.error;
          } catch {
            message = "Falha no login. Resposta invalida do servidor.";
          }
        }
        setError(message);
        setLoading(false);
        return;
      }

      window.location.assign("/dashboard");
      router.refresh();
    } catch {
      setError("Nao foi possivel conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1">
        <label className="text-sm font-medium">Email</label>
        <Input value={email} onChange={(event) => setEmail(event.target.value)} required />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Senha</label>
        <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      </div>
      <Button type="submit" disabled={loading}>
        {loading ? "Entrando..." : "Entrar"}
      </Button>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </form>
  );
}
