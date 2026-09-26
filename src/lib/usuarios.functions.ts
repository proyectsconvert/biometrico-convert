import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const UsuarioSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(72),
  full_name: z.string().trim().min(1).max(150),
  rol: z.string().trim().min(1).max(50),
  campanas: z.string().trim().max(500).optional(),
  documento: z.string().trim().max(20).optional(),
});

export type NuevoUsuario = z.infer<typeof UsuarioSchema>;

/**
 * Qué datos pide cada rol:
 * - basico (administrador, nómina y roles propios): correo, nombre, contraseña y rol.
 * - campanas (supervisor, coordinador, back office): además, una o más campañas separadas por comas.
 * - asesor: además, una campaña (opcional) y la cédula del empleado, que debe existir y no estar
 *   vinculado a otro usuario.
 */
export type GrupoRol = "basico" | "campanas" | "asesor";
export function grupoDeRol(code: string): GrupoRol {
  const c = code.trim().toLowerCase();
  if (c === "asesor") return "asesor";
  if (["supervisor", "coordinador", "bo"].includes(c)) return "campanas";
  return "basico";
}

type Rol = { id: string; code: string; name: string };
type Campana = { id: string; code: string | null; name: string };
type Catalogos = { roles: Rol[]; campanas: Campana[] };
type Acceso = { rol: Rol; grupo: GrupoRol; campaignIds: string[]; alcance: string };

const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const limpiarCedula = (v: string | undefined | null) => (v ?? "").replace(/[.\s]/g, "");
const listaCampanas = (v: string | undefined | null) => (v ?? "").split(/[|,;]/).map((x) => x.trim()).filter(Boolean);

async function contextoAdmin(context: { supabase: SupabaseClient; userId: string }) {
  const { data: currentTenant } = await context.supabase.rpc("current_tenant_id");
  const tenantId = (currentTenant as string | null) ?? "11111111-1111-1111-1111-111111111111";
  const { data: esSuper } = await context.supabase.rpc("is_super_admin", { _user_id: context.userId });
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as unknown as SupabaseClient;
  const [{ data: roles }, { data: campanas }] = await Promise.all([
    admin.from("roles").select("id, code, name"),
    admin.from("campaigns").select("id, code, name").eq("tenant_id", tenantId),
  ]);
  return { tenantId, esSuper: Boolean(esSuper), admin, cat: { roles: (roles ?? []) as Rol[], campanas: (campanas ?? []) as Campana[] } };
}

/** Rol + campañas según las reglas de cada rol. Devuelve el acceso o el motivo del rechazo. */
function resolverAcceso(cat: Catalogos, esSuper: boolean, rolTexto: string, campanasTexto: string | undefined): Acceso | string {
  const rol = cat.roles.find((r) => norm(r.code) === norm(rolTexto) || norm(r.name) === norm(rolTexto));
  if (!rol) return `El rol «${rolTexto}» no existe.`;
  if (rol.code === "super_admin" && !esSuper) return "Solo un super administrador puede asignar el rol super administrador.";
  const grupo = grupoDeRol(rol.code);
  const pedidas = grupo === "basico" ? [] : listaCampanas(campanasTexto);
  const noEncontradas: string[] = [];
  const campaignIds = pedidas
    .map((p) => {
      const c = cat.campanas.find((x) => norm(x.name) === norm(p) || norm(x.code) === norm(p));
      if (!c) noEncontradas.push(p);
      return c?.id;
    })
    .filter((x): x is string => Boolean(x));
  if (noEncontradas.length) return `Campaña no encontrada: ${noEncontradas.join(", ")}.`;
  if (grupo === "campanas" && !campaignIds.length) return "Indica al menos una campaña (varias separadas por comas).";
  if (grupo === "asesor" && campaignIds.length > 1) return "Un asesor solo puede tener una campaña.";
  // Asesor sin campaña solo ve lo suyo; con campaña, a los de su campaña
  const alcance = ["admin", "nomina", "super_admin"].includes(rol.code)
    ? "plataforma"
    : grupo === "basico" ? "mi_empresa" : campaignIds.length ? "campanas_asignadas" : "solo_yo";
  return { rol, grupo, campaignIds: [...new Set(campaignIds)], alcance };
}

/** Empleado al que se vincula un asesor: debe existir y no estar vinculado a otro usuario. */
async function buscarEmpleadoLibre(admin: SupabaseClient, tenantId: string, cedula: string, usuarioPropio?: string) {
  if (!cedula) return "Falta la cédula del asesor.";
  const { data: e } = await admin.from("employees").select("id, user_id").eq("tenant_id", tenantId).eq("document", cedula).maybeSingle();
  if (!e) return `No existe un empleado con la cédula ${cedula}. Créalo primero en Empleados.`;
  if (e.user_id && e.user_id !== usuarioPropio) return `El empleado con cédula ${cedula} ya está vinculado a otro usuario.`;
  return { id: e.id as string };
}

export const crearUsuarios = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ usuarios: z.array(UsuarioSchema).min(1).max(1000) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: puede } = await context.supabase.rpc("has_permission", { _module: "usuarios", _action: "crear" });
    if (!puede) throw new Error("No tienes permiso para crear usuarios.");
    const { tenantId, esSuper, admin, cat } = await contextoAdmin(context as never);
    const resultados: { email: string; ok: boolean; error?: string }[] = [];
    const cedulasEnLote = new Set<string>();

    for (const u of data.usuarios) {
      const fallo = (error: string) => resultados.push({ email: u.email, ok: false, error });
      try {
        // 1. Validar todo antes de crear nada
        const acceso = resolverAcceso(cat, esSuper, u.rol, u.campanas);
        if (typeof acceso === "string") { fallo(acceso); continue; }
        let empleado: { id: string } | null = null;
        if (acceso.grupo === "asesor") {
          const cedula = limpiarCedula(u.documento);
          if (cedula && cedulasEnLote.has(cedula)) { fallo(`La cédula ${cedula} está repetida en la carga.`); continue; }
          const e = await buscarEmpleadoLibre(admin, tenantId, cedula);
          if (typeof e === "string") { fallo(e); continue; }
          cedulasEnLote.add(cedula);
          empleado = e;
        }

        // 2. Crear el usuario, su vínculo con el empleado y su rol
        const { data: creado, error } = await admin.auth.admin.createUser({
          email: u.email.toLowerCase(),
          password: u.password,
          email_confirm: true,
          user_metadata: { full_name: u.full_name },
        });
        if (error || !creado.user) { fallo(error?.message ?? "Error al crear en auth"); continue; }
        const id = creado.user.id;
        await admin.from("profiles").update({ tenant_id: tenantId, full_name: u.full_name }).eq("id", id);
        if (empleado) {
          // Solo se vincula si nadie lo tomó entretanto
          const { data: vinc } = await admin.from("employees").update({ user_id: id }).eq("id", empleado.id).is("user_id", null).select("id");
          if (!vinc?.length) {
            await admin.auth.admin.deleteUser(id);
            fallo("El empleado se vinculó a otro usuario mientras se creaba; no se creó.");
            continue;
          }
        }
        const { error: eRol } = await admin.from("user_roles").insert({
          user_id: id, role_id: acceso.rol.id, tenant_id: tenantId, scope: acceso.alcance, campaign_ids: acceso.campaignIds,
        });
        if (eRol) { resultados.push({ email: u.email, ok: true, error: `Creado, pero no se asignó el rol: ${eRol.message}` }); continue; }
        resultados.push({ email: u.email, ok: true });
      } catch (err: unknown) {
        fallo((err as Error).message);
      }
    }
    return { resultados };
  });

// ───────────── Edición masiva (solo super administrador) ─────────────

export type FilaUsuarioExport = {
  id: string; correo: string; nombre: string; rol: string; campanas: string; cedula: string; activo: string; contrasena_nueva: string;
};

async function estadoActual(admin: SupabaseClient, tenantId: string, cat: Catalogos) {
  const [{ data: perfiles }, { data: urs }, { data: emps }] = await Promise.all([
    admin.from("profiles").select("id, email, full_name, is_active").eq("tenant_id", tenantId).order("full_name"),
    admin.from("user_roles").select("id, user_id, role_id, campaign_ids").eq("tenant_id", tenantId),
    admin.from("employees").select("id, document, user_id").eq("tenant_id", tenantId).not("user_id", "is", null),
  ]);
  const rolPorId = new Map(cat.roles.map((r) => [r.id, r]));
  const campPorId = new Map(cat.campanas.map((c) => [c.id, c.name]));
  const urPorUsuario = new Map(((urs ?? []) as { id: string; user_id: string; role_id: string; campaign_ids: string[] | null }[]).map((u) => [u.user_id, u]));
  const empPorUsuario = new Map(((emps ?? []) as { id: string; document: string; user_id: string }[]).map((e) => [e.user_id, e]));
  return ((perfiles ?? []) as { id: string; email: string | null; full_name: string | null; is_active: boolean | null }[]).map((p) => {
    const ur = urPorUsuario.get(p.id);
    return {
      id: p.id,
      correo: (p.email ?? "").toLowerCase(),
      nombre: p.full_name ?? "",
      rol: ur ? rolPorId.get(ur.role_id)?.code ?? "" : "",
      campanas: (ur?.campaign_ids ?? []).map((c) => campPorId.get(c)).filter(Boolean).join(", "),
      cedula: empPorUsuario.get(p.id)?.document ?? "",
      activo: p.is_active === false ? "no" : "si",
      contrasena_nueva: "",
      _userRoleId: ur?.id ?? null,
    };
  });
}

async function soloSuperAdmin(context: { supabase: SupabaseClient; userId: string }) {
  const { data } = await context.supabase.rpc("is_super_admin", { _user_id: context.userId });
  if (!data) throw new Error("Solo un super administrador puede descargar y editar usuarios en bloque.");
}

/** Todos los usuarios de la empresa, para editarlos en Excel. */
export const exportarUsuarios = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await soloSuperAdmin(context as never);
    const { tenantId, admin, cat } = await contextoAdmin(context as never);
    const filas = await estadoActual(admin, tenantId, cat);
    return {
      filas: filas.map(({ _userRoleId, ...f }) => f) as FilaUsuarioExport[],
      roles: cat.roles.map((r) => r.code),
      campanas: cat.campanas.map((c) => c.name),
    };
  });

const FilaEdicionSchema = z.object({
  id: z.string().uuid(),
  correo: z.string().trim().max(255).optional(),
  nombre: z.string().trim().max(150).optional(),
  rol: z.string().trim().max(50).optional(),
  campanas: z.string().trim().max(1000).optional(),
  cedula: z.string().trim().max(20).optional(),
  activo: z.string().trim().max(10).optional(),
  contrasena_nueva: z.string().max(72).optional(),
  fila: z.number().int().optional(),
});
export type FilaEdicion = z.infer<typeof FilaEdicionSchema>;
export type CambioUsuario = { campo: string; antes: string; despues: string };
export type ResultadoEdicion = { id: string; fila?: number | undefined; correo: string; nombre: string; cambios: CambioUsuario[]; error?: string };

/**
 * Aplica solo lo que cambió: cada fila se compara con el usuario actual y se actualizan únicamente
 * los campos distintos. Los usuarios que no vienen en el archivo no se tocan. La contraseña solo se
 * cambia si la columna contrasena_nueva trae un valor. Con `aplicar: false` solo muestra los cambios.
 */
export const editarUsuariosMasivo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ filas: z.array(FilaEdicionSchema).min(1).max(5000), aplicar: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await soloSuperAdmin(context as never);
    const { tenantId, esSuper, admin, cat } = await contextoAdmin(context as never);
    const actuales = new Map((await estadoActual(admin, tenantId, cat)).map((u) => [u.id, u]));
    const resultados: ResultadoEdicion[] = [];
    const vistos = new Set<string>();
    const espacios = (v: string) => v.replace(/\s+/g, " ").trim();
    const mismasCampanas = (a: string, b: string) =>
      [...new Set(listaCampanas(a).map(norm))].sort().join("|") === [...new Set(listaCampanas(b).map(norm))].sort().join("|");

    for (const f of data.filas) {
      const act = actuales.get(f.id);
      const r: ResultadoEdicion = { id: f.id, fila: f.fila, correo: act?.correo ?? f.correo ?? "", nombre: act?.nombre ?? f.nombre ?? "", cambios: [] };
      resultados.push(r);
      if (!act) { r.error = "Usuario no encontrado (no cambies la columna id)."; continue; }
      if (vistos.has(f.id)) { r.error = "Usuario repetido en el archivo."; continue; }
      vistos.add(f.id);

      // Qué cambió (una celda ausente en el archivo no cambia nada)
      const nuevo = {
        correo: f.correo !== undefined ? f.correo.toLowerCase() : act.correo,
        nombre: f.nombre !== undefined ? f.nombre.trim() : act.nombre,
        rol: f.rol !== undefined ? f.rol : act.rol,
        campanas: f.campanas !== undefined ? f.campanas : act.campanas,
        cedula: f.cedula !== undefined ? limpiarCedula(f.cedula) : act.cedula,
        activo: f.activo !== undefined ? (["no", "n", "false", "0", "inactivo"].includes(norm(f.activo)) ? "no" : "si") : act.activo,
      };
      const cambio = {
        correo: nuevo.correo !== act.correo,
        // espacios de más no son un cambio
        nombre: espacios(nuevo.nombre) !== espacios(act.nombre),
        rol: norm(nuevo.rol) !== norm(act.rol),
        campanas: !mismasCampanas(nuevo.campanas, act.campanas),
        cedula: nuevo.cedula !== act.cedula,
        activo: nuevo.activo !== act.activo,
        contrasena: Boolean(f.contrasena_nueva),
      };

      // Validaciones de lo que cambia
      if (cambio.correo && !z.string().email().safeParse(nuevo.correo).success) { r.error = `Correo no válido: ${nuevo.correo}`; continue; }
      if (cambio.nombre && !nuevo.nombre) { r.error = "El nombre no puede quedar vacío."; continue; }
      if (cambio.contrasena && f.contrasena_nueva!.length < 8) { r.error = "La contraseña nueva debe tener al menos 8 caracteres."; continue; }
      if (cambio.activo && nuevo.activo === "no" && f.id === context.userId) { r.error = "No puedes desactivar tu propio usuario."; continue; }
      let acceso: Acceso | null = null;
      if (cambio.rol || cambio.campanas || cambio.cedula) {
        const a = resolverAcceso(cat, esSuper, nuevo.rol, nuevo.campanas);
        if (typeof a === "string") { r.error = a; continue; }
        acceso = a;
      }
      let empleado: { id: string } | null = null;
      if (cambio.cedula || (acceso?.grupo === "asesor" && cambio.rol)) {
        if (acceso?.grupo === "asesor" || nuevo.cedula) {
          const e = await buscarEmpleadoLibre(admin, tenantId, nuevo.cedula, f.id);
          if (typeof e === "string") { r.error = e; continue; }
          empleado = e;
        }
      }

      const anotar = (campo: string, antes: string, despues: string) => r.cambios.push({ campo, antes, despues });
      if (cambio.correo) anotar("Correo", act.correo, nuevo.correo);
      if (cambio.nombre) anotar("Nombre", act.nombre, nuevo.nombre);
      if (cambio.rol) anotar("Rol", act.rol, nuevo.rol);
      if (cambio.campanas) anotar("Campañas", act.campanas || "—", nuevo.campanas || "—");
      if (cambio.cedula) anotar("Cédula vinculada", act.cedula || "—", nuevo.cedula || "—");
      if (cambio.activo) anotar("Activo", act.activo, nuevo.activo);
      if (cambio.contrasena) anotar("Contraseña", "••••", "nueva");
      if (!data.aplicar || !r.cambios.length) continue;

      try {
        // Solo los campos que cambiaron
        if (cambio.correo || cambio.nombre || cambio.activo || cambio.contrasena) {
          const { error } = await admin.auth.admin.updateUserById(f.id, {
            ...(cambio.correo ? { email: nuevo.correo, email_confirm: true } : {}),
            ...(cambio.nombre ? { user_metadata: { full_name: nuevo.nombre } } : {}),
            ...(cambio.activo ? { ban_duration: nuevo.activo === "si" ? "none" : "876000h" } : {}),
            ...(cambio.contrasena && f.contrasena_nueva ? { password: f.contrasena_nueva } : {}),
          });
          if (error) throw new Error(error.message);
        }
        if (cambio.correo || cambio.nombre || cambio.activo) {
          const { error } = await admin.from("profiles").update({
            ...(cambio.correo ? { email: nuevo.correo } : {}),
            ...(cambio.nombre ? { full_name: nuevo.nombre } : {}),
            ...(cambio.activo ? { is_active: nuevo.activo === "si" } : {}),
          }).eq("id", f.id);
          if (error) throw new Error(error.message);
        }
        if (acceso && (cambio.rol || cambio.campanas)) {
          const valores = { role_id: acceso.rol.id, scope: acceso.alcance, campaign_ids: acceso.campaignIds };
          const { error } = act._userRoleId
            ? await admin.from("user_roles").update(valores).eq("id", act._userRoleId)
            : await admin.from("user_roles").insert({ ...valores, user_id: f.id, tenant_id: tenantId });
          if (error) throw new Error(error.message);
        }
        if (cambio.cedula) {
          await admin.from("employees").update({ user_id: null }).eq("user_id", f.id);
          if (empleado) {
            const { data: vinc } = await admin.from("employees").update({ user_id: f.id }).eq("id", empleado.id).is("user_id", null).select("id");
            if (!vinc?.length) throw new Error("El empleado se vinculó a otro usuario mientras se editaba.");
          }
        }
        await admin.from("audit_logs").insert({
          tenant_id: tenantId,
          user_id: context.userId,
          module: "usuarios",
          action: "editar",
          record_id: f.id,
          new_value: { cambios: r.cambios.map((c) => (c.campo === "Contraseña" ? { campo: c.campo } : c)) },
          reason: "Edición masiva de usuarios",
        });
      } catch (e) {
        r.error = `No se pudo aplicar: ${(e as Error).message}`;
      }
    }
    return {
      resultados: resultados.filter((r) => r.cambios.length || r.error),
      sinCambios: resultados.filter((r) => !r.cambios.length && !r.error).length,
    };
  });

// Verifica permiso de edición y que el usuario objetivo sea visible (misma empresa por RLS).
// Solo un super administrador puede modificar a otro super administrador.
async function validarEdicion(
  context: { supabase: import("@supabase/supabase-js").SupabaseClient; userId: string },
  id: string,
) {
  const { data: puede } = await context.supabase.rpc("has_permission", { _module: "usuarios", _action: "editar" });
  if (!puede && id !== context.userId) throw new Error("No tienes permiso para editar usuarios.");
  const { data: perfil } = await context.supabase.from("profiles").select("id").eq("id", id).maybeSingle();
  if (!perfil) throw new Error("Usuario no encontrado.");
  const [{ data: objetivoSuper }, { data: yoSuper }] = await Promise.all([
    context.supabase.rpc("is_super_admin", { _user_id: id }),
    context.supabase.rpc("is_super_admin", { _user_id: context.userId }),
  ]);
  if (objetivoSuper && !yoSuper) throw new Error("Solo un super administrador puede modificar a otro super administrador.");
}

export const actualizarUsuario = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        full_name: z.string().trim().min(1).max(150),
        email: z.string().trim().email().max(255),
        is_active: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await validarEdicion(context, data.id);
    if (data.id === context.userId && !data.is_active) throw new Error("No puedes desactivar tu propio usuario.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.id, {
      email: data.email.toLowerCase(),
      email_confirm: true,
      user_metadata: { full_name: data.full_name },
      // Un usuario inactivo no puede iniciar sesión
      ban_duration: data.is_active ? "none" : "876000h",
    });
    if (error) throw new Error(error.message);
    const { error: e2 } = await supabaseAdmin
      .from("profiles")
      .update({ full_name: data.full_name, email: data.email.toLowerCase(), is_active: data.is_active })
      .eq("id", data.id);
    if (e2) throw new Error(e2.message);
    await supabaseAdmin.from("audit_logs").insert({
      tenant_id: (await context.supabase.rpc("current_tenant_id")).data,
      user_id: context.userId,
      module: "usuarios",
      action: "editar",
      record_id: data.id,
      new_value: { full_name: data.full_name, email: data.email, is_active: data.is_active },
    });
    return { ok: true };
  });

export const cambiarContrasena = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ id: z.string().uuid(), password: z.string().min(8).max(72) }).parse(d))
  .handler(async ({ data, context }) => {
    await validarEdicion(context, data.id);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.id, { password: data.password });
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("audit_logs").insert({
      tenant_id: (await context.supabase.rpc("current_tenant_id")).data,
      user_id: context.userId,
      module: "usuarios",
      action: "cambiar_contrasena",
      record_id: data.id,
      reason: data.id === context.userId ? "Cambio de contraseña propia" : "Contraseña asignada por un administrador",
    });
    return { ok: true };
  });

/** Último ingreso y bloqueo de cada usuario (solo quien puede ver usuarios). */
export const accesosUsuarios = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: puede } = await context.supabase.rpc("has_permission", { _module: "usuarios", _action: "ver" });
    if (!puede) return {} as Record<string, { ultimo_ingreso: string | null; bloqueado: boolean }>;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const out: Record<string, { ultimo_ingreso: string | null; bloqueado: boolean }> = {};
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      for (const u of data.users) {
        const ban = (u as { banned_until?: string | null }).banned_until;
        out[u.id] = { ultimo_ingreso: u.last_sign_in_at ?? null, bloqueado: Boolean(ban && new Date(ban) > new Date()) };
      }
      if (data.users.length < 200) break;
    }
    // Solo los usuarios que quien consulta puede ver (RLS de profiles)
    const { data: visibles } = await context.supabase.from("profiles").select("id");
    const ids = new Set((visibles ?? []).map((p) => p.id as string));
    return Object.fromEntries(Object.entries(out).filter(([id]) => ids.has(id)));
  });

/**
 * Vincula (o desvincula) un usuario con su registro de empleado. Con alcance «solo yo»,
 * el usuario solo ve la información de ese empleado.
 */
export const vincularEmpleado = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
    z.object({ id: z.string().uuid(), documento: z.string().trim().max(20).nullable() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await validarEdicion(context, data.id);
    const { data: tenant } = await context.supabase.rpc("current_tenant_id");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let empleado: { id: string; full_name: string } | null = null;
    if (data.documento) {
      const { data: e } = await supabaseAdmin
        .from("employees")
        .select("id, full_name, user_id")
        .eq("tenant_id", tenant as string)
        .eq("document", data.documento.replace(/\D/g, ""))
        .maybeSingle();
      if (!e) throw new Error("No existe un empleado con ese documento.");
      if (e.user_id && e.user_id !== data.id) throw new Error("Ese empleado ya está vinculado a otro usuario.");
      empleado = { id: e.id, full_name: e.full_name };
    }
    await supabaseAdmin.from("employees").update({ user_id: null }).eq("user_id", data.id);
    if (empleado) await supabaseAdmin.from("employees").update({ user_id: data.id }).eq("id", empleado.id);
    await supabaseAdmin.from("audit_logs").insert({
      tenant_id: tenant,
      user_id: context.userId,
      module: "usuarios",
      action: "editar",
      record_id: data.id,
      new_value: { empleado_vinculado: empleado ? `${empleado.full_name} (${data.documento})` : null },
    });
    return { empleado: empleado?.full_name ?? null };
  });
