import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { dividirLineaCsv, parsearFilas } from "@/lib/biometria";

const LOTE = 10000;
const LOTES_SIMULTANEOS = 2;

export const procesarImportacion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const [{ data: p1 }, { data: p2 }] = await Promise.all([
      context.supabase.rpc("has_permission", { _module: "importaciones", _action: "crear" }),
      context.supabase.rpc("has_permission", { _module: "importaciones", _action: "importar" }),
    ]);
    if (!p1 && !p2) throw new Error("No tienes permiso para importar archivos.");

    // Solo importaciones visibles para el usuario (RLS)
    const { data: imp, error: e0 } = await context.supabase
      .from("biometric_imports")
      .select("id, tenant_id, storage_path, filename")
      .eq("id", data.importId)
      .maybeSingle();
    if (e0 || !imp) throw new Error("Importación no encontrada.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const fallar = async (msg: string) => {
      await supabaseAdmin
        .from("biometric_imports")
        .update({ status: "error", error_message: msg, finished_at: new Date().toISOString() })
        .eq("id", imp.id);
      throw new Error(msg);
    };

    try {
      await supabaseAdmin.from("biometric_imports").update({ status: "procesando" }).eq("id", imp.id);
      const { data: blob, error: eDl } = await supabaseAdmin.storage
        .from("biometrico")
        .download(imp.storage_path ?? "");
      if (eDl || !blob) return await fallar("No se pudo leer el archivo desde el almacenamiento.");

      const texto = (await blob.text()).replace(/^\uFEFF/, "");
      const lineas = texto.split(/\r?\n/);
      const encabezado = dividirLineaCsv(lineas[0] ?? "");
      const requeridas = ["fecha", "id dispositivo", "usuarios", "evento"];
      const faltan = requeridas.filter((r) => !encabezado.some((h) => h.toLowerCase().trim() === r));
      if (faltan.length) return await fallar(`Faltan columnas en el CSV: ${faltan.join(", ")}`);

      const filas = parsearFilas(lineas.slice(1), encabezado);
      if (!filas.length) return await fallar("El archivo no contiene marcaciones legibles.");

      await supabaseAdmin
        .from("biometric_imports")
        .update({ rows_found: filas.length })
        .eq("id", imp.id);

      // 1. Capa cruda: TODAS las filas del CSV, tal cual (incluidas las repetidas), con su línea.
      //    Al reprocesar se reemplaza la capa cruda de este archivo.
      const { error: eDel } = await (supabaseAdmin as unknown as SupabaseClient).from("biometric_raw").delete().eq("import_id", imp.id);
      if (eDel) return await fallar(`Error preparando el archivo: ${eDel.message}`);
      const compactas = filas.map((f) => [
        f.linea,
        f.event_at,
        f.door ?? "",
        f.device_code,
        f.device_name ?? "",
        f.user_group ?? "",
        f.raw_user ?? "",
        f.event_type,
      ]);
      const lotes: (string | number)[][][] = [];
      for (let i = 0; i < compactas.length; i += LOTE) lotes.push(compactas.slice(i, i + LOTE));
      let siguiente = 0;
      let errorLote: string | null = null;
      await Promise.all(
        Array.from({ length: Math.min(LOTES_SIMULTANEOS, lotes.length) }, async () => {
          while (siguiente < lotes.length && !errorLote) {
            const lote = lotes[siguiente++]!;
            const { error } = await supabaseAdmin.rpc("cargar_crudo" as never, {
              _import_id: imp.id,
              _filas: lote,
            } as never);
            if (error) errorLote = error.message;
          }
        }),
      );
      if (errorLote) return await fallar(`Error guardando el archivo: ${errorLote}`);

      // 2. Capa limpia: se suma al histórico solo lo que no existía (un evento = mismo segundo,
      //    lector, evento y usuario). Lo demás queda en la capa cruda como «ya existía».
      const { data: cons, error: eCons } = await supabaseAdmin.rpc("consolidar_importacion" as never, {
        _import_id: imp.id,
      } as never);
      if (eCons) return await fallar(`Error consolidando: ${(eCons as { message: string }).message}`);
      const c = (cons ?? {}) as { crudas?: number; nuevas?: number; ya_existian?: number; repetidas_en_archivo?: number };

      // 3. Clasificación, empleados, repetidas y cálculo de las jornadas afectadas
      const { data: res, error: eProc } = await supabaseAdmin.rpc("procesar_importacion", {
        _import_id: imp.id,
      });
      if (eProc) return await fallar(`Error procesando: ${eProc.message}`);
      const r = (res ?? {}) as { desde?: string; hasta?: string; validas?: number; total?: number };

      if (r.desde && r.hasta) {
        const { error: eCalc } = await supabaseAdmin.rpc("recalcular_asistencia", {
          _tenant: imp.tenant_id,
          _desde: r.desde,
          _hasta: r.hasta,
        });
        if (eCalc) return await fallar(`Error calculando asistencia: ${eCalc.message}`);
      }

      // 4. Marcaciones válidas que contiene el archivo (aunque otro archivo ya las hubiera aportado)
      const { data: est } = await supabaseAdmin.rpc("estadisticas_importacion" as never, { _import: imp.id } as never);
      const validas = ((est ?? {}) as { validas?: number }).validas ?? r.validas ?? 0;

      await supabaseAdmin
        .from("biometric_imports")
        .update({ status: "completado", error_message: null, finished_at: new Date().toISOString() })
        .eq("id", imp.id);

      return {
        filas: filas.length,
        nuevas: c.nuevas ?? 0,
        ya_existian: c.ya_existian ?? 0,
        repetidas_en_archivo: c.repetidas_en_archivo ?? 0,
        validas,
      };
    } catch (e) {
      const msg = (e as Error).message;
      await supabaseAdmin
        .from("biometric_imports")
        .update({ status: "error", error_message: msg, finished_at: new Date().toISOString() })
        .eq("id", imp.id);
      throw e;
    }
  });

export const eliminarImportacion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const [canDel, canImp] = await Promise.all([
      context.supabase.rpc("has_permission", { _module: "importaciones", _action: "eliminar" }),
      context.supabase.rpc("has_permission", { _module: "importaciones", _action: "crear" }),
    ]);
    if (!canDel.data && !canImp.data) throw new Error("No tienes permiso para eliminar importaciones.");

    const { data: imp, error: e0 } = await context.supabase
      .from("biometric_imports")
      .select("id, tenant_id, storage_path")
      .eq("id", data.importId)
      .maybeSingle();
    if (e0 || !imp) throw new Error("Importación no encontrada.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Borra el archivo y lo que aportó; lo que otros archivos también contienen vuelve al histórico
    const { data: res, error } = await supabaseAdmin.rpc("eliminar_importacion" as never, { _import_id: imp.id } as never);
    if (error) throw new Error((error as { message: string }).message);
    const r = (res ?? {}) as { desde?: string | null; hasta?: string | null; recuperadas_de_otros_archivos?: number };
    if (r.desde && r.hasta) {
      await supabaseAdmin.rpc("recalcular_asistencia", { _tenant: imp.tenant_id, _desde: r.desde, _hasta: r.hasta });
    }
    if (imp.storage_path) {
      await supabaseAdmin.storage.from("biometrico").remove([imp.storage_path]);
    }
    return { ok: true, recuperadas: r.recuperadas_de_otros_archivos ?? 0 };
  });


// ---------------------------------------------------------------------------------------------
// Reproceso completo: 1) capa cruda de cada archivo, 2) capa limpia mes a mes, 3) cierre.
// Cada llamada es corta: las peticiones pasan por Cloudflare, que corta a los 100 s.
// ---------------------------------------------------------------------------------------------

async function puedeReprocesar(context: { supabase: SupabaseClient }) {
  const [a, b] = await Promise.all([
    context.supabase.rpc("has_permission", { _module: "importaciones", _action: "importar" }),
    context.supabase.rpc("has_permission", { _module: "importaciones", _action: "crear" }),
  ]);
  if (!a.data && !b.data) throw new Error("No tienes permiso para reprocesar archivos.");
  const { data: tenant } = await context.supabase.rpc("current_tenant_id");
  if (!tenant) throw new Error("Tu usuario no está asignado a una empresa.");
  return tenant as string;
}

/** Vuelve a leer un archivo del almacenamiento y reemplaza su capa cruda (todas las filas). */
export const recargarCrudo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await puedeReprocesar(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as SupabaseClient;
    const { data: imp } = await admin
      .from("biometric_imports")
      .select("id, tenant_id, storage_path, filename")
      .eq("id", data.importId)
      .eq("tenant_id", tenant)
      .maybeSingle();
    if (!imp) throw new Error("Importación no encontrada.");
    const { data: blob, error: eDl } = await admin.storage.from("biometrico").download(imp.storage_path ?? "");
    if (eDl || !blob) throw new Error(`No se pudo leer ${imp.filename} del almacenamiento.`);
    const lineas = (await blob.text()).replace(/^\uFEFF/, "").split(/\r?\n/);
    const filas = parsearFilas(lineas.slice(1), dividirLineaCsv(lineas[0] ?? ""));
    const { error: eDel } = await admin.from("biometric_raw").delete().eq("import_id", imp.id);
    if (eDel) throw new Error(eDel.message);
    const compactas = filas.map((f) => [f.linea, f.event_at, f.door ?? "", f.device_code, f.device_name ?? "", f.user_group ?? "", f.raw_user ?? "", f.event_type]);
    for (let i = 0; i < compactas.length; i += LOTE) {
      const { error } = await admin.rpc("cargar_crudo", { _import_id: imp.id, _filas: compactas.slice(i, i + LOTE) });
      if (error) throw new Error(error.message);
    }
    await admin.from("biometric_imports").update({ rows_found: filas.length, rows_raw: filas.length, status: "procesando", error_message: null }).eq("id", imp.id);
    return { filas: filas.length };
  });

/** Meses que cubre la capa cruda, y cuántos archivos aún no la tienen. */
export const estadoCapaCruda = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenant = await puedeReprocesar(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as SupabaseClient;
    // Tramos de días consecutivos de hasta ~200.000 filas crudas (cada uno cabe en < 100 s)
    const { data: dias, error } = await admin.rpc("filas_crudas_por_dia", { _tenant: tenant });
    if (error) throw new Error(error.message);
    // Los días con más de 200.000 filas (sincronizaciones masivas de BioStar) se parten por horas;
    // las jornadas del día se recalculan al cerrar su último tramo.
    const sig = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    const tramos: { ini: string; fin: string; recalcular: boolean; etiqueta: string }[] = [];
    let cur: { desde: string; hasta: string; n: number } | null = null;
    const cerrar = () => {
      if (cur) tramos.push({ ini: `${cur.desde}T00:00:00`, fin: `${sig(cur.hasta)}T00:00:00`, recalcular: true, etiqueta: `${cur.desde} a ${cur.hasta}` });
      cur = null;
    };
    for (const { dia, filas } of (dias ?? []) as { dia: string; filas: number }[]) {
      if (filas > 200000) {
        cerrar();
        const { data: horas } = await admin.rpc("filas_crudas_por_hora", { _tenant: tenant, _dia: dia });
        let ini = `${dia}T00:00:00`;
        let n = 0;
        const partes: { ini: string; fin: string }[] = [];
        for (const h of (horas ?? []) as { hora: string; filas: number }[]) {
          const hi = h.hora.replace(" ", "T").slice(0, 19);
          if (n && n + h.filas > 100000) {
            partes.push({ ini, fin: hi });
            ini = hi;
            n = 0;
          }
          n += h.filas;
        }
        partes.push({ ini, fin: `${sig(dia)}T00:00:00` });
        partes.forEach((p, i) => tramos.push({ ...p, recalcular: i === partes.length - 1, etiqueta: `${dia} ${p.ini.slice(11, 16)}–${p.fin.slice(11, 16)}` }));
        continue;
      }
      if (cur && cur.n + filas <= 200000 && (Date.parse(dia) - Date.parse(cur.desde)) / 864e5 < 10) {
        cur.hasta = dia;
        cur.n += filas;
      } else {
        cerrar();
        cur = { desde: dia, hasta: dia, n: filas };
      }
    }
    cerrar();
    const { data: imps } = await admin.from("biometric_imports").select("id, rows_raw").eq("tenant_id", tenant);
    return { tramos, sinCrudo: (imps ?? []).filter((i) => !i.rows_raw).map((i) => i.id as string) };
  });

/** Reconstruye la capa limpia y las jornadas de un mes a partir de la capa cruda. */
export const reconstruirMes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
    z
      .object({
        ini: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
        fin: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
        recalcular: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const tenant = await puedeReprocesar(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as SupabaseClient;
    // Seguridad: sin la capa cruda de todos los archivos se perderían eventos del mes
    const { count } = await admin.from("biometric_imports").select("id", { count: "exact", head: true }).eq("tenant_id", tenant).eq("rows_raw", 0);
    if (count) throw new Error(`${count} archivos aún no tienen su capa cruda; recárgalos primero.`);
    const { data: r, error } = await admin.rpc("reconstruir_tramo", { _tenant: tenant, _ini: data.ini, _fin: data.fin, _recalcular: data.recalcular });
    if (error) throw new Error(error.message);
    return r as { filas_crudas: number; eventos_limpios: number; jornadas: number };
  });

/** Cierre: regla de unicidad definitiva, estadísticas por archivo y auditoría. */
export const finalizarReconstruccion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenant = await puedeReprocesar(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as SupabaseClient;
    const { data: r, error } = await admin.rpc("finalizar_reconstruccion", { _tenant: tenant });
    if (error) throw new Error(error.message);
    // Marcaciones válidas que contiene cada archivo, de a tres a la vez (cada una cabe en < 100 s)
    const { data: imps } = await admin.from("biometric_imports").select("id").eq("tenant_id", tenant);
    const cola = [...((imps ?? []) as { id: string }[])];
    await Promise.all(
      [0, 1, 2].map(async () => {
        for (let im = cola.shift(); im; im = cola.shift()) await admin.rpc("estadisticas_importacion", { _import: im.id });
      }),
    );
    await admin.from("audit_logs").insert({
      tenant_id: tenant,
      user_id: (context as unknown as { userId: string }).userId,
      module: "importaciones",
      action: "editar",
      new_value: r,
      reason: "Reproceso completo del histórico desde los archivos originales",
    });
    return r as { filas_crudas: number; eventos_limpios: number };
  });
