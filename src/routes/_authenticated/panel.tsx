import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AlarmClock,
  CalendarCheck,
  Clock3,
  Moon,
  Search,
  Sun,
  TrendingUp,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { MultiSelectFilter } from "@/components/multi-select-filter";

export const Route = createFileRoute("/_authenticated/panel")({
  head: () => ({ meta: [{ title: "Panel estratégico — Convert-IA" }] }),
  component: Panel,
});

type Kpis = {
  empleados_activos: number; empleados_con_marcacion: number; jornadas: number; completas: number; incompletas: number;
  sin_marcacion: number; horas_trabajadas: number; horas_esperadas: number; horas_extra: number; horas_nocturnas: number;
  horas_dominicales: number; minutos_tarde: number; llegadas_tarde: number; ajustes_manuales: number;
  jornadas_con_turno?: number; sin_empresa?: number; excluidos?: number; incluye_sin_empresa?: boolean;
};
type BI = {
  kpis: Kpis;
  serie: { fecha: string; completas: number; incompletas: number; sin_marcacion: number; horas_extra: number; tarde: number }[];
  campanas: { campana: string; personas: number; jornadas: number; cumplimiento: number | null; horas_extra: number; tarde: number }[];
  semana: { dow: number; jornadas: number; incompletas: number; tarde: number }[];
  horas_entrada: { hora: number; personas: number }[];
  top_tarde: { nombre: string; documento: string; campana: string; veces: number; minutos: number }[];
  top_extra: { nombre: string; documento: string; campana: string; horas: number }[];
  novedades: { tipo: string; total: number }[];
  rango: { min: string | null; max: string | null };
};

const C1 = "var(--primary)";
const C2 = "var(--accent)";
const C3 = "var(--destructive)";
const PALETA = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", C1, C2];
const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const n = (v: number | null | undefined, d = 0) => (v ?? 0).toLocaleString("es-CO", { maximumFractionDigits: d });
const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);

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

  const campanas = useQuery({
    queryKey: ["campanas-simple"],
    queryFn: async () => {
      const { data } = await supabase.from("campaigns").select("id, name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const empleados = useQuery({
    queryKey: ["empleados-selector-panel"],
    queryFn: async () => {
      const { data } = await supabase
        .from("employees")
        .select("id, document, full_name, position")
        .order("full_name")
        .limit(3000);
      return (data ?? []) as { id: string; document: string; full_name: string; position: string | null }[];
    },
  });

  const opcionesCampanas = useMemo(
    () => (campanas.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    [campanas.data]
  );
  const opcionesPersonas = useMemo(
    () =>
      (empleados.data ?? []).map((e) => ({
        value: e.id,
        label: e.full_name,
        sublabel: `${e.document}${e.position ? ` · ${e.position}` : ""}`,
      })),
    [empleados.data]
  );

  const bi = useQuery({
    queryKey: ["panel-bi", desde, hasta, campanasSel, personasSel, busqueda],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("panel_bi", {
        _desde: desde,
        _hasta: hasta,
        _campaigns: campanasSel.length > 0 ? campanasSel : null,
        _cost_centers: null,
        _employees: personasSel.length > 0 ? personasSel : null,
        _search: busqueda.trim() ? busqueda.trim() : null,
      });
      if (error) throw error;
      return data as unknown as BI;
    },
  });

  // Si no hay datos en el rango por defecto, saltar al último periodo con datos
  const d = bi.data;
  useEffect(() => {
    if (!d || anclado) return;
    setAnclado(true);
    if (!d.kpis.jornadas && d.rango.max) {
      setHasta(d.rango.max);
      setDesde(iso(new Date(new Date(`${d.rango.max}T12:00:00`).getTime() - 29 * 864e5)));
    }
  }, [d, anclado]);

  const aplicarPreset = (id: string) => {
    const base = d?.rango.max && d.rango.max < iso(new Date()) ? new Date(`${d.rango.max}T12:00:00`) : new Date();
    if (id === "mes") {
      setDesde(iso(new Date(Date.UTC(base.getFullYear(), base.getMonth(), 1))));
      setHasta(iso(base));
    } else {
      setHasta(iso(base));
      setDesde(iso(new Date(base.getTime() - (Number(id) - 1) * 864e5)));
    }
  };

  const limpiarFiltros = () => {
    setCampanasSel([]);
    setPersonasSel([]);
    setBusqueda("");
    aplicarPreset("30");
  };

  const hayFiltrosActivos =
    campanasSel.length > 0 ||
    personasSel.length > 0 ||
    Boolean(busqueda.trim());

  const k = d?.kpis;
  const cumplimiento = k ? pct(k.completas, k.jornadas) : 0;
  const cobertura = k ? pct(k.horas_trabajadas, k.horas_esperadas) : 0;
  const puntualidad = k ? 100 - pct(k.llegadas_tarde, k.jornadas) : 0;
  // Sin turnos asignados no hay hora de entrada esperada: la puntualidad no se puede medir
  const midePuntualidad = Boolean(k?.jornadas_con_turno);

  const serie = useMemo(() => (d?.serie ?? []).map((s) => ({ ...s, dia: s.fecha.slice(5).split("-").reverse().join("/") })), [d]);
  const semana = useMemo(() => DIAS.map((nombre, i) => {
    const s = d?.semana.find((x) => x.dow === i);
    return { nombre, jornadas: s?.jornadas ?? 0, pct_incidencia: s ? Math.round(pct(s.incompletas, s.jornadas)) : 0, tarde: s?.tarde ?? 0 };
  }), [d]);
  const estados = k ? [
    { nombre: "Completas", valor: k.completas, color: C1 },
    { nombre: "Incompletas", valor: k.incompletas, color: C2 },
    { nombre: "Sin marcación", valor: k.sin_marcacion, color: C3 },
  ] : [];

  const campanasFiltradas = useMemo(() => {
    let lista = d?.campanas ?? [];
    if (busqueda.trim()) {
      const q = busqueda.trim().toLowerCase();
      lista = lista.filter((c) => c.campana.toLowerCase().includes(q));
    }
    return lista;
  }, [d?.campanas, busqueda]);

  const topTardeFiltrado = useMemo(() => {
    let lista = d?.top_tarde ?? [];
    if (busqueda.trim()) {
      const q = busqueda.trim().toLowerCase();
      lista = lista.filter((t) => `${t.nombre} ${t.documento} ${t.campana}`.toLowerCase().includes(q));
    }
    return lista;
  }, [d?.top_tarde, busqueda]);

  const topExtraFiltrado = useMemo(() => {
    let lista = d?.top_extra ?? [];
    if (busqueda.trim()) {
      const q = busqueda.trim().toLowerCase();
      lista = lista.filter((t) => `${t.nombre} ${t.documento} ${t.campana}`.toLowerCase().includes(q));
    }
    return lista;
  }, [d?.top_extra, busqueda]);

  const alertas: { texto: string; tono: "alto" | "medio" }[] = [];
  if (k) {
    if (cumplimiento < 85 && k.jornadas) alertas.push({ texto: `Solo el ${n(cumplimiento, 1)}% de las jornadas están completas. Revisa marcaciones incompletas y la clasificación de dispositivos.`, tono: "alto" });
    if (k.horas_extra > k.horas_trabajadas * 0.08) alertas.push({ texto: `Las horas extra representan el ${n(pct(k.horas_extra, k.horas_trabajadas), 1)}% del tiempo trabajado: posible sobrecosto de nómina.`, tono: "medio" });
    if (midePuntualidad && puntualidad < 90 && k.jornadas) alertas.push({ texto: `${n(k.llegadas_tarde)} llegadas tarde (${n(100 - puntualidad, 1)}% de las jornadas), ${n(k.minutos_tarde / 60, 1)} horas perdidas.`, tono: "medio" });
    const peor = [...(d?.campanas ?? [])].filter((c) => c.jornadas > 20).sort((a, b) => (a.cumplimiento ?? 0) - (b.cumplimiento ?? 0))[0];
    if (peor && (peor.cumplimiento ?? 100) < 85) alertas.push({ texto: `La campaña ${peor.campana} tiene el menor cumplimiento (${n(peor.cumplimiento, 1)}%).`, tono: "alto" });
  }

  return (
    <div className="space-y-5">
      {/* Encabezado */}
      <div className="relative overflow-hidden rounded-2xl bg-sidebar p-6 text-sidebar-foreground">
        <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-brand-gradient opacity-25 blur-3xl" />
        <div className="relative flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
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
              <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="h-8 w-36 border-sidebar-border bg-sidebar-accent/40 text-xs text-sidebar-foreground" />
              <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="h-8 w-36 border-sidebar-border bg-sidebar-accent/40 text-xs text-sidebar-foreground" />
            </div>
          </div>

          {/* Filtros avanzados: Campañas, Centros de costo, Personas y Buscador de texto */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-sidebar-border/40">
            <MultiSelectFilter
              title="Campañas"
              placeholder="Todas las campañas"
              searchPlaceholder="Buscar campaña…"
              options={opcionesCampanas}
              selected={campanasSel}
              onChange={setCampanasSel}
              triggerClassName="h-8 border-sidebar-border bg-sidebar-accent/40 text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground min-w-[170px]"
            />

            <MultiSelectFilter
              title="Personas"
              placeholder="Todas las personas"
              searchPlaceholder="Buscar por cédula o nombre…"
              options={opcionesPersonas}
              selected={personasSel}
              onChange={setPersonasSel}
              triggerClassName="h-8 border-sidebar-border bg-sidebar-accent/40 text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground min-w-[180px]"
              popoverWidth="w-[340px]"
            />

            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-foreground/50" />
              <Input
                placeholder="Búsqueda libre (cédula, nombre, cargo)…"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                className="h-8 pl-8 text-xs border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground placeholder:text-sidebar-foreground/40"
              />
            </div>

            {hayFiltrosActivos ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={limpiarFiltros}
                className="h-8 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                title="Limpiar filtros"
              >
                <X className="mr-1 size-3.5" /> Limpiar
              </Button>
            ) : null}
          </div>
        </div>

        {/* Indicadores principales */}
        <div className="relative mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Gauge titulo="Cumplimiento de jornada" valor={cumplimiento} detalle={`${n(k?.completas)} de ${n(k?.jornadas)} jornadas completas`} cargando={bi.isLoading} />
          <Gauge titulo="Cobertura de horas" valor={cobertura} detalle={`${n(k?.horas_trabajadas)} h de ${n(k?.horas_esperadas)} h esperadas`} cargando={bi.isLoading} />
          {midePuntualidad || bi.isLoading ? (
            <Gauge titulo="Puntualidad" valor={puntualidad} detalle={`${n(k?.llegadas_tarde)} llegadas tarde · ${n(pct(k?.jornadas_con_turno ?? 0, k?.jornadas ?? 0), 0)}% de jornadas con turno`} cargando={bi.isLoading} />
          ) : (
            <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/30 p-4">
              <p className="text-xs text-sidebar-foreground/60">Puntualidad</p>
              <p className="mt-1 font-display text-3xl font-semibold">—</p>
              <p className="mt-2 text-[11px] text-sidebar-foreground/55">Asigna turnos a empleados o campañas para medir llegadas tarde.</p>
            </div>
          )}
          <Gauge titulo="Personal con marcación" valor={k ? pct(k.empleados_con_marcacion, k.empleados_activos) : 0} detalle={`${n(k?.empleados_con_marcacion)} de ${n(k?.empleados_activos)} activos`} cargando={bi.isLoading} />
        </div>
      </div>

      {/* KPIs secundarios */}
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi icon={Users} titulo="Empleados activos" valor={n(k?.empleados_activos)} cargando={bi.isLoading} />
        <Kpi icon={Clock3} titulo="Horas trabajadas" valor={n(k?.horas_trabajadas)} cargando={bi.isLoading} />
        <Kpi icon={TrendingUp} titulo="Horas extra" valor={n(k?.horas_extra, 1)} tono="accent" cargando={bi.isLoading} />
        <Kpi icon={Moon} titulo="Horas nocturnas" valor={n(k?.horas_nocturnas, 1)} cargando={bi.isLoading} />
        <Kpi icon={Sun} titulo="Dominicales / festivos" valor={n(k?.horas_dominicales, 1)} cargando={bi.isLoading} />
        <Kpi icon={AlarmClock} titulo="Horas perdidas por tarde" valor={n((k?.minutos_tarde ?? 0) / 60, 1)} tono="danger" cargando={bi.isLoading} />
      </div>

      {/* Personal considerado */}
      {k && (k.sin_empresa || k.excluidos) ? (
        <Card className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
          <Users className="size-4 text-accent" />
          {k.excluidos ? <span><strong className="tabular-nums">{n(k.excluidos)}</strong> personas de otros empleadores (seguridad, aseo…) están excluidas.</span> : null}
          {k.sin_empresa ? (
            <span>
              <strong className="tabular-nums">{n(k.sin_empresa)}</strong> activos sin empleador {k.incluye_sin_empresa === false ? "no se incluyen" : "se están incluyendo"}.
            </span>
          ) : null}
          <Link to="/empleados" className="ml-auto text-primary underline">Clasificar personal</Link>
        </Card>
      ) : null}

      {/* Alertas */}
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

      {/* Tendencia + estados */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Panelito titulo="Tendencia diaria de jornadas" subtitulo="Completas vs. incompletas y sin marcación" className="xl:col-span-2">
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={serie} margin={{ left: -10, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="gC" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C1} stopOpacity={0.5} /><stop offset="100%" stopColor={C1} stopOpacity={0} /></linearGradient>
                <linearGradient id="gI" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C2} stopOpacity={0.5} /><stop offset="100%" stopColor={C2} stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="dia" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Area type="monotone" dataKey="completas" name="Completas" stroke={C1} fill="url(#gC)" strokeWidth={2} />
              <Area type="monotone" dataKey="incompletas" name="Incompletas" stroke={C2} fill="url(#gI)" strokeWidth={2} />
              <Area type="monotone" dataKey="sin_marcacion" name="Sin marcación" stroke={C3} fill="transparent" strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </Panelito>
        <Panelito titulo="Estado de las jornadas" subtitulo="Distribución del periodo">
          <div className="relative">
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={estados} dataKey="valor" nameKey="nombre" innerRadius={62} outerRadius={90} paddingAngle={2} stroke="none">
                  {estados.map((e) => <Cell key={e.nombre} fill={e.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <p className="font-display text-2xl font-semibold">{n(cumplimiento, 0)}%</p>
              <p className="text-[11px] text-muted-foreground">completas</p>
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            {estados.map((e) => (
              <div key={e.nombre} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: e.color }} />{e.nombre}</span>
                <span className="font-medium tabular-nums">{n(e.valor)}</span>
              </div>
            ))}
          </div>
        </Panelito>
      </div>

      {/* Campañas + semana */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Panelito titulo="Desempeño por campaña" subtitulo="Cumplimiento, horas extra y tardanzas" className="xl:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground"><th className="pb-2 font-medium">Campaña</th><th className="pb-2 font-medium">Personas</th><th className="pb-2 font-medium">Jornadas</th><th className="w-56 pb-2 font-medium">Cumplimiento</th><th className="pb-2 font-medium">H. extra</th><th className="pb-2 font-medium">Tardanzas</th></tr></thead>
              <tbody>
                {campanasFiltradas.map((c) => (
                  <tr key={c.campana} className="border-t">
                    <td className="py-2 font-medium">{c.campana}</td>
                    <td className="py-2 tabular-nums">{n(c.personas)}</td>
                    <td className="py-2 tabular-nums">{n(c.jornadas)}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-brand-gradient" style={{ width: `${c.cumplimiento ?? 0}%` }} /></div>
                        <span className="w-12 text-right text-xs tabular-nums">{n(c.cumplimiento, 1)}%</span>
                      </div>
                    </td>
                    <td className="py-2 tabular-nums">{n(c.horas_extra, 1)}</td>
                    <td className="py-2 tabular-nums">{n(c.tarde)}</td>
                  </tr>
                ))}
                {!campanasFiltradas.length ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      {busqueda.trim() ? "No hay resultados para este filtro." : "Sin datos en el periodo."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panelito>
        <Panelito titulo="Incidencia por día de la semana" subtitulo="% de jornadas no completas">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={semana} margin={{ left: -20, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="nombre" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
              <YAxis unit="%" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="pct_incidencia" name="% incidencia" radius={[6, 6, 0, 0]}>
                {semana.map((s) => <Cell key={s.nombre} fill={s.pct_incidencia >= 25 ? C3 : s.pct_incidencia >= 15 ? C2 : C1} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panelito>
      </div>

      {/* Hora de llegada + horas extra + novedades */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Panelito titulo="Hora de llegada" subtitulo="Personas según hora de primera entrada">
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={(d?.horas_entrada ?? []).map((h) => ({ ...h, h: `${String(h.hora).padStart(2, "0")}:00` }))} margin={{ left: -20, right: 8, top: 8 }}>
              <XAxis dataKey="h" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="personas" name="Personas" fill={C2} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panelito>
        <Panelito titulo="Horas extra por día" subtitulo="Impacto en nómina">
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={serie} margin={{ left: -20, right: 8, top: 8 }}>
              <XAxis dataKey="dia" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="horas_extra" name="Horas extra" fill={C1} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panelito>
        <Panelito titulo="Novedades del periodo" subtitulo="Incapacidades, licencias, vacaciones…">
          {d?.novedades.length ? (
            <div className="space-y-2">
              {d.novedades.slice(0, 7).map((x, i) => {
                const max = d.novedades[0]!.total;
                return (
                  <div key={x.tipo}>
                    <div className="flex justify-between text-xs"><span>{x.tipo}</span><span className="tabular-nums text-muted-foreground">{n(x.total)}</span></div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${pct(x.total, max)}%`, background: PALETA[i % PALETA.length] }} /></div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">Sin novedades. <Link to="/novedades" className="text-primary underline">Cargar plantilla</Link></p>
          )}
        </Panelito>
      </div>

      {/* Rankings */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Ranking
          titulo="Mayor tiempo de llegada tarde"
          icon={AlarmClock}
          filas={topTardeFiltrado.map((t) => ({ nombre: t.nombre, sub: `${t.documento} · ${t.campana}`, valor: `${n(t.minutos / 60, 1)} h`, extra: `${t.veces} veces` }))}
        />
        <Ranking
          titulo="Mayor número de horas extra"
          icon={Activity}
          filas={topExtraFiltrado.map((t) => ({ nombre: t.nombre, sub: `${t.documento} · ${t.campana}`, valor: `${n(t.horas, 1)} h` }))}
        />
      </div>
      {bi.isFetching && !bi.isLoading ? <p className="text-center text-xs text-muted-foreground">Actualizando…</p> : null}
      {bi.error ? <p className="text-center text-sm text-destructive">{(bi.error as Error).message}</p> : null}
      <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground"><CalendarCheck className="size-3" /> Los datos respetan tu alcance (campañas asignadas) y solo incluyen al personal de empleadores que cuentan en reportes.</p>
    </div>
  );
}

function Gauge({ titulo, valor, detalle, cargando }: { titulo: string; valor: number; detalle: string; cargando: boolean }) {
  const v = Math.max(0, Math.min(100, valor));
  return (
    <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/30 p-4">
      <p className="text-xs text-sidebar-foreground/60">{titulo}</p>
      {cargando ? <Skeleton className="mt-2 h-8 w-24" /> : <p className="mt-1 font-display text-3xl font-semibold">{n(v, 1)}%</p>}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sidebar-border"><div className="h-full rounded-full bg-brand-gradient transition-all" style={{ width: `${v}%` }} /></div>
      <p className="mt-2 text-[11px] text-sidebar-foreground/55">{detalle}</p>
    </div>
  );
}

function Kpi({ icon: Icon, titulo, valor, tono, cargando }: { icon: typeof Users; titulo: string; valor: string; tono?: "accent" | "danger"; cargando: boolean }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{titulo}</p>
        <span className={cn("rounded-md p-1.5", tono === "danger" ? "bg-destructive/10 text-destructive" : tono === "accent" ? "bg-accent/15 text-accent" : "bg-primary/15 text-foreground")}><Icon className="size-3.5" /></span>
      </div>
      {cargando ? <Skeleton className="mt-2 h-7 w-20" /> : <p className="mt-1.5 font-display text-2xl font-semibold tabular-nums">{valor}</p>}
    </Card>
  );
}

function Panelito({ titulo, subtitulo, className, children }: { titulo: string; subtitulo?: string; className?: string; children: React.ReactNode }) {
  return (
    <Card className={cn("p-5", className)}>
      <p className="font-display text-sm font-semibold">{titulo}</p>
      {subtitulo ? <p className="mb-3 text-xs text-muted-foreground">{subtitulo}</p> : null}
      {children}
    </Card>
  );
}

function Ranking({ titulo, icon: Icon, filas }: { titulo: string; icon: typeof Users; filas: { nombre: string; sub: string; valor: string; extra?: string }[] }) {
  return (
    <Card className="p-5">
      <p className="mb-3 flex items-center gap-2 font-display text-sm font-semibold"><Icon className="size-4 text-accent" /> {titulo}</p>
      {filas.length ? (
        <ol className="space-y-2">
          {filas.map((f, i) => (
            <li key={f.sub} className="flex items-center gap-3">
              <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", i < 3 ? "bg-brand-gradient text-sidebar" : "bg-muted text-muted-foreground")}>{i + 1}</span>
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{f.nombre}</p><p className="truncate text-[11px] text-muted-foreground">{f.sub}</p></div>
              <div className="text-right"><p className="text-sm font-semibold tabular-nums">{f.valor}</p>{f.extra ? <p className="text-[11px] text-muted-foreground">{f.extra}</p> : null}</div>
            </li>
          ))}
        </ol>
      ) : <p className="py-6 text-center text-sm text-muted-foreground">Sin datos en el periodo.</p>}
    </Card>
  );
}
