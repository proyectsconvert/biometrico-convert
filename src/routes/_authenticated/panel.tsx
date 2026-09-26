import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  Activity,
  AlarmClock,
  ArrowDownRight,
  ArrowUpRight,
  CalendarCheck,
  CalendarX2,
  Clock3,
  Compass,
  Gauge as GaugeIcon,
  Info as InfoIcon,
  LayoutDashboard,
  Lightbulb,
  Minus,
  Moon,
  Search,
  Sun,
  TrendingUp,
  TriangleAlert,
  UserX,
  Users,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip as Ayudita, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Paginador, usePaginado } from "@/components/simple-table";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { useFiltroCampanaPersonas } from "@/lib/filtro-personas";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/panel")({
  head: () => ({ meta: [{ title: "Panel estratégico — Convert-IA" }] }),
  component: Panel,
});

type Kpis = {
  empleados_activos: number; empleados_con_marcacion: number; jornadas: number; completas: number; incompletas: number;
  sin_marcacion: number; horas_trabajadas: number; horas_esperadas: number; horas_extra: number; horas_nocturnas: number;
  horas_dominicales: number; minutos_tarde: number; llegadas_tarde: number; ajustes_manuales: number;
  jornadas_con_turno?: number; sin_empresa?: number; excluidos?: number; incluye_sin_empresa?: boolean;
  dias_laborales: number; personas_base: number; dias_posibles: number; ausencias: number; ausencias_justificadas: number;
  personas_ausentes: number; tasa_ausentismo: number | null;
};
type Campana = {
  campana: string; personas: number; jornadas: number; cumplimiento: number | null; horas_extra: number;
  horas_trabajadas: number; tarde: number; ausencias: number; tasa_ausentismo: number | null;
};
type BI = {
  kpis: Kpis;
  serie: { fecha: string; completas: number; incompletas: number; horas_extra: number; tarde: number; laboral: boolean; ausentes: number | null; ausentes_justificados: number | null }[];
  campanas: Campana[];
  semana: { dow: number; jornadas: number; incompletas: number; tarde: number; ausencias: number }[];
  horas_entrada: { hora: number; personas: number }[];
  top_tarde: { nombre: string; documento: string; campana: string; veces: number; minutos: number }[];
  top_extra: { nombre: string; documento: string; campana: string; horas: number; jornadas: number }[];
  top_ausentes: { nombre: string; documento: string; campana: string; dias: number; justificados: number; ultima: string; ultima_marca: string | null }[];
  motivos_ausencia: { motivo: string; total: number }[];
  novedades: { tipo: string; total: number }[];
  rango: { min: string | null; max: string | null };
};
type Mes = {
  mes: string; personas: number; jornadas: number; cumplimiento: number | null; horas_trabajadas: number; horas_extra: number;
  horas_nocturnas: number; pct_extra: number | null; llegadas_tarde: number; dias_laborales: number; ausencias: number; tasa_ausentismo: number | null;
};

// Colores por función: identidad fija por serie (nunca por posición)
const C_COMPLETA = "var(--chart-1)";
const C_INCOMPLETA = "var(--chart-2)";
const C_AUSENTE = "var(--chart-5)";
const C_JUSTIFICADA = "var(--chart-3)";
const C_EXTRA = "var(--chart-4)";
const TOOLTIP = { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" };
const EJE = { fontSize: 11, fill: "var(--muted-foreground)" };
const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const n = (v: number | null | undefined, d = 0) => (v ?? 0).toLocaleString("es-CO", { maximumFractionDigits: d });
const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
const diaCorto = (f: string) => f.slice(5).split("-").reverse().join("/");
const mesCorto = (f: string) => `${MESES[Number(f.slice(5, 7)) - 1]} ${f.slice(2, 4)}`;
const sumarDias = (f: string, dias: number) => iso(new Date(new Date(`${f}T12:00:00`).getTime() + dias * 864e5));

/** Qué es y cómo se mide cada gráfico, indicador y columna (se muestra en el ícono «i»). */
const AYUDA: Record<string, string> = {
  "Jornadas completas": "De los días en que una persona marcó, qué porcentaje tiene entrada y salida (2 o más marcaciones). Un día con una sola marcación queda incompleto porque falta la salida. Cálculo: jornadas completas ÷ días trabajados.",
  "Tasa de ausentismo": "Porcentaje de días laborales en que una persona no marcó. Cálculo: días sin marcación ÷ días en que cada persona debía venir. Cuenta los días laborales de Reglas de cálculo, sin festivos y con datos cargados, desde el ingreso de la persona y hasta su fecha de retiro.",
  Ausentismo: "Porcentaje de días laborales sin marcación (ver Tasa de ausentismo).",
  "Cobertura de horas": "Horas trabajadas frente a las horas esperadas según el turno o la jornada configurada. Más de 100% significa que se trabajó más de lo esperado.",
  Puntualidad: "Porcentaje de días trabajados sin llegada tarde. Llegada tarde = primera marcación después de la hora de entrada del turno más la tolerancia. Requiere turnos asignados.",
  "Personal con marcación": "Personas activas que marcaron al menos una vez en el periodo, sobre el total de activos del personal que cuenta en reportes.",
  "Tendencia diaria de jornadas": "Por cada día: personas con jornada completa (entrada y salida), incompleta (una sola marcación) y ausentes (día laboral sin marcación). Los ausentes solo se calculan en días laborales: domingos y festivos no se evalúan.",
  "Días-persona del periodo": "Cada persona en cada día laboral es un día-persona. Se reparte en jornada completa, incompleta o ausencia: muestra qué parte del tiempo esperado se cumplió.",
  "Hora de llegada": "Cuántas jornadas empezaron en cada hora del día, según la primera marcación. Muestra a qué hora llega realmente la gente.",
  "Novedades del periodo": "Novedades cargadas en el módulo Novedades (incapacidades, licencias, vacaciones…), sin contar las rechazadas.",
  "Desempeño por campaña": "Resumen del periodo por campaña. Haz clic en el título de una columna para ordenar y pasa el mouse por su «i» para ver qué mide.",
  "col:Personas": "Personas distintas que marcaron al menos una vez en el periodo.",
  "col:Días trabajados": "Días-persona con al menos una marcación: una persona que vino 20 días suma 20.",
  "col:Jornadas completas": "Porcentaje de los días trabajados con entrada y salida (2 o más marcaciones).",
  "col:Ausentismo": "Porcentaje de días laborales sin marcación de las personas de la campaña.",
  "col:Horas extra": "Horas trabajadas por encima de la jornada esperada.",
  "col:Llegadas tarde": "Días con la primera marcación después de la hora de entrada del turno más la tolerancia. Requiere turno asignado.",
  "Días sin marcación": "Total de días laborales en que alguna persona no marcó: una persona que faltó 3 días suma 3.",
  "Personas con ausencias": "Personas que faltaron al menos un día laboral en el periodo, sobre las que marcan en el periodo.",
  "Con novedad reportada": "Porcentaje de las ausencias que tienen una novedad cargada (incapacidad, licencia, vacaciones…). Las demás son ausencias sin justificar.",
  "Ausentes por día laboral": "Personas sin marcación en cada día laboral, separadas en con novedad (justificadas) y sin novedad.",
  "Motivos de ausencia": "Tipo de novedad reportada para cada día sin marcación. «Sin novedad reportada» significa que nadie la justificó.",
  "Ausencias por día de la semana": "Total de ausencias según el día de la semana. Si un día concentra muchas, revisa si realmente es laboral para esa población (Reglas de cálculo).",
  "Personas con más ausencias": "Todas las personas con ausencias, de más a menos días. El ícono de alerta indica que no marca hace más de 30 días: posible retiro sin registrar.",
  "Horas trabajadas": "Suma del tiempo trabajado de todas las jornadas: de la entrada a la salida, menos el descanso si está configurado descontarlo.",
  "Horas extra": "Tiempo trabajado por encima de la jornada esperada de cada día, según Reglas de cálculo.",
  "Horas nocturnas": "Horas trabajadas dentro de la franja nocturna configurada (por defecto 21:00 a 06:00).",
  "Dominicales / festivos": "Horas trabajadas en domingo o festivo nacional.",
  "Horas perdidas por tarde": "Suma del tiempo de llegada tarde, en horas. Requiere turnos asignados.",
  "Personas con horas extra": "Personas con al menos una hora extra en el periodo, y qué parte de la extra total concentra el 20% que más tiene.",
  "Horas extra por día": "Total de horas extra registradas cada día.",
  "Mayor número de horas extra": "Todas las personas con horas extra, de mayor a menor. Usa el buscador y la paginación para recorrerlas.",
  "Mayor tiempo de llegada tarde": "Personas ordenadas por el tiempo total de llegada tarde. Requiere turnos asignados.",
  "Periodo actual vs. anterior": "Compara el periodo elegido con el inmediatamente anterior de la misma duración. Verde = mejoró; rojo = empeoró.",
  "Horas extra / trabajadas": "Horas extra como porcentaje de las horas trabajadas: mide el sobrecosto relativo.",
  "Horas extra sobre trabajadas": "Horas extra como porcentaje de las horas trabajadas, mes a mes.",
  "Horas nocturnas / trabajadas": "Horas nocturnas como porcentaje de las horas trabajadas.",
  "Horas por persona": "Horas trabajadas en promedio por cada persona que marcó.",
  "Personas que marcan": "Personas distintas con al menos una marcación en el periodo.",
  "Matriz de riesgo por campaña": "Cada burbuja es una campaña: horizontal = ausentismo, vertical = horas extra sobre trabajadas, tamaño = personas. Las líneas punteadas son el promedio. Arriba a la derecha: se cubren faltas con horas extra (sobrecosto).",
};

const PRESETS = [
  { id: "7", label: "7 días" },
  { id: "30", label: "30 días" },
  { id: "90", label: "90 días" },
  { id: "mes", label: "Este mes" },
];

function Panel() {
  const acceso = useAccess();
  const [hasta, setHasta] = useState(iso(new Date()));
  const [desde, setDesde] = useState(iso(new Date(Date.now() - 29 * 864e5)));
  const [campanasSel, setCampanasSel] = useState<string[]>([]);
  const [personasSel, setPersonasSel] = useState<string[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [anclado, setAnclado] = useState(false);
  const [pestana, setPestana] = useState("resumen");

  const campanas = useQuery({
    queryKey: ["campanas-simple"],
    queryFn: async () => {
      const { data } = await supabase.from("campaigns").select("id, name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const todasCampanas = useMemo(() => (campanas.data ?? []).map((c) => ({ value: c.id, label: c.name })), [campanas.data]);
  // Campañas y personas coherentes entre sí y en orden alfabético
  const { opcionesCampanas, opcionesPersonas, placeholderCampanas, placeholderPersonas } = useFiltroCampanaPersonas({
    opcionesCampanas: todasCampanas, campanas: campanasSel, personas: personasSel, alCambiarPersonas: setPersonasSel, valor: "id",
  });

  const filtros = {
    _campaigns: campanasSel.length ? campanasSel : null,
    _employees: personasSel.length ? personasSel : null,
    _search: busqueda.trim() || null,
  };
  const cargarBI = async (d: string, h: string) => {
    const { data, error } = await supabase.rpc("panel_bi" as never, { _desde: d, _hasta: h, _cost_centers: null, ...filtros } as never);
    if (error) throw error;
    return data as unknown as BI;
  };

  const bi = useQuery({
    queryKey: ["panel-bi", desde, hasta, campanasSel, personasSel, busqueda],
    placeholderData: keepPreviousData,
    queryFn: () => cargarBI(desde, hasta),
  });

  // Periodo anterior de la misma duración (comparativo del tablero estratégico)
  const duracion = Math.max(1, Math.round((Date.parse(hasta) - Date.parse(desde)) / 864e5) + 1);
  const antHasta = sumarDias(desde, -1);
  const antDesde = sumarDias(antHasta, -(duracion - 1));
  const anterior = useQuery({
    queryKey: ["panel-bi", antDesde, antHasta, campanasSel, personasSel, busqueda],
    enabled: pestana === "estrategico",
    placeholderData: keepPreviousData,
    queryFn: () => cargarBI(antDesde, antHasta),
  });
  const tendencia = useQuery({
    queryKey: ["panel-tendencia", hasta, campanasSel, personasSel, busqueda],
    enabled: pestana === "estrategico",
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("panel_tendencia" as never, { _hasta: hasta, _meses: 12, ...filtros } as never);
      if (error) throw error;
      return (data ?? []) as unknown as Mes[];
    },
  });

  // Si no hay datos en el rango por defecto, saltar al último periodo con datos
  const d = bi.data;
  useEffect(() => {
    if (!d || anclado) return;
    setAnclado(true);
    if (!d.kpis.jornadas && d.rango.max) {
      setHasta(d.rango.max);
      setDesde(sumarDias(d.rango.max, -29));
    }
  }, [d, anclado]);

  const aplicarPreset = (id: string) => {
    const base = d?.rango.max && d.rango.max < iso(new Date()) ? d.rango.max : iso(new Date());
    if (id === "mes") {
      setDesde(`${base.slice(0, 8)}01`);
      setHasta(base);
    } else {
      setHasta(base);
      setDesde(sumarDias(base, -(Number(id) - 1)));
    }
  };
  const limpiarFiltros = () => {
    setCampanasSel([]);
    setPersonasSel([]);
    setBusqueda("");
  };
  const hayFiltros = campanasSel.length > 0 || personasSel.length > 0 || Boolean(busqueda.trim());
  const cargando = bi.isLoading;
  const k = d?.kpis;

  return (
    <div className="space-y-5">
      {/* Encabezado y filtros: una sola fila de controles sobre todos los tableros */}
      <div className="relative overflow-hidden rounded-2xl bg-sidebar p-5 text-sidebar-foreground md:p-6">
        <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-brand-gradient opacity-25 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-sidebar-foreground/60">Panel estratégico</p>
            <h1 className="font-display text-2xl font-semibold md:text-3xl">
              Hola, {acceso.fullName.split(" ")[0]}. <span className="text-brand-gradient">Así va tu operación.</span>
            </h1>
            <p className="mt-1 text-sm text-sidebar-foreground/60">
              {acceso.tenantName ?? "Plataforma"} · {desde} → {hasta}
              {d?.rango.max ? ` · último dato ${d.rango.max}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((p) => (
              <Button key={p.id} size="sm" variant="ghost" className="h-8 text-xs text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" onClick={() => aplicarPreset(p.id)}>
                {p.label}
              </Button>
            ))}
            <Input type="date" aria-label="Desde" value={desde} onChange={(e) => setDesde(e.target.value)} className="h-8 w-36 border-sidebar-border bg-sidebar-accent/40 text-xs text-sidebar-foreground" />
            <Input type="date" aria-label="Hasta" value={hasta} onChange={(e) => setHasta(e.target.value)} className="h-8 w-36 border-sidebar-border bg-sidebar-accent/40 text-xs text-sidebar-foreground" />
          </div>
        </div>
        <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-sidebar-border/40 pt-4">
          <MultiSelectFilter
            title="Campañas" placeholder={placeholderCampanas} searchPlaceholder="Buscar campaña…"
            options={opcionesCampanas} selected={campanasSel} onChange={setCampanasSel}
            triggerClassName="h-8 min-w-[170px] border-sidebar-border bg-sidebar-accent/40 text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          />
          <MultiSelectFilter
            title="Personas" placeholder={placeholderPersonas} searchPlaceholder="Buscar por cédula o nombre…"
            options={opcionesPersonas} selected={personasSel} onChange={setPersonasSel} popoverWidth="w-[340px]"
            triggerClassName="h-8 min-w-[180px] border-sidebar-border bg-sidebar-accent/40 text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          />
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-foreground/50" />
            <Input
              placeholder="Búsqueda libre (cédula, nombre, cargo)…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
              className="h-8 border-sidebar-border bg-sidebar-accent/40 pl-8 text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/40"
            />
          </div>
          {hayFiltros ? (
            <Button type="button" size="sm" variant="ghost" onClick={limpiarFiltros} className="h-8 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
              <X className="mr-1 size-3.5" /> Limpiar
            </Button>
          ) : null}
        </div>
      </div>

      {k && (k.sin_empresa || k.excluidos) ? (
        <Card className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
          <Users className="size-4 text-accent" />
          {k.excluidos ? <span><strong className="tabular-nums">{n(k.excluidos)}</strong> personas de otros empleadores (seguridad, aseo…) están excluidas.</span> : null}
          {k.sin_empresa ? (
            <span><strong className="tabular-nums">{n(k.sin_empresa)}</strong> activos sin empleador {k.incluye_sin_empresa === false ? "no se incluyen" : "se están incluyendo"}.</span>
          ) : null}
          <Link to="/empleados" className="ml-auto text-primary underline">Clasificar personal</Link>
        </Card>
      ) : null}

      <Tabs value={pestana} onValueChange={setPestana}>
        <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
          <TabsTrigger value="resumen" className="gap-1.5"><LayoutDashboard className="size-4" />Resumen</TabsTrigger>
          <TabsTrigger value="ausentismo" className="gap-1.5"><CalendarX2 className="size-4" />Ausentismo</TabsTrigger>
          <TabsTrigger value="horas" className="gap-1.5"><Clock3 className="size-4" />Horas y costos</TabsTrigger>
          <TabsTrigger value="estrategico" className="gap-1.5"><Compass className="size-4" />Estratégico</TabsTrigger>
        </TabsList>

        <TabsContent value="resumen" className="mt-4 space-y-4">
          <Resumen d={d} cargando={cargando} alVerAusentismo={() => setPestana("ausentismo")} />
        </TabsContent>
        <TabsContent value="ausentismo" className="mt-4 space-y-4">
          <Ausentismo d={d} cargando={cargando} />
        </TabsContent>
        <TabsContent value="horas" className="mt-4 space-y-4">
          <HorasCostos d={d} cargando={cargando} />
        </TabsContent>
        <TabsContent value="estrategico" className="mt-4 space-y-4">
          <Estrategico d={d} anterior={anterior.data} meses={tendencia.data ?? []} cargando={cargando || anterior.isLoading} cargandoMeses={tendencia.isLoading} periodoAnterior={`${antDesde} → ${antHasta}`} />
        </TabsContent>
      </Tabs>

      {bi.isFetching && !bi.isLoading ? <p className="text-center text-xs text-muted-foreground">Actualizando…</p> : null}
      {bi.error ? <p className="text-center text-sm text-destructive">{(bi.error as Error).message}</p> : null}
      <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground"><CalendarCheck className="size-3" /> Los datos respetan tu alcance (campañas asignadas) y solo incluyen al personal de empleadores que cuentan en reportes.</p>
    </div>
  );
}

// ───────────── Resumen ─────────────

function Resumen({ d, cargando, alVerAusentismo }: { d: BI | undefined; cargando: boolean; alVerAusentismo: () => void }) {
  const k = d?.kpis;
  const cumplimiento = k ? pct(k.completas, k.jornadas) : 0;
  const cobertura = k ? pct(k.horas_trabajadas, k.horas_esperadas) : 0;
  const puntualidad = k ? 100 - pct(k.llegadas_tarde, k.jornadas) : 0;
  const midePuntualidad = Boolean(k?.jornadas_con_turno);
  const serie = useMemo(() => (d?.serie ?? []).map((s) => ({ ...s, dia: diaCorto(s.fecha) })), [d]);
  const estados = k ? [
    { nombre: "Completas", valor: k.completas, color: C_COMPLETA },
    { nombre: "Incompletas", valor: k.incompletas, color: C_INCOMPLETA },
    { nombre: "Ausencias", valor: k.ausencias, color: C_AUSENTE },
  ] : [];
  const totalEstados = estados.reduce((a, e) => a + e.valor, 0);

  const alertas: { texto: string; tono: "alto" | "medio" }[] = [];
  if (k && k.jornadas) {
    if ((k.tasa_ausentismo ?? 0) >= 10) alertas.push({ texto: `Ausentismo del ${n(k.tasa_ausentismo, 1)}%: ${n(k.ausencias)} días sin marcación de ${n(k.personas_ausentes)} personas; ${n(pct(k.ausencias - k.ausencias_justificadas, k.ausencias), 0)}% sin novedad reportada.`, tono: "alto" });
    if (cumplimiento < 85) alertas.push({ texto: `Solo el ${n(cumplimiento, 1)}% de las jornadas están completas. Revisa marcaciones incompletas.`, tono: "alto" });
    if (k.horas_extra > k.horas_trabajadas * 0.08) alertas.push({ texto: `Las horas extra son el ${n(pct(k.horas_extra, k.horas_trabajadas), 1)}% del tiempo trabajado: posible sobrecosto de nómina.`, tono: "medio" });
    if (midePuntualidad && puntualidad < 90) alertas.push({ texto: `${n(k.llegadas_tarde)} llegadas tarde (${n(100 - puntualidad, 1)}% de las jornadas), ${n(k.minutos_tarde / 60, 1)} horas perdidas.`, tono: "medio" });
    const peor = [...(d?.campanas ?? [])].filter((c) => c.jornadas > 20).sort((a, b) => (b.tasa_ausentismo ?? 0) - (a.tasa_ausentismo ?? 0))[0];
    if (peor && (peor.tasa_ausentismo ?? 0) >= 10) alertas.push({ texto: `La campaña ${peor.campana} tiene el mayor ausentismo (${n(peor.tasa_ausentismo, 1)}%).`, tono: "medio" });
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Indicador titulo="Jornadas completas" valor={`${n(cumplimiento, 1)}%`} barra={cumplimiento} detalle={`${n(k?.completas)} de ${n(k?.jornadas)} días trabajados con entrada y salida`} cargando={cargando} />
        <Indicador titulo="Tasa de ausentismo" valor={`${n(k?.tasa_ausentismo, 1)}%`} barra={k?.tasa_ausentismo ?? 0} tono="malo" detalle={`${n(k?.ausencias)} días sin marcación · ${n(k?.personas_ausentes)} personas`} cargando={cargando} onClick={alVerAusentismo} />
        <Indicador titulo="Cobertura de horas" valor={`${n(cobertura, 1)}%`} barra={cobertura} detalle={`${n(k?.horas_trabajadas)} h de ${n(k?.horas_esperadas)} h esperadas`} cargando={cargando} />
        {midePuntualidad || cargando ? (
          <Indicador titulo="Puntualidad" valor={`${n(puntualidad, 1)}%`} barra={puntualidad} detalle={`${n(k?.llegadas_tarde)} llegadas tarde`} cargando={cargando} />
        ) : (
          <Indicador titulo="Puntualidad" valor="—" detalle="Asigna turnos a empleados o campañas para medir llegadas tarde." cargando={false} />
        )}
        <Indicador titulo="Personal con marcación" valor={`${n(k ? pct(k.empleados_con_marcacion, k.empleados_activos) : 0, 1)}%`} barra={k ? pct(k.empleados_con_marcacion, k.empleados_activos) : 0} detalle={`${n(k?.empleados_con_marcacion)} de ${n(k?.empleados_activos)} activos`} cargando={cargando} />
      </div>

      {alertas.length ? (
        <Card className="p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><TriangleAlert className="size-4 text-accent" /> Focos de atención</p>
          <ul className="grid gap-2 md:grid-cols-2">
            {alertas.map((a) => (
              <li key={a.texto} className={cn("rounded-lg border-l-4 bg-muted/40 px-3 py-2 text-sm", a.tono === "alto" ? "border-destructive" : "border-accent")}>{a.texto}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <Bloque titulo="Tendencia diaria de jornadas" subtitulo="Personas por día: jornadas completas, incompletas y ausentes (días laborales)" className="xl:col-span-2">
          <ResponsiveContainer width="100%" height={290}>
            <ComposedChart data={serie} margin={{ left: -10, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="gC" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C_COMPLETA} stopOpacity={0.45} /><stop offset="100%" stopColor={C_COMPLETA} stopOpacity={0} /></linearGradient>
                <linearGradient id="gI" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C_INCOMPLETA} stopOpacity={0.4} /><stop offset="100%" stopColor={C_INCOMPLETA} stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="dia" tick={EJE} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis tick={EJE} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v, nombre) => (v == null ? ["No laboral", nombre] : [n(Number(v)), nombre])} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="completas" name="Completas" stroke={C_COMPLETA} fill="url(#gC)" strokeWidth={2} />
              <Area type="monotone" dataKey="incompletas" name="Incompletas" stroke={C_INCOMPLETA} fill="url(#gI)" strokeWidth={2} />
              <Line type="monotone" dataKey="ausentes" name="Ausentes" stroke={C_AUSENTE} strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </Bloque>
        <Bloque titulo="Días-persona del periodo" subtitulo="Cómo se reparten los días laborales de las personas">
          <div className="relative">
            <ResponsiveContainer width="100%" height={210}>
              <PieChart>
                <Pie data={estados} dataKey="valor" nameKey="nombre" innerRadius={62} outerRadius={88} paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
                  {estados.map((e) => <Cell key={e.nombre} fill={e.color} />)}
                </Pie>
                <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => n(v)} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <p className="font-display text-2xl font-semibold">{n(pct(k?.completas ?? 0, totalEstados), 0)}%</p>
              <p className="text-[11px] text-muted-foreground">días con jornada completa</p>
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            {estados.map((e) => (
              <div key={e.nombre} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: e.color }} />{e.nombre}</span>
                <span className="tabular-nums"><b>{n(e.valor)}</b> <span className="text-xs text-muted-foreground">({n(pct(e.valor, totalEstados), 1)}%)</span></span>
              </div>
            ))}
          </div>
        </Bloque>
      </div>

      <TablaCampanas campanas={d?.campanas ?? []} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Bloque titulo="Hora de llegada" subtitulo="Jornadas según la hora de la primera marcación">
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={(d?.horas_entrada ?? []).map((h) => ({ ...h, h: `${String(h.hora).padStart(2, "0")}:00` }))} margin={{ left: -20, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="h" tick={{ ...EJE, fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis tick={EJE} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [n(v), "Jornadas"]} />
              <Bar dataKey="personas" name="Jornadas" fill={C_COMPLETA} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Bloque>
        <Bloque titulo="Novedades del periodo" subtitulo="Incapacidades, licencias, vacaciones… reportadas">
          {d?.novedades.length ? (
            <BarrasHorizontales filas={d.novedades.map((x) => ({ etiqueta: x.tipo, valor: x.total }))} color={C_JUSTIFICADA} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">Sin novedades. <Link to="/novedades" className="text-primary underline">Cargar plantilla</Link></p>
          )}
        </Bloque>
      </div>
    </>
  );
}

function TablaCampanas({ campanas }: { campanas: Campana[] }) {
  const [orden, setOrden] = useState<{ col: keyof Campana; asc: boolean }>({ col: "jornadas", asc: false });
  const filas = useMemo(() => [...campanas].sort((a, b) => {
    const x = a[orden.col] ?? -1;
    const y = b[orden.col] ?? -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "es");
    return orden.asc ? c : -c;
  }), [campanas, orden]);
  const { visibles, paginador } = usePaginado(filas, 10);
  const Th = ({ col, children, className }: { col: keyof Campana; children: string; className?: string }) => (
    <th className={cn("pb-2 font-medium", className)}>
      <span className="inline-flex items-center gap-1">
        <button type="button" className="hover:text-foreground" onClick={() => setOrden({ col, asc: orden.col === col ? !orden.asc : false })}>
          {children}{orden.col === col ? (orden.asc ? " ↑" : " ↓") : ""}
        </button>
        <Ayuda titulo={`col:${children}`} />
      </span>
    </th>
  );
  return (
    <Bloque titulo="Desempeño por campaña" subtitulo="Días trabajados = días con al menos una marcación · Jornadas completas = % de esos días con entrada y salida">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <Th col="campana">Campaña</Th><Th col="personas">Personas</Th><Th col="jornadas">Días trabajados</Th>
              <Th col="cumplimiento" className="w-48">Jornadas completas</Th><Th col="tasa_ausentismo" className="w-48">Ausentismo</Th>
              <Th col="horas_extra">Horas extra</Th><Th col="tarde">Llegadas tarde</Th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((c) => (
              <tr key={c.campana} className="border-t">
                <td className="py-2 font-medium">{c.campana}</td>
                <td className="py-2 tabular-nums">{n(c.personas)}</td>
                <td className="py-2 tabular-nums">{n(c.jornadas)}</td>
                <td className="py-2 pr-6"><Barrita valor={c.cumplimiento ?? 0} color={C_COMPLETA} /></td>
                <td className="py-2 pr-6"><Barrita valor={c.tasa_ausentismo ?? 0} color={C_AUSENTE} escala={Math.max(30, ...campanas.map((x) => x.tasa_ausentismo ?? 0))} /></td>
                <td className="py-2 tabular-nums">{n(c.horas_extra, 1)}</td>
                <td className="py-2 tabular-nums">{n(c.tarde)}</td>
              </tr>
            ))}
            {!filas.length ? <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">Sin datos en el periodo.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {filas.length > 10 ? <div className="mt-2"><Paginador {...paginador} /></div> : null}
    </Bloque>
  );
}

// ───────────── Ausentismo ─────────────

function Ausentismo({ d, cargando }: { d: BI | undefined; cargando: boolean }) {
  const k = d?.kpis;
  const serie = useMemo(
    () => (d?.serie ?? []).filter((s) => s.laboral).map((s) => ({
      dia: diaCorto(s.fecha),
      justificadas: s.ausentes_justificados ?? 0,
      sin_novedad: (s.ausentes ?? 0) - (s.ausentes_justificados ?? 0),
    })),
    [d],
  );
  const semana = useMemo(() => DIAS.map((nombre, i) => ({ nombre, ausencias: d?.semana.find((x) => x.dow === i)?.ausencias ?? 0 })).filter((s, i) => i !== 0 || s.ausencias > 0), [d]);
  const totalSemana = semana.reduce((a, s) => a + s.ausencias, 0);
  const pico = [...semana].sort((a, b) => b.ausencias - a.ausencias)[0];
  const ultimoDato = d?.rango.max ?? "";
  // Activos que siguen contando ausencias 30+ días después de su última marcación: probables retiros sin registrar
  const sinVolver = (d?.top_ausentes ?? []).filter((p) => p.ultima_marca && p.ultima > sumarDias(p.ultima_marca, 30));
  const justificadas = k ? pct(k.ausencias_justificadas, k.ausencias) : 0;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Indicador titulo="Tasa de ausentismo" valor={`${n(k?.tasa_ausentismo, 1)}%`} barra={k?.tasa_ausentismo ?? 0} tono="malo" detalle={`${n(k?.ausencias)} de ${n(k?.dias_posibles)} días-persona laborales`} cargando={cargando} />
        <Indicador titulo="Días sin marcación" valor={n(k?.ausencias)} detalle={`${n(k?.dias_laborales)} días laborales con datos en el periodo`} cargando={cargando} />
        <Indicador titulo="Personas con ausencias" valor={n(k?.personas_ausentes)} barra={k ? pct(k.personas_ausentes, k.personas_base) : 0} tono="malo" detalle={`de ${n(k?.personas_base)} personas que marcan en el periodo`} cargando={cargando} />
        <Indicador titulo="Con novedad reportada" valor={`${n(justificadas, 1)}%`} barra={justificadas} detalle={`${n(k?.ausencias_justificadas)} ausencias justificadas · ${n((k?.ausencias ?? 0) - (k?.ausencias_justificadas ?? 0))} sin novedad`} cargando={cargando} />
      </div>

      {sinVolver.length ? (
        <Card className="flex flex-wrap items-center gap-3 border-l-4 border-l-accent p-4 text-sm">
          <UserX className="size-5 text-accent" />
          <p className="flex-1">
            <b>{n(sinVolver.length)} personas activas</b> no marcan desde hace más de 30 días y siguen sumando ausencias.
            Si ya se retiraron, registra su <b>estado inactivo y fecha de retiro</b> en Empleados: sus ausencias se contarán solo hasta esa fecha.
          </p>
          <Link to="/empleados" className="text-primary underline">Ir a Empleados</Link>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <Bloque titulo="Ausentes por día laboral" subtitulo="Personas sin marcación cada día, con o sin novedad reportada" className="xl:col-span-2">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={serie} margin={{ left: -10, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="dia" tick={EJE} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis tick={EJE} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v: number, nombre: string) => [n(v), nombre]} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="sin_novedad" name="Sin novedad" stackId="a" fill={C_AUSENTE} />
              <Bar dataKey="justificadas" name="Con novedad" stackId="a" fill={C_JUSTIFICADA} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Bloque>
        <Bloque titulo="Motivos de ausencia" subtitulo="Novedad reportada para cada día sin marcación">
          {d?.motivos_ausencia.length ? (
            <BarrasHorizontales filas={d.motivos_ausencia.map((m) => ({ etiqueta: m.motivo, valor: m.total }))} color={C_JUSTIFICADA} destacar="Sin novedad reportada" colorDestacado={C_AUSENTE} />
          ) : <Vacio />}
        </Bloque>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Bloque titulo="Ausencias por día de la semana" subtitulo={pico && totalSemana ? `${pico.nombre} concentra el ${n(pct(pico.ausencias, totalSemana), 0)}% de las ausencias` : "Días laborales del periodo"}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={semana} margin={{ left: -20, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="nombre" tick={EJE} tickLine={false} axisLine={false} />
              <YAxis tick={EJE} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`${n(v)} (${n(pct(v, totalSemana), 1)}%)`, "Ausencias"]} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
              <Bar dataKey="ausencias" name="Ausencias" radius={[4, 4, 0, 0]}>
                {semana.map((s) => <Cell key={s.nombre} fill={s === pico ? C_AUSENTE : "var(--muted-foreground)"} fillOpacity={s === pico ? 1 : 0.45} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {pico && totalSemana && pct(pico.ausencias, totalSemana) > 30 ? (
            <p className="mt-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
              Si el personal no trabaja los {pico.nombre.toLowerCase()}, quítalo de los días laborales en <Link to="/jornada" className="text-primary underline">Reglas de cálculo</Link> para no contarlos como ausencia.
            </p>
          ) : null}
        </Bloque>
        <div className="xl:col-span-2">
          <RankingPaginado
            titulo="Personas con más ausencias"
            icon={CalendarX2}
            filas={(d?.top_ausentes ?? []).map((t) => ({
              clave: t.documento, nombre: t.nombre, sub: `${t.documento} · ${t.campana}`,
              valor: `${n(t.dias)} días`,
              extra: `${n(t.justificados)} con novedad · última marca ${t.ultima_marca ?? "—"}`,
              alerta: Boolean(t.ultima_marca && t.ultima > sumarDias(t.ultima_marca, 30)),
            }))}
            pie={<Link to="/reportes" className="text-xs text-primary underline">Ver el detalle día a día en Reportes → Ausentismo</Link>}
          />
        </div>
      </div>
      {ultimoDato ? <p className="text-center text-[11px] text-muted-foreground">Ausencia = día laboral (sin festivos) con datos cargados en que una persona que marca en el periodo no registró marcación, desde su ingreso y hasta su fecha de retiro.</p> : null}
    </>
  );
}

// ───────────── Horas y costos ─────────────

function HorasCostos({ d, cargando }: { d: BI | undefined; cargando: boolean }) {
  const k = d?.kpis;
  const serie = useMemo(() => (d?.serie ?? []).map((s) => ({ dia: diaCorto(s.fecha), horas_extra: s.horas_extra })), [d]);
  // Concentración (Pareto): qué parte de las horas extra acumula el 20% de las personas con más extra
  const pareto = useMemo(() => {
    const lista = d?.top_extra ?? [];
    const total = lista.reduce((a, t) => a + t.horas, 0);
    const top = Math.max(1, Math.ceil(lista.length * 0.2));
    return { personas: lista.length, top, pct: pct(lista.slice(0, top).reduce((a, t) => a + t.horas, 0), total) };
  }, [d]);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi icon={Clock3} titulo="Horas trabajadas" valor={n(k?.horas_trabajadas)} cargando={cargando} />
        <Kpi icon={TrendingUp} titulo="Horas extra" valor={n(k?.horas_extra, 1)} detalle={`${n(k ? pct(k.horas_extra, k.horas_trabajadas) : 0, 1)}% del tiempo trabajado`} tono="accent" cargando={cargando} />
        <Kpi icon={Moon} titulo="Horas nocturnas" valor={n(k?.horas_nocturnas, 1)} cargando={cargando} />
        <Kpi icon={Sun} titulo="Dominicales / festivos" valor={n(k?.horas_dominicales, 1)} cargando={cargando} />
        <Kpi icon={AlarmClock} titulo="Horas perdidas por tarde" valor={n((k?.minutos_tarde ?? 0) / 60, 1)} tono="danger" cargando={cargando} />
        <Kpi icon={Users} titulo="Personas con horas extra" valor={n(pareto.personas)} detalle={pareto.personas ? `El ${n(pareto.top)} (20%) suma el ${n(pareto.pct, 0)}% de la extra` : undefined} cargando={cargando} />
      </div>
      <Bloque titulo="Horas extra por día" subtitulo="Impacto diario en nómina">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={serie} margin={{ left: -20, right: 8, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="dia" tick={{ ...EJE, fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={EJE} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`${n(v, 1)} h`, "Horas extra"]} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
            <Bar dataKey="horas_extra" name="Horas extra" fill={C_EXTRA} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Bloque>
      <div className="grid gap-4 lg:grid-cols-2">
        <RankingPaginado
          titulo="Mayor número de horas extra"
          icon={Activity}
          filas={(d?.top_extra ?? []).map((t) => ({ clave: t.documento, nombre: t.nombre, sub: `${t.documento} · ${t.campana}`, valor: `${n(t.horas, 1)} h`, extra: `${n(t.jornadas)} jornadas con extra` }))}
        />
        <RankingPaginado
          titulo="Mayor tiempo de llegada tarde"
          icon={AlarmClock}
          filas={(d?.top_tarde ?? []).map((t) => ({ clave: t.documento, nombre: t.nombre, sub: `${t.documento} · ${t.campana}`, valor: `${n(t.minutos / 60, 1)} h`, extra: `${n(t.veces)} veces` }))}
          vacio="Sin llegadas tarde en el periodo (requiere turnos asignados)."
        />
      </div>
    </>
  );
}

// ───────────── Estratégico ─────────────

function Estrategico({ d, anterior, meses, cargando, cargandoMeses, periodoAnterior }: {
  d: BI | undefined; anterior: BI | undefined; meses: Mes[]; cargando: boolean; cargandoMeses: boolean; periodoAnterior: string;
}) {
  const k = d?.kpis;
  const a = anterior?.kpis;
  const metricas = (x: Kpis | undefined) => x ? {
    cumplimiento: pct(x.completas, x.jornadas),
    ausentismo: x.tasa_ausentismo ?? 0,
    extra: pct(x.horas_extra, x.horas_trabajadas),
    horasPersona: x.empleados_con_marcacion ? x.horas_trabajadas / x.empleados_con_marcacion : 0,
    personas: x.empleados_con_marcacion,
    nocturnas: pct(x.horas_nocturnas, x.horas_trabajadas),
  } : null;
  const m = metricas(k);
  // Sin datos en el periodo anterior (ej. meses sin CSV cargados) no hay contra qué comparar
  const sinAnterior = !cargando && !a?.jornadas;
  const p = sinAnterior ? null : metricas(a);

  // Matriz de riesgo por campaña: ausentismo vs. % de horas extra (tamaño = personas)
  const matriz = useMemo(() => (d?.campanas ?? []).filter((c) => c.jornadas >= 20).map((c) => ({
    campana: c.campana, personas: c.personas, ausentismo: c.tasa_ausentismo ?? 0, extra: pct(c.horas_extra, c.horas_trabajadas),
  })), [d]);
  const promAus = m?.ausentismo ?? 0;
  const promExtra = m?.extra ?? 0;
  const criticas = matriz.filter((c) => c.ausentismo > promAus && c.extra > promExtra);

  const serieMeses = meses.map((x) => ({ ...x, etiqueta: mesCorto(x.mes) }));
  const conclusiones: string[] = [];
  if (m && p && a?.jornadas) {
    const dA = m.ausentismo - p.ausentismo;
    if (Math.abs(dA) >= 1) conclusiones.push(`El ausentismo ${dA > 0 ? "subió" : "bajó"} ${n(Math.abs(dA), 1)} puntos frente al periodo anterior (${n(p.ausentismo, 1)}% → ${n(m.ausentismo, 1)}%).`);
    const dE = m.extra - p.extra;
    if (Math.abs(dE) >= 0.5) conclusiones.push(`Las horas extra pasaron del ${n(p.extra, 1)}% al ${n(m.extra, 1)}% del tiempo trabajado.`);
  }
  if (criticas.length) conclusiones.push(`${criticas.length === 1 ? "La campaña" : `${criticas.length} campañas`} ${criticas.slice(0, 3).map((c) => c.campana).join(", ")}${criticas.length > 3 ? "…" : ""} ${criticas.length === 1 ? "combina" : "combinan"} ausentismo y horas extra por encima del promedio: el ausentismo se está cubriendo con extra.`);
  if (serieMeses.length >= 3) {
    const ult = serieMeses.slice(-3);
    const sube = ult.every((x, i) => i === 0 || (x.tasa_ausentismo ?? 0) >= (ult[i - 1]!.tasa_ausentismo ?? 0));
    if (sube && (ult[2]!.tasa_ausentismo ?? 0) > (ult[0]!.tasa_ausentismo ?? 0)) conclusiones.push(`El ausentismo mensual lleva 3 meses subiendo (${ult.map((x) => `${n(x.tasa_ausentismo, 1)}%`).join(" → ")}).`);
  }

  return (
    <>
      <Bloque titulo="Periodo actual vs. anterior" subtitulo={sinAnterior ? `El periodo anterior (${periodoAnterior}) no tiene datos cargados: no hay comparación.` : `Comparado con ${periodoAnterior} (misma duración)`}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Comparativo titulo="Jornadas completas" actual={m?.cumplimiento} anterior={p?.cumplimiento} unidad="%" mejorSiSube cargando={cargando} />
          <Comparativo titulo="Ausentismo" actual={m?.ausentismo} anterior={p?.ausentismo} unidad="%" cargando={cargando} />
          <Comparativo titulo="Horas extra / trabajadas" actual={m?.extra} anterior={p?.extra} unidad="%" cargando={cargando} />
          <Comparativo titulo="Horas nocturnas / trabajadas" actual={m?.nocturnas} anterior={p?.nocturnas} unidad="%" cargando={cargando} />
          <Comparativo titulo="Horas por persona" actual={m?.horasPersona} anterior={p?.horasPersona} unidad=" h" mejorSiSube cargando={cargando} />
          <Comparativo titulo="Personas que marcan" actual={m?.personas} anterior={p?.personas} unidad="" mejorSiSube decimales={0} cargando={cargando} />
        </div>
      </Bloque>

      {conclusiones.length ? (
        <Card className="p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Lightbulb className="size-4 text-accent" /> Lectura estratégica</p>
          <ul className="space-y-1.5 text-sm">{conclusiones.map((c) => <li key={c} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />{c}</li>)}</ul>
        </Card>
      ) : null}

      <div>
        <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><GaugeIcon className="size-4 text-muted-foreground" /> Tendencia de los últimos 12 meses</p>
        <div className="grid gap-4 lg:grid-cols-3">
          <MiniTendencia titulo="Tasa de ausentismo" datos={serieMeses} campo="tasa_ausentismo" color={C_AUSENTE} unidad="%" cargando={cargandoMeses} />
          <MiniTendencia titulo="Horas extra sobre trabajadas" datos={serieMeses} campo="pct_extra" color={C_EXTRA} unidad="%" cargando={cargandoMeses} />
          <MiniTendencia titulo="Jornadas completas" datos={serieMeses} campo="cumplimiento" color={C_COMPLETA} unidad="%" cargando={cargandoMeses} />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Bloque titulo="Matriz de riesgo por campaña" subtitulo="Ausentismo vs. horas extra · tamaño = personas · líneas = promedio del periodo" className="xl:col-span-2">
          {matriz.length ? (
            <ResponsiveContainer width="100%" height={320}>
              <ScatterChart margin={{ left: -5, right: 16, top: 12, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis type="number" dataKey="ausentismo" name="Ausentismo" unit="%" tick={EJE} tickLine={false} axisLine={false} />
                <YAxis type="number" dataKey="extra" name="Horas extra" unit="%" tick={EJE} tickLine={false} axisLine={false} />
                <ZAxis type="number" dataKey="personas" range={[60, 600]} name="Personas" />
                <ReferenceLine x={promAus} stroke="var(--muted-foreground)" strokeDasharray="4 4" />
                <ReferenceLine y={promExtra} stroke="var(--muted-foreground)" strokeDasharray="4 4" />
                <Tooltip
                  contentStyle={TOOLTIP}
                  cursor={{ strokeDasharray: "3 3" }}
                  content={({ payload }) => {
                    const c = payload?.[0]?.payload as (typeof matriz)[number] | undefined;
                    return c ? (
                      <div style={TOOLTIP} className="p-2">
                        <p className="font-semibold">{c.campana}</p>
                        <p>Ausentismo: {n(c.ausentismo, 1)}%</p>
                        <p>Horas extra: {n(c.extra, 1)}% del tiempo</p>
                        <p>{n(c.personas)} personas</p>
                      </div>
                    ) : null;
                  }}
                />
                <Scatter data={matriz}>
                  {matriz.map((c) => <Cell key={c.campana} fill={criticas.includes(c) ? C_AUSENTE : C_COMPLETA} fillOpacity={0.75} stroke="var(--card)" strokeWidth={2} />)}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          ) : <Vacio />}
        </Bloque>
        <Bloque titulo="Cómo leer la matriz" subtitulo="Cuadrantes respecto al promedio">
          <ul className="space-y-3 text-sm">
            <li className="flex gap-2"><span className="mt-1 size-3 shrink-0 rounded-full" style={{ background: C_AUSENTE }} /><span><b>Arriba a la derecha (riesgo):</b> más ausentismo y más horas extra. Se cubren faltas con extra: sobrecosto.</span></li>
            <li className="flex gap-2"><span className="mt-1 size-3 shrink-0 rounded-full" style={{ background: C_COMPLETA }} /><span><b>Abajo a la izquierda (sano):</b> poco ausentismo y poca extra.</span></li>
            <li className="text-muted-foreground"><b>Abajo a la derecha:</b> faltas sin cubrir (riesgo de servicio). <b>Arriba a la izquierda:</b> extra por demanda o planeación.</li>
          </ul>
          {criticas.length ? (
            <div className="mt-4 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Campañas en riesgo</p>
              {criticas.sort((x, y) => y.ausentismo + y.extra - (x.ausentismo + x.extra)).slice(0, 6).map((c) => (
                <div key={c.campana} className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-xs">
                  <span className="truncate font-medium">{c.campana}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{n(c.ausentismo, 1)}% aus · {n(c.extra, 1)}% extra</span>
                </div>
              ))}
            </div>
          ) : null}
        </Bloque>
      </div>
    </>
  );
}

// ───────────── Piezas visuales ─────────────

function Indicador({ titulo, valor, detalle, barra, tono, cargando, onClick }: {
  titulo: string; valor: string; detalle: string; barra?: number; tono?: "malo"; cargando: boolean; onClick?: () => void;
}) {
  const v = Math.max(0, Math.min(100, barra ?? 0));
  const Contenedor = onClick ? "button" : "div";
  return (
    <Card className={cn("p-4", onClick && "text-left transition-colors hover:border-primary/50")}>
      <Contenedor type={onClick ? "button" : undefined} onClick={onClick} className="block w-full text-left">
        <p className="flex items-center gap-1 text-xs text-muted-foreground">{titulo}<Ayuda titulo={titulo} /></p>
        {cargando ? <Skeleton className="mt-2 h-8 w-24" /> : <p className="mt-1 font-display text-3xl font-semibold tabular-nums">{valor}</p>}
        {barra !== undefined ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full transition-all" style={{ width: `${v}%`, background: tono === "malo" ? C_AUSENTE : C_COMPLETA }} />
          </div>
        ) : null}
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{detalle}</p>
      </Contenedor>
    </Card>
  );
}

function Kpi({ icon: Icon, titulo, valor, detalle, tono, cargando }: { icon: typeof Users; titulo: string; valor: string; detalle?: string | undefined; tono?: "accent" | "danger"; cargando: boolean }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-xs text-muted-foreground">{titulo}<Ayuda titulo={titulo} /></p>
        <span className={cn("rounded-md p-1.5", tono === "danger" ? "bg-destructive/10 text-destructive" : tono === "accent" ? "bg-accent/15 text-accent" : "bg-primary/15 text-foreground")}><Icon className="size-3.5" /></span>
      </div>
      {cargando ? <Skeleton className="mt-2 h-7 w-20" /> : <p className="mt-1.5 font-display text-2xl font-semibold tabular-nums">{valor}</p>}
      {detalle ? <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{detalle}</p> : null}
    </Card>
  );
}

function Comparativo({ titulo, actual, anterior, unidad, mejorSiSube, decimales = 1, cargando }: {
  titulo: string; actual: number | undefined; anterior: number | undefined; unidad: string; mejorSiSube?: boolean; decimales?: number; cargando: boolean;
}) {
  const delta = actual !== undefined && anterior !== undefined ? actual - anterior : null;
  const estable = delta === null || Math.abs(delta) < (decimales ? 0.05 : 0.5);
  const bueno = delta !== null && (mejorSiSube ? delta > 0 : delta < 0);
  const Flecha = estable ? Minus : delta! > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="rounded-xl border p-3">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">{titulo}<Ayuda titulo={titulo} /></p>
      {cargando ? <Skeleton className="mt-2 h-7 w-20" /> : (
        <>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{n(actual, decimales)}{unidad}</p>
          <p className={cn("mt-1 flex items-center gap-1 text-xs tabular-nums", estable ? "text-muted-foreground" : bueno ? "text-success" : "text-destructive")}>
            <Flecha className="size-3.5" />
            {delta === null ? "sin dato anterior" : `${delta > 0 ? "+" : ""}${n(delta, decimales)}${unidad === "%" ? " pts" : unidad} · antes ${n(anterior, decimales)}${unidad}`}
          </p>
        </>
      )}
    </div>
  );
}

function MiniTendencia({ titulo, datos, campo, color, unidad, cargando }: { titulo: string; datos: (Mes & { etiqueta: string })[]; campo: keyof Mes; color: string; unidad: string; cargando: boolean }) {
  const ultimo = datos.at(-1)?.[campo] as number | null | undefined;
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between">
        <p className="flex items-center gap-1 text-sm font-medium">{titulo}<Ayuda titulo={titulo} /></p>
        <p className="font-display text-lg font-semibold tabular-nums">{ultimo == null ? "—" : `${n(ultimo, 1)}${unidad}`}</p>
      </div>
      {cargando ? <Skeleton className="mt-3 h-36 w-full" /> : (
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={datos} margin={{ left: -24, right: 8, top: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="etiqueta" tick={{ ...EJE, fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={8} />
            <YAxis tick={{ ...EJE, fontSize: 10 }} tickLine={false} axisLine={false} unit={unidad} domain={["auto", "auto"]} />
            <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`${n(v, 1)}${unidad}`, titulo]} />
            <Line type="monotone" dataKey={campo} stroke={color} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

function Bloque({ titulo, subtitulo, className, children }: { titulo: string; subtitulo?: string; className?: string; children: ReactNode }) {
  return (
    <Card className={cn("p-5", className)}>
      <p className="flex items-center gap-1.5 font-display text-sm font-semibold">{titulo}<Ayuda titulo={titulo} /></p>
      {subtitulo ? <p className="mb-3 text-xs text-muted-foreground">{subtitulo}</p> : <div className="mb-3" />}
      {children}
    </Card>
  );
}

function Barrita({ valor, color, escala = 100 }: { valor: number; color: string; escala?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${Math.min(100, (100 * valor) / escala)}%`, background: color }} /></div>
      <span className="w-12 text-right text-xs tabular-nums">{n(valor, 1)}%</span>
    </div>
  );
}

function BarrasHorizontales({ filas, color, destacar, colorDestacado }: { filas: { etiqueta: string; valor: number }[]; color: string; destacar?: string; colorDestacado?: string }) {
  const max = Math.max(1, ...filas.map((f) => f.valor));
  const total = filas.reduce((a, f) => a + f.valor, 0);
  return (
    <div className="space-y-2.5">
      {filas.slice(0, 8).map((f) => (
        <div key={f.etiqueta}>
          <div className="flex justify-between gap-2 text-xs"><span className="truncate">{f.etiqueta}</span><span className="shrink-0 tabular-nums text-muted-foreground">{n(f.valor)} · {n(pct(f.valor, total), 0)}%</span></div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${pct(f.valor, max)}%`, background: f.etiqueta === destacar ? colorDestacado : color }} /></div>
        </div>
      ))}
    </div>
  );
}

/** Ícono «i» que al pasar el mouse explica qué es y cómo se mide. */
function Ayuda({ titulo }: { titulo: string }) {
  const texto = AYUDA[titulo];
  if (!texto) return null;
  return (
    <Ayudita>
      <TooltipTrigger asChild>
        <span role="img" tabIndex={0} aria-label={`Qué es: ${titulo.replace("col:", "")}`} className="inline-flex cursor-help text-muted-foreground/70 hover:text-foreground focus:text-foreground focus:outline-none">
          <InfoIcon className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs font-normal leading-relaxed">{texto}</TooltipContent>
    </Ayudita>
  );
}

function Vacio() {
  return <p className="py-8 text-center text-sm text-muted-foreground">Sin datos en el periodo.</p>;
}

type FilaRanking = { clave: string; nombre: string; sub: string; valor: string; extra?: string; alerta?: boolean };

/** Ranking completo con buscador y paginación (no solo los primeros). */
function RankingPaginado({ titulo, icon: Icon, filas, vacio, pie }: { titulo: string; icon: typeof Users; filas: FilaRanking[]; vacio?: string; pie?: ReactNode }) {
  const [buscar, setBuscar] = useState("");
  const conPuesto = useMemo(() => filas.map((f, i) => ({ ...f, puesto: i + 1 })), [filas]);
  const filtradas = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    return q ? conPuesto.filter((f) => `${f.nombre} ${f.sub}`.toLowerCase().includes(q)) : conPuesto;
  }, [conPuesto, buscar]);
  const { visibles, paginador, reiniciar } = usePaginado(filtradas, 10);
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-display text-sm font-semibold"><Icon className="size-4 text-accent" /> {titulo}<Ayuda titulo={titulo} /></p>
        <Badge variant="secondary" className="tabular-nums">{n(filas.length)} personas</Badge>
      </div>
      {filas.length ? (
        <>
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-8 pl-8 text-xs" placeholder="Buscar por nombre, cédula o campaña…" value={buscar} onChange={(e) => { setBuscar(e.target.value); reiniciar(); }} />
          </div>
          <ol className="flex-1 space-y-2">
            {visibles.map((f) => (
              <li key={f.clave} className="flex items-center gap-3">
                <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums", f.puesto <= 3 ? "bg-brand-gradient text-sidebar" : "bg-muted text-muted-foreground")}>{f.puesto}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">{f.nombre}{f.alerta ? <UserX className="size-3.5 shrink-0 text-accent" aria-label="No marca hace más de 30 días" /> : null}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{f.sub}</p>
                </div>
                <div className="text-right"><p className="text-sm font-semibold tabular-nums">{f.valor}</p>{f.extra ? <p className="text-[11px] text-muted-foreground">{f.extra}</p> : null}</div>
              </li>
            ))}
            {!visibles.length ? <li className="py-4 text-center text-sm text-muted-foreground">Sin resultados.</li> : null}
          </ol>
          <div className="mt-3"><Paginador {...paginador} /></div>
          {pie ? <div className="mt-2">{pie}</div> : null}
        </>
      ) : <p className="py-6 text-center text-sm text-muted-foreground">{vacio ?? "Sin datos en el periodo."}</p>}
    </Card>
  );
}
