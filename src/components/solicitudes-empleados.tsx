import { useEffect, useMemo, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Inbox,
  Loader2,
  MessageSquare,
  Send,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { alfabetico } from "@/lib/filtro-personas";
import { haceCuanto } from "@/components/notificaciones";
import { AdjuntarArchivos, carpetaEmpleado } from "@/components/comentarios-empleado";
import {
  BUCKET_EVIDENCIAS_EMPLEADOS,
  ChipArchivo,
  VisorDocumento,
  subirArchivos,
  type Archivo,
} from "@/components/visor-documento";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export const TIPOS_SOLICITUD: Record<string, string> = {
  activar: "Activar",
  inactivar: "Inactivar",
  cambio_campana: "Cambio de campaña",
  actualizar_datos: "Actualizar datos",
  otro: "Otro ajuste",
};
const ESTADOS: Record<string, { etiqueta: string; clase: string }> = {
  pendiente: { etiqueta: "Pendiente", clase: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  aprobada: {
    etiqueta: "Aprobada",
    clase: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  rechazada: { etiqueta: "Rechazada", clase: "bg-destructive/15 text-destructive" },
};
const CAMPOS: Record<string, string> = {
  status: "Estado",
  termination_date: "Fecha de retiro",
  hire_date: "Fecha de ingreso",
  campaign_id: "Campaña",
  position: "Cargo",
  cost_center_id: "Centro de costo",
  email: "Correo",
};

export type EmpleadoSolicitud = { id: string; full_name: string; status: string };
type Solicitud = {
  id: string;
  employee_id: string;
  campaign_id: string | null;
  tipo: string;
  detalle: string;
  cambios: Record<string, string | null>;
  estado: string;
  respuesta: string | null;
  created_at: string;
  resolved_at: string | null;
  requested_by: string | null;
  employees: { full_name: string; document: string; status: string } | null;
  campaigns: { name: string } | null;
  autor: { full_name: string | null } | null;
  resolutor: { full_name: string | null } | null;
};
type Evento = {
  id: string;
  tipo: string;
  comentario: string | null;
  archivos: Archivo[];
  created_at: string;
  profiles: { full_name: string | null } | null;
};

async function subirSoportes(archivos: File[], tenantId: string | null, empleados: string[]) {
  if (!archivos.length || !tenantId) return [] as Archivo[];
  if (empleados.length > 30)
    throw new Error("Para adjuntar soportes, envía la solicitud para máximo 30 personas a la vez.");
  const out: Archivo[] = [];
  for (const id of [...new Set(empleados)])
    out.push(
      ...(await subirArchivos(
        archivos,
        BUCKET_EVIDENCIAS_EMPLEADOS,
        carpetaEmpleado(tenantId, id),
      )),
    );
  return out;
}

function useCampanas() {
  return useQuery({
    queryKey: ["solicitudes", "campanas"],
    queryFn: async () => {
      const { data, error } = await supabase.from("campaigns").select("id, name").order("name");
      if (error) throw error;
      return ((data ?? []) as { id: string; name: string }[]).sort((a, b) =>
        alfabetico(a.name, b.name),
      );
    },
  });
}

const valorCambio = (k: string, v: string | null, campanas: Map<string, string>) =>
  v === null || v === ""
    ? "(vacío)"
    : k === "campaign_id"
      ? (campanas.get(v) ?? "otra campaña")
      : k === "status"
        ? v
        : String(v);

/* ---------------- Solicitar ---------------- */

/** El supervisor pide a Nómina/Administración un ajuste de uno o varios empleados. */
export function SolicitarAjusteDialog({
  empleados,
  abierta,
  onClose,
  onListo,
}: {
  empleados: EmpleadoSolicitud[];
  abierta: boolean;
  onClose: () => void;
  onListo?: () => void;
}) {
  const qc = useQueryClient();
  const campanas = useCampanas();
  const inactivos = empleados.filter((e) => e.status !== "activo");
  const activos = empleados.filter((e) => e.status === "activo");
  const [tipo, setTipo] = useState("");
  const [detalle, setDetalle] = useState("");
  const [archivos, setArchivos] = useState<File[]>([]);
  const acceso = useAccess();
  const [fecha, setFecha] = useState("");
  const [campana, setCampana] = useState("");
  const [cargo, setCargo] = useState("");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!abierta) return;
    setTipo(
      inactivos.length && !activos.length
        ? "activar"
        : activos.length && !inactivos.length
          ? "otro"
          : "",
    );
    setDetalle("");
    setArchivos([]);
    setFecha("");
    setCampana("");
    setCargo("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierta]);

  // Activar solo aplica a inactivos e inactivar solo a activos
  const destino = tipo === "activar" ? inactivos : tipo === "inactivar" ? activos : empleados;
  const omitidos = empleados.length - destino.length;

  async function enviar() {
    if (!tipo) {
      toast.error("Elige el tipo de solicitud");
      return;
    }
    if (detalle.trim().length < 5) {
      toast.error("Explica el motivo de la solicitud");
      return;
    }
    if (tipo === "cambio_campana" && !campana) {
      toast.error("Elige la campaña destino");
      return;
    }
    if (!destino.length) {
      toast.error("Ninguna de las personas elegidas aplica para este tipo de solicitud");
      return;
    }
    const cambios: Record<string, string> = {};
    if (tipo === "activar" && fecha) cambios["hire_date"] = fecha;
    if (tipo === "inactivar" && fecha) cambios["termination_date"] = fecha;
    if (tipo === "cambio_campana") cambios["campaign_id"] = campana;
    if (tipo === "actualizar_datos") {
      if (cargo.trim()) cambios["position"] = cargo.trim();
      if (fecha) cambios["hire_date"] = fecha;
    }
    setEnviando(true);
    let soportes: Archivo[] = [];
    try {
      soportes = await subirSoportes(
        archivos,
        acceso.tenantId,
        destino.map((e) => e.id),
      );
    } catch (e) {
      setEnviando(false);
      toast.error("No se pudieron subir los soportes", { description: (e as Error).message });
      return;
    }
    const { data, error } = await supabase.rpc(
      "solicitar_ajuste_empleado" as never,
      {
        _empleados: destino.map((e) => e.id),
        _tipo: tipo,
        _detalle: detalle.trim(),
        _cambios: cambios,
        _archivos: soportes,
      } as never,
    );
    setEnviando(false);
    if (error) {
      toast.error("No se pudo enviar la solicitud", { description: error.message });
      return;
    }
    toast.success(
      `Solicitud enviada a Nómina y Administración (${data as number} ${(data as number) === 1 ? "empleado" : "empleados"})`,
    );
    void qc.invalidateQueries({ queryKey: ["solicitudes"] });
    onListo?.();
    onClose();
  }

  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Solicitar ajuste de{" "}
            {empleados.length === 1 ? empleados[0]?.full_name : `${empleados.length} empleados`}
          </DialogTitle>
          <DialogDescription>
            La solicitud llega solo a Nómina y Administración. Cuando la resuelvan te llegará una
            notificación.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {empleados.length > 1 ? (
            <div className="flex max-h-20 flex-wrap gap-1 overflow-auto">
              {empleados.map((e) => (
                <Badge
                  key={e.id}
                  variant={e.status === "activo" ? "secondary" : "outline"}
                  className="font-normal"
                >
                  {e.full_name}
                  {e.status !== "activo" ? " · inactivo" : ""}
                </Badge>
              ))}
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label>¿Qué necesitas?</Label>
            <Select
              value={tipo}
              onValueChange={(v) => {
                setTipo(v);
                setFecha("");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Elige el tipo de solicitud" />
              </SelectTrigger>
              <SelectContent>
                {inactivos.length ? (
                  <SelectItem value="activar">
                    Activar (está inactivo y debe estar activo)
                  </SelectItem>
                ) : null}
                {activos.length ? (
                  <SelectItem value="inactivar">Inactivar (retiro)</SelectItem>
                ) : null}
                <SelectItem value="cambio_campana">Cambio de campaña</SelectItem>
                <SelectItem value="actualizar_datos">
                  Actualizar datos (cargo, fecha de ingreso)
                </SelectItem>
                <SelectItem value="otro">Otro ajuste</SelectItem>
              </SelectContent>
            </Select>
            {omitidos > 0 && tipo ? (
              <p className="text-xs text-muted-foreground">
                {omitidos} {omitidos === 1 ? "persona no aplica" : "personas no aplican"} para este
                tipo y se omiten.
              </p>
            ) : null}
          </div>
          {tipo === "activar" ? (
            <div className="space-y-1.5">
              <Label htmlFor="s-fecha">Fecha de reingreso (opcional)</Label>
              <Input
                id="s-fecha"
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Si la indicas, queda como nueva fecha de ingreso. Al activar se borra la fecha de
                retiro.
              </p>
            </div>
          ) : null}
          {tipo === "inactivar" ? (
            <div className="space-y-1.5">
              <Label htmlFor="s-fecha">Fecha de retiro</Label>
              <Input
                id="s-fecha"
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                El ausentismo se cuenta solo hasta esta fecha.
              </p>
            </div>
          ) : null}
          {tipo === "cambio_campana" ? (
            <div className="space-y-1.5">
              <Label>Campaña destino</Label>
              <Select value={campana} onValueChange={setCampana}>
                <SelectTrigger>
                  <SelectValue placeholder="Elige la campaña" />
                </SelectTrigger>
                <SelectContent>
                  {(campanas.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Si la campaña destino no aparece en la lista, escríbela en el motivo.
              </p>
            </div>
          ) : null}
          {tipo === "actualizar_datos" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="s-cargo">Cargo nuevo</Label>
                <Input id="s-cargo" value={cargo} onChange={(e) => setCargo(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-fecha">Fecha de ingreso</Label>
                <Input
                  id="s-fecha"
                  type="date"
                  value={fecha}
                  onChange={(e) => setFecha(e.target.value)}
                />
              </div>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="s-detalle">Motivo</Label>
            <Textarea
              id="s-detalle"
              rows={3}
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              placeholder={
                tipo === "activar"
                  ? "Ej.: sigue trabajando en la campaña desde el 1 de octubre; quedó inactivo por error en la carga."
                  : "Explica qué hay que ajustar y por qué."
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Soportes (opcional)</Label>
            <AdjuntarArchivos archivos={archivos} onChange={setArchivos} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void enviar()} disabled={enviando}>
            {enviando ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}{" "}
            Enviar solicitud
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Bandeja ---------------- */

/** Botón con la bandeja de solicitudes: Nómina/Admin las resuelven; el supervisor ve las de sus campañas y comenta. */
export function SolicitudesEmpleados() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const [abierta, setAbierta] = useState(false);
  const [estado, setEstado] = useState("pendiente");
  const [busqueda, setBusqueda] = useState("");
  const [expandida, setExpandida] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [accion, setAccion] = useState<{
    tipo: "aprobar" | "rechazar" | "comentar";
    solicitudes: Solicitud[];
  } | null>(null);
  const puedeResolver = acceso.can("empleados", "aprobar") || acceso.can("empleados", "editar");
  const campanas = useCampanas();
  const mapaCampanas = useMemo(
    () => new Map((campanas.data ?? []).map((c) => [c.id, c.name])),
    [campanas.data],
  );

  // Las notificaciones enlazan a /empleados?solicitudes=1
  const desdeUrl = Boolean(search["solicitudes"]);
  useEffect(() => {
    if (desdeUrl) setAbierta(true);
  }, [desdeUrl]);

  const lista = useQuery({
    queryKey: ["solicitudes", "lista"],
    refetchInterval: 120_000,
    queryFn: async () => {
      const { data, error } = await dbAny
        .from("employee_requests")
        .select(
          "*, employees(full_name, document, status), campaigns(name), autor:requested_by(full_name), resolutor:resolved_by(full_name)",
        )
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as Solicitud[];
    },
  });
  const todas = lista.data ?? [];
  const pendientes = todas.filter((s) => s.estado === "pendiente").length;
  const filas = todas.filter(
    (s) =>
      (estado === "todas" || s.estado === estado) &&
      (!busqueda.trim() ||
        `${s.employees?.full_name ?? ""} ${s.employees?.document ?? ""} ${s.campaigns?.name ?? ""} ${s.detalle}`
          .toLowerCase()
          .includes(busqueda.toLowerCase())),
  );
  const seleccionadas = filas.filter((s) => seleccion.has(s.id) && s.estado === "pendiente");

  const conteo = (e: string) =>
    e === "todas" ? todas.length : todas.filter((s) => s.estado === e).length;

  return (
    <>
      <Button variant="outline" onClick={() => setAbierta(true)} className="relative">
        <Inbox className="size-4" /> Solicitudes
        {pendientes > 0 ? (
          <Badge className="ml-1 h-5 px-1.5 tabular-nums">{pendientes}</Badge>
        ) : null}
      </Button>
      <Dialog open={abierta} onOpenChange={setAbierta}>
        <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Solicitudes de ajuste de empleados</DialogTitle>
            <DialogDescription>
              {puedeResolver
                ? "Los supervisores piden activar, inactivar o ajustar personal. Al aprobar, el cambio se aplica al empleado y se notifica a los supervisores de su campaña."
                : "Tus solicitudes y las de tus campañas. Nómina y Administración las resuelven; te llegará una notificación con la respuesta."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              value={estado}
              onValueChange={(v) => {
                setEstado(v);
                setSeleccion(new Set());
              }}
            >
              <TabsList>
                {["pendiente", "aprobada", "rechazada", "todas"].map((e) => (
                  <TabsTrigger key={e} value={e}>
                    {e === "todas" ? "Todas" : ESTADOS[e]!.etiqueta + "s"} ({conteo(e)})
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Input
              className="max-w-xs"
              placeholder="Buscar persona, campaña o motivo…"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
          </div>
          {puedeResolver && seleccionadas.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
              <span className="font-medium">{seleccionadas.length} seleccionadas</span>
              <Button
                size="sm"
                onClick={() => setAccion({ tipo: "aprobar", solicitudes: seleccionadas })}
              >
                <Check className="size-4" /> Aprobar
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAccion({ tipo: "rechazar", solicitudes: seleccionadas })}
              >
                <X className="size-4" /> Rechazar
              </Button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {lista.isLoading ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 inline size-4 animate-spin" />
                Cargando…
              </p>
            ) : filas.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No hay solicitudes{" "}
                {estado === "todas" ? "" : (ESTADOS[estado]?.etiqueta.toLowerCase() ?? "") + "s"}.
              </p>
            ) : (
              filas.map((s) => (
                <Card key={s.id} className="p-3">
                  <div className="flex items-start gap-3">
                    {puedeResolver && s.estado === "pendiente" ? (
                      <Checkbox
                        className="mt-1"
                        aria-label="Seleccionar"
                        checked={seleccion.has(s.id)}
                        onCheckedChange={(v) =>
                          setSeleccion((p) => {
                            const n = new Set(p);
                            if (v) n.add(s.id);
                            else n.delete(s.id);
                            return n;
                          })
                        }
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs font-medium",
                            ESTADOS[s.estado]?.clase,
                          )}
                        >
                          {ESTADOS[s.estado]?.etiqueta}
                        </span>
                        <Badge variant="outline">{TIPOS_SOLICITUD[s.tipo] ?? s.tipo}</Badge>
                        <span className="font-medium">{s.employees?.full_name ?? "Empleado"}</span>
                        <span className="text-xs text-muted-foreground">
                          {s.employees?.document} · {s.campaigns?.name ?? "Sin campaña"} · hoy{" "}
                          {s.employees?.status ?? "—"}
                        </span>
                      </div>
                      <p className="mt-1 text-sm">{s.detalle}</p>
                      {Object.keys(s.cambios ?? {}).length ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Cambio:{" "}
                          {Object.entries(s.cambios)
                            .map(
                              ([k, v]) => `${CAMPOS[k] ?? k} → ${valorCambio(k, v, mapaCampanas)}`,
                            )
                            .join(" · ")}
                        </p>
                      ) : null}
                      {s.respuesta ? (
                        <p className="mt-1 text-xs">
                          <strong>Respuesta:</strong> {s.respuesta}
                        </p>
                      ) : null}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Solicitó {s.autor?.full_name ?? "—"} · {haceCuanto(s.created_at)}
                        {s.resolved_at
                          ? ` · Resolvió ${s.resolutor?.full_name ?? "—"} ${haceCuanto(s.resolved_at)}`
                          : ""}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setExpandida(expandida === s.id ? null : s.id)}
                        >
                          {expandida === s.id ? (
                            <ChevronDown className="size-3.5" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )}{" "}
                          Historial
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setAccion({ tipo: "comentar", solicitudes: [s] })}
                        >
                          <MessageSquare className="size-3.5" /> Comentar
                        </Button>
                        {puedeResolver && s.estado === "pendiente" ? (
                          <>
                            <Button
                              size="sm"
                              className="ml-auto h-7 text-xs"
                              onClick={() => setAccion({ tipo: "aprobar", solicitudes: [s] })}
                            >
                              <Check className="size-3.5" /> Aprobar y aplicar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => setAccion({ tipo: "rechazar", solicitudes: [s] })}
                            >
                              <X className="size-3.5" /> Rechazar
                            </Button>
                          </>
                        ) : null}
                      </div>
                      {expandida === s.id ? <HistorialSolicitud id={s.id} /> : null}
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ResolverDialog
        accion={accion}
        mapaCampanas={mapaCampanas}
        onClose={() => setAccion(null)}
        onListo={() => {
          setAccion(null);
          setSeleccion(new Set());
          void qc.invalidateQueries({ queryKey: ["solicitudes"] });
          void qc.invalidateQueries({ queryKey: ["employees"] });
        }}
      />
    </>
  );
}

function HistorialSolicitud({ id }: { id: string }) {
  const [visor, setVisor] = useState<Archivo | null>(null);
  const eventos = useQuery({
    queryKey: ["solicitudes", "historial", id],
    queryFn: async () => {
      const { data, error } = await dbAny
        .from("employee_request_events")
        .select("id, tipo, comentario, archivos, created_at, profiles:user_id(full_name)")
        .eq("request_id", id)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as Evento[];
    },
  });
  const etiqueta: Record<string, string> = {
    creada: "Creó la solicitud",
    comentario: "Comentó",
    aprobada: "Aprobó",
    rechazada: "Rechazó",
  };
  if (eventos.isLoading) return <p className="mt-2 text-xs text-muted-foreground">Cargando…</p>;
  return (
    <ol className="mt-2 space-y-1.5 border-l pl-3">
      {(eventos.data ?? []).map((e) => (
        <li key={e.id} className="text-xs">
          <span className="font-medium">{e.profiles?.full_name ?? "—"}</span> ·{" "}
          {etiqueta[e.tipo] ?? e.tipo} ·{" "}
          <span className="text-muted-foreground">{haceCuanto(e.created_at)}</span>
          {e.comentario ? <p className="text-muted-foreground">{e.comentario}</p> : null}
          {e.archivos?.length ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {e.archivos.map((a) => (
                <ChipArchivo
                  key={a.path}
                  archivo={{ ...a, bucket: a.bucket ?? BUCKET_EVIDENCIAS_EMPLEADOS }}
                  onAbrir={setVisor}
                />
              ))}
            </div>
          ) : null}
        </li>
      ))}
      <VisorDocumento archivo={visor} onClose={() => setVisor(null)} />
    </ol>
  );
}

function ResolverDialog({
  accion,
  mapaCampanas,
  onClose,
  onListo,
}: {
  accion: { tipo: "aprobar" | "rechazar" | "comentar"; solicitudes: Solicitud[] } | null;
  mapaCampanas: Map<string, string>;
  onClose: () => void;
  onListo: () => void;
}) {
  const [comentario, setComentario] = useState("");
  const [archivos, setArchivos] = useState<File[]>([]);
  const acceso = useAccess();
  const [fecha, setFecha] = useState("");
  const [enviando, setEnviando] = useState(false);
  const una = accion?.solicitudes.length === 1 ? accion.solicitudes[0] : undefined;
  // Al aprobar una sola activación o inactivación, Nómina puede ajustar la fecha
  const campoFecha =
    accion?.tipo === "aprobar" && una
      ? una.tipo === "activar"
        ? "hire_date"
        : una.tipo === "inactivar"
          ? "termination_date"
          : null
      : null;

  useEffect(() => {
    setComentario("");
    setArchivos([]);
    setFecha(campoFecha && una ? (una.cambios?.[campoFecha] ?? "") : "");
  }, [accion, campoFecha, una]);

  if (!accion) return null;
  const titulo = { aprobar: "Aprobar y aplicar", rechazar: "Rechazar", comentar: "Comentar" }[
    accion.tipo
  ];

  async function enviar() {
    if (!accion) return;
    if (accion.tipo === "rechazar" && comentario.trim().length < 3) {
      toast.error("Escribe el motivo del rechazo");
      return;
    }
    if (accion.tipo === "comentar" && comentario.trim().length < 3 && !archivos.length) {
      toast.error("Escribe el comentario o adjunta un archivo");
      return;
    }
    setEnviando(true);
    let soportes: Archivo[] = [];
    try {
      soportes = await subirSoportes(
        archivos,
        acceso.tenantId,
        accion.solicitudes.map((s) => s.employee_id),
      );
    } catch (e) {
      setEnviando(false);
      toast.error("No se pudieron subir los soportes", { description: (e as Error).message });
      return;
    }
    const cambios = campoFecha ? { [campoFecha]: fecha || null } : null;
    const { data, error } = await supabase.rpc(
      "resolver_solicitud_empleado" as never,
      {
        _ids: accion.solicitudes.map((s) => s.id),
        _accion: accion.tipo,
        _comentario: comentario.trim() || null,
        _cambios: campoFecha && una?.tipo === "activar" && !fecha ? null : cambios,
        _archivos: soportes,
      } as never,
    );
    setEnviando(false);
    if (error) {
      toast.error("No se pudo completar", { description: error.message });
      return;
    }
    toast.success(
      accion.tipo === "aprobar"
        ? `${data as number} ${(data as number) === 1 ? "solicitud aprobada y aplicada" : "solicitudes aprobadas y aplicadas"}`
        : accion.tipo === "rechazar"
          ? "Solicitud rechazada; se notificó a quien la hizo"
          : "Comentario enviado",
    );
    onListo();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {titulo}{" "}
            {una
              ? `· ${una.employees?.full_name ?? ""}`
              : `${accion.solicitudes.length} solicitudes`}
          </DialogTitle>
          <DialogDescription>
            {accion.tipo === "aprobar"
              ? "El cambio se aplica de inmediato al empleado y se notifica al supervisor."
              : accion.tipo === "rechazar"
                ? "El supervisor verá el motivo del rechazo."
                : "El comentario queda en el historial y se notifica a la otra parte."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {accion.tipo === "aprobar" && una && Object.keys(una.cambios ?? {}).length ? (
            <p className="rounded-md bg-muted/50 p-2 text-xs">
              Se aplicará:{" "}
              {Object.entries(una.cambios)
                .filter(([k]) => k !== campoFecha)
                .map(([k, v]) => `${CAMPOS[k] ?? k} → ${valorCambio(k, v, mapaCampanas)}`)
                .join(" · ")}
            </p>
          ) : null}
          {campoFecha ? (
            <div className="space-y-1.5">
              <Label htmlFor="r-fecha">
                {CAMPOS[campoFecha]}
                {campoFecha === "hire_date" ? " (opcional)" : ""}
              </Label>
              <Input
                id="r-fecha"
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
              />
            </div>
          ) : null}
          {accion.tipo === "aprobar" && una?.tipo === "otro" ? (
            <p className="text-xs text-muted-foreground">
              Las solicitudes de «Otro ajuste» no cambian datos automáticamente: haz el ajuste en el
              empleado y aprueba para cerrarla.
            </p>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="r-com">
              {accion.tipo === "aprobar" ? "Comentario (opcional)" : "Comentario"}
            </Label>
            <Textarea
              id="r-com"
              rows={3}
              value={comentario}
              onChange={(e) => setComentario(e.target.value)}
            />
          </div>
          <AdjuntarArchivos archivos={archivos} onChange={setArchivos} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant={accion.tipo === "rechazar" ? "destructive" : "default"}
            onClick={() => void enviar()}
            disabled={enviando}
          >
            {enviando ? <Loader2 className="size-4 animate-spin" /> : null} {titulo}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
