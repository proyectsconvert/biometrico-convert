import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Info, Loader2, LocateFixed, MapPin, Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { useEmpleadosFiltro } from "@/lib/filtro-personas";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { MapaUbicaciones } from "@/components/mapa-ubicaciones";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Ubicacion = { nombre: string; lat: number; lon: number; radio_m: number };
type Regla = {
  id: string;
  nombre: string;
  alcance: "empresa" | "campana" | "empleado";
  campaign_id: string | null;
  employee_id: string | null;
  activo: boolean;
  modo: "bloquear" | "alertar";
  ips: string[];
  ubicaciones: Ubicacion[];
  exigir_ubicacion: boolean;
  dispositivos: string[];
  mismo_dispositivo_cierre: boolean;
  max_horas: number;
  tolerancia_min: number;
  recordatorio_min: number;
  alarmas_activas: boolean;
  alertar_roles: string[];
  aviso_empleado_activo: boolean;
  aviso_empleado_min: number;
  aviso_empleado_repetir_min: number;
  campaigns?: { name: string } | null;
  employees?: { full_name: string; document: string } | null;
};

const DISPOSITIVOS = [
  { v: "pc", l: "Computador (PC)" },
  { v: "movil", l: "Celular" },
  { v: "tablet", l: "Tablet" },
];
const ROLES = [
  { v: "supervisor", l: "Supervisor" },
  { v: "coordinador", l: "Coordinador" },
  { v: "admin", l: "Administrador" },
  { v: "nomina", l: "Nómina" },
];
const ALCANCE = { empresa: "Toda la empresa", campana: "Campaña", empleado: "Empleado" } as const;
/** IPv4 o IPv6, con rango CIDR opcional (p. ej. 181.57.0.0/16). */
const IP_VALIDA = /^((\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?|[0-9a-f:]+:[0-9a-f:]*(\/\d{1,3})?)$/i;

const nueva = (): Omit<Regla, "id"> & { id?: string } => ({
  nombre: "",
  alcance: "campana",
  campaign_id: null,
  employee_id: null,
  activo: true,
  modo: "alertar",
  ips: [],
  ubicaciones: [],
  exigir_ubicacion: false,
  dispositivos: [],
  mismo_dispositivo_cierre: true,
  max_horas: 8,
  tolerancia_min: 15,
  recordatorio_min: 30,
  alarmas_activas: true,
  alertar_roles: ["supervisor", "coordinador"],
  aviso_empleado_activo: true,
  aviso_empleado_min: 5,
  aviso_empleado_repetir_min: 10,
});

/** Pestaña «Configuración» de Registro de turnos: reglas por empresa, campaña o empleado. */
export function ConfiguracionTurnos() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const puedeEditar = acceso.can("registro_turnos", "configurar");
  const [editando, setEditando] = useState<(Omit<Regla, "id"> & { id?: string }) | null>(null);

  const reglas = useQuery({
    queryKey: ["reglas-turno"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shift_policies" as never)
        .select("*, campaigns(name), employees(full_name, document)")
        .order("alcance")
        .order("nombre");
      if (error) throw error;
      return (data as unknown as Regla[]) ?? [];
    },
  });

  async function eliminar(r: Regla) {
    if (!confirm(`¿Eliminar la regla «${r.nombre}»? Los turnos que la usan conservan su historial.`)) return;
    const { error } = await supabase.from("shift_policies" as never).delete().eq("id", r.id);
    if (error) toast.error("No se pudo eliminar", { description: error.message });
    else {
      toast.success("Regla eliminada");
      void qc.invalidateQueries({ queryKey: ["reglas-turno"] });
    }
  }

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-start gap-3 p-4 text-sm">
        <Info className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-1 text-muted-foreground">
          <p className="font-medium text-foreground">¿Cómo funcionan las reglas?</p>
          <p>
            Cada persona usa la regla más específica: la de su <b>empleado</b>, si no la de su <b>campaña</b> y si no la de la{" "}
            <b>empresa</b>. En modo <b>Bloquear</b> no se deja iniciar ni finalizar fuera de la regla; en <b>Solo alertar</b> se deja,
            pero se genera una alarma. El turno solo se finaliza desde el mismo equipo y navegador donde inició; si se pierde el
            equipo, el supervisor hace un cierre autorizado desde «Inicio turno».
          </p>
          <p className="text-xs">
            Límites reales: la IP la toma el servidor y es confiable; la ubicación la da el navegador (puede ser imprecisa o
            negarse); el tipo de dispositivo se deduce del navegador y la «llave» del equipo se pierde si se borran los datos del
            navegador.
          </p>
        </div>
        {puedeEditar ? (
          <Button onClick={() => setEditando(nueva())}>
            <Plus className="size-4" /> Nueva regla
          </Button>
        ) : null}
      </Card>

      {reglas.isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline size-4 animate-spin" />
          Cargando reglas…
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {(reglas.data ?? []).map((r) => (
            <Card key={r.id} className={cn("space-y-3 p-4", !r.activo && "opacity-60")}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{r.nombre}</p>
                  <p className="text-xs text-muted-foreground">
                    {ALCANCE[r.alcance]}
                    {r.campaigns ? ` · ${r.campaigns.name}` : ""}
                    {r.employees ? ` · ${r.employees.full_name} (${r.employees.document})` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Badge variant={r.modo === "bloquear" ? "destructive" : "secondary"}>
                    {r.modo === "bloquear" ? "Bloquea" : "Solo alerta"}
                  </Badge>
                  {!r.activo ? <Badge variant="outline">Inactiva</Badge> : null}
                  {puedeEditar ? (
                    <>
                      <Button size="icon" variant="ghost" title="Editar" onClick={() => setEditando(r)}>
                        <Pencil className="size-4" />
                      </Button>
                      {r.alcance !== "empresa" ? (
                        <Button size="icon" variant="ghost" title="Eliminar" onClick={() => void eliminar(r)}>
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">IP autorizadas</dt>
                <dd>{r.ips.length ? r.ips.join(", ") : "Cualquiera"}</dd>
                <dt className="text-muted-foreground">Ubicaciones</dt>
                <dd>
                  {r.ubicaciones.length
                    ? r.ubicaciones.map((u) => `${u.nombre} (${u.radio_m} m)`).join(", ")
                    : r.exigir_ubicacion
                      ? "Cualquiera (obligatoria también al finalizar)"
                      : "Cualquiera"}
                </dd>
                <dt className="text-muted-foreground">Dispositivos</dt>
                <dd>
                  {r.dispositivos.length
                    ? r.dispositivos.map((d) => DISPOSITIVOS.find((x) => x.v === d)?.l ?? d).join(", ")
                    : "Cualquiera"}
                </dd>
                <dt className="text-muted-foreground">Cierre</dt>
                <dd>{r.mismo_dispositivo_cierre ? "Solo desde el mismo equipo" : "Desde cualquier equipo"}</dd>
                <dt className="text-muted-foreground">Tiempo máximo</dt>
                <dd>
                  {r.max_horas} h + {r.tolerancia_min} min de tolerancia
                </dd>
                <dt className="text-muted-foreground">Alarmas</dt>
                <dd>
                  {r.alarmas_activas
                    ? `Cada ${r.recordatorio_min} min a ${r.alertar_roles.map((x) => ROLES.find((y) => y.v === x)?.l ?? x).join(", ") || "nadie"}`
                    : "Desactivadas"}
                </dd>
                <dt className="text-muted-foreground">Aviso a la persona</dt>
                <dd>
                  {r.aviso_empleado_activo
                    ? `Ventana emergente ${r.aviso_empleado_min} min después del máximo, cada ${r.aviso_empleado_repetir_min} min`
                    : "Desactivado"}
                </dd>
              </dl>
            </Card>
          ))}
        </div>
      )}

      {editando ? (
        <EditorRegla
          inicial={editando}
          onClose={() => setEditando(null)}
          onListo={() => {
            setEditando(null);
            void qc.invalidateQueries({ queryKey: ["reglas-turno"] });
          }}
        />
      ) : null}
    </div>
  );
}

function EditorRegla({
  inicial,
  onClose,
  onListo,
}: {
  inicial: Omit<Regla, "id"> & { id?: string };
  onClose: () => void;
  onListo: () => void;
}) {
  const acceso = useAccess();
  const [r, setR] = useState(inicial);
  const [ipsTexto, setIpsTexto] = useState(inicial.ips.join("\n"));
  const [guardando, setGuardando] = useState(false);
  const [ubicando, setUbicando] = useState(false);
  const [sel, setSel] = useState(0);
  const set = <K extends keyof typeof r>(k: K, v: (typeof r)[K]) => setR((p) => ({ ...p, [k]: v }));

  const campanas = useQuery({
    queryKey: ["campanas-simple"],
    queryFn: async () => {
      const { data } = await supabase.from("campaigns").select("id, name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const empleados = useEmpleadosFiltro();
  const opcionesEmpleados = useMemo(
    () =>
      (empleados.data ?? [])
        .filter((e) => e.status === "activo")
        .map((e) => ({ value: e.id, label: e.full_name, sublabel: [e.document, e.campana].filter(Boolean).join(" · ") })),
    [empleados.data],
  );

  const ips = ipsTexto
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const ipsMalas = ips.filter((x) => !IP_VALIDA.test(x));
  const valido =
    r.nombre.trim().length >= 3 &&
    !ipsMalas.length &&
    (r.alcance !== "campana" || r.campaign_id) &&
    (r.alcance !== "empleado" || r.employee_id) &&
    r.max_horas > 0 &&
    r.aviso_empleado_min >= 0 &&
    r.aviso_empleado_min <= 600 &&
    r.aviso_empleado_repetir_min >= 1 &&
    r.aviso_empleado_repetir_min <= 600 &&
    r.ubicaciones.every((u) => u.nombre.trim() && Number.isFinite(u.lat) && Number.isFinite(u.lon) && u.radio_m >= 10 && u.radio_m <= 5000);

  function agregarSede(lat: number, lon: number) {
    set("ubicaciones", [...r.ubicaciones, { nombre: `Sede ${r.ubicaciones.length + 1}`, lat, lon, radio_m: 50 }]);
    setSel(r.ubicaciones.length);
  }

  function ubicacionActual() {
    if (!("geolocation" in navigator)) {
      toast.error("Este navegador no da ubicación");
      return;
    }
    setUbicando(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setUbicando(false);
        agregarSede(Number(p.coords.latitude.toFixed(6)), Number(p.coords.longitude.toFixed(6)));
        toast.success(`Ubicación agregada (precisión ±${Math.round(p.coords.accuracy)} m)`);
      },
      (e) => {
        setUbicando(false);
        toast.error("No se pudo obtener la ubicación", { description: e.message });
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function guardar() {
    setGuardando(true);
    const fila = {
      tenant_id: acceso.tenantId,
      nombre: r.nombre.trim(),
      alcance: r.alcance,
      campaign_id: r.alcance === "campana" ? r.campaign_id : null,
      employee_id: r.alcance === "empleado" ? r.employee_id : null,
      activo: r.activo,
      modo: r.modo,
      ips,
      ubicaciones: r.ubicaciones,
      exigir_ubicacion: r.exigir_ubicacion,
      dispositivos: r.dispositivos,
      mismo_dispositivo_cierre: r.mismo_dispositivo_cierre,
      max_horas: r.max_horas,
      tolerancia_min: r.tolerancia_min,
      recordatorio_min: r.recordatorio_min,
      alarmas_activas: r.alarmas_activas,
      alertar_roles: r.alertar_roles,
      aviso_empleado_activo: r.aviso_empleado_activo,
      aviso_empleado_min: r.aviso_empleado_min,
      aviso_empleado_repetir_min: r.aviso_empleado_repetir_min,
      updated_at: new Date().toISOString(),
    };
    const consulta = r.id
      ? supabase.from("shift_policies" as never).update(fila as never).eq("id", r.id)
      : supabase.from("shift_policies" as never).insert(fila as never);
    const { error } = await consulta;
    setGuardando(false);
    if (error) {
      toast.error("No se pudo guardar la regla", {
        description: error.code === "23505" ? "Ya existe una regla para esa campaña o empleado: edítala." : error.message,
      });
      return;
    }
    toast.success("Regla guardada", { description: "Aplica desde el próximo inicio de turno." });
    onListo();
  }

  const casilla = (lista: string[], v: string, k: "dispositivos" | "alertar_roles") =>
    set(k, lista.includes(v) ? lista.filter((x) => x !== v) : [...lista, v]);

  return (
    <Dialog open onOpenChange={(v) => !v && !guardando && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{r.id ? "Editar regla de turno" : "Nueva regla de turno"}</DialogTitle>
          <DialogDescription>Define desde dónde, con qué equipo y por cuánto tiempo se puede tener el turno abierto.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Nombre</Label>
              <Input value={r.nombre} onChange={(e) => set("nombre", e.target.value)} placeholder="Ej: Sede principal · Claro" />
            </div>
            <div className="space-y-1.5">
              <Label>Aplica a</Label>
              <Select value={r.alcance} onValueChange={(v) => set("alcance", v as Regla["alcance"])} disabled={inicial.alcance === "empresa" && Boolean(inicial.id)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="empresa">Toda la empresa</SelectItem>
                  <SelectItem value="campana">Una campaña</SelectItem>
                  <SelectItem value="empleado">Un empleado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {r.alcance === "campana" ? (
              <div className="space-y-1.5">
                <Label>Campaña</Label>
                <Select value={r.campaign_id ?? ""} onValueChange={(v) => set("campaign_id", v)}>
                  <SelectTrigger><SelectValue placeholder="Elige la campaña" /></SelectTrigger>
                  <SelectContent>
                    {(campanas.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : r.alcance === "empleado" ? (
              <div className="space-y-1.5">
                <Label>Empleado</Label>
                <MultiSelectFilter
                  title="Empleado"
                  placeholder="Busca por nombre o cédula"
                  searchPlaceholder="Nombre o cédula…"
                  options={opcionesEmpleados}
                  selected={r.employee_id ? [r.employee_id] : []}
                  onChange={(v) => set("employee_id", v.at(-1) ?? null)}
                  popoverWidth="w-[340px]"
                  triggerClassName="w-full"
                />
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={r.activo} onCheckedChange={(v) => set("activo", v)} /> Regla activa
            </label>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              {(["bloquear", "alertar"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => set("modo", m)}
                  className={cn("flex-1 rounded-lg border p-3 text-left text-sm", r.modo === m && "border-primary bg-primary/5")}
                >
                  <p className="font-medium">{m === "bloquear" ? "Bloquear" : "Solo alertar"}</p>
                  <p className="text-xs text-muted-foreground">
                    {m === "bloquear"
                      ? "No deja iniciar ni finalizar fuera de la regla; el intento queda como alarma."
                      : "Deja iniciar y finalizar, pero genera una alarma si algo no cumple."}
                  </p>
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" /> Red, ubicación y equipo</p>
            <div className="space-y-1.5">
              <Label>IP autorizadas (una por línea; admite rangos como 181.57.0.0/16)</Label>
              <Textarea rows={3} value={ipsTexto} onChange={(e) => setIpsTexto(e.target.value)} placeholder="Vacío = cualquier IP" />
              {ipsMalas.length ? <p className="text-xs text-destructive">No son IP válidas: {ipsMalas.join(", ")}</p> : null}
              <p className="text-xs text-muted-foreground">La IP de cada inicio aparece en la pestaña «Registros» (columna «Equipo y red»).</p>
            </div>
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>Ubicaciones permitidas (sedes y su rango)</Label>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={ubicando} onClick={ubicacionActual}>
                    {ubicando ? <Loader2 className="size-4 animate-spin" /> : <LocateFixed className="size-4" />} Usar mi ubicación
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => agregarSede(4.6486, -74.0628)}>
                    <Plus className="size-4" /> Agregar sede
                  </Button>
                </div>
              </div>
              <MapaUbicaciones
                puntos={r.ubicaciones}
                seleccion={sel}
                onClicMapa={(lat, lon) =>
                  r.ubicaciones.length
                    ? set("ubicaciones", r.ubicaciones.map((x, j) => (j === sel ? { ...x, lat, lon } : x)))
                    : agregarSede(lat, lon)
                }
              />
              <p className="text-xs text-muted-foreground">
                Haz clic en el mapa para ubicar la sede seleccionada (en verde). Si la persona sale del rango durante el turno, se genera una alarma.
              </p>
              {r.ubicaciones.map((u, i) => (
                <div
                  key={i}
                  className={cn("space-y-2 rounded-md border p-2", i === sel ? "border-primary bg-primary/5" : "cursor-pointer")}
                  onClick={() => setSel(i)}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input className="h-8 max-w-56" value={u.nombre} onChange={(e) => set("ubicaciones", r.ubicaciones.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)))} placeholder="Nombre de la sede" />
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {u.lat.toFixed(5)}, {u.lon.toFixed(5)}
                    </span>
                    <a href={`https://www.google.com/maps?q=${u.lat},${u.lon}`} target="_blank" rel="noreferrer" className="p-1 text-primary" title="Ver en Google Maps" onClick={(e) => e.stopPropagation()}>
                      <MapPin className="size-4" />
                    </a>
                    <button
                      type="button"
                      className="ml-auto p-1 text-destructive"
                      title="Quitar sede"
                      onClick={(e) => {
                        e.stopPropagation();
                        set("ubicaciones", r.ubicaciones.filter((_, j) => j !== i));
                        setSel(0);
                      }}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Rango:</span>
                    {[20, 30, 50, 100, 200].map((m) => (
                      <Button
                        key={m}
                        type="button"
                        size="sm"
                        variant={u.radio_m === m ? "default" : "outline"}
                        className="h-7 px-2 text-xs"
                        onClick={() => set("ubicaciones", r.ubicaciones.map((x, j) => (j === i ? { ...x, radio_m: m } : x)))}
                      >
                        {m} m
                      </Button>
                    ))}
                    <Input
                      className="h-7 w-20 text-xs"
                      inputMode="numeric"
                      value={u.radio_m}
                      title="Radio en metros"
                      onChange={(e) => set("ubicaciones", r.ubicaciones.map((x, j) => (j === i ? { ...x, radio_m: Number(e.target.value) } : x)))}
                    />
                    <span className="text-xs text-muted-foreground">metros</span>
                  </div>
                </div>
              ))}
              {!r.ubicaciones.length ? (
                <p className="text-xs text-muted-foreground">Sin sedes: se permite cualquier ubicación (pero siempre debe estar activa para iniciar turno).</p>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={r.exigir_ubicacion} onCheckedChange={(v) => set("exigir_ubicacion", v)} /> Exigir la ubicación también al finalizar (para iniciar siempre es obligatoria)
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Label>Dispositivos permitidos:</Label>
              {DISPOSITIVOS.map((d) => (
                <label key={d.v} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={r.dispositivos.includes(d.v)} onCheckedChange={() => casilla(r.dispositivos, d.v, "dispositivos")} /> {d.l}
                </label>
              ))}
              <span className="text-xs text-muted-foreground">(ninguno marcado = cualquiera)</span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={r.mismo_dispositivo_cierre} onCheckedChange={(v) => set("mismo_dispositivo_cierre", v)} />
              Finalizar solo desde el mismo equipo y navegador donde inició
            </label>
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium">Tiempo y alarmas</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Tiempo máximo (horas)</Label>
                <Input inputMode="decimal" value={r.max_horas} onChange={(e) => set("max_horas", Number(e.target.value.replace(",", ".")))} />
              </div>
              <div className="space-y-1.5">
                <Label>Tolerancia (min)</Label>
                <Input inputMode="numeric" value={r.tolerancia_min} onChange={(e) => set("tolerancia_min", Number(e.target.value))} />
              </div>
              <div className="space-y-1.5">
                <Label>Repetir alarma cada (min)</Label>
                <Input inputMode="numeric" value={r.recordatorio_min} onChange={(e) => set("recordatorio_min", Number(e.target.value))} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={r.alarmas_activas} onCheckedChange={(v) => set("alarmas_activas", v === true)} /> Generar alarmas cuando pase el tiempo
            </label>
            <div className="flex flex-wrap items-center gap-4">
              <Label>Avisar a:</Label>
              {ROLES.map((x) => (
                <label key={x.v} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={r.alertar_roles.includes(x.v)} onCheckedChange={() => casilla(r.alertar_roles, x.v, "alertar_roles")} /> {x.l}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Supervisores y coordinadores reciben las alarmas solo de sus campañas. Las alarmas se generan en el servidor aunque nadie tenga el tablero abierto.
            </p>
            <div className="space-y-2 rounded-lg border p-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={r.aviso_empleado_activo} onCheckedChange={(v) => set("aviso_empleado_activo", v)} />
                Avisar a la persona con una ventana emergente cuando pase su tiempo máximo
              </label>
              {r.aviso_empleado_activo ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Primer aviso: minutos después del máximo</Label>
                    <Input inputMode="numeric" value={r.aviso_empleado_min} onChange={(e) => set("aviso_empleado_min", Number(e.target.value))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Repetir el aviso cada (min)</Label>
                    <Input inputMode="numeric" value={r.aviso_empleado_repetir_min} onChange={(e) => set("aviso_empleado_repetir_min", Number(e.target.value))} />
                  </div>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                La ventana se repite hasta que finalice el turno. Si se autorizan horas extra, cuenta desde el fin de la extra. Si tiene la página en
                segundo plano, también le llega una notificación del sistema (si permitió notificaciones en el navegador).
              </p>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={guardando}>Cancelar</Button>
          <Button onClick={() => void guardar()} disabled={!valido || guardando}>
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null} Guardar regla
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
