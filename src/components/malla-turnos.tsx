import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { alfabetico } from "@/lib/filtro-personas";
import { recalcularAsistencia } from "@/lib/asistencia.functions";
import {
  NOVEDADES_MALLA,
  descargarPlantillaMalla,
  leerPlantillaMalla,
  type DiaPlantilla,
  type FilaMalla,
} from "@/lib/malla";
import {
  DIAS,
  corta,
  deIso,
  hora,
  hoy,
  lunesDe,
  rangoFechas,
  sumarDias,
  todas,
  type Empleado,
  type Programado,
  type Turno,
} from "@/lib/turnos";
import { ChipTurno } from "@/components/chip-turno";
import { HiloComentarios } from "@/components/comentarios-empleado";
import { HistorialCambios } from "@/components/historial-cambios";
import { Paginador } from "@/components/simple-table";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Resultado = {
  total?: number;
  validas?: number;
  personas?: number;
  con_horario?: number;
  novedades?: number;
  a_borrar?: number;
  horarios_nuevos?: number;
  guardados?: number;
  borrados?: number;
  horarios_creados?: number;
  desde?: string | null;
  hasta?: string | null;
  errores: {
    fila: number;
    documento: string | null;
    nombre: string | null;
    fecha: string | null;
    error: string;
  }[];
};

const DIA_CORTO = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const ORIGEN: Record<string, string> = {
  malla: "Programado en la malla",
  rotacion: "Viene de una rotación",
  fijo: "Viene de un horario fijo asignado",
};

async function guardarMalla(
  filas: FilaMalla[] | Record<string, unknown>[],
  soloValidar: boolean,
  origen: "manual" | "plantilla",
) {
  const { data, error } = await supabase.rpc(
    "guardar_malla" as never,
    { _filas: filas, _solo_validar: soloValidar, _origen: origen } as never,
  );
  if (error) throw new Error(error.message);
  return data as unknown as Resultado;
}

/** Recalcula la asistencia del tramo ya pasado (máximo 62 días) para que las tardanzas usen la malla nueva. */
function useRecalcularPasado() {
  const recalcular = useServerFn(recalcularAsistencia);
  return async (desde?: string | null, hasta?: string | null) => {
    const h = hoy();
    if (!desde || desde > h) return;
    const fin = hasta && hasta < h ? hasta : h;
    const ini = desde < sumarDias(fin, -62) ? sumarDias(fin, -62) : desde;
    try {
      await recalcular({ data: { desde: ini, hasta: fin } });
      toast.success("Asistencia recalculada con la malla", {
        description: `${corta(ini)} a ${corta(fin)}`,
      });
    } catch (e) {
      toast.warning("La malla quedó guardada, pero no se pudo recalcular la asistencia", {
        description: (e as Error).message,
      });
    }
  };
}

function CeldaDia({
  p,
  mapaTurnos,
}: {
  p: Programado | undefined;
  mapaTurnos: Map<string, Turno>;
}) {
  if (!p) return <span className="text-xs text-muted-foreground/60">—</span>;
  if (p.novedad) {
    return (
      <span
        className={cn(
          "inline-block max-w-[7.5rem] truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium",
          p.novedad === "DESCANSO"
            ? "bg-muted text-muted-foreground"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        )}
        title={p.novedad}
      >
        {p.novedad}
      </span>
    );
  }
  const t = p.shift_id ? mapaTurnos.get(p.shift_id) : undefined;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex flex-col items-start">
          <ChipTurno turno={t} compacto apagado={p.origen !== "malla"} />
          {!p.laborable ? (
            <span className="text-[10px] text-muted-foreground">día de descanso del horario</span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>{ORIGEN[p.origen]}</TooltipContent>
    </Tooltip>
  );
}

export function MallaTab({
  campana,
  mapaCampanas,
  mapaTurnos,
  turnos,
  puedeAsignar,
}: {
  campana: string | null;
  mapaCampanas: Map<string, string>;
  mapaTurnos: Map<string, Turno>;
  turnos: Turno[];
  puedeAsignar: boolean;
}) {
  const [inicio, setInicio] = useState(() => lunesDe(hoy()));
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(0);
  const [tamano, setTamano] = useState(20);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [celda, setCelda] = useState<{
    empleado: Empleado;
    fecha: string;
    actual: Programado | undefined;
  } | null>(null);
  const [programar, setProgramar] = useState(false);
  const [descargar, setDescargar] = useState(false);
  const [cargar, setCargar] = useState(false);

  // Solo personal activo: el inactivo no se programa
  const empleados = useQuery({
    queryKey: ["turnos", "personal-activo"],
    queryFn: () =>
      todas<Empleado>((a, b) =>
        supabase
          .from("employees")
          .select("id, document, full_name, position, campaign_id")
          .eq("status", "activo")
          .order("full_name")
          .range(a, b),
      ),
  });
  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return (empleados.data ?? [])
      .filter((e) => !campana || e.campaign_id === campana)
      .filter(
        (e) =>
          !q ||
          e.full_name.toLowerCase().includes(q) ||
          e.document.includes(q) ||
          (e.position ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => alfabetico(a.full_name, b.full_name));
  }, [empleados.data, campana, busqueda]);
  const visibles = filtrados.slice(pagina * tamano, (pagina + 1) * tamano);
  if (pagina > 0 && pagina * tamano >= filtrados.length) setPagina(0);
  const fechas = rangoFechas(inicio, sumarDias(inicio, 6));

  const programacion = useQuery({
    queryKey: ["turnos", "malla", inicio, visibles.map((e) => e.id).join(",")],
    enabled: visibles.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "turnos_programados" as never,
        { _fechas: fechas, _empleados: visibles.map((e) => e.id) } as never,
      );
      if (error) throw error;
      const mapa = new Map<string, Programado>();
      for (const p of (data ?? []) as Programado[]) mapa.set(`${p.employee_id}|${p.fecha}`, p);
      return mapa;
    },
  });

  // Si todo el personal filtrado es de una campaña, la plantilla lleva su nombre
  const campanasFiltradas = [...new Set(filtrados.map((e) => e.campaign_id))];
  const tituloPlantilla =
    campanasFiltradas.length === 1 && campanasFiltradas[0]
      ? (mapaCampanas.get(campanasFiltradas[0]) ?? "Campaña")
      : "Todas las campañas";
  const seleccionados = (empleados.data ?? []).filter((e) => seleccion.has(e.id));
  const todosFiltrados = filtrados.length > 0 && filtrados.every((e) => seleccion.has(e.id));
  const h = hoy();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Buscar por nombre, cédula o cargo…"
          value={busqueda}
          onChange={(e) => {
            setBusqueda(e.target.value);
            setPagina(0);
          }}
        />
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setInicio(sumarDias(inicio, -7))}>
            ‹
          </Button>
          <Input
            type="date"
            className="h-8 w-40"
            value={inicio}
            onChange={(e) => e.target.value && setInicio(e.target.value)}
            aria-label="Primer día de la semana"
          />
          <Button variant="outline" size="sm" onClick={() => setInicio(sumarDias(inicio, 7))}>
            ›
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setInicio(lunesDe(hoy()))}>
            Esta semana
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDescargar(true)}>
            <Download className="size-4" /> Descargar plantilla
          </Button>
          {puedeAsignar ? (
            <Button variant="outline" onClick={() => setCargar(true)}>
              <Upload className="size-4" /> Cargar plantilla
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Cada día puede tener su propio horario o una novedad (descanso, vacaciones, incapacidad…).
        Lo programado en la malla manda sobre la rotación o el horario fijo (estos se ven con borde
        punteado). Solo aparece el personal <strong>activo</strong>; si falta alguien, solicítalo en{" "}
        <Link to="/empleados" className="text-primary underline">
          Empleados
        </Link>
        .
      </p>

      {puedeAsignar && seleccionados.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">{seleccionados.length} seleccionados</span>
          <Button size="sm" onClick={() => setProgramar(true)}>
            <CalendarRange className="size-4" /> Programar días
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setSeleccion(new Set())}
          >
            <X className="size-4" /> Quitar selección
          </Button>
        </div>
      ) : puedeAsignar ? (
        <p className="text-xs text-muted-foreground">
          Selecciona personas para programar varios días a la vez, o haz clic en un día para
          editarlo.
        </p>
      ) : null}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              {puedeAsignar ? (
                <th className="w-10 px-3 py-2">
                  <Checkbox
                    aria-label="Seleccionar todos los filtrados"
                    checked={todosFiltrados}
                    onCheckedChange={(v) =>
                      setSeleccion(v ? new Set(filtrados.map((e) => e.id)) : new Set())
                    }
                  />
                </th>
              ) : null}
              <th className="min-w-56 px-3 py-2">Persona</th>
              {fechas.map((f) => {
                const d = deIso(f).getDay();
                return (
                  <th
                    key={f}
                    className={cn(
                      "whitespace-nowrap px-2 py-2 text-center",
                      d === 0 && "bg-amber-500/10",
                      f === h && "text-primary",
                    )}
                  >
                    {DIA_CORTO[d]} {corta(f)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {empleados.isLoading ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline size-4 animate-spin" />
                  Cargando personal…
                </td>
              </tr>
            ) : visibles.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  No hay personal activo con estos filtros.
                </td>
              </tr>
            ) : (
              visibles.map((e) => (
                <tr key={e.id} className="border-t">
                  {puedeAsignar ? (
                    <td className="px-3 py-2">
                      <Checkbox
                        aria-label={`Seleccionar a ${e.full_name}`}
                        checked={seleccion.has(e.id)}
                        onCheckedChange={(v) =>
                          setSeleccion((prev) => {
                            const n = new Set(prev);
                            if (v) n.add(e.id);
                            else n.delete(e.id);
                            return n;
                          })
                        }
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2">
                    <p className="font-medium leading-tight">{e.full_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.document} ·{" "}
                      {e.campaign_id ? (mapaCampanas.get(e.campaign_id) ?? "—") : "Sin campaña"}
                    </p>
                  </td>
                  {fechas.map((f) => {
                    const p = programacion.data?.get(`${e.id}|${f}`);
                    return (
                      <td
                        key={f}
                        className={cn(
                          "px-1 py-1 text-center",
                          deIso(f).getDay() === 0 && "bg-amber-500/5",
                        )}
                      >
                        {programacion.isLoading ? (
                          <span className="text-xs text-muted-foreground">…</span>
                        ) : puedeAsignar ? (
                          <button
                            type="button"
                            aria-label={`Editar ${e.full_name} ${f}`}
                            onClick={() => setCelda({ empleado: e, fecha: f, actual: p })}
                            className="w-full rounded-md px-1 py-1 hover:bg-muted"
                          >
                            <CeldaDia p={p} mapaTurnos={mapaTurnos} />
                          </button>
                        ) : (
                          <CeldaDia p={p} mapaTurnos={mapaTurnos} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
      <Paginador
        pagina={pagina}
        tamano={tamano}
        total={filtrados.length}
        onCambio={setPagina}
        onTamano={setTamano}
      />

      <CeldaDialog
        celda={celda}
        onClose={() => setCelda(null)}
        mapaTurnos={mapaTurnos}
        turnos={turnos}
      />
      <ProgramarDiasDialog
        abierta={programar}
        onClose={() => setProgramar(false)}
        personas={seleccionados}
        turnos={turnos}
        inicio={inicio}
        onListo={() => {
          setSeleccion(new Set());
          setProgramar(false);
        }}
      />
      <DescargarDialog
        abierta={descargar}
        onClose={() => setDescargar(false)}
        personas={filtrados}
        inicio={inicio}
        mapaTurnos={mapaTurnos}
        mapaCampanas={mapaCampanas}
        titulo={tituloPlantilla}
      />
      <CargarDialog abierta={cargar} onClose={() => setCargar(false)} />
    </div>
  );
}

/* ---------------- Editor de horario (ingreso/salida o novedad) ---------------- */

function EditorHorario({
  modo,
  setModo,
  ingreso,
  setIngreso,
  salida,
  setSalida,
  novedad,
  setNovedad,
  turnos,
  permitirQuitar,
}: {
  modo: "horario" | "novedad" | "quitar";
  setModo: (m: "horario" | "novedad" | "quitar") => void;
  ingreso: string;
  setIngreso: (v: string) => void;
  salida: string;
  setSalida: (v: string) => void;
  novedad: string;
  setNovedad: (v: string) => void;
  turnos: Turno[];
  permitirQuitar: boolean;
}) {
  const opciones: ["horario" | "novedad" | "quitar", string][] = [
    ["horario", "Horario"],
    ["novedad", "Novedad"],
    ...(permitirQuitar ? [["quitar", "Quitar"] as ["quitar", string]] : []),
  ];
  // Horarios ya usados en la campaña, sin repetir horas
  const atajos = [
    ...new Map(turnos.map((t) => [`${hora(t.start_time)}-${hora(t.end_time)}`, t])).values(),
  ]
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
    .slice(0, 12);
  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {opciones.map(([m, t]) => (
          <button
            key={m}
            type="button"
            onClick={() => setModo(m)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm",
              modo === m ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {modo === "horario" ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="m-ini">Ingreso</Label>
              <Input
                id="m-ini"
                type="time"
                value={ingreso}
                onChange={(e) => setIngreso(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-fin">Salida</Label>
              <Input
                id="m-fin"
                type="time"
                value={salida}
                onChange={(e) => setSalida(e.target.value)}
              />
            </div>
          </div>
          {ingreso && salida && salida < ingreso ? (
            <p className="text-xs text-muted-foreground">
              Turno nocturno: termina al día siguiente.
            </p>
          ) : null}
          {atajos.length ? (
            <div className="flex flex-wrap gap-1.5">
              {atajos.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setIngreso(hora(t.start_time));
                    setSalida(hora(t.end_time));
                  }}
                  className="rounded-full border px-2 py-0.5 text-xs hover:border-primary hover:text-primary"
                >
                  {hora(t.start_time)}–{hora(t.end_time)}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : modo === "novedad" ? (
        <Select value={novedad} onValueChange={setNovedad}>
          <SelectTrigger>
            <SelectValue placeholder="Elige la novedad" />
          </SelectTrigger>
          <SelectContent>
            {NOVEDADES_MALLA.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
          Se quita lo programado en la malla; si la persona tiene una rotación u horario fijo,
          vuelve a aplicar ese.
        </p>
      )}
    </div>
  );
}

function CeldaDialog({
  celda,
  onClose,
  mapaTurnos,
  turnos,
}: {
  celda: { empleado: Empleado; fecha: string; actual: Programado | undefined } | null;
  onClose: () => void;
  mapaTurnos: Map<string, Turno>;
  turnos: Turno[];
}) {
  const qc = useQueryClient();
  const recalcular = useRecalcularPasado();
  const [modo, setModo] = useState<"horario" | "novedad" | "quitar">("horario");
  const [ingreso, setIngreso] = useState("");
  const [salida, setSalida] = useState("");
  const [novedad, setNovedad] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [abiertaPara, setAbiertaPara] = useState<typeof celda>(null);
  if (celda !== abiertaPara) {
    setAbiertaPara(celda);
    const t = celda?.actual?.shift_id ? mapaTurnos.get(celda.actual.shift_id) : undefined;
    setModo(celda?.actual?.novedad ? "novedad" : "horario");
    setIngreso(t ? hora(t.start_time) : "");
    setSalida(t ? hora(t.end_time) : "");
    setNovedad(celda?.actual?.novedad ?? "");
  }
  if (!celda) return null;
  const deCampana = turnos.filter(
    (t) =>
      t.status === "activo" &&
      (t.campaign_id === null || t.campaign_id === celda.empleado.campaign_id),
  );

  async function guardar() {
    if (!celda) return;
    const base = {
      fila: 1,
      documento: celda.empleado.document,
      employee_id: celda.empleado.id,
      fecha: celda.fecha,
    };
    const fila =
      modo === "quitar"
        ? { ...base, borrar: true }
        : modo === "novedad"
          ? { ...base, novedad }
          : { ...base, ingreso, salida };
    if (modo === "novedad" && !novedad) {
      toast.error("Elige la novedad");
      return;
    }
    if (modo === "horario" && (!ingreso || !salida)) {
      toast.error("Indica ingreso y salida");
      return;
    }
    setGuardando(true);
    try {
      const r = await guardarMalla([fila], false, "manual");
      if (r.errores.length) {
        toast.error(r.errores[0]!.error);
        return;
      }
      toast.success(modo === "quitar" ? "Día quitado de la malla" : "Día programado");
      void qc.invalidateQueries({ queryKey: ["turnos"] });
      await recalcular(celda.fecha, celda.fecha);
      onClose();
    } catch (e) {
      toast.error("No se pudo guardar", { description: (e as Error).message });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="leading-tight">{celda.empleado.full_name}</DialogTitle>
          <DialogDescription>
            {DIAS.find(([d]) => d === deIso(celda.fecha).getDay())?.[2]} {corta(celda.fecha)}
            {celda.actual && celda.actual.origen !== "malla"
              ? ` · hoy: ${ORIGEN[celda.actual.origen]?.toLowerCase()}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <EditorHorario
          modo={modo}
          setModo={setModo}
          ingreso={ingreso}
          setIngreso={setIngreso}
          salida={salida}
          setSalida={setSalida}
          novedad={novedad}
          setNovedad={setNovedad}
          turnos={deCampana}
          permitirQuitar={celda.actual?.origen === "malla"}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void guardar()} disabled={guardando}>
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null} Guardar
          </Button>
        </DialogFooter>
        <div className="border-t pt-3">
          <p className="mb-2 text-sm font-medium">Comentarios y evidencias de este día</p>
          <HiloComentarios
            empleadoId={celda.empleado.id}
            fecha={celda.fecha}
            contexto="malla"
            compacto
            soloDelDia
          />
        </div>
        <div className="border-t pt-3">
          <HistorialCambios
            tabla="shift_schedule"
            clave={{ employee_id: celda.empleado.id, fecha: celda.fecha }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Programar varios días a varias personas ---------------- */

function ProgramarDiasDialog({
  abierta,
  onClose,
  personas,
  turnos,
  inicio,
  onListo,
}: {
  abierta: boolean;
  onClose: () => void;
  personas: Empleado[];
  turnos: Turno[];
  inicio: string;
  onListo: () => void;
}) {
  const qc = useQueryClient();
  const recalcular = useRecalcularPasado();
  const [desde, setDesde] = useState(inicio);
  const [hasta, setHasta] = useState(sumarDias(inicio, 5));
  const [dias, setDias] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [modo, setModo] = useState<"horario" | "novedad" | "quitar">("horario");
  const [ingreso, setIngreso] = useState("");
  const [salida, setSalida] = useState("");
  const [novedad, setNovedad] = useState("");
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [abiertaAntes, setAbiertaAntes] = useState(false);
  if (abierta !== abiertaAntes) {
    setAbiertaAntes(abierta);
    if (abierta) {
      setDesde(inicio);
      setHasta(sumarDias(inicio, 5));
    }
  }

  const fechas =
    desde && hasta && hasta >= desde
      ? rangoFechas(desde, hasta).filter((f) => dias.includes(deIso(f).getDay()))
      : [];
  const campanasSel = new Set(personas.map((p) => p.campaign_id));
  const deCampanas = turnos.filter(
    (t) => t.status === "activo" && (t.campaign_id === null || campanasSel.has(t.campaign_id)),
  );
  const total = fechas.length * personas.length;

  async function guardar() {
    if (!fechas.length) {
      toast.error("No hay días en el rango con los días de la semana elegidos");
      return;
    }
    if (modo === "horario" && (!ingreso || !salida)) {
      toast.error("Indica ingreso y salida");
      return;
    }
    if (modo === "novedad" && !novedad) {
      toast.error("Elige la novedad");
      return;
    }
    if (total > 25000) {
      toast.error("Máximo 25.000 días por vez; reduce el rango o las personas");
      return;
    }
    const filas = personas.flatMap((p, i) =>
      fechas.map((f) => ({
        fila: i + 1,
        documento: p.document,
        employee_id: p.id,
        fecha: f,
        nota: nota || null,
        ...(modo === "quitar"
          ? { borrar: true }
          : modo === "novedad"
            ? { novedad }
            : { ingreso, salida }),
      })),
    );
    setGuardando(true);
    try {
      const r = await guardarMalla(filas, false, "manual");
      const n = modo === "quitar" ? (r.borrados ?? 0) : (r.guardados ?? 0);
      toast.success(
        modo === "quitar" ? `${n} días quitados de la malla` : `${n} días programados`,
        {
          description: r.horarios_creados
            ? `Se creó ${r.horarios_creados} horario nuevo en el catálogo de la campaña.`
            : undefined,
        },
      );
      if (r.errores.length)
        toast.warning(`${r.errores.length} días no se pudieron programar`, {
          description: r.errores
            .slice(0, 3)
            .map((e) => `${e.nombre ?? e.documento}: ${e.error}`)
            .join(" · "),
        });
      void qc.invalidateQueries({ queryKey: ["turnos"] });
      await recalcular(fechas[0], fechas[fechas.length - 1]);
      setNota("");
      onListo();
    } catch (e) {
      toast.error("No se pudo programar", { description: (e as Error).message });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Programar días · {personas.length} {personas.length === 1 ? "persona" : "personas"}
          </DialogTitle>
          <DialogDescription>
            Ej.: del lunes 5 al sábado 10 de octubre de 07:00 a 14:00; la semana siguiente, otro
            rango de 14:00 a 21:00.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex max-h-16 flex-wrap gap-1 overflow-auto">
            {personas.map((p) => (
              <Badge key={p.id} variant="secondary" className="font-normal">
                {p.full_name}
              </Badge>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="p-desde">Desde</Label>
              <Input
                id="p-desde"
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-hasta">Hasta</Label>
              <Input
                id="p-hasta"
                type="date"
                value={hasta}
                min={desde}
                onChange={(e) => setHasta(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Días de la semana</Label>
            <div className="flex flex-wrap items-center gap-1">
              {DIAS.map(([d, l, n]) => (
                <button
                  key={d}
                  type="button"
                  title={n}
                  aria-pressed={dias.includes(d)}
                  onClick={() =>
                    setDias(dias.includes(d) ? dias.filter((x) => x !== d) : [...dias, d])
                  }
                  className={cn(
                    "size-9 rounded-md border text-sm font-medium",
                    dias.includes(d)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {l}
                </button>
              ))}
              <button
                type="button"
                className="ml-2 text-xs text-muted-foreground underline"
                onClick={() => setDias([0, 1, 2, 3, 4, 5, 6])}
              >
                todos
              </button>
            </div>
          </div>
          <EditorHorario
            modo={modo}
            setModo={setModo}
            ingreso={ingreso}
            setIngreso={setIngreso}
            salida={salida}
            setSalida={setSalida}
            novedad={novedad}
            setNovedad={setNovedad}
            turnos={deCampanas}
            permitirQuitar
          />
          <div className="space-y-1.5">
            <Label htmlFor="p-nota">Observación (opcional)</Label>
            <Textarea id="p-nota" rows={2} value={nota} onChange={(e) => setNota(e.target.value)} />
          </div>
          <p className="rounded-md bg-muted/50 p-2 text-xs">
            {personas.length} {personas.length === 1 ? "persona" : "personas"} × {fechas.length}{" "}
            {fechas.length === 1 ? "día" : "días"} ={" "}
            <strong>{total.toLocaleString("es-CO")}</strong> días
            {fechas.length ? ` (${corta(fechas[0]!)} a ${corta(fechas[fechas.length - 1]!)})` : ""}.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void guardar()} disabled={guardando || !total}>
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null}{" "}
            {modo === "quitar" ? "Quitar" : "Programar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Descargar plantilla ---------------- */

function DescargarDialog({
  abierta,
  onClose,
  personas,
  inicio,
  mapaTurnos,
  mapaCampanas,
  titulo,
}: {
  abierta: boolean;
  onClose: () => void;
  personas: Empleado[];
  inicio: string;
  mapaTurnos: Map<string, Turno>;
  mapaCampanas: Map<string, string>;
  titulo: string;
}) {
  const [desde, setDesde] = useState(inicio);
  const [hasta, setHasta] = useState(sumarDias(inicio, 6));
  const [generando, setGenerando] = useState(false);
  const [abiertaAntes, setAbiertaAntes] = useState(false);
  if (abierta !== abiertaAntes) {
    setAbiertaAntes(abierta);
    if (abierta) {
      setDesde(inicio);
      setHasta(sumarDias(inicio, 6));
    }
  }
  const dias = desde && hasta && hasta >= desde ? rangoFechas(desde, hasta).length : 0;

  async function generar() {
    if (!dias || dias > 62) {
      toast.error("Elige un rango de 1 a 62 días");
      return;
    }
    if (!personas.length) {
      toast.error("No hay personal activo con los filtros actuales");
      return;
    }
    setGenerando(true);
    try {
      const fechas = rangoFechas(desde, hasta);
      const prog = new Map<string, Programado>();
      for (let i = 0; i < personas.length; i += 150) {
        const lote = personas.slice(i, i + 150);
        const { data, error } = await supabase.rpc(
          "turnos_programados" as never,
          { _fechas: fechas, _empleados: lote.map((e) => e.id) } as never,
        );
        if (error) throw error;
        for (const p of (data ?? []) as Programado[]) prog.set(`${p.employee_id}|${p.fecha}`, p);
      }
      const idPorDoc = new Map(personas.map((p) => [p.document, p.id]));
      const ordenadas = [...personas].sort(
        (a, b) =>
          alfabetico(
            mapaCampanas.get(a.campaign_id ?? "") ?? "",
            mapaCampanas.get(b.campaign_id ?? "") ?? "",
          ) || alfabetico(a.full_name, b.full_name),
      );
      await descargarPlantillaMalla({
        titulo,
        fechas,
        personas: ordenadas.map((p) => ({
          document: p.document,
          full_name: p.full_name,
          position: p.position,
          campana: p.campaign_id ? (mapaCampanas.get(p.campaign_id) ?? null) : null,
        })),
        valor: (doc, f): DiaPlantilla => {
          const p = prog.get(`${idPorDoc.get(doc)}|${f}`);
          if (!p) return null;
          if (p.novedad) return { novedad: p.novedad };
          const t = p.shift_id ? mapaTurnos.get(p.shift_id) : undefined;
          if (!t) return null;
          return p.laborable
            ? { ingreso: hora(t.start_time), salida: hora(t.end_time) }
            : { novedad: "DESCANSO" };
        },
      });
      toast.success("Plantilla descargada", {
        description:
          "Uso interno de Convertia: no la compartas con personas ajenas a la organización.",
      });
      onClose();
    } catch (e) {
      toast.error("No se pudo generar la plantilla", { description: (e as Error).message });
    } finally {
      setGenerando(false);
    }
  }

  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Descargar plantilla de malla</DialogTitle>
          <DialogDescription>
            Excel con el personal activo de «{titulo}» ({personas.length}), lo que ya está
            programado y listas desplegables de horas y novedades.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="d-desde">Desde</Label>
            <Input
              id="d-desde"
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-hasta">Hasta</Label>
            <Input
              id="d-hasta"
              type="date"
              value={hasta}
              min={desde}
              onChange={(e) => setHasta(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["1 semana", 6],
              ["2 semanas", 13],
              ["Quincena", 14],
              ["Mes", 30],
            ] as [string, number][]
          ).map(([t, n]) => (
            <button
              key={t}
              type="button"
              onClick={() => setHasta(sumarDias(desde, n))}
              className="rounded-full border px-2 py-0.5 text-xs hover:border-primary hover:text-primary"
            >
              {t}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {dias} días · máximo 62. Para otra campaña, cámbiala en el filtro de arriba.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void generar()} disabled={generando}>
            {generando ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="size-4" />
            )}{" "}
            Descargar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Cargar plantilla ---------------- */

function CargarDialog({ abierta, onClose }: { abierta: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const recalcular = useRecalcularPasado();
  const [archivo, setArchivo] = useState<File | null>(null);
  const [filas, setFilas] = useState<FilaMalla[]>([]);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [revision, setRevision] = useState<Resultado | null>(null);
  const [trabajando, setTrabajando] = useState<"" | "leyendo" | "guardando">("");

  const reiniciar = () => {
    setArchivo(null);
    setFilas([]);
    setAvisos([]);
    setRevision(null);
  };
  const cerrar = () => {
    reiniciar();
    onClose();
  };

  async function leer(f: File) {
    reiniciar();
    setArchivo(f);
    setTrabajando("leyendo");
    try {
      const r = await leerPlantillaMalla(f);
      setFilas(r.filas);
      setAvisos(r.avisos);
      if (r.filas.length) setRevision(await guardarMalla(r.filas, true, "plantilla"));
    } catch (e) {
      toast.error("No se pudo leer el archivo", { description: (e as Error).message });
    } finally {
      setTrabajando("");
    }
  }

  async function guardar() {
    setTrabajando("guardando");
    try {
      const r = await guardarMalla(filas, false, "plantilla");
      toast.success(`Malla cargada: ${r.guardados ?? 0} días de ${r.personas ?? 0} personas`, {
        description:
          [
            r.borrados ? `${r.borrados} días quitados` : "",
            r.horarios_creados ? `${r.horarios_creados} horarios nuevos en el catálogo` : "",
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      });
      void qc.invalidateQueries({ queryKey: ["turnos"] });
      await recalcular(r.desde, r.hasta);
      cerrar();
    } catch (e) {
      toast.error("No se pudo cargar la malla", { description: (e as Error).message });
    } finally {
      setTrabajando("");
    }
  }

  const errores = revision?.errores ?? [];
  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && cerrar()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cargar plantilla de malla</DialogTitle>
          <DialogDescription>
            Sube la plantilla descargada de aquí o el «Formato de mallas» de la campaña. Antes de
            guardar verás qué se va a cargar y qué filas tienen errores.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm hover:border-primary">
            <FileSpreadsheet className="size-8 text-muted-foreground" />
            {archivo ? (
              <span className="font-medium">{archivo.name}</span>
            ) : (
              <span>Elige el archivo de Excel (.xlsx)</span>
            )}
            <span className="text-xs text-muted-foreground">
              Columnas: CC, NOMBRE y por cada día INGRESO / SALIDA (o una novedad)
            </span>
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void leer(f);
              }}
            />
          </label>
          {trabajando === "leyendo" ? (
            <p className="text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" />
              Revisando la plantilla…
            </p>
          ) : null}
          {avisos.map((a, i) => (
            <p
              key={i}
              className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {a}
            </p>
          ))}
          {archivo && !trabajando && !filas.length ? (
            <p className="text-sm text-destructive">
              No se encontraron días para cargar en el archivo.
            </p>
          ) : null}
          {revision ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ["Personas", revision.personas],
                    ["Días válidos", revision.validas],
                    ["Con novedad", revision.novedades],
                    ["Horarios nuevos", revision.horarios_nuevos],
                  ] as [string, number | undefined][]
                ).map(([t, v]) => (
                  <Card key={t} className="p-3">
                    <p className="text-xs text-muted-foreground">{t}</p>
                    <p className="text-xl font-semibold tabular-nums">
                      {(v ?? 0).toLocaleString("es-CO")}
                    </p>
                  </Card>
                ))}
              </div>
              {revision.desde ? (
                <p className="text-xs text-muted-foreground">
                  Rango: {corta(revision.desde)} a {corta(revision.hasta ?? revision.desde)}
                  {revision.a_borrar ? ` · ${revision.a_borrar} días a quitar (BORRAR)` : ""}.
                </p>
              ) : null}
              {errores.length ? (
                <div className="rounded-lg border border-destructive/40">
                  <p className="flex items-center gap-1.5 border-b bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive">
                    <AlertTriangle className="size-4" /> {errores.length}
                    {errores.length >= 500 ? "+" : ""}{" "}
                    {errores.length === 1 ? "día con error" : "días con errores"} (no se cargan)
                  </p>
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 text-left text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1">Fila</th>
                          <th className="px-2 py-1">Persona</th>
                          <th className="px-2 py-1">Fecha</th>
                          <th className="px-2 py-1">Motivo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {errores.map((e, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-1 tabular-nums">{e.fila}</td>
                            <td className="px-2 py-1">{e.nombre ?? e.documento}</td>
                            <td className="px-2 py-1 tabular-nums">
                              {e.fecha ? corta(e.fecha) : "—"}
                            </td>
                            <td className="px-2 py-1">{e.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="size-4" /> Todo está correcto.
                </p>
              )}
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={cerrar}>
            Cancelar
          </Button>
          <Button onClick={() => void guardar()} disabled={!revision?.validas || trabajando !== ""}>
            {trabajando === "guardando" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {revision?.validas
              ? ` Cargar ${revision.validas.toLocaleString("es-CO")} días`
              : " Cargar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
