import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Recalcula la asistencia de un rango desde el servidor (sin el límite de 8 s del navegador),
 * mes a mes. Si no se indica rango, usa todo el periodo con marcaciones.
 */
export const recalcularAsistencia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
    z
      .object({
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const permisos = await Promise.all(
      [["asistencia", "editar"], ["reglas", "editar"], ["festivos", "crear"], ["festivos", "editar"]].map(([m, a]) =>
        context.supabase.rpc("has_permission", { _module: m!, _action: a! }),
      ),
    );
    if (!permisos.some((p) => p.data)) throw new Error("No tienes permiso para recalcular la asistencia.");
    const { data: tenant } = await context.supabase.rpc("current_tenant_id");
    if (!tenant) throw new Error("Tu usuario no está asignado a una empresa.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let desde = data.desde;
    let hasta = data.hasta;
    if (!desde || !hasta) {
      const [a, b] = await Promise.all([
        supabaseAdmin.from("biometric_events").select("event_at").eq("tenant_id", tenant).eq("is_attendance", true).order("event_at").limit(1),
        supabaseAdmin.from("biometric_events").select("event_at").eq("tenant_id", tenant).eq("is_attendance", true).order("event_at", { ascending: false }).limit(1),
      ]);
      desde = desde ?? (a.data?.[0]?.event_at as string | undefined)?.slice(0, 10);
      hasta = hasta ?? (b.data?.[0]?.event_at as string | undefined)?.slice(0, 10);
    }
    if (!desde || !hasta) return { filas: 0, desde: null, hasta: null };

    let filas = 0;
    let inicio = new Date(`${desde}T12:00:00Z`);
    const fin = new Date(`${hasta}T12:00:00Z`);
    while (inicio <= fin) {
      const finMes = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, 0, 12));
      const tramoFin = finMes < fin ? finMes : fin;
      const { data: n, error } = await supabaseAdmin.rpc("recalcular_asistencia", {
        _tenant: tenant as string,
        _desde: inicio.toISOString().slice(0, 10),
        _hasta: tramoFin.toISOString().slice(0, 10),
      });
      if (error) throw new Error(error.message);
      filas += (n as number) ?? 0;
      inicio = new Date(tramoFin.getTime() + 864e5);
    }
    return { filas, desde, hasta };
  });

/**
 * Reconstruye el histórico: une todas las marcaciones cargadas (todos los CSV), vuelve a
 * clasificar, marca repetidas en todo el histórico y recalcula todas las jornadas desde cero.
 */
export const reconstruirHistorico = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [a, b] = await Promise.all([
      context.supabase.rpc("has_permission", { _module: "importaciones", _action: "importar" }),
      context.supabase.rpc("has_permission", { _module: "asistencia", _action: "editar" }),
    ]);
    if (!a.data && !b.data) throw new Error("No tienes permiso para reconstruir el histórico.");
    const { data: tenant } = await context.supabase.rpc("current_tenant_id");
    if (!tenant) throw new Error("Tu usuario no está asignado a una empresa.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const inicio = Date.now();
    const { data, error } = await supabaseAdmin.rpc("reconstruir_historico" as never, { _tenant: tenant } as never);
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("audit_logs").insert({
      tenant_id: tenant,
      user_id: context.userId,
      module: "importaciones",
      action: "editar",
      new_value: data,
      reason: "Reconstrucción del histórico de marcaciones",
    });
    return { ...(data as Record<string, unknown>), segundos: Math.round((Date.now() - inicio) / 1000) } as {
      desde: string | null; hasta: string | null; jornadas: number; marcaciones_validas: number; repetidas: number; empleados_nuevos: number; segundos: number;
    };
  });
