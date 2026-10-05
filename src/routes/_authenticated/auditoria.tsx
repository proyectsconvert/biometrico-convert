import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, History } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { descargarCsv } from "@/lib/biometria";
import { PageHeader } from "@/components/app-shell";
import { Paginador, SimpleTable, ordenarFilas, usePaginado, type Orden } from "@/components/simple-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/auditoria")({
  head: () => ({ meta: [{ title: "Auditoría — Convert-IA" }] }),
  component: Auditoria,
});

type Log = {
  id: number;
  module: string;
  action: string;
  record_id: string | null;
  reason: string | null;
  old_value: unknown;
  new_value: unknown;
  created_at: string;
  profiles: { full_name: string | null; email: string | null } | null;
};

const MODULOS: Record<string, string> = {
  empleados: "Empleados", usuarios: "Usuarios", roles: "Roles y permisos", reglas: "Reglas de cálculo",
  novedades: "Novedades", datos: "Calidad de datos", asistencia: "Control diario", importaciones: "Importaciones",
  dispositivos: "Dispositivos", festivos: "Festivos", empleadores: "Empleadores",
  turnos: "Turnos", campanas: "Campañas", centros_costo: "Centros de costo",
};
// Entidades de la trazabilidad automática (acciones crear_*, editar_*, eliminar_*)
const ENTIDADES: Record<string, string> = {
  empleado: "empleado", novedad_dia: "novedad del día", novedad_horas: "horas de novedad", plantilla: "plantilla de novedades",
  horario: "horario", rotacion: "rotación", asignacion: "asignación de turno", malla: "día de la malla", campana: "campaña",
  centro_costo: "centro de costo", empleador: "empleador", festivo: "festivo", regla: "regla de cálculo", dispositivo: "dispositivo",
};
const ACCIONES: Record<string, { label: string; clase: string }> = {
  crear: { label: "Creó", clase: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  importar: { label: "Importó", clase: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  editar: { label: "Editó", clase: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  aprobado: { label: "Aprobó", clase: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  observado: { label: "Observó", clase: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" },
  pendiente: { label: "Reabrió", clase: "bg-muted text-foreground" },
  cambiar_contrasena: { label: "Cambió contraseña", clase: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300" },
  eliminar: { label: "Eliminó", clase: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  ocultar: { label: "Ocultó", clase: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  mostrar: { label: "Mostró", clase: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  rechazado: { label: "Rechazó", clase: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  respondido: { label: "Respondió", clase: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300" },
  asignar: { label: "Asignó turnos", clase: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  quitar_asignacion: { label: "Quitó asignación de turno", clase: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  cargar_malla: { label: "Cargó plantilla de malla", clase: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  programar_malla: { label: "Programó la malla", clase: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  aprobar_solicitud: { label: "Aprobó solicitud", clase: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
};
const accion = (a: string) => {
  if (ACCIONES[a]) return ACCIONES[a]!;
  // Trazabilidad automática: «editar_novedad_dia», «crear_empleado_masivo», …
  const m = a.match(/^(crear|editar|eliminar)_(.+?)(_masivo)?$/);
  if (m) {
    const base = ACCIONES[m[1]!]!;
    return { label: `${base.label} ${ENTIDADES[m[2]!] ?? m[2]!.replace(/_/g, " ")}${m[3] ? " (masivo)" : ""}`, clase: base.clase };
  }
  return { label: a.replace(/_/g, " "), clase: "bg-muted text-foreground" };
};
const modulo = (m: string) => MODULOS[m] ?? m;

/** Resumen legible de lo que cambió. */
function resumen(l: Log) {
  const v = (l.new_value ?? {}) as { agregados?: unknown[]; quitados?: unknown[]; rol?: string; registros?: number; archivo?: string };
  if (l.module === "roles" && (v.agregados || v.quitados))
    return `${v.rol}: +${v.agregados?.length ?? 0} / −${v.quitados?.length ?? 0} permisos`;
  if (typeof v.registros !== "undefined") return `${v.registros} registro(s)`;
  if (v.archivo) return String(v.archivo);
  const claves = Object.keys(v);
  return claves.length ? claves.slice(0, 4).join(", ") : "";
}

function Auditoria() {
  const acceso = useAccess();
  const [f, setF] = useState({ modulo: "todos", accion: "todas", usuario: "todos", texto: "", desde: "", hasta: "" });
  const [orden, setOrden] = useState<Orden | null>({ col: "created_at", asc: false });
  const [detalle, setDetalle] = useState<Log | null>(null);

  const lista = useQuery({
    queryKey: ["auditoria"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("id, module, action, record_id, reason, old_value, new_value, created_at, profiles(full_name, email)")
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as unknown as Log[];
    },
  });

  const datos = lista.data ?? [];
  const opciones = useMemo(() => ({
    modulos: [...new Set(datos.map((l) => l.module))].sort(),
    acciones: [...new Set(datos.map((l) => l.action))].sort(),
    usuarios: [...new Set(datos.map((l) => l.profiles?.full_name ?? "Sistema"))].sort(),
  }), [datos]);

  const filas = useMemo(() => {
    const t = f.texto.trim().toLowerCase();
    return ordenarFilas(
      datos
        .map((l) => ({ ...l, usuario: l.profiles?.full_name ?? "Sistema", moduloTexto: modulo(l.module), resumenTexto: resumen(l) }))
        .filter((l) => f.modulo === "todos" || l.module === f.modulo)
        .filter((l) => f.accion === "todas" || l.action === f.accion)
        .filter((l) => f.usuario === "todos" || l.usuario === f.usuario)
        .filter((l) => !f.desde || l.created_at.slice(0, 10) >= f.desde)
        .filter((l) => !f.hasta || l.created_at.slice(0, 10) <= f.hasta)
        .filter((l) => !t || `${l.reason ?? ""} ${l.record_id ?? ""} ${l.resumenTexto} ${JSON.stringify(l.new_value ?? "")}`.toLowerCase().includes(t)),
      orden,
    );
  }, [datos, f, orden]);
  const pag = usePaginado(filas, 20);

  return (
    <div>
      <PageHeader
        titulo="Auditoría"
        descripcion="Quién cambió qué y cuándo. Haz clic en un movimiento para ver el detalle antes/después. La auditoría no se puede borrar."
        acciones={
          !acceso.can("auditoria", "exportar") ? null : <Button
            variant="outline"
            disabled={!filas.length}
            onClick={() =>
              descargarCsv("auditoria", filas.map((l) => ({
                fecha: new Date(l.created_at).toLocaleString("es-CO"),
                usuario: l.usuario,
                modulo: l.moduloTexto,
                accion: accion(l.action).label,
                registro: l.record_id ?? "",
                resumen: l.resumenTexto,
                motivo: l.reason ?? "",
                valor_anterior: l.old_value ? JSON.stringify(l.old_value) : "",
                valor_nuevo: l.new_value ? JSON.stringify(l.new_value) : "",
              })))
            }
          >
            <Download className="size-4" /> Exportar
          </Button>
        }
      />

      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <Filtro label="Módulo" valor={f.modulo} onChange={(v) => setF({ ...f, modulo: v })} todos="todos" opciones={opciones.modulos.map((m) => [m, modulo(m)])} />
        <Filtro label="Acción" valor={f.accion} onChange={(v) => setF({ ...f, accion: v })} todos="todas" opciones={opciones.acciones.map((a) => [a, accion(a).label])} />
        <Filtro label="Usuario" valor={f.usuario} onChange={(v) => setF({ ...f, usuario: v })} todos="todos" opciones={opciones.usuarios.map((u) => [u, u])} />
        <div className="space-y-1.5"><Label>Desde</Label><Input type="date" value={f.desde} onChange={(e) => setF({ ...f, desde: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Hasta</Label><Input type="date" value={f.hasta} onChange={(e) => setF({ ...f, hasta: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Buscar</Label><Input placeholder="Motivo, registro…" value={f.texto} onChange={(e) => setF({ ...f, texto: e.target.value })} /></div>
      </Card>

      <SimpleTable
        cargando={lista.isLoading}
        filas={pag.visibles}
        getKey={(l) => String(l.id)}
        orden={orden}
        onOrden={setOrden}
        onFilaClick={setDetalle}
        vacio="No hay movimientos con estos filtros."
        columnas={[
          { key: "fecha", orden: "created_at", header: "Fecha", cell: (l) => <span className="whitespace-nowrap text-xs tabular-nums">{new Date(l.created_at).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}</span> },
          { key: "usuario", orden: "usuario", header: "Usuario", cell: (l) => <span className="font-medium">{l.usuario}</span> },
          { key: "modulo", orden: "moduloTexto", header: "Módulo", cell: (l) => l.moduloTexto },
          { key: "accion", orden: "action", header: "Acción", cell: (l) => <Badge variant="secondary" className={cn("font-normal", accion(l.action).clase)}>{accion(l.action).label}</Badge> },
          { key: "resumen", header: "Detalle", cell: (l) => <span className="line-clamp-1 max-w-72 text-xs text-muted-foreground">{l.resumenTexto}</span> },
          { key: "motivo", header: "Motivo", cell: (l) => <span className="line-clamp-2 max-w-80 text-xs">{l.reason ?? "—"}</span> },
        ]}
      />
      <Paginador {...pag.paginador} />

      <Dialog open={Boolean(detalle)} onOpenChange={(v) => !v && setDetalle(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {detalle ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2"><History className="size-5" />{accion(detalle.action).label} · {modulo(detalle.module)}</DialogTitle>
                <DialogDescription>
                  {detalle.profiles?.full_name ?? "Sistema"} · {new Date(detalle.created_at).toLocaleString("es-CO", { dateStyle: "full", timeStyle: "medium" })}
                  {detalle.record_id ? ` · registro ${detalle.record_id}` : ""}
                </DialogDescription>
              </DialogHeader>
              {detalle.reason ? <p className="rounded-md bg-muted/50 p-3 text-sm"><span className="font-medium">Motivo:</span> {detalle.reason}</p> : null}
              <Diferencias antes={detalle.old_value} despues={detalle.new_value} />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Filtro({ label, valor, onChange, todos, opciones }: { label: string; valor: string; onChange: (v: string) => void; todos: string; opciones: [string, string][] }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={valor} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={todos}>Todos</SelectItem>
          {opciones.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

const mostrar = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v, null, 1) : String(v));

/** Tabla campo por campo: valor anterior → valor nuevo (resalta lo que cambió). */
function Diferencias({ antes, despues }: { antes: unknown; despues: unknown }) {
  const a = (antes && typeof antes === "object" ? antes : {}) as Record<string, unknown>;
  const d = (despues && typeof despues === "object" ? despues : {}) as Record<string, unknown>;
  const claves = [...new Set([...Object.keys(a), ...Object.keys(d)])];
  if (!claves.length) return <p className="text-sm text-muted-foreground">Sin detalle adicional.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr><th className="py-1 pr-3 font-medium">Campo</th><th className="py-1 pr-3 font-medium">Antes</th><th className="py-1 font-medium">Después</th></tr>
      </thead>
      <tbody>
        {claves.map((k) => {
          const cambio = JSON.stringify(a[k]) !== JSON.stringify(d[k]);
          return (
            <tr key={k} className="border-t align-top">
              <td className="py-1.5 pr-3 font-medium">{k}</td>
              <td className="py-1.5 pr-3"><pre className="whitespace-pre-wrap break-all font-sans text-xs text-muted-foreground">{mostrar(a[k])}</pre></td>
              <td className={cn("py-1.5", cambio && Object.keys(a).length > 0 && "bg-amber-50 dark:bg-amber-950/30")}><pre className="whitespace-pre-wrap break-all font-sans text-xs">{mostrar(d[k])}</pre></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
