import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Loader2, Lock, Pencil, Plus, RotateCcw, Save, Search, ShieldCheck, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/roles")({
  head: () => ({ meta: [{ title: "Roles y permisos — Convert-IA" }] }),
  component: Roles,
});

type Rol = { id: string; code: string; name: string; description: string | null; is_system: boolean; tenant_id: string | null };
type Permiso = { id: string; module: string; action: string };

// Módulos agrupados como en el menú; los módulos nuevos aparecen solos en «Otros».
const GRUPOS: { titulo: string; modulos: [string, string][] }[] = [
  { titulo: "Inicio", modulos: [["dashboard", "Panel"], ["reportes", "Reportes"]] },
  { titulo: "Personal", modulos: [["empleados", "Empleados"], ["empleadores", "Empleadores"], ["campanas", "Campañas"], ["centros_costo", "Centros de costo"]] },
  { titulo: "Asistencia", modulos: [["importaciones", "Importaciones"], ["asistencia", "Control diario"], ["marcaciones", "Marcaciones"], ["turnos", "Turnos"], ["registro_turnos", "Registro de turnos"]] },
  { titulo: "Novedades", modulos: [["novedades", "Novedades y conciliación"]] },
  {
    titulo: "Administración",
    modulos: [["usuarios", "Usuarios"], ["roles", "Roles y permisos"], ["dispositivos", "Dispositivos"], ["reglas", "Reglas de cálculo"], ["festivos", "Festivos"], ["datos", "Calidad de datos"], ["auditoria", "Auditoría"], ["empresas", "Empresas (tenants)"]],
  },
];
const ACCIONES: [string, string][] = [
  ["ver", "Ver"], ["crear", "Crear"], ["editar", "Editar"], ["eliminar", "Eliminar"], ["importar", "Importar"], ["exportar", "Exportar"],
  ["aprobar", "Aprobar"], ["rechazar", "Rechazar"], ["ajustar", "Ajustar"], ["configurar", "Configurar"], ["depurar", "Depurar"], ["asignar", "Asignar"],
  ["exportar_adecco", "Exportar Adecco"],
];
const PLANTILLAS: { id: string; label: string; acciones: string[] | null }[] = [
  { id: "todo", label: "Acceso total", acciones: null },
  { id: "lectura", label: "Solo lectura", acciones: ["ver", "exportar"] },
  { id: "ninguno", label: "Sin acceso", acciones: [] },
];

const slug = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

function Roles() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [rolId, setRolId] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<Set<string> | null>(null);
  const [buscar, setBuscar] = useState("");
  const [dialogo, setDialogo] = useState<{ modo: "nuevo" | "editar" | "duplicar"; rol?: Rol } | null>(null);
  const puedeEditar = acceso.can("roles", "editar");

  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("roles").select("id, code, name, description, is_system, tenant_id").order("name");
      if (error) throw error;
      return (data ?? []) as Rol[];
    },
  });
  const permisos = useQuery({
    queryKey: ["permisos"],
    queryFn: async () => {
      const { data, error } = await supabase.from("permissions").select("id, module, action");
      if (error) throw error;
      return (data ?? []) as Permiso[];
    },
  });
  const conteos = useQuery({
    queryKey: ["roles", "conteos"],
    queryFn: async () => {
      const [rp, ur] = await Promise.all([
        supabase.from("role_permissions").select("role_id"),
        supabase.from("user_roles").select("role_id"),
      ]);
      const cuenta = (filas: { role_id: string }[] | null) => {
        const m = new Map<string, number>();
        for (const f of filas ?? []) m.set(f.role_id, (m.get(f.role_id) ?? 0) + 1);
        return m;
      };
      return { permisos: cuenta(rp.data as { role_id: string }[] | null), usuarios: cuenta(ur.data as { role_id: string }[] | null) };
    },
  });

  const rol = roles.data?.find((r) => r.id === (rolId ?? roles.data?.[0]?.id)) ?? null;
  const esSuper = rol?.code === "super_admin";
  const editable = puedeEditar && !esSuper;

  const asignados = useQuery({
    queryKey: ["role-permissions", rol?.id],
    enabled: Boolean(rol),
    queryFn: async () => {
      const { data, error } = await supabase.from("role_permissions").select("permission_id").eq("role_id", rol!.id);
      if (error) throw error;
      return new Set((data ?? []).map((r) => r.permission_id as string));
    },
  });
  // Al cambiar de rol o recargar, el borrador parte de lo guardado
  useEffect(() => setBorrador(asignados.data ? new Set(asignados.data) : null), [asignados.data]);

  const indice = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of permisos.data ?? []) m.set(`${p.module}.${p.action}`, p.id);
    return m;
  }, [permisos.data]);

  const grupos = useMemo(() => {
    const conocidos = new Set(GRUPOS.flatMap((g) => g.modulos.map(([m]) => m)));
    const otros = [...new Set((permisos.data ?? []).map((p) => p.module))].filter((m) => !conocidos.has(m)).map((m) => [m, m.replace(/_/g, " ")] as [string, string]);
    const t = buscar.trim().toLowerCase();
    return [...GRUPOS, ...(otros.length ? [{ titulo: "Otros", modulos: otros }] : [])]
      .map((g) => ({ ...g, modulos: g.modulos.filter(([m, l]) => !t || l.toLowerCase().includes(t) || m.includes(t)) }))
      .filter((g) => g.modulos.length);
  }, [permisos.data, buscar]);

  const actual = esSuper ? new Set(permisos.data?.map((p) => p.id)) : borrador ?? new Set<string>();
  const cambios = useMemo(() => {
    if (!borrador || !asignados.data) return { agregar: [] as string[], quitar: [] as string[] };
    return {
      agregar: [...borrador].filter((id) => !asignados.data.has(id)),
      quitar: [...asignados.data].filter((id) => !borrador.has(id)),
    };
  }, [borrador, asignados.data]);
  const pendientes = cambios.agregar.length + cambios.quitar.length;

  const fijar = (ids: string[], activo: boolean) =>
    setBorrador((prev) => {
      const n = new Set(prev ?? []);
      for (const id of ids) {
        if (activo) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  const idsDe = (modulos: string[], acciones: string[]) =>
    modulos.flatMap((m) => acciones.map((a) => indice.get(`${m}.${a}`)).filter(Boolean) as string[]);
  const todosModulos = grupos.flatMap((g) => g.modulos.map(([m]) => m));

  function aplicarPlantilla(acciones: string[] | null) {
    const todas = ACCIONES.map(([a]) => a);
    const ids = new Set(idsDe(todosModulos, acciones ?? todas));
    setBorrador((prev) => {
      const n = new Set(prev ?? []);
      for (const id of idsDe(todosModulos, todas)) n.delete(id);
      for (const id of ids) n.add(id);
      return n;
    });
  }

  const guardar = useMutation({
    mutationFn: async () => {
      if (!rol) return;
      if (cambios.agregar.length) {
        const { error } = await supabase.from("role_permissions").insert(cambios.agregar.map((permission_id) => ({ role_id: rol.id, permission_id })));
        if (error) throw error;
      }
      if (cambios.quitar.length) {
        const { error } = await supabase.from("role_permissions").delete().eq("role_id", rol.id).in("permission_id", cambios.quitar);
        if (error) throw error;
      }
      const nombre = (id: string) => { const p = permisos.data?.find((x) => x.id === id); return p ? `${p.module}.${p.action}` : id; };
      await supabase.from("audit_logs").insert({
        tenant_id: acceso.tenantId,
        user_id: acceso.userId,
        module: "roles",
        action: "editar",
        record_id: rol.id,
        new_value: { rol: rol.name, agregados: cambios.agregar.map(nombre), quitados: cambios.quitar.map(nombre) },
      });
    },
    onSuccess: () => {
      toast.success(`Permisos de «${rol?.name}» guardados`, { description: "Los usuarios con este rol los verán al recargar la página." });
      void qc.invalidateQueries({ queryKey: ["role-permissions"] });
      void qc.invalidateQueries({ queryKey: ["roles", "conteos"] });
    },
    onError: (e: Error) => toast.error("No se pudo guardar", { description: e.message }),
  });

  const eliminar = useMutation({
    mutationFn: async (r: Rol) => {
      if (conteos.data?.usuarios.get(r.id)) throw new Error("Tiene usuarios asignados; quítaselo primero en Usuarios.");
      const { error } = await supabase.from("roles").delete().eq("id", r.id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Rol eliminado"); setRolId(null); void qc.invalidateQueries({ queryKey: ["roles"] }); },
    onError: (e: Error) => toast.error("No se pudo eliminar", { description: e.message }),
  });

  function cambiarRol(id: string) {
    if (pendientes && !confirm("Tienes cambios sin guardar en este rol. ¿Descartarlos?")) return;
    setRolId(id);
  }

  return (
    <div>
      <PageHeader
        titulo="Roles y permisos"
        descripcion="Elige un rol y marca qué puede hacer en cada módulo. Los cambios se guardan juntos al pulsar «Guardar»."
        acciones={puedeEditar ? <Button onClick={() => setDialogo({ modo: "nuevo" })}><Plus className="size-4" /> Nuevo rol</Button> : null}
      />

      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <div className="space-y-2">
          {roles.isLoading ? <Skeleton className="h-64 w-full" /> : (roles.data ?? []).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => cambiarRol(r.id)}
              className={cn("w-full rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary", r.id === rol?.id && "border-primary ring-1 ring-primary")}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{r.name}</p>
                {r.is_system ? <Badge variant="outline" className="text-[10px]">sistema</Badge> : <Badge variant="secondary" className="text-[10px]">personalizado</Badge>}
              </div>
              <p className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><ShieldCheck className="size-3" />{r.code === "super_admin" ? "todos" : conteos.data?.permisos.get(r.id) ?? 0} permisos</span>
                <span className="flex items-center gap-1"><Users className="size-3" />{conteos.data?.usuarios.get(r.id) ?? 0} usuarios</span>
              </p>
            </button>
          ))}
        </div>

        {rol ? (
          <Card className="overflow-hidden p-0">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
              <div>
                <h2 className="font-display text-lg font-semibold">{rol.name}</h2>
                <p className="text-sm text-muted-foreground">{rol.description || "Sin descripción"} · código {rol.code}</p>
              </div>
              {puedeEditar ? (
                <div className="flex flex-wrap gap-1">
                  {!rol.is_system ? <Button variant="ghost" size="sm" onClick={() => setDialogo({ modo: "editar", rol })}><Pencil className="size-4" /> Editar</Button> : null}
                  <Button variant="ghost" size="sm" onClick={() => setDialogo({ modo: "duplicar", rol })}><Copy className="size-4" /> Duplicar</Button>
                  {!rol.is_system ? (
                    <Button variant="ghost" size="sm" onClick={() => { if (confirm(`¿Eliminar el rol «${rol.name}»?`)) eliminar.mutate(rol); }}><Trash2 className="size-4 text-destructive" /> Eliminar</Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {esSuper ? (
              <p className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm"><Lock className="size-4" /> El Super Administrador siempre tiene acceso total; sus permisos no se editan.</p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input className="w-56 pl-8" placeholder="Buscar módulo…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
              </div>
              {editable ? (
                <>
                  <span className="ml-2 text-xs text-muted-foreground">Plantilla:</span>
                  {PLANTILLAS.map((p) => <Button key={p.id} variant="outline" size="sm" onClick={() => aplicarPlantilla(p.acciones)}>{p.label}</Button>)}
                </>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                {pendientes ? <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300">{pendientes} cambio(s) sin guardar</Badge> : null}
                {editable ? (
                  <>
                    <Button variant="ghost" size="sm" disabled={!pendientes} onClick={() => setBorrador(asignados.data ? new Set(asignados.data) : null)}><RotateCcw className="size-4" /> Descartar</Button>
                    <Button size="sm" disabled={!pendientes || guardar.isPending} onClick={() => guardar.mutate()}>
                      {guardar.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Guardar
                    </Button>
                  </>
                ) : !puedeEditar ? <Badge variant="outline"><Eye className="mr-1 size-3" />Solo lectura</Badge> : null}
              </div>
            </div>

            {permisos.isLoading || asignados.isLoading ? (
              <Skeleton className="m-4 h-64" />
            ) : (
              <div className="max-h-[65vh] overflow-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-muted">
                    <tr>
                      <th className="sticky left-0 z-20 min-w-48 bg-muted px-4 py-2 text-left font-medium">Módulo</th>
                      {ACCIONES.map(([a, l]) => {
                        const ids = idsDe(todosModulos, [a]);
                        const todas = ids.length > 0 && ids.every((id) => actual.has(id));
                        return (
                          <th key={a} className="px-1 py-2 text-center text-xs font-medium">
                            <button
                              type="button"
                              disabled={!editable || !ids.length}
                              className="rounded px-1.5 py-0.5 hover:bg-background disabled:cursor-default disabled:hover:bg-transparent"
                              title={editable ? `${todas ? "Quitar" : "Dar"} «${l}» en todos los módulos` : l}
                              onClick={() => fijar(ids, !todas)}
                            >
                              {l}
                            </button>
                          </th>
                        );
                      })}
                      <th className="px-2 py-2 text-center text-xs font-medium">Todo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grupos.map((g) => (
                      <GrupoFilas key={g.titulo} titulo={g.titulo} modulos={g.modulos} indice={indice} actual={actual} editable={editable} onFijar={fijar} guardado={asignados.data} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : null}
      </div>

      <DialogoRol
        estado={dialogo}
        onClose={() => setDialogo(null)}
        onListo={(id) => { setDialogo(null); void qc.invalidateQueries({ queryKey: ["roles"] }); if (id) setRolId(id); }}
      />
    </div>
  );
}

function GrupoFilas({
  titulo, modulos, indice, actual, editable, onFijar, guardado,
}: {
  titulo: string;
  modulos: [string, string][];
  indice: Map<string, string>;
  actual: Set<string>;
  editable: boolean;
  onFijar: (ids: string[], activo: boolean) => void;
  guardado: Set<string> | undefined;
}) {
  return (
    <>
      <tr><td colSpan={ACCIONES.length + 2} className="bg-muted/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{titulo}</td></tr>
      {modulos.map(([m, l]) => {
        const ids = ACCIONES.map(([a]) => indice.get(`${m}.${a}`)).filter(Boolean) as string[];
        const n = ids.filter((id) => actual.has(id)).length;
        return (
          <tr key={m} className="border-t hover:bg-muted/20">
            <td className="sticky left-0 bg-card px-4 py-1.5">
              <p className="font-medium">{l}</p>
              <p className="text-[11px] text-muted-foreground">{n ? `${n} de ${ids.length}` : "sin acceso"}</p>
            </td>
            {ACCIONES.map(([a, la]) => {
              const id = indice.get(`${m}.${a}`);
              if (!id) return <td key={a} className="text-center text-muted-foreground/30">·</td>;
              const cambiado = guardado ? guardado.has(id) !== actual.has(id) : false;
              return (
                <td key={a} className={cn("py-1.5 text-center", cambiado && "bg-amber-100/60 dark:bg-amber-950/40")}>
                  <Checkbox aria-label={`${l}: ${la}`} checked={actual.has(id)} disabled={!editable} onCheckedChange={(v) => onFijar([id], Boolean(v))} />
                </td>
              );
            })}
            <td className="py-1.5 text-center">
              <Checkbox aria-label={`${l}: todo`} checked={n === ids.length ? true : n ? "indeterminate" : false} disabled={!editable} onCheckedChange={() => onFijar(ids, n !== ids.length)} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

function DialogoRol({ estado, onClose, onListo }: { estado: { modo: "nuevo" | "editar" | "duplicar"; rol?: Rol } | null; onClose: () => void; onListo: (id?: string) => void }) {
  const acceso = useAccess();
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  useEffect(() => {
    if (!estado) return;
    setNombre(estado.modo === "duplicar" ? `${estado.rol?.name} (copia)` : estado.modo === "editar" ? estado.rol?.name ?? "" : "");
    setDescripcion(estado.rol?.description ?? "");
  }, [estado]);

  const guardar = useMutation({
    mutationFn: async () => {
      if (!estado) return undefined;
      if (estado.modo === "editar" && estado.rol) {
        const { error } = await supabase.from("roles").update({ name: nombre.trim(), description: descripcion.trim() || null }).eq("id", estado.rol.id);
        if (error) throw error;
        return estado.rol.id;
      }
      const { data, error } = await supabase
        .from("roles")
        .insert({ tenant_id: acceso.tenantId, code: `${slug(nombre)}_${Date.now().toString(36).slice(-4)}`, name: nombre.trim(), description: descripcion.trim() || null, is_system: false })
        .select("id")
        .single();
      if (error) throw error;
      if (estado.modo === "duplicar" && estado.rol) {
        const { data: rp } = await supabase.from("role_permissions").select("permission_id").eq("role_id", estado.rol.id);
        if (rp?.length) {
          const { error: e2 } = await supabase.from("role_permissions").insert(rp.map((x) => ({ role_id: data.id, permission_id: x.permission_id })));
          if (e2) throw e2;
        }
      }
      return data.id as string;
    },
    onSuccess: (id) => { toast.success(estado?.modo === "editar" ? "Rol actualizado" : "Rol creado"); onListo(id); },
    onError: (e: Error) => toast.error("No se pudo guardar", { description: e.message }),
  });

  const titulo = estado?.modo === "editar" ? "Editar rol" : estado?.modo === "duplicar" ? `Duplicar «${estado.rol?.name}»` : "Nuevo rol";
  return (
    <Dialog open={Boolean(estado)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
          <DialogDescription>
            {estado?.modo === "duplicar" ? "Se copian todos sus permisos; luego ajústalos." : "Ejemplos: Analista, Auditor, RRHH, Gerente, Cliente, Solo lectura."}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (nombre.trim()) guardar.mutate(); }}>
          <div className="space-y-1.5"><Label htmlFor="rol-nombre">Nombre</Label><Input id="rol-nombre" required value={nombre} onChange={(e) => setNombre(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rol-desc">Descripción</Label><Textarea id="rol-desc" rows={2} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Qué hace este rol" /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={!nombre.trim() || guardar.isPending}>{guardar.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Guardar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
