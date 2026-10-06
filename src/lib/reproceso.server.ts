/**
 * Reproceso del histórico biométrico en segundo plano (corre en el servidor, no en el navegador).
 *
 * - Conexión directa a Postgres si existe DATABASE_URL (sin Cloudflare ni límite de 100 s, lotes
 *   grandes); si no, por la API de Supabase (REPROCESO_SUPABASE_URL, idealmente la local
 *   http://127.0.0.1:8040; si falta, SUPABASE_URL). Por la API las llamadas se mantienen cortas y,
 *   si un proxy corta la conexión, se espera a que la base termine y el tramo se parte en dos.
 * - Estado por archivo y por tramo en `reprocess_jobs`: se puede cerrar la pestaña, y si el
 *   servidor se reinicia el trabajo se reanuda donde iba.
 * - Reintentos con espera creciente y una segunda pasada para los archivos que fallen. Ningún
 *   tramo se reconstruye hasta que el 100 % de los archivos tenga su capa cruda completa.
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { dividirLineaCsv, parsearFilas } from "@/lib/biometria";
import { esCorte, mensajeLimpio } from "@/lib/errores-red";

type EstadoArchivo = {
  nombre: string;
  estado: "pendiente" | "ok" | "error";
  intentos: number;
  filas?: number;
  error?: string;
};
type Tramo = {
  ini: string;
  fin: string;
  recalcular: boolean;
  etiqueta: string;
  estado: "pendiente" | "ok" | "error";
  intentos: number;
  error?: string;
  segundos?: number;
  /** Eventos ya reconstruidos (un reintento solo repite las jornadas). */
  eventos_ok?: boolean;
  /** Días de jornadas a recalcular (si el tramo se partió, el último pedazo recalcula todos). */
  jornadas_desde?: string;
  jornadas_hasta?: string;
  jornadas_ok_hasta?: string;
};
type Trabajo = {
  id: string;
  tenant_id: string;
  modo: "completo" | "verificar";
  releer_todo: boolean;
  status: string;
  fase: string | null;
  detalle: string | null;
  total: number;
  hechos: number;
  conexion: string | null;
  archivos: Record<string, EstadoArchivo>;
  tramos: Tramo[];
  errores: string[];
  resultado: Record<string, unknown> | null;
  iniciado_por: string | null;
  owner?: string | null;
  reintentos: number;
  proximo_intento_at: string | null;
};
type Import = {
  id: string;
  filename: string;
  started_at: string;
  storage_path: string | null;
  rows_found: number | null;
};

/** Identifica este proceso del servidor: solo el dueño del trabajo lo ejecuta. */
const INSTANCIA = randomUUID();
const corriendo = new Set<string>();
const ESPERAS = [3_000, 10_000, 30_000];
/** Si una ronda completa falla, se vuelve a intentar sola tras 1, 5, 15, 30 y 60 minutos. */
const ESPERAS_AUTOMATICAS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ Conexiones ------------------------------ */

/**
 * Lo que usa el motor de la conexión directa. Los genéricos completos de la librería «postgres»
 * agotan la memoria del compilador de TypeScript, así que se tipa solo esta superficie.
 */
type Filas = Record<string, unknown>[];
type SqlDirecta = {
  (strings: TemplateStringsArray, ...valores: unknown[]): Promise<Filas>;
  unsafe: (consulta: string, parametros?: unknown[]) => Promise<Filas>;
  begin: <R>(fn: (tx: SqlDirecta) => Promise<R>) => Promise<R>;
};

let sqlDirecta: SqlDirecta | null | undefined;
/** Postgres directo (mismo servidor, sin Cloudflare). null si no está configurado o no responde. */
async function directa(): Promise<SqlDirecta | null> {
  if (sqlDirecta !== undefined) return sqlDirecta;
  const url = process.env["DATABASE_URL"];
  if (!url) return (sqlDirecta = null);
  try {
    const sql = postgres(url, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => undefined,
    }) as unknown as SqlDirecta;
    await sql`select 1`;
    return (sqlDirecta = sql);
  } catch (e) {
    console.error("[reproceso] DATABASE_URL no responde; se usa la API:", (e as Error).message);
    return (sqlDirecta = null);
  }
}

let api: SupabaseClient | undefined;
function clienteApi(): SupabaseClient {
  if (api) return api;
  // REPROCESO_SUPABASE_URL: la API local del mismo servidor (p. ej. http://127.0.0.1:8040), sin
  // pasar por Cloudflare. Solo la usa este proceso; el navegador sigue con la dirección pública.
  const url =
    process.env["REPROCESO_SUPABASE_URL"] ||
    process.env["SUPABASE_URL"] ||
    process.env["VITE_SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Falta SUPABASE_URL o la llave de servicio en el servidor.");
  api = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return api;
}

/** Ejecuta una función de la base como service_role (directa) o por la API. */
async function llamar<T>(
  fn: string,
  args: Record<string, unknown>,
  tipos: Record<string, string>,
): Promise<T> {
  const sql = await directa();
  if (sql) {
    const nombres = Object.keys(args);
    const lista = nombres.map((k, i) => `${k} => $${i + 1}::${tipos[k] ?? "text"}`).join(", ");
    const valores = nombres.map((k) => (tipos[k] === "jsonb" ? JSON.stringify(args[k]) : args[k]));
    const filas = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`;
      return tx.unsafe(`select public.${fn}(${lista}) as r`, valores);
    });
    return (filas[0] as unknown as { r: T }).r;
  }
  const { data, error } = await clienteApi().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

async function filasDe<T>(
  consultaDirecta: string,
  params: unknown[],
  porApi: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const sql = await directa();
  if (sql) return (await sql.unsafe(consultaDirecta, params)) as unknown as T[];
  const { data, error } = await porApi();
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

/* ------------------------------ Estado del trabajo ------------------------------ */

async function leerTrabajo(id: string): Promise<Trabajo> {
  const { data, error } = await clienteApi()
    .from("reprocess_jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "Trabajo no encontrado");
  return data as unknown as Trabajo;
}

let ultimoGuardado = 0;
async function guardar(t: Trabajo, forzar = false) {
  const ahora = Date.now();
  if (!forzar && ahora - ultimoGuardado < 1500) return;
  ultimoGuardado = ahora;
  const { error } = await clienteApi()
    .from("reprocess_jobs")
    .update({
      status: t.status,
      fase: t.fase,
      detalle: t.detalle,
      total: t.total,
      hechos: t.hechos,
      conexion: t.conexion,
      archivos: t.archivos,
      tramos: t.tramos,
      errores: t.errores.slice(-200),
      resultado: t.resultado,
      heartbeat_at: new Date().toISOString(),
      owner: INSTANCIA,
      reintentos: t.reintentos,
      proximo_intento_at: t.proximo_intento_at,
      ...(["completado", "error", "cancelado"].includes(t.status)
        ? { finished_at: new Date().toISOString() }
        : {}),
    })
    .eq("id", t.id);
  if (error) console.error("[reproceso] no se pudo guardar el estado:", error.message);
}

/** Toma el trabajo para este proceso si nadie más lo está ejecutando (latido vencido). */
async function tomar(id: string): Promise<boolean> {
  const limite = new Date(Date.now() - 3 * 60_000).toISOString();
  const { data } = await clienteApi()
    .from("reprocess_jobs")
    .update({ owner: INSTANCIA, heartbeat_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "en_curso")
    .or(`owner.is.null,owner.eq.${INSTANCIA},heartbeat_at.lt.${limite}`)
    .select("id");
  return Boolean(data?.length);
}

class Cancelado extends Error {}
/** La conexión se cortó y conviene partir el tramo en pedazos más pequeños. */
class Corte extends Error {}

/* ------------------------------ Pasos ------------------------------ */

/**
 * Tras un corte la consulta sigue corriendo en la base con el candado de la empresa: se espera a
 * que termine en vez de encimar otro intento detrás (eso hacía que cada reintento tardara más).
 */
async function esperarBaseLibre(t: Trabajo) {
  const limite = Date.now() + 30 * 60_000;
  let avisado = false;
  while (Date.now() < limite) {
    if (t.status !== "en_curso") throw new Cancelado();
    let ocupado: boolean;
    try {
      ocupado = await llamar<boolean>(
        "reproceso_ocupado",
        { _tenant: t.tenant_id },
        { _tenant: "uuid" },
      );
    } catch (e) {
      // Sin la función (migración 0052) o sin conexión: una espera prudente y se sigue
      console.warn("[reproceso] no se pudo consultar si la base está ocupada:", mensajeLimpio(e));
      await dormir(60_000);
      return;
    }
    if (!ocupado) return;
    if (!avisado) {
      avisado = true;
      t.detalle = `${t.detalle ?? ""} · esperando a que la base termine lo que quedó en curso`;
      await guardar(t, true);
    }
    await dormir(10_000);
  }
}

type OpcionesReintento = {
  /** Antes de cada intento, esperar a que nada más use el candado de la empresa. */
  esperarLibre?: boolean;
  /** Ante un corte, no reintentar igual: lanzar Corte para partir el tramo. */
  partirAlCortarse?: boolean;
};

async function conReintentos<T>(
  t: Trabajo,
  etiqueta: string,
  fn: () => Promise<T>,
  intentos = ESPERAS.length + 1,
  op: OpcionesReintento = {},
): Promise<T> {
  let ultimo: Error | undefined;
  for (let i = 0; i < intentos; i++) {
    if (t.status !== "en_curso") throw new Cancelado();
    if (op.esperarLibre) await esperarBaseLibre(t);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Cancelado) throw e;
      const msg = mensajeLimpio(e);
      ultimo = new Error(msg);
      console.warn(`[reproceso] ${etiqueta}: intento ${i + 1} falló: ${msg}`);
      if (op.partirAlCortarse && esCorte(msg)) {
        if (op.esperarLibre) await esperarBaseLibre(t);
        throw new Corte(msg);
      }
      if (i < intentos - 1) await dormir(ESPERAS[i] ?? 30_000);
    }
  }
  throw ultimo ?? new Error(`${etiqueta}: falló`);
}

async function descargarYLeer(imp: Import) {
  const { data: blob, error } = await clienteApi()
    .storage.from("biometrico")
    .download(imp.storage_path ?? "");
  if (error || !blob) throw new Error(`No se pudo leer ${imp.filename} del almacenamiento`);
  const lineas = (await blob.text()).replace(/^\uFEFF/, "").split(/\r?\n/);
  return parsearFilas(lineas.slice(1), dividirLineaCsv(lineas[0] ?? ""));
}

async function contarCrudo(importId: string): Promise<number> {
  const r = await filasDe<{ n: string | number }>(
    "select count(*) as n from public.biometric_raw where import_id = $1",
    [importId],
    () =>
      clienteApi()
        .from("biometric_raw")
        .select("id", { count: "exact", head: true })
        .eq("import_id", importId)
        .then((x) => ({ data: [{ n: x.count ?? 0 }], error: x.error })),
  );
  return Number(r[0]?.n ?? 0);
}

/**
 * Lee el archivo original y lo compara con su capa cruda (no se confía en contadores guardados).
 * Si no coincide, o si se pidió releer todo, reemplaza la capa cruda con lo leído; mientras tanto el
 * archivo queda marcado incompleto (rows_raw = 0) para que ningún tramo se reconstruya sin él.
 */
async function verificarORecargar(imp: Import, directaOk: boolean, releerTodo: boolean) {
  const db = clienteApi();
  const filas = await descargarYLeer(imp);
  if (!filas.length) throw new Error("El archivo no contiene marcaciones legibles");
  if (!releerTodo && (await contarCrudo(imp.id)) === filas.length) {
    await db
      .from("biometric_imports")
      .update({
        rows_raw: filas.length,
        rows_found: filas.length,
        status: "completado",
        error_message: null,
      })
      .eq("id", imp.id);
    return { filas: filas.length, releido: false };
  }
  await db
    .from("biometric_imports")
    .update({ rows_raw: 0, status: "procesando", error_message: null })
    .eq("id", imp.id);
  const sql = await directa();
  if (sql) await sql`delete from public.biometric_raw where import_id = ${imp.id}`;
  else {
    const { error } = await db.from("biometric_raw").delete().eq("import_id", imp.id);
    if (error) throw new Error(error.message);
  }
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
  const LOTE = directaOk ? 25_000 : 10_000;
  const lotes: unknown[][][] = [];
  for (let i = 0; i < compactas.length; i += LOTE) lotes.push(compactas.slice(i, i + LOTE));
  let siguiente = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, lotes.length) }, async () => {
      while (siguiente < lotes.length) {
        const lote = lotes[siguiente++]!;
        await llamar<number>(
          "cargar_crudo",
          { _import_id: imp.id, _filas: lote },
          { _import_id: "uuid", _filas: "jsonb" },
        );
      }
    }),
  );
  // Verificación: la capa cruda tiene exactamente las filas del archivo (el índice único evita duplicados)
  const n = await contarCrudo(imp.id);
  if (n !== filas.length) throw new Error(`Quedaron ${n} de ${filas.length} filas`);
  await db
    .from("biometric_imports")
    // La capa cruda del archivo ya está completa: no queda en «procesando» si el reproceso se detiene
    .update({ rows_raw: n, rows_found: n, status: "completado", error_message: null })
    .eq("id", imp.id);
  return { filas: n, releido: true };
}

/** Tramos de días consecutivos según las filas crudas (los días enormes se parten por horas). */
async function calcularTramos(tenant: string, maxFilas: number, maxDias: number) {
  const sig = (d: string) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const dias = await filasDe<{ dia: string; filas: number }>(
    "select dia::text as dia, filas::int as filas from public.filas_crudas_por_dia($1::uuid)",
    [tenant],
    () => clienteApi().rpc("filas_crudas_por_dia", { _tenant: tenant }),
  );
  const tramos: Tramo[] = [];
  let cur: { desde: string; hasta: string; n: number } | null = null;
  const nuevo = (ini: string, fin: string, recalcular: boolean, etiqueta: string): Tramo => ({
    ini,
    fin,
    recalcular,
    etiqueta,
    estado: "pendiente",
    intentos: 0,
  });
  const cerrar = () => {
    if (cur)
      tramos.push(
        nuevo(
          `${cur.desde}T00:00:00`,
          `${sig(cur.hasta)}T00:00:00`,
          true,
          `${cur.desde} a ${cur.hasta}`,
        ),
      );
    cur = null;
  };
  for (const { dia: d, filas } of dias) {
    const dia = String(d).slice(0, 10);
    if (filas > maxFilas) {
      cerrar();
      const horas = await filasDe<{ hora: string; filas: number }>(
        "select hora::text as hora, filas::int as filas from public.filas_crudas_por_hora($1::uuid, $2::date)",
        [tenant, dia],
        () => clienteApi().rpc("filas_crudas_por_hora", { _tenant: tenant, _dia: dia }),
      );
      let ini = `${dia}T00:00:00`;
      let n = 0;
      const partes: { ini: string; fin: string }[] = [];
      for (const h of horas) {
        const hi = String(h.hora).replace(" ", "T").slice(0, 19);
        if (n && n + h.filas > maxFilas / 2) {
          partes.push({ ini, fin: hi });
          ini = hi;
          n = 0;
        }
        n += h.filas;
      }
      partes.push({ ini, fin: `${sig(dia)}T00:00:00` });
      partes.forEach((p, i) =>
        tramos.push(
          nuevo(
            p.ini,
            p.fin,
            i === partes.length - 1,
            `${dia} ${p.ini.slice(11, 16)}–${p.fin.slice(11, 16)}`,
          ),
        ),
      );
      continue;
    }
    if (
      cur &&
      cur.n + filas <= maxFilas &&
      (Date.parse(dia) - Date.parse(cur.desde)) / 864e5 < maxDias
    ) {
      cur.hasta = dia;
      cur.n += filas;
    } else {
      cerrar();
      cur = { desde: dia, hasta: dia, n: filas };
    }
  }
  cerrar();
  return tramos;
}

const msDe = (iso: string) => Date.parse(`${iso}Z`);
const isoDe = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const HORA = 3_600_000;
const DIA = 24 * HORA;

function etiquetaDe(ini: string, fin: string) {
  if (ini.endsWith("T00:00:00") && fin.endsWith("T00:00:00"))
    return `${ini.slice(0, 10)} a ${isoDe(msDe(fin) - 1000).slice(0, 10)}`;
  return `${ini.slice(0, 16).replace("T", " ")}–${fin.slice(0, 16).replace("T", " ")}`;
}

/**
 * Parte un tramo en dos mitades (por días; si es de un día, por horas). La primera solo reconstruye
 * eventos; la segunda recalcula las jornadas de todo el rango original, cuando ya están completos.
 * null si el tramo ya es de menos de dos horas.
 */
export function partirTramo(x: Tramo): [Tramo, Tramo] | null {
  const a = msDe(x.ini);
  const b = msDe(x.fin);
  const unidad = b - a >= 2 * DIA ? DIA : HORA;
  if (b - a < 2 * unidad) return null;
  const mitad = isoDe(a + Math.round((b - a) / 2 / unidad) * unidad);
  const base = { estado: "pendiente" as const, intentos: 0 };
  return [
    { ...base, ini: x.ini, fin: mitad, recalcular: false, etiqueta: etiquetaDe(x.ini, mitad) },
    {
      ...base,
      ini: mitad,
      fin: x.fin,
      recalcular: x.recalcular,
      etiqueta: etiquetaDe(mitad, x.fin),
      jornadas_desde: x.jornadas_desde ?? x.ini.slice(0, 10),
      jornadas_hasta: x.jornadas_hasta ?? isoDe(b - 1000).slice(0, 10),
    },
  ];
}

async function enParalelo<T>(lista: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, lista.length) }, async () => {
      while (i < lista.length) await fn(lista[i++]!);
    }),
  );
}

/* ------------------------------ Ejecución ------------------------------ */

/** Ejecuta (o reanuda) un trabajo. No lanza errores: todo queda en `reprocess_jobs`. */
export async function ejecutarReproceso(id: string) {
  if (corriendo.has(id)) return;
  if (!(await tomar(id))) return; // otro proceso del servidor lo está ejecutando
  corriendo.add(id);
  const t = await leerTrabajo(id);
  // Latido independiente del avance (un tramo largo no deja vencer el trabajo) y lectura de cancelación
  const latido = setInterval(async () => {
    try {
      const { data } = await clienteApi()
        .from("reprocess_jobs")
        .select("status, owner")
        .eq("id", id)
        .maybeSingle();
      if (data && (data.status !== "en_curso" || (data.owner && data.owner !== INSTANCIA)))
        t.status = data.status === "en_curso" ? "interrumpido" : (data.status as string);
      else
        await clienteApi()
          .from("reprocess_jobs")
          .update({ heartbeat_at: new Date().toISOString() })
          .eq("id", id)
          .eq("owner", INSTANCIA);
    } catch {
      /* se reintenta en el siguiente latido */
    }
  }, 15_000);

  const inicio = Date.now();
  t.proximo_intento_at = null;
  try {
    const sql = await directa();
    t.conexion = sql ? "directa" : "api";
    const db = clienteApi();
    const { data: impsData, error } = await db
      .from("biometric_imports")
      .select("id, filename, started_at, storage_path, rows_found")
      .eq("tenant_id", t.tenant_id);
    if (error) throw new Error(error.message);
    const imps = (impsData ?? []) as Import[];

    // 1. Integridad: qué archivos no tienen su capa cruda completa
    t.fase = "Verificando la capa cruda de cada archivo";
    t.detalle = `${imps.length} archivos`;
    await guardar(t, true);
    if (t.modo === "verificar") {
      // Solo lectura: cada archivo del almacenamiento contra su capa cruda
      t.fase = "Comparando cada archivo con su capa cruda";
      t.total = imps.length;
      t.hechos = 0;
      await enParalelo(imps, 8, async (imp) => {
        const prev = t.archivos[imp.id];
        if (prev?.estado === "ok") {
          t.hechos++;
          return;
        }
        try {
          const filas = await conReintentos(t, imp.filename, () => descargarYLeer(imp));
          // Conteo por archivo (índice por import_id): nada de agregados sobre toda la capa cruda
          const n = await conReintentos(t, imp.filename, () => contarCrudo(imp.id));
          t.archivos[imp.id] =
            n === filas.length
              ? { nombre: imp.filename, estado: "ok", intentos: 1, filas: n }
              : {
                  nombre: imp.filename,
                  estado: "error",
                  intentos: 1,
                  filas: n,
                  error: `capa cruda con ${n} de ${filas.length} filas`,
                };
        } catch (e) {
          if (e instanceof Cancelado) throw e;
          t.archivos[imp.id] = {
            nombre: imp.filename,
            estado: "error",
            intentos: ESPERAS.length + 1,
            error: mensajeLimpio(e),
          };
        }
        t.hechos++;
        t.detalle = imp.filename;
        await guardar(t);
      });
      const malos = Object.values(t.archivos).filter((a) => a.estado === "error");
      t.resultado = {
        archivos: imps.length,
        completos: imps.length - malos.length,
        incompletos: malos.length,
        segundos: Math.round((Date.now() - inicio) / 1000),
      };
      t.status = "completado";
      t.fase = malos.length
        ? `${malos.length} archivos necesitan reproceso`
        : "Todos los archivos están completos";
      return;
    }

    // 2. Capa cruda: cada archivo se compara con su original y se repara si le falta algo
    for (const imp of imps) {
      const prev = t.archivos[imp.id];
      if (prev?.estado === "ok") continue;
      t.archivos[imp.id] = {
        nombre: imp.filename,
        estado: "pendiente",
        intentos: prev?.intentos ?? 0,
      };
    }
    let releidos = Object.values(t.archivos).filter(
      (a) => a.estado === "ok" && a.error === "releido",
    ).length;
    const cola = imps.filter((i) => t.archivos[i.id] && t.archivos[i.id]!.estado !== "ok");
    if (cola.length) {
      t.fase = t.releer_todo
        ? "Leyendo los archivos originales (capa cruda)"
        : "Comparando cada archivo con su original y reparando";
      t.total = cola.length;
      t.hechos = 0;
      await guardar(t, true);
      const procesar = async (imp: Import, intentos: number) => {
        const a = t.archivos[imp.id]!;
        try {
          const res = await conReintentos(
            t,
            imp.filename,
            async () => {
              a.intentos++;
              return verificarORecargar(imp, Boolean(sql), t.releer_todo);
            },
            intentos,
          );
          if (res.releido) releidos++;
          // «releido» queda como marca para el resumen (no es un error)
          t.archivos[imp.id] = {
            ...a,
            estado: "ok",
            filas: res.filas,
            ...(res.releido ? { error: "releido" } : {}),
          };
        } catch (e) {
          if (e instanceof Cancelado) throw e;
          t.archivos[imp.id] = { ...a, estado: "error", error: mensajeLimpio(e) };
        }
      };
      await enParalelo(cola, sql ? 6 : 4, async (imp) => {
        await procesar(imp, ESPERAS.length + 1);
        t.hechos++;
        t.detalle = imp.filename;
        await guardar(t);
      });
      // Segunda pasada para los que fallaron (p. ej. un corte de red pasajero)
      const fallidos = cola.filter((i) => t.archivos[i.id]?.estado === "error");
      if (fallidos.length) {
        t.fase = `Reintentando ${fallidos.length} archivos que fallaron`;
        await guardar(t, true);
        await dormir(20_000);
        await enParalelo(fallidos, 2, (imp) => procesar(imp, 3));
      }
      const siguen = cola.filter((i) => t.archivos[i.id]?.estado === "error");
      if (siguen.length) {
        t.errores.push(
          ...siguen.map((i) => `${i.filename}: ${t.archivos[i.id]?.error ?? "error"}`),
        );
        throw new Error(
          `${siguen.length} archivos no se pudieron leer completos. No se reconstruyó nada para no perder marcaciones; usa «Reintentar».`,
        );
      }
    }

    // 3. Capa limpia y jornadas por tramos (en orden cronológico). Por la API cada llamada debe
    //    caber holgada en los 100 s de Cloudflare: tramos pequeños, eventos y jornadas por separado,
    //    y si aun así se corta, se espera a la base y el tramo se parte en dos.
    if (!t.tramos.length)
      t.tramos = await calcularTramos(t.tenant_id, sql ? 500_000 : 100_000, sql ? 31 : 7);
    t.fase = "Ordenando, limpiando y recalculando por tramos";
    const tiposTramo = {
      _tenant: "uuid",
      _ini: "timestamp",
      _fin: "timestamp",
      _recalcular: "boolean",
    };
    const diasPorLlamada = sql ? 31 : 5;
    let k = 0;
    while (k < t.tramos.length) {
      const tramo = t.tramos[k]!;
      if (tramo.estado === "ok") {
        k++;
        continue;
      }
      t.total = t.tramos.length;
      t.hechos = t.tramos.filter((x) => x.estado === "ok").length;
      t.detalle = tramo.etiqueta;
      await guardar(t, true);
      const t0 = Date.now();
      try {
        if (!tramo.eventos_ok) {
          await conReintentos(
            t,
            `tramo ${tramo.etiqueta}`,
            async () => {
              tramo.intentos++;
              await llamar(
                "reconstruir_tramo",
                { _tenant: t.tenant_id, _ini: tramo.ini, _fin: tramo.fin, _recalcular: false },
                tiposTramo,
              );
            },
            ESPERAS.length + 1,
            { esperarLibre: true, partirAlCortarse: !sql && partirTramo(tramo) !== null },
          );
          tramo.eventos_ok = true;
          await guardar(t, true);
        }
        if (tramo.recalcular) {
          const hasta = tramo.jornadas_hasta ?? isoDe(msDe(tramo.fin) - 1000).slice(0, 10);
          let desde = tramo.jornadas_ok_hasta
            ? isoDe(msDe(`${tramo.jornadas_ok_hasta}T00:00:00`) + DIA).slice(0, 10)
            : (tramo.jornadas_desde ?? tramo.ini.slice(0, 10));
          while (desde <= hasta) {
            const fin = isoDe(
              Math.min(
                msDe(`${desde}T00:00:00`) + (diasPorLlamada - 1) * DIA,
                msDe(`${hasta}T00:00:00`),
              ),
            ).slice(0, 10);
            t.detalle = `${tramo.etiqueta} · jornadas ${desde} a ${fin}`;
            await guardar(t);
            await conReintentos(
              t,
              `jornadas ${desde} a ${fin}`,
              () =>
                llamar<number>(
                  "recalcular_jornadas_tramo",
                  { _tenant: t.tenant_id, _desde: desde, _hasta: fin },
                  { _tenant: "uuid", _desde: "date", _hasta: "date" },
                ),
              ESPERAS.length + 1,
              { esperarLibre: true },
            );
            tramo.jornadas_ok_hasta = fin;
            desde = isoDe(msDe(`${fin}T00:00:00`) + DIA).slice(0, 10);
          }
        }
        tramo.estado = "ok";
        tramo.segundos = Math.round((Date.now() - t0) / 1000);
        delete tramo.error;
        k++;
      } catch (e) {
        if (e instanceof Cancelado) throw e;
        const partes = e instanceof Corte ? partirTramo(tramo) : null;
        if (partes) {
          // Se reemplaza por sus dos mitades y se sigue con la primera
          t.tramos.splice(k, 1, ...partes);
          console.warn(`[reproceso] tramo ${tramo.etiqueta} se partió en dos tras un corte`);
          continue;
        }
        tramo.estado = "error";
        tramo.error = mensajeLimpio(e);
        t.errores.push(`Tramo ${tramo.etiqueta}: ${tramo.error}`);
        throw new Error(
          `El tramo ${tramo.etiqueta} falló tras varios intentos; se retoma desde ahí.`,
        );
      }
    }
    t.hechos = t.tramos.length;
    t.total = t.tramos.length;

    // 4. Cierre archivo por archivo (estadísticas y estado final), sin agregados globales
    t.fase = "Cerrando: estadísticas por archivo";
    t.total = imps.length;
    t.hechos = 0;
    await guardar(t, true);
    const cierre = { filas_crudas: 0, eventos_limpios: 0 };
    const sinCrudo: string[] = [];
    await enParalelo(imps, sql ? 6 : 3, async (imp) => {
      const r = await conReintentos(t, `cierre ${imp.filename}`, () =>
        llamar<{ filas_crudas: number; eventos_limpios: number }>(
          "cerrar_importacion",
          { _import: imp.id },
          { _import: "uuid" },
        ),
      );
      cierre.filas_crudas += Number(r.filas_crudas) || 0;
      cierre.eventos_limpios += Number(r.eventos_limpios) || 0;
      if (!Number(r.filas_crudas)) sinCrudo.push(imp.filename);
      t.hechos++;
      await guardar(t);
    });

    // 5. Resultado
    t.resultado = {
      ...cierre,
      archivos: imps.length,
      releidos,
      tramos: t.tramos.length,
      sin_capa_cruda: sinCrudo,
      conexion: t.conexion,
      minutos: Math.round((Date.now() - inicio) / 6000) / 10,
    };
    await db.from("audit_logs").insert({
      tenant_id: t.tenant_id,
      user_id: t.iniciado_por,
      module: "importaciones",
      action: "editar",
      new_value: t.resultado,
      reason: "Reproceso completo del histórico (segundo plano)",
    });
    if (sinCrudo.length)
      throw new Error(
        `${sinCrudo.length} archivos quedaron sin capa cruda: ${sinCrudo.slice(0, 5).join(", ")}`,
      );
    t.status = "completado";
    t.fase = "Terminado";
    t.detalle = null;
  } catch (e) {
    if (e instanceof Cancelado || t.status !== "en_curso") {
      if (t.status === "en_curso") t.status = "cancelado";
      t.fase = t.status === "interrumpido" ? "Lo tomó otro proceso del servidor" : "Cancelado";
    } else {
      const msg = mensajeLimpio(e);
      t.errores.push(msg);
      console.error("[reproceso]", msg);
      const espera = ESPERAS_AUTOMATICAS[t.reintentos];
      if (espera !== undefined) {
        // Sigue «en curso»: lo que falló vuelve a pendiente y se reintenta más tarde, con calma
        t.reintentos++;
        t.proximo_intento_at = new Date(Date.now() + espera).toISOString();
        for (const a of Object.values(t.archivos)) if (a.estado === "error") a.estado = "pendiente";
        for (const x of t.tramos) if (x.estado === "error") x.estado = "pendiente";
        const hora = new Date(Date.now() + espera).toLocaleTimeString("es-CO", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Bogota",
        });
        t.fase = `Reintento automático ${t.reintentos} de ${ESPERAS_AUTOMATICAS.length} a las ${hora}`;
        t.detalle = msg.slice(0, 200);
        setTimeout(() => void ejecutarReproceso(id), espera);
      } else {
        t.status = "error";
        t.fase = "Se detuvo tras varios reintentos automáticos";
      }
    }
  } finally {
    clearInterval(latido);
    corriendo.delete(id);
    if (t.status !== "interrumpido") await guardar(t, true);
  }
}

/** Reanuda los trabajos «en curso» cuyo latido venció (p. ej. tras reiniciar el servidor). */
export async function reanudarSiQuedoColgado(
  id: string,
  heartbeat: string,
  proximo?: string | null,
) {
  if (corriendo.has(id)) return false;
  if (proximo && Date.parse(proximo) > Date.now()) return false; // espera su reintento programado
  if (Date.now() - Date.parse(heartbeat) < 3 * 60_000 && !proximo) return false;
  void ejecutarReproceso(id);
  return true;
}

export const esteProcesoLoEjecuta = (id: string) => corriendo.has(id);

let vigilando = false;
type Pendiente = { id: string; heartbeat_at: string; proximo_intento_at: string | null };

/** Trabajos en curso (tipado explícito: la inferencia del texto del select agota al compilador). */
async function trabajosEnCurso(): Promise<Pendiente[]> {
  const consulta: PromiseLike<{ data: unknown }> = clienteApi()
    .from("reprocess_jobs")
    .select("*")
    .eq("status", "en_curso");
  const { data } = await consulta;
  return (data ?? []) as Pendiente[];
}

/**
 * Vigilante del servidor de producción: al arrancar y cada minuto retoma los reprocesos en curso
 * que quedaron colgados (reinicio del servidor) o cuyo reintento automático ya toca.
 */
export function vigilarReprocesos() {
  if (vigilando) return;
  vigilando = true;
  const revisar = async () => {
    try {
      for (const j of await trabajosEnCurso())
        await reanudarSiQuedoColgado(j.id, j.heartbeat_at, j.proximo_intento_at);
    } catch (e) {
      console.warn("[reproceso] vigilante:", (e as Error).message);
    }
  };
  setTimeout(() => void revisar(), 20_000);
  setInterval(() => void revisar(), 60_000);
}
