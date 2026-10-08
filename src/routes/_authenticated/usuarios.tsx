import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Eye, EyeOff, KeyRound, Loader2, Pencil, Settings2, ShieldPlus, Trash2, UserCog, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { accesosUsuarios, actualizarUsuario, cambiarContrasena, eliminarUsuario, vincularEmpleado } from "@/lib/usuarios.functions";
import { PageHeader } from "@/components/app-shell";
import { Paginador, SimpleTable, ordenarFilas, usePaginado, type Orden } from "@/components/simple-table";
import { CrearUsuarios } from "@/components/crear-usuarios";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/usuarios")({
  head: () => ({ meta: [{ title: "Usuarios — Convert-IA" }] }),
  component: Usuarios,
});

type Perfil = {
  id: string;
  full_name: string | null;
  email: string | null;
  is_active: boolean;
  tenants: { name: string } | null;
};

type AsignacionRol = {
  id: string;
  user_id: string;
  scope: string;
  campaign_ids: string[] | null;
  roles: { id: string; name: string; code: string } | null;
};

type Alcance = "solo_yo" | "mi_campana" | "campanas_asignadas" | "mi_empresa" | "plataforma";

const ALCANCES: { value: Alcance; label: string }[] = [
  { value: "solo_yo", label: "Solo su información" },
  { value: "mi_campana", label: "Su campaña" },
  { value: "campanas_asignadas", label: "Campañas asignadas" },
  { value: "mi_empresa", label: "Toda la empresa" },
  { value: "plataforma", label: "Toda la plataforma" },
];

const iniciales = (n: string | null) =>
  (n ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
const fechaHora = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }) : "Nunca";

function Usuarios() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const leerAccesos = useServerFn(accesosUsuarios);
  const ejecutarEliminar = useServerFn(eliminarUsuario);
  const [gestionar, setGestionar] = useState<{ perfil: Perfil; pestana: string } | null>(null);
  const [usuarioAEliminar, setUsuarioAEliminar] = useState<Perfil | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [filtroRol, setFiltroRol] = useState("todos");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [orden, setOrden] = useState<Orden | null>({ col: "full_name", asc: true });

  const perfiles = useQuery({
    queryKey: ["perfiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, is_active, tenants(name)")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as unknown as Perfil[];
    },
  });

  const asignaciones = useQuery({
    queryKey: ["asignaciones-rol"],
    queryFn: async () => {
      const { data, error } = await supabase.from("user_roles").select("id, user_id, scope, campaign_ids, roles(id, name, code)");
      if (error) throw error;
      return (data ?? []) as unknown as AsignacionRol[];
    },
  });

  const roles = useQuery({
    queryKey: ["roles-simple"],
    queryFn: async () => {
      const { data, error } = await supabase.from("roles").select("id, name, code").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; code: string }[];
    },
  });

  const accesos = useQuery({ queryKey: ["usuarios-accesos"], queryFn: () => leerAccesos() });

  const filas = useMemo(() => {
    const t = busqueda.trim().toLowerCase();
    const lista = (perfiles.data ?? [])
      .map((p) => {
        const suyos = (asignaciones.data ?? []).filter((a) => a.user_id === p.id);
        return {
          ...p,
          asignaciones: suyos,
          rolesTexto: suyos.map((a) => a.roles?.name ?? "").join(", "),
          ultimo: accesos.data?.[p.id]?.ultimo_ingreso ?? null,
          estadoTexto: p.is_active ? "activo" : "inactivo",
        };
      })
      .filter((p) => !t || `${p.full_name ?? ""} ${p.email ?? ""}`.toLowerCase().includes(t))
      .filter((p) => filtroRol === "todos" || (filtroRol === "_sin" ? !p.asignaciones.length : p.asignaciones.some((a) => a.roles?.id === filtroRol)))
      .filter((p) => filtroEstado === "todos" || p.estadoTexto === filtroEstado);
    return ordenarFilas(lista, orden);
  }, [perfiles.data, asignaciones.data, accesos.data, busqueda, filtroRol, filtroEstado, orden]);
  const pag = usePaginado(filas, 20);

  const todos = perfiles.data ?? [];
  const sinRol = todos.filter((p) => !(asignaciones.data ?? []).some((a) => a.user_id === p.id)).length;
  const refrescar = () => void qc.invalidateQueries();
  const puedeEditar = acceso.can("usuarios", "editar");

  const mutEliminar = useMutation({
    mutationFn: (id: string) => ejecutarEliminar({ data: { id } }),
    onSuccess: (res) => {
      toast.success("Usuario eliminado", {
        description: `El usuario ${res.email ?? ""} ha sido eliminado exitosamente.`,
      });
      setUsuarioAEliminar(null);
      if (gestionar?.perfil.id === res.id) {
        setGestionar(null);
      }
      refrescar();
    },
    onError: (e: Error) => {
      toast.error("Error al eliminar usuario", { description: e.message });
    },
  });

  return (
    <div>
      <PageHeader
        titulo="Usuarios"
        descripcion="Personas con acceso a la plataforma: sus datos, roles, alcance de información y contraseña."
        acciones={acceso.can("usuarios", "crear") ? <CrearUsuarios alTerminar={refrescar} /> : null}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {[
          { t: "Usuarios", v: todos.length, k: "todos" },
          { t: "Activos", v: todos.filter((p) => p.is_active).length, k: "activo" },
          { t: "Inactivos", v: todos.filter((p) => !p.is_active).length, k: "inactivo" },
          { t: "Sin rol asignado", v: sinRol, k: "_sin" },
        ].map((c) => (
          <button
            key={c.k}
            type="button"
            onClick={() => {
              if (c.k === "_sin") { setFiltroRol("_sin"); setFiltroEstado("todos"); }
              else { setFiltroEstado(c.k); setFiltroRol("todos"); }
            }}
            className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary"
          >
            <p className="text-xs text-muted-foreground">{c.t}</p>
            <p className="text-2xl font-semibold tabular-nums">{perfiles.isLoading ? "…" : c.v}</p>
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input className="max-w-sm" placeholder="Buscar por nombre o correo…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
        <Select value={filtroRol} onValueChange={setFiltroRol}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Rol: todos</SelectItem>
            <SelectItem value="_sin">Sin rol</SelectItem>
            {(roles.data ?? []).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filtroEstado} onValueChange={setFiltroEstado}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Estado: todos</SelectItem>
            <SelectItem value="activo">Activos</SelectItem>
            <SelectItem value="inactivo">Inactivos</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{filas.length} usuarios</span>
      </div>

      <SimpleTable
        cargando={perfiles.isLoading}
        filas={pag.visibles}
        getKey={(f) => f.id}
        orden={orden}
        onOrden={setOrden}
        onFilaClick={puedeEditar ? (f) => setGestionar({ perfil: f, pestana: "datos" }) : undefined}
        vacio="No hay usuarios con estos filtros."
        columnas={[
          {
            key: "nombre",
            orden: "full_name",
            header: "Usuario",
            cell: (f) => (
              <div className="flex items-center gap-3">
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold", f.is_active ? "bg-primary/15 text-foreground" : "bg-muted text-muted-foreground")}>
                  {iniciales(f.full_name)}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium">{f.full_name ?? "—"}{f.id === acceso.userId ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">(tú)</span> : null}</p>
                  <p className="truncate text-xs text-muted-foreground">{f.email ?? ""}</p>
                </div>
              </div>
            ),
          },
          {
            key: "roles",
            orden: "rolesTexto",
            header: "Roles y alcance",
            cell: (f) =>
              f.asignaciones.length ? (
                <div className="flex flex-wrap gap-1">
                  {f.asignaciones.map((a) => (
                    <Badge key={a.id} variant="outline" className="font-normal">
                      {a.roles?.name} · {ALCANCES.find((x) => x.value === a.scope)?.label ?? a.scope}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-amber-700 dark:text-amber-400">Sin rol: no ve ningún módulo</span>
              ),
          },
          { key: "ultimo", orden: "ultimo", header: "Último ingreso", cell: (f) => <span className="text-xs">{accesos.isLoading ? "…" : fechaHora(f.ultimo)}</span> },
          {
            key: "estado",
            orden: "estadoTexto",
            header: "Estado",
            cell: (f) => <Badge variant={f.is_active ? "default" : "secondary"}>{f.is_active ? "Activo" : "Inactivo"}</Badge>,
          },
          {
            key: "acciones",
            header: "",
            className: "w-36 text-right",
            cell: (f) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                {puedeEditar ? (
                  <>
                    <Button variant="ghost" size="icon" title="Editar datos" onClick={() => setGestionar({ perfil: f, pestana: "datos" })}><UserCog className="size-4" /></Button>
                    <Button variant="ghost" size="icon" title="Roles y alcance" onClick={() => setGestionar({ perfil: f, pestana: "roles" })}><ShieldPlus className="size-4" /></Button>
                    <Button variant="ghost" size="icon" title="Cambiar contraseña" onClick={() => setGestionar({ perfil: f, pestana: "clave" })}><KeyRound className="size-4" /></Button>
                  </>
                ) : null}
                {acceso.isSuperAdmin && f.id !== acceso.userId ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Eliminar usuario (solo Super Administrador)"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setUsuarioAEliminar(f)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]}
      />
      <Paginador {...pag.paginador} />

      <GestionUsuario
        estado={gestionar}
        onClose={() => setGestionar(null)}
        onPestana={(p) => setGestionar((g) => (g ? { ...g, pestana: p } : g))}
        asignaciones={(asignaciones.data ?? []).filter((a) => a.user_id === gestionar?.perfil.id)}
        roles={roles.data ?? []}
        ultimo={gestionar ? accesos.data?.[gestionar.perfil.id]?.ultimo_ingreso ?? null : null}
        onCambio={refrescar}
        onSolicitarEliminar={(p) => setUsuarioAEliminar(p)}
      />

      <AlertDialog open={Boolean(usuarioAEliminar)} onOpenChange={(v) => { if (!v && !mutEliminar.isPending) setUsuarioAEliminar(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-5" />
              ¿Eliminar usuario definitivamente?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-sm text-muted-foreground">
              <span>
                Estás a punto de eliminar de forma permanente a{" "}
                <strong className="text-foreground">{usuarioAEliminar?.full_name || "este usuario"}</strong> ({usuarioAEliminar?.email}).
              </span>
              <span className="block text-xs">
                Se revocarán todos sus accesos, credenciales de inicio de sesión, roles asignados y se desvinculará de cualquier empleado. Esta acción es irreversible y está restringida únicamente al rol <strong>Super Administrador</strong>.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutEliminar.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={mutEliminar.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (usuarioAEliminar) mutEliminar.mutate(usuarioAEliminar.id);
              }}
            >
              {mutEliminar.isPending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Trash2 className="mr-1.5 size-4" />}
              {mutEliminar.isPending ? "Eliminando…" : "Sí, eliminar usuario"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function GestionUsuario({
  estado,
  onClose,
  onPestana,
  asignaciones,
  roles,
  ultimo,
  onCambio,
  onSolicitarEliminar,
}: {
  estado: { perfil: Perfil; pestana: string } | null;
  onClose: () => void;
  onPestana: (p: string) => void;
  asignaciones: AsignacionRol[];
  roles: { id: string; name: string; code: string }[];
  ultimo: string | null;
  onCambio: () => void;
  onSolicitarEliminar?: (perfil: Perfil) => void;
}) {
  const p = estado?.perfil;
  return (
    <Sheet open={Boolean(estado)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {p ? (
          <>
            <SheetHeader className="mb-4">
              <div className="flex items-center gap-3">
                <span className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-base font-semibold">{iniciales(p.full_name)}</span>
                <div>
                  <SheetTitle>{p.full_name ?? p.email}</SheetTitle>
                  <SheetDescription>{p.email} · último ingreso: {fechaHora(ultimo)}</SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <Tabs value={estado.pestana} onValueChange={onPestana}>
              <TabsList className="mb-4 grid w-full grid-cols-3">
                <TabsTrigger value="datos"><UserCog className="mr-1.5 size-4" />Datos</TabsTrigger>
                <TabsTrigger value="roles"><ShieldPlus className="mr-1.5 size-4" />Roles</TabsTrigger>
                <TabsTrigger value="clave"><KeyRound className="mr-1.5 size-4" />Contraseña</TabsTrigger>
              </TabsList>
              <TabsContent value="datos"><DatosUsuario perfil={p} onCambio={onCambio} onSolicitarEliminar={onSolicitarEliminar} /></TabsContent>
              <TabsContent value="roles"><RolesUsuario perfil={p} asignaciones={asignaciones} roles={roles} onCambio={onCambio} /></TabsContent>
              <TabsContent value="clave"><ClaveUsuario perfil={p} /></TabsContent>
            </Tabs>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DatosUsuario({
  perfil,
  onCambio,
  onSolicitarEliminar,
}: {
  perfil: Perfil;
  onCambio: () => void;
  onSolicitarEliminar?: ((perfil: Perfil) => void) | undefined;
}) {
  const acceso = useAccess();
  const actualizar = useServerFn(actualizarUsuario);
  const [f, setF] = useState({ full_name: perfil.full_name ?? "", email: perfil.email ?? "", is_active: perfil.is_active });
  useEffect(() => setF({ full_name: perfil.full_name ?? "", email: perfil.email ?? "", is_active: perfil.is_active }), [perfil]);
  const guardar = useMutation({
    mutationFn: () => actualizar({ data: { id: perfil.id, ...f } }),
    onSuccess: () => { toast.success("Usuario actualizado"); onCambio(); },
    onError: (e: Error) => toast.error("No se pudo guardar", { description: e.message }),
  });
  const propio = perfil.id === acceso.userId;
  return (
    <>
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); guardar.mutate(); }}>
      <div className="space-y-1.5"><Label htmlFor="u-nombre">Nombre completo</Label><Input id="u-nombre" required value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></div>
      <div className="space-y-1.5">
        <Label htmlFor="u-correo">Correo (usuario de ingreso)</Label>
        <Input id="u-correo" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <p className="text-xs text-muted-foreground">Si cambias el correo, la persona debe ingresar con el nuevo.</p>
      </div>
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">Usuario activo</p>
          <p className="text-xs text-muted-foreground">{propio ? "No puedes desactivar tu propio usuario." : "Un usuario inactivo no puede iniciar sesión."}</p>
        </div>
        <Switch checked={f.is_active} disabled={propio} onCheckedChange={(v) => setF({ ...f, is_active: v })} />
      </div>
      <Button type="submit" disabled={guardar.isPending} className="w-full">
        {guardar.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Guardar cambios
      </Button>
    </form>
    <div className="mt-5"><VinculoEmpleado perfil={perfil} /></div>

    {acceso.isSuperAdmin && !propio && onSolicitarEliminar ? (
      <div className="mt-6 rounded-lg border border-destructive/20 bg-destructive/5 p-4 space-y-2">
        <div className="flex items-center gap-2 text-destructive font-medium text-sm">
          <Trash2 className="size-4" />
          <span>Zona de peligro</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Eliminar permanentemente este usuario de la base de datos y del sistema de autenticación. Esta acción solo puede ser realizada por el rol Super Administrador.
        </p>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="w-full mt-2"
          onClick={() => onSolicitarEliminar(perfil)}
        >
          <Trash2 className="size-4 mr-1.5" />
          Eliminar este usuario
        </Button>
      </div>
    ) : null}
    </>
  );
}

/** Empleado al que corresponde el usuario: con alcance «solo su información» solo ve sus datos. */
function VinculoEmpleado({ perfil }: { perfil: Perfil }) {
  const qc = useQueryClient();
  const vincular = useServerFn(vincularEmpleado);
  const [documento, setDocumento] = useState("");
  const actual = useQuery({
    queryKey: ["usuario-empleado", perfil.id],
    queryFn: async () => {
      const { data } = await supabase.from("employees").select("document, full_name, campaigns(name)").eq("user_id", perfil.id).maybeSingle();
      return data as { document: string; full_name: string; campaigns: { name: string } | null } | null;
    },
  });
  const guardar = useMutation({
    mutationFn: (doc: string | null) => vincular({ data: { id: perfil.id, documento: doc } }),
    onSuccess: (r) => {
      toast.success(r.empleado ? `Vinculado a ${r.empleado}` : "Vínculo retirado");
      setDocumento("");
      void qc.invalidateQueries({ queryKey: ["usuario-empleado", perfil.id] });
    },
    onError: (e: Error) => toast.error("No se pudo vincular", { description: e.message }),
  });
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">Empleado vinculado</p>
      {actual.data ? (
        <div className="flex items-center justify-between gap-2 rounded-md bg-muted/40 p-2 text-sm">
          <span>{actual.data.full_name} · {actual.data.document}{actual.data.campaigns ? ` · ${actual.data.campaigns.name}` : ""}</span>
          <Button type="button" variant="ghost" size="sm" disabled={guardar.isPending} onClick={() => guardar.mutate(null)}>Quitar</Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Sin vínculo. Un asesor (o un BO sin campañas) solo ve la información de su empleado vinculado: vincúlalo para que vea sus datos.</p>
      )}
      <div className="flex gap-2">
        <Input placeholder="Documento del empleado" value={documento} onChange={(e) => setDocumento(e.target.value)} />
        <Button type="button" variant="outline" disabled={!documento.trim() || guardar.isPending} onClick={() => guardar.mutate(documento.trim())}>
          {actual.data ? "Cambiar" : "Vincular"}
        </Button>
      </div>
    </div>
  );
}

function RolesUsuario({
  perfil,
  asignaciones,
  roles,
  onCambio,
}: {
  perfil: Perfil;
  asignaciones: AsignacionRol[];
  roles: { id: string; name: string; code: string }[];
  onCambio: () => void;
}) {
  const acceso = useAccess();
  const [rolId, setRolId] = useState("");
  const [scope, setScope] = useState<Alcance>("mi_empresa");
  const [campSel, setCampSel] = useState<string[]>([]);
  const [editando, setEditando] = useState<string | null>(null);
  const requiereCampanas = scope === "mi_campana" || scope === "campanas_asignadas";
  const esAsesor = roles.find((r) => r.id === rolId)?.code === "asesor";
  useEffect(() => {
    if (esAsesor && campSel.length > 1) setCampSel(campSel.slice(0, 1));
  }, [esAsesor, campSel]);

  const campanas = useQuery({
    queryKey: ["campanas-simple"],
    queryFn: async () => {
      const { data, error } = await supabase.from("campaigns").select("id, name").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const nombreCampana = (id: string) => campanas.data?.find((c) => c.id === id)?.name ?? "?";

  const asignar = useMutation({
    mutationFn: async () => {
      if (!rolId) throw new Error("Selecciona un rol.");
      if (requiereCampanas && !campSel.length) throw new Error("Selecciona al menos una campaña.");
      const { error } = await supabase.from("user_roles").insert({
        user_id: perfil.id,
        role_id: rolId,
        tenant_id: acceso.tenantId,
        scope,
        campaign_ids: requiereCampanas ? campSel : [],
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Rol asignado"); setRolId(""); setCampSel([]); onCambio(); },
    onError: (e: Error) => toast.error("No se pudo asignar", { description: e.message }),
  });

  const quitar = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("user_roles").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Rol retirado"); onCambio(); },
    onError: (e: Error) => toast.error("No se pudo retirar", { description: e.message }),
  });

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm font-medium">Roles actuales</p>
        {asignaciones.length ? (
          asignaciones.map((a) => (
            <div key={a.id} className="rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{a.roles?.name}</p>
                <p className="text-xs text-muted-foreground">
                  {ALCANCES.find((x) => x.value === a.scope)?.label ?? a.scope}
                  {a.campaign_ids?.length ? ` · ${a.campaign_ids.map(nombreCampana).join(", ")}` : ""}
                </p>
              </div>
              <div className="flex shrink-0">
              {!["admin", "nomina", "super_admin"].includes(a.roles?.code ?? "") ? (
                <Button
                  variant="ghost"
                  size="icon"
                  title="Editar alcance y campañas"
                  onClick={() => setEditando((e) => (e === a.id ? null : a.id))}
                >
                  <Pencil className="size-4" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                title="Quitar rol"
                disabled={quitar.isPending || (a.roles?.code === "super_admin" && perfil.id === acceso.userId)}
                onClick={() => { if (confirm(`¿Quitar el rol ${a.roles?.name} a ${perfil.full_name}?`)) quitar.mutate(a.id); }}
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
              </div>
            </div>
            {editando === a.id ? (
              <EditarCampanasRol
                asignacion={a}
                campanas={campanas.data ?? []}
                puedePlataforma={acceso.isSuperAdmin}
                nombreUsuario={perfil.full_name ?? ""}
                onListo={() => { setEditando(null); onCambio(); }}
              />
            ) : null}
            </div>
          ))
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Sin roles: esta persona no ve ningún módulo.</p>
        )}
      </div>

      <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
        <p className="text-sm font-medium">Agregar rol</p>
        <Select
          value={rolId}
          onValueChange={(v) => {
            setRolId(v);
            const c = roles.find((r) => r.id === v)?.code ?? "";
            if (["admin", "nomina", "super_admin"].includes(c)) setScope("plataforma");
            else if (c === "asesor") setScope("solo_yo"); // el asesor solo ve lo suyo
            else if (["supervisor", "coordinador", "bo"].includes(c)) setScope("campanas_asignadas");
          }}
        >
          <SelectTrigger><SelectValue placeholder="Selecciona un rol" /></SelectTrigger>
          <SelectContent>
            {roles.filter((r) => r.code !== "super_admin" || acceso.isSuperAdmin).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={scope} onValueChange={(v) => setScope(v as Alcance)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {ALCANCES.filter((a) => a.value !== "plataforma" || acceso.isSuperAdmin).map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {requiereCampanas ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {esAsesor ? "Un asesor siempre ve solo su propia información; la campaña es informativa (máximo una)." : "Puede ver una o varias campañas."}
            </p>
            <div className="max-h-44 space-y-1 overflow-auto rounded-md border bg-background p-2">
              {(campanas.data ?? []).map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type={esAsesor ? "radio" : "checkbox"}
                    name="campanas-rol"
                    checked={campSel.includes(c.id)}
                    onChange={(e) => setCampSel((p) => (esAsesor ? [c.id] : e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </div>
        ) : null}
        <Button className="w-full" disabled={asignar.isPending || !rolId} onClick={() => asignar.mutate()}>
          <ShieldPlus className="size-4" /> Asignar rol
        </Button>
      </div>
    </div>
  );
}

/** Cambia el alcance y las campañas de un rol ya asignado, sin quitarlo y volverlo a asignar. */
function EditarCampanasRol({
  asignacion,
  campanas,
  puedePlataforma,
  nombreUsuario,
  onListo,
}: {
  asignacion: AsignacionRol;
  campanas: { id: string; name: string }[];
  puedePlataforma: boolean;
  nombreUsuario: string;
  onListo: () => void;
}) {
  const acceso = useAccess();
  const esAsesor = asignacion.roles?.code === "asesor";
  const [scope, setScope] = useState<Alcance>(asignacion.scope as Alcance);
  const [sel, setSel] = useState<string[]>(asignacion.campaign_ids ?? []);
  const [filtro, setFiltro] = useState("");
  const requiere = scope === "mi_campana" || scope === "campanas_asignadas";
  const visibles = campanas.filter((c) => c.name.toLowerCase().includes(filtro.trim().toLowerCase()));

  const guardar = useMutation({
    mutationFn: async () => {
      if (requiere && !sel.length) throw new Error("Selecciona al menos una campaña.");
      const campaign_ids = requiere ? (esAsesor ? sel.slice(0, 1) : sel) : [];
      const { error } = await supabase.from("user_roles").update({ scope, campaign_ids }).eq("id", asignacion.id);
      if (error) throw error;
      // Trazabilidad: antes y después
      await supabase.from("audit_logs").insert({
        tenant_id: acceso.tenantId,
        user_id: acceso.userId,
        module: "usuarios",
        action: "editar_campanas",
        record_id: asignacion.user_id,
        old_value: { rol: asignacion.roles?.name ?? null, alcance: asignacion.scope, campanas: asignacion.campaign_ids ?? [] },
        new_value: { rol: asignacion.roles?.name ?? null, alcance: scope, campanas: campaign_ids },
        reason: `Campañas de ${nombreUsuario}`,
      });
    },
    onSuccess: () => {
      toast.success("Campañas actualizadas", { description: "La persona las verá al volver a cargar la página." });
      onListo();
    },
    onError: (e: Error) => toast.error("No se pudieron guardar las campañas", { description: e.message }),
  });

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <Select value={scope} onValueChange={(v) => setScope(v as Alcance)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {ALCANCES.filter((x) => x.value !== "plataforma" || puedePlataforma).map((x) => <SelectItem key={x.value} value={x.value}>{x.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {requiere ? (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{esAsesor ? "Un asesor tiene una sola campaña (informativa)." : `${sel.length} de ${campanas.length} campañas`}</span>
            {!esAsesor ? (
              <span className="flex gap-2">
                <button type="button" className="text-primary hover:underline" onClick={() => setSel([...new Set([...sel, ...visibles.map((c) => c.id)])])}>Todas</button>
                <button type="button" className="text-primary hover:underline" onClick={() => setSel([])}>Ninguna</button>
              </span>
            ) : null}
          </div>
          {campanas.length > 8 ? <Input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Buscar campaña" className="h-8" /> : null}
          <div className="max-h-44 space-y-1 overflow-auto rounded-md border bg-background p-2">
            {visibles.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type={esAsesor ? "radio" : "checkbox"}
                  name={`campanas-${asignacion.id}`}
                  checked={sel.includes(c.id)}
                  onChange={(e) => setSel((p) => (esAsesor ? [c.id] : e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                />
                {c.name}
              </label>
            ))}
          </div>
        </>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onListo} disabled={guardar.isPending}>Cancelar</Button>
        <Button size="sm" onClick={() => guardar.mutate()} disabled={guardar.isPending}>
          {guardar.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Guardar campañas
        </Button>
      </div>
    </div>
  );
}

function generarClave() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const v = new Uint32Array(10);
  crypto.getRandomValues(v);
  return `${Array.from(v, (x) => c[x % c.length]).join("")}*${(v[0]! % 90) + 10}`;
}

function ClaveUsuario({ perfil }: { perfil: Perfil }) {
  const cambiar = useServerFn(cambiarContrasena);
  const [clave, setClave] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [ver, setVer] = useState(false);
  useEffect(() => { setClave(""); setConfirmar(""); }, [perfil.id]);
  const valida = clave.length >= 8 && clave === confirmar;
  const guardar = useMutation({
    mutationFn: () => cambiar({ data: { id: perfil.id, password: clave } }),
    onSuccess: () => { toast.success("Contraseña actualizada", { description: "Compártela por un canal seguro; la persona puede cambiarla desde su menú." }); setClave(""); setConfirmar(""); },
    onError: (e: Error) => toast.error("No se pudo cambiar", { description: e.message }),
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valida) guardar.mutate(); }}>
      <div className="space-y-1.5">
        <Label htmlFor="u-clave">Nueva contraseña</Label>
        <div className="flex gap-2">
          <Input id="u-clave" type={ver ? "text" : "password"} autoComplete="new-password" value={clave} onChange={(e) => setClave(e.target.value)} />
          <Button type="button" variant="outline" size="icon" title={ver ? "Ocultar" : "Mostrar"} onClick={() => setVer(!ver)}>{ver ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
          <Button type="button" variant="outline" size="icon" title="Generar contraseña segura" onClick={() => { const g = generarClave(); setClave(g); setConfirmar(g); setVer(true); }}><Wand2 className="size-4" /></Button>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="u-clave2">Confirmar contraseña</Label>
        <Input id="u-clave2" type={ver ? "text" : "password"} autoComplete="new-password" value={confirmar} onChange={(e) => setConfirmar(e.target.value)} />
        {clave && clave.length < 8 ? <p className="text-xs text-destructive">Mínimo 8 caracteres.</p> : null}
        {confirmar && clave !== confirmar ? <p className="text-xs text-destructive">Las contraseñas no coinciden.</p> : null}
      </div>
      <Button type="submit" className="w-full" disabled={!valida || guardar.isPending}>
        {guardar.isPending ? <Loader2 className="size-4 animate-spin" /> : <Settings2 className="size-4" />} Cambiar contraseña
      </Button>
    </form>
  );
}
