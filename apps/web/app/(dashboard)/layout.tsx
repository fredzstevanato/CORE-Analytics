import { Sidebar } from "@/components/sidebar";
import { ensureRole, getMockSession, requireSession } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { LiveDataControls } from "@/components/live-data-controls";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const sessionUser = await requireSession();
  ensureRole(sessionUser.role, ["ADMIN", "ANALYST", "REVIEWER"]);
  const session = await getMockSession();

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-6">
        <header className="mb-6 flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-4">
          <div className="space-y-2">
            <div>
              <p className="text-xs uppercase text-zinc-500">Usuario</p>
              <p className="font-medium">{session.user.name}</p>
            </div>
            <LiveDataControls />
          </div>
          <div className="text-right">
            <p className="text-xs uppercase text-zinc-500">Role</p>
            <p className="font-medium">{session.user.role}</p>
            <form action="/api/auth/logout" method="post" className="mt-2">
              <Button type="submit" variant="outline" size="sm">
                Sair
              </Button>
            </form>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
