import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const depurarDatos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
    z
      .object({
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        modo: z.enum(["eliminar", "ocultar", "mostrar"]),
        alcance: z.array(z.enum(["marcaciones", "asistencia", "novedades"])).min(1),
        motivo: z.string().trim().min(3).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: ok } = await context.supabase.rpc("has_permission", {
      _module: "datos",
      _action: "depurar",
    });
    if (!ok) throw new Error("No tienes permiso para depurar datos.");
    const { data: tenant } = await context.supabase.rpc("current_tenant_id");
    if (!tenant) throw new Error("Tu usuario no está asignado a una empresa.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: filas, error } = await supabaseAdmin.rpc("depurar_datos", {
      _tenant: tenant as string,
      _user: context.userId,
      _desde: data.desde,
      _hasta: data.hasta,
      _modo: data.modo,
      _alcance: data.alcance,
      _motivo: data.motivo,
    });
    if (error) throw new Error(error.message);
    return { filas: (filas as number) ?? 0 };
  });
