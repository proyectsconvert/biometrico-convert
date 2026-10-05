import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type TrabajoReproceso = {
  id: string;
  modo: "completo" | "verificar";
  releer_todo: boolean;
  status: "en_curso" | "completado" | "error" | "cancelado" | "interrumpido";
  fase: string | null;
  detalle: string | null;
  total: number;
  hechos: number;
  conexion: string | null;
  archivos: Record<
    string,
    { nombre: string; estado: string; intentos: number; filas?: number; error?: string }
  >;
  tramos: {
    etiqueta: string;
    estado: string;
    intentos: number;
    error?: string;
    segundos?: number;
  }[];
  errores: string[];
  resultado: Record<string, string | number | boolean | string[] | null> | null;
  created_at: string;
  reintentos: number;
  proximo_intento_at: string | null;
  heartbeat_at: string;
  finished_at: string | null;
};

async function permiso(context: { supabase: SupabaseClient }) {
  const [a, b] = await Promise.all([
    context.supabase.rpc("has_permission", { _module: "importaciones", _action: "importar" }),
    context.supabase.rpc("has_permission", { _module: "importaciones", _action: "crear" }),
  ]);
  if (!a.data && !b.data) throw new Error("No tienes permiso para reprocesar el histórico.");
  const { data: tenant } = await context.supabase.rpc("current_tenant_id");
  if (!tenant) throw new Error("Tu usuario no está asignado a una empresa.");
  return tenant as string;
}

/** Inicia el reproceso en el servidor y responde de inmediato; el avance queda en reprocess_jobs. */
export const iniciarReproceso = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
    z.object({ modo: z.enum(["completo", "verificar"]), releerTodo: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const tenant = await permiso(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as SupabaseClient;
    const { data: activo } = await admin
      .from("reprocess_jobs")
      .select("id")
      .eq("tenant_id", tenant)
      .eq("status", "en_curso")
      .maybeSingle();
    if (activo) throw new Error("Ya hay un reproceso en curso; espera a que termine o cancélalo.");
    const { data: job, error } = await admin
      .from("reprocess_jobs")
      .insert({
        tenant_id: tenant,
        modo: data.modo,
        releer_todo: data.releerTodo,
        status: "en_curso",
        fase: "En cola",
        iniciado_por: (context as unknown as { userId: string }).userId,
      })
      .select("id")
      .single();
    if (error || !job) throw new Error(error?.message ?? "No se pudo crear el trabajo");
    const { ejecutarReproceso } = await import("@/lib/reproceso.server");
    void ejecutarReproceso(job.id as string); // sigue en el servidor aunque se cierre la pestaña
    return { id: job.id as string };
  });

/** Último trabajo de la empresa; si quedó colgado (servidor reiniciado) se reanuda solo. */
export const estadoReproceso = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenant = await permiso(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as SupabaseClient;
    const { data } = await admin
      .from("reprocess_jobs")
      .select("*")
      .eq("tenant_id", tenant)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const trabajo = (data ?? null) as TrabajoReproceso | null;
    let reanudado = false;
    if (trabajo?.status === "en_curso") {
      const { reanudarSiQuedoColgado } = await import("@/lib/reproceso.server");
      // Solo en producción: un servidor de desarrollo no debe tomar trabajos de la base compartida
      if (process.env["NODE_ENV"] === "production" || process.env["REPROCESO_VIGILANTE"] === "1")
        reanudado = await reanudarSiQuedoColgado(
          trabajo.id,
          trabajo.heartbeat_at,
          trabajo.proximo_intento_at,
        );
    }
    return { trabajo, reanudado };
  });

/** Cancela el trabajo en curso (se detiene al terminar el archivo o tramo que esté haciendo). */
export const cancelarReproceso = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await permiso(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as unknown as SupabaseClient)
      .from("reprocess_jobs")
      .update({ status: "cancelado", fase: "Cancelado", finished_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("tenant_id", tenant)
      .eq("status", "en_curso");
    return { ok: true };
  });

/** Reintenta un trabajo detenido desde donde iba (no repite archivos ni tramos ya hechos). */
export const reintentarReproceso = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await permiso(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as SupabaseClient;
    const { data: job } = await admin
      .from("reprocess_jobs")
      .select("id, status, archivos, tramos")
      .eq("id", data.id)
      .eq("tenant_id", tenant)
      .maybeSingle();
    if (!job) throw new Error("Trabajo no encontrado");
    if (job.status === "en_curso") throw new Error("El trabajo sigue en curso");
    // Lo que falló vuelve a pendiente; lo terminado se conserva
    const archivos = Object.fromEntries(
      Object.entries((job.archivos ?? {}) as Record<string, { estado: string }>).map(([k, v]) => [
        k,
        v.estado === "ok" ? v : { ...v, estado: "pendiente" },
      ]),
    );
    const tramos = ((job.tramos ?? []) as { estado: string }[]).map((x) =>
      x.estado === "ok" ? x : { ...x, estado: "pendiente" },
    );
    const { error } = await admin
      .from("reprocess_jobs")
      .update({
        status: "en_curso",
        fase: "Reanudando",
        archivos,
        tramos,
        errores: [],
        finished_at: null,
        owner: null,
        reintentos: 0,
        proximo_intento_at: null,
        heartbeat_at: new Date(0).toISOString(),
      })
      .eq("id", data.id);
    if (error)
      throw new Error(
        error.message.includes("reprocess_jobs_uno_activo")
          ? "Ya hay otro reproceso en curso"
          : error.message,
      );
    const { ejecutarReproceso } = await import("@/lib/reproceso.server");
    void ejecutarReproceso(data.id);
    return { ok: true };
  });
