import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { SessionProvider, useSupabaseSession } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // getSession lee la sesión local (sin ir a la red en cada navegación)
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/auth" });
    return { user: data.session.user };
  },
  component: Layout,
});

function Layout() {
  const { session, ready } = useSupabaseSession();

  if (!ready || !session) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <SessionProvider session={session}>
      <AppShell>
        <Outlet />
      </AppShell>
    </SessionProvider>
  );
}
