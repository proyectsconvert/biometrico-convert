import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AccessInfo = {
  userId: string;
  email: string;
  fullName: string;
  tenantId: string | null;
  tenantName: string | null;
  isSuperAdmin: boolean;
  roleCodes: string[];
  scope: string;
  campaignIds: string[];
  permissions: Set<string>;
  can: (module: string, action: string) => boolean;
  loading: boolean;
};

const SessionContext = createContext<AccessInfo | null>(null);

type RolePermissionRow = { permissions: { module: string; action: string } | null };
type UserRoleRow = {
  scope: string;
  campaign_ids: string[] | null;
  roles: { code: string; role_permissions: RolePermissionRow[] | null } | null;
};

export function useSupabaseSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession((prev) => (prev?.user.id === next?.user.id && prev?.access_token === next?.access_token ? prev : next));
      setReady(true);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, ready };
}

export function SessionProvider({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  const userId = session.user.id;

  const profileQuery = useQuery({
    queryKey: ["mi-perfil", userId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, tenant_id, tenants(name)")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const rolesQuery = useQuery({
    queryKey: ["mis-roles", userId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("scope, campaign_ids, roles(code, role_permissions(permissions(module, action)))")
        .eq("user_id", userId);
      if (error) throw error;
      return (data ?? []) as unknown as UserRoleRow[];
    },
  });

  const value = useMemo<AccessInfo>(() => {
    const rows = rolesQuery.data ?? [];
    const roleCodes = rows.map((r) => r.roles?.code).filter(Boolean) as string[];
    const isSuperAdmin = roleCodes.includes("super_admin");
    const permissions = new Set<string>();
    for (const row of rows) {
      for (const rp of row.roles?.role_permissions ?? []) {
        if (rp.permissions) permissions.add(`${rp.permissions.module}.${rp.permissions.action}`);
      }
    }
    const order = ["solo_yo", "mi_campana", "campanas_asignadas", "mi_empresa", "plataforma"];
    const isAdminOrNomina = isSuperAdmin || roleCodes.includes("admin") || roleCodes.includes("nomina");
    const scope =
      isAdminOrNomina
        ? "plataforma"
        : (rows
            .map((r) => r.scope)
            .sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? "solo_yo");
    const campaignIds = rows.flatMap((r) => r.campaign_ids ?? []);
    const profile = profileQuery.data as
      | { full_name: string | null; email: string | null; tenant_id: string | null; tenants: { name: string } | null }
      | null
      | undefined;

    return {
      userId,
      email: profile?.email ?? session.user.email ?? "",
      fullName: profile?.full_name ?? session.user.email ?? "",
      tenantId: profile?.tenant_id ?? null,
      tenantName: profile?.tenants?.name ?? null,
      isSuperAdmin,
      roleCodes,
      scope,
      campaignIds,
      permissions,
      can: (module: string, action: string) =>
        isSuperAdmin || permissions.has(`${module}.${action}`),
      loading: profileQuery.isLoading || rolesQuery.isLoading,
    };
  }, [rolesQuery.data, rolesQuery.isLoading, profileQuery.data, profileQuery.isLoading, userId, session.user.email]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useAccess() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useAccess debe usarse dentro de SessionProvider");
  return ctx;
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    window.location.href = "/auth";
  };
}
