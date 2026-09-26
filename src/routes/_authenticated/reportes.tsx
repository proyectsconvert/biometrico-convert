import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import {
  AlarmClock, CalendarX2, History, ClipboardList, Clock3, Download, FileSpreadsheet, Info, ListChecks, Loader2, Scale, Table2, TriangleAlert, Users,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { descargarCsv } from "@/lib/biometria";
import { PageHeader } from "@/components/app-shell";
import { Paginador, SimpleTable, ordenarFilas, usePaginado, type Orden } from "@/components/simple-table";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/reportes")({
  head: () => ({ meta: [{ title: "Reportes — Convert-IA" }] }),
  component: Reportes,
});

type Fila = Record<string, unknown>;
// Filas crudas de la base (columnas dinámicas)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Crudo = any;
type Filtros = { desde: string; hasta: string; campana: string; excluidos: boolean };
type Reporte = {
  id: string;
  grupo: string;
  titulo: string;
  descripcion: string;
  icon: typeof Users;
  cargar: (f: Filtros) => Promise<Fila[]>;
};

const args = (f: Filtros) => ({
  _desde: f.desde,
  _hasta: f.hasta,
  _campaign: f.campana === "todas" ? null : f.campana,
  _incluir_excluidos: f.excluidos,
});
async function rpc(nombre: string, f: Filtros) {
  const { data, error } = await supabase.rpc(nombre as never, args(f) as never);
  if (error) throw error;
  return (data as unknown as Fila[]) ?? [];
}
const hm = (m: unknown) => {
  const n = Number(m ?? 0);
  return n ? Math.round((n / 60) * 100) / 100 : 0;
};

const REPORTES: Reporte[] = [
  {
    id: "horas_empleado", grupo: "Asistencia y nómina", titulo: "Horas y recargos por empleado", icon: Clock3,
    descripcion: "Resumen del periodo por persona: días, horas trabajadas, extras diurnas y nocturnas, recargo nocturno, dominical/festivo y tardanzas. Formato de nómina.",
    cargar: (f) => rpc("reporte_asistencia_empleado", f),
  },
  {
    id: "campana", grupo: "Asistencia y nómina", titulo: "Asistencia por campaña", icon: Users,
    descripcion: "Personas, jornadas, cumplimiento y horas por campaña.",
    cargar: (f) => rpc("reporte_asistencia_campana", f),
  },
  {
    id: "diario", grupo: "Asistencia y nómina", titulo: "Control diario (detalle por día)", icon: Table2,
    descripcion: "Una fila por persona y día: entrada, salida, horas, extras, nocturnas, dominical/festivo y estado.",
    cargar: async (f) => {
      const out: Fila[] = [];
      for (let i = 0; i < 100; i++) {
        let q = dbAny
          .from("asistencia_reporte")
          .select("work_date, document, full_name, position, campaign_name, employer_name, shift_name, hora_entrada, hora_salida, worked_minutes, overtime_minutes, overtime_night_minutes, night_minutes, sunday_holiday_minutes, late_minutes, status")
          .gte("work_date", f.desde).lte("work_date", f.hasta)
          .order("work_date", { ascending: false }).order("full_name").range(i * 1000, i * 1000 + 999);
        if (!f.excluidos) q = q.eq("en_reportes", true);
        if (f.campana !== "todas") q = q.eq("campaign_id", f.campana);
        const { data, error } = await q;
        if (error) throw error;
        for (const r of (data ?? []) as Crudo[]) {
          out.push({
            fecha: r.work_date, documento: r.document, empleado: r.full_name, cargo: r.position, campana: r.campaign_name,
            empleador: r.employer_name, turno: r.shift_name, entrada: String(r.hora_entrada ?? "").slice(0, 5), salida: String(r.hora_salida ?? "").slice(0, 5),
            horas_trabajadas: hm(r.worked_minutes), extra_diurnas: hm(Number(r.overtime_minutes) - Number(r.overtime_night_minutes)),
            extra_nocturnas: hm(r.overtime_night_minutes), recargo_nocturno: hm(Math.max(0, Number(r.night_minutes) - Number(r.overtime_night_minutes))),
            dominical_festivo: hm(r.sunday_holiday_minutes), minutos_tarde: r.late_minutes, estado: r.status,
          });
        }
        if (!data || data.length < 1000) break;
      }
      return out;
    },
  },
  {
    id: "historico", grupo: "Control de marcaciones", titulo: "Histórico de marcaciones (consolidado)", icon: History,
    descripcion: "Todas las marcaciones válidas de cada persona en orden cronológico, ya unificadas de todos los CSV: número de marca en el día, cuál se tomó como entrada y salida, y cuántas veces venía en los archivos.",
    cargar: async (f) => {
      const out: Fila[] = [];
      for (let i = 0; i < 200; i++) {
        let q = dbAny
          .from("historico_marcaciones")
          .select("tenant_id, document, empleado, campana, fecha, event_at, device_name, door, event_type, is_duplicate, n_marca, marcas_dia")
          .gte("fecha", f.desde).lte("fecha", f.hasta)
          .order("document").order("event_at").range(i * 1000, i * 1000 + 999);
        if (!f.excluidos) q = q.eq("en_reportes", true);
        if (f.campana !== "todas") q = q.eq("campaign_id", f.campana);
        const { data, error } = await q;
        if (error) throw error;
        for (const x of (data ?? []) as Crudo[]) {
          out.push({
            documento: x.document, empleado: x.empleado, campana: x.campana, fecha: x.fecha,
            hora: String(x.event_at).slice(11, 19), n_marca: x.n_marca, marcas_dia: x.marcas_dia,
            toma_como: x.n_marca === 1 ? "Entrada" : x.n_marca === x.marcas_dia ? "Salida" : "",
            dispositivo: x.device_name, puerta: x.door, evento: x.event_type,
            repetida: x.is_duplicate ? "Sí" : "",
          });
        }
        if (!data || data.length < 1000) break;
      }
      return out;
    },
  },
  {
    id: "incompletas", grupo: "Control de marcaciones", titulo: "Marcaciones incompletas", icon: TriangleAlert,
    descripcion: "Días con una sola marcación (falta entrada o salida). Útil para corregir antes de liquidar.",
    cargar: (f) => rpc("reporte_incompletas", f),
  },
  {
    id: "ausentismo", grupo: "Control de marcaciones", titulo: "Ausentismo", icon: CalendarX2,
    descripcion: "Días laborales (sin festivos) en que personas activas que sí marcan en el periodo no registraron marcación, con la novedad reportada si existe.",
    cargar: (f) => rpc("reporte_ausentismo", f),
  },
  {
    id: "tardanzas", grupo: "Control de marcaciones", titulo: "Llegadas tarde", icon: AlarmClock,
    descripcion: "Entradas después de la hora del turno más la tolerancia. Requiere turnos asignados.",
    cargar: (f) => rpc("reporte_tardanzas", f),
  },
  {
    id: "novedades", grupo: "Novedades", titulo: "Novedades por empleado", icon: ClipboardList,
    descripcion: "Días por tipo de novedad (incapacidad, vacaciones, licencias…) y su estado.",
    cargar: (f) => rpc("reporte_novedades", f),
  },
  {
    id: "conciliacion", grupo: "Novedades", titulo: "Conciliación de nómina", icon: Scale,
    descripcion: "Plantilla de novedades frente al biométrico: lo reportado y lo que respalda la marcación, con el resultado y la revisión de nómina.",
    cargar: async (f) => {
      const { data, error } = await supabase.rpc("conciliacion_novedades" as never, { _desde: f.desde, _hasta: f.hasta } as never);
      if (error) throw error;
      const ESTADO: Record<string, string> = { coherente: "Coherente", advertencia: "Revisar días", inconsistente: "Inconsistente", sin_biometria: "Sin biometría", no_encontrado: "No encontrado" };
      return ((data as unknown as Crudo[]) ?? []).map((x: Crudo) => {
        const c = (x.conceptos as { clave: string; reportado: number; biometrico: number }[]) ?? [];
        const v = (k: string, t: "reportado" | "biometrico") => c.find((y) => y.clave === k)?.[t] ?? 0;
        return {
          documento: x.document, empleado: x.full_name, campana: x.campaign_label, periodo: `${x.period_start} a ${x.period_end}`,
          resultado: ESTADO[String(x.estado)] ?? x.estado,
          nocturnas_reportadas: v("nocturnas", "reportado"), nocturnas_biometrico: v("nocturnas", "biometrico"),
          dom_fest_reportadas: v("dom_fest", "reportado"), dom_fest_biometrico: v("dom_fest", "biometrico"),
          extra_diurnas_reportadas: v("extra_diurnas", "reportado"), extra_diurnas_biometrico: v("extra_diurnas", "biometrico"),
          extra_nocturnas_reportadas: v("extra_nocturnas", "reportado"), extra_nocturnas_biometrico: v("extra_nocturnas", "biometrico"),
          asiste_sin_marcacion: x.asiste_sin_marca, revision: x.review_status, comentario: x.review_comment,
        };
      });
    },
  },
];

const ETIQUETAS: Record<string, string> = {
  hora: "Hora", n_marca: "N.º de marca del día", marcas_dia: "Marcas en el día", toma_como: "Se toma como",
  dispositivo: "Dispositivo", puerta: "Puerta", evento: "Evento", repetida: "Repetida (pocos segundos)",
  documento: "Documento", empleado: "Empleado", cargo: "Cargo", campana: "Campaña", centro_costo: "Centro de costo", empleador: "Empleador",
  dias_marcados: "Días marcados", completas: "Completas", incompletas: "Incompletas", horas_trabajadas: "Horas trabajadas", horas_esperadas: "Horas esperadas",
  extra_diurnas: "Extra diurnas (1,25)", extra_nocturnas: "Extra nocturnas (1,75)", recargo_nocturno: "Recargo nocturno (0,35)", dominical_festivo: "Dominical/festivo",
  llegadas_tarde: "Llegadas tarde", minutos_tarde: "Minutos tarde", personas: "Personas", jornadas: "Jornadas", pct_completas: "% completas",
  fecha: "Fecha", unica_marcacion: "Única marcación", turno: "Turno", entrada: "Entrada", salida: "Salida", novedad: "Novedad reportada",
  tipo: "Tipo", dias: "Días", desde: "Desde", hasta: "Hasta", estado: "Estado", periodo: "Periodo", resultado: "Resultado",
  nocturnas_reportadas: "Nocturnas reportadas", nocturnas_biometrico: "Nocturnas biométrico", dom_fest_reportadas: "Dom/fest reportadas",
  dom_fest_biometrico: "Dom/fest biométrico", extra_diurnas_reportadas: "Extra diurnas reportadas", extra_diurnas_biometrico: "Extra diurnas biométrico",
  extra_nocturnas_reportadas: "Extra nocturnas reportadas", extra_nocturnas_biometrico: "Extra nocturnas biométrico",
  asiste_sin_marcacion: "«Asiste» sin marcación", revision: "Revisión nómina", comentario: "Comentario",
};
const etiqueta = (k: string) => ETIQUETAS[k] ?? k.replace(/_/g, " ");
const fmt = (v: unknown) =>
  v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? v.toLocaleString("es-CO", { maximumFractionDigits: 2 }) : String(v);

const iso = (d: Date) => d.toISOString().slice(0, 10);

function Reportes() {
  const acceso = useAccess();
  const [reporteId, setReporteId] = useState(REPORTES[0]!.id);
  const [f, setF] = useState<Filtros>({ desde: "", hasta: "", campana: "todas", excluidos: false });
  const [aplicados, setAplicados] = useState<Filtros | null>(null);
  const [orden, setOrden] = useState<Orden | null>(null);
  const puedeExportar = acceso.can("reportes", "exportar");
  const reporte = REPORTES.find((r) => r.id === reporteId)!;

  // Periodo inicial: el mes del último dato cargado
  const ultimo = useQuery({
    queryKey: ["reportes", "ultimo-dia"],
    queryFn: async () => {
      const { data } = await supabase.from("attendance_daily").select("work_date").order("work_date", { ascending: false }).limit(1);
      return (data?.[0]?.work_date as string | undefined) ?? iso(new Date());
    },
  });
  useEffect(() => {
    if (!ultimo.data || f.desde) return;
    const ini = `${ultimo.data.slice(0, 8)}01`;
    const nf = { ...f, desde: ini, hasta: ultimo.data };
    setF(nf);
    setAplicados(nf);
  }, [ultimo.data, f]);

  const campanas = useQuery({
    queryKey: ["campanas-simple"],
    queryFn: async () => {
      const { data } = await supabase.from("campaigns").select("id, name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const vinculado = useQuery({
    queryKey: ["reportes", "mi-empleado", acceso.userId],
    queryFn: async () => {
      const { data } = await supabase.from("employees").select("full_name, document").eq("user_id", acceso.userId).maybeSingle();
      return data as { full_name: string; document: string } | null;
    },
  });

  const datos = useQuery({
    queryKey: ["reportes", reporteId, aplicados],
    enabled: Boolean(aplicados),
    queryFn: () => reporte.cargar(aplicados!),
  });
  useEffect(() => setOrden(null), [reporteId]);

  const filas = useMemo(() => ordenarFilas(datos.data ?? [], orden), [datos.data, orden]);
  const pag = usePaginado(filas, 20);
  const columnas = useMemo(() => Object.keys(datos.data?.[0] ?? {}), [datos.data]);
  const totales = useMemo(() => {
    const t: Record<string, number> = {};
    for (const c of columnas) {
      if (["documento", "dias_marcados"].includes(c) || c.startsWith("pct")) continue;
      const nums = (datos.data ?? []).map((r) => r[c]).filter((v) => typeof v === "number") as number[];
      if (nums.length && nums.length === (datos.data ?? []).length) t[c] = Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
    }
    return t;
  }, [datos.data, columnas]);

  // Qué alcance tiene quien consulta (la base de datos aplica el mismo límite)
  const alcanceTexto = acceso.isSuperAdmin || ["plataforma", "mi_empresa"].includes(acceso.scope)
    ? "Toda la empresa"
    : acceso.campaignIds.length
      ? `Campañas asignadas: ${acceso.campaignIds.map((id) => campanas.data?.find((c) => c.id === id)?.name ?? "…").join(", ")}`
      : vinculado.data
        ? `Solo tu información (${vinculado.data.full_name})`
        : "Solo tu información";

  function descargar(tipo: "xlsx" | "csv") {
    if (!aplicados || !filas.length) return;
    const nombre = `${reporte.id}_${aplicados.desde}_${aplicados.hasta}`;
    const conEtiquetas = filas.map((r) => Object.fromEntries(columnas.map((c) => [etiqueta(c), r[c] ?? ""])));
    if (tipo === "csv") {
      descargarCsv(nombre, conEtiquetas);
      return;
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(conEtiquetas);
    ws["!cols"] = columnas.map((c) => ({ wch: Math.max(10, Math.min(40, etiqueta(c).length + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, reporte.titulo.slice(0, 31));
    const campana = aplicados.campana === "todas" ? "Todas las visibles" : campanas.data?.find((c) => c.id === aplicados.campana)?.name ?? "";
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Reporte", reporte.titulo],
        ["Periodo", `${aplicados.desde} a ${aplicados.hasta}`],
        ["Campaña", campana],
        ["Personal excluido (seguridad, aseo…)", aplicados.excluidos ? "Incluido" : "No incluido"],
        ["Alcance de quien descarga", alcanceTexto],
        ["Generado por", `${acceso.fullName} (${acceso.email})`],
        ["Fecha de generación", new Date().toLocaleString("es-CO")],
        ["Filas", filas.length],
      ]),
      "Información",
    );
    XLSX.writeFile(wb, `${nombre}.xlsx`);
    toast.success("Reporte descargado", { description: "Contiene información de Convertia: no la compartas fuera de la organización." });
  }

  const grupos = [...new Set(REPORTES.map((r) => r.grupo))];

  return (
    <div>
      <PageHeader titulo="Reportes" descripcion="Informes listos para revisar y descargar. Solo incluyen la información que tu usuario puede ver." />

      <Card className="mb-4 flex flex-wrap items-center gap-2 border-primary/30 bg-primary/5 p-3 text-sm">
        <Info className="size-4 text-primary" />
        <span><strong>Estás viendo:</strong> {alcanceTexto}.</span>
        {!acceso.isSuperAdmin && acceso.scope === "solo_yo" && !acceso.campaignIds.length && vinculado.isSuccess && !vinculado.data ? (
          <span className="text-amber-700 dark:text-amber-400">Tu usuario no está vinculado a un empleado; pide a un administrador que lo vincule en Usuarios.</span>
        ) : null}
      </Card>

      <div className="grid gap-5 xl:grid-cols-[300px_1fr]">
        <div className="space-y-4">
          {grupos.map((g) => (
            <div key={g}>
              <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g}</p>
              <div className="space-y-1.5">
                {REPORTES.filter((r) => r.grupo === g).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setReporteId(r.id)}
                    className={cn("flex w-full items-start gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary", r.id === reporteId && "border-primary ring-1 ring-primary")}
                  >
                    <span className="rounded-lg bg-primary/10 p-2"><r.icon className="size-4" /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{r.titulo}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{r.descripcion}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="p-4">
            <div className="mb-3 flex items-start gap-3">
              <span className="rounded-lg bg-primary/10 p-2"><reporte.icon className="size-5" /></span>
              <div>
                <h2 className="font-display text-lg font-semibold">{reporte.titulo}</h2>
                <p className="text-sm text-muted-foreground">{reporte.descripcion}</p>
              </div>
            </div>
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setAplicados({ ...f }); }}>
              <div className="space-y-1.5"><Label>Desde</Label><Input type="date" value={f.desde} onChange={(e) => setF({ ...f, desde: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Hasta</Label><Input type="date" value={f.hasta} onChange={(e) => setF({ ...f, hasta: e.target.value })} /></div>
              <div className="flex gap-1 pb-0.5">
                {[
                  ["1Q", 1, 15],
                  ["2Q", 16, 31],
                ].map(([l, a, b]) => (
                  <Button key={String(l)} type="button" variant="ghost" size="sm" onClick={() => {
                    const base = f.hasta || ultimo.data || iso(new Date());
                    const [y, m] = base.split("-").map(Number);
                    const fin = Math.min(Number(b), new Date(Date.UTC(y!, m!, 0)).getUTCDate());
                    setF({ ...f, desde: `${base.slice(0, 8)}${String(a).padStart(2, "0")}`, hasta: `${base.slice(0, 8)}${String(fin).padStart(2, "0")}` });
                  }}>{l}</Button>
                ))}
                <Button type="button" variant="ghost" size="sm" onClick={() => {
                  const base = f.hasta || ultimo.data || iso(new Date());
                  const [y, m] = base.split("-").map(Number);
                  setF({ ...f, desde: `${base.slice(0, 8)}01`, hasta: iso(new Date(Date.UTC(y!, m!, 0))) });
                }}>Mes</Button>
              </div>
              {reporteId !== "conciliacion" ? (
                <>
                  <div className="space-y-1.5">
                    <Label>Campaña</Label>
                    <Select value={f.campana} onValueChange={(v) => setF({ ...f, campana: v })}>
                      <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="todas">Todas las que puedo ver</SelectItem>
                        {(campanas.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center gap-2 pb-2 text-sm">
                    <Switch checked={f.excluidos} onCheckedChange={(v) => setF({ ...f, excluidos: v })} />
                    Incluir personal excluido
                  </label>
                </>
              ) : null}
              <Button type="submit"><ListChecks className="size-4" /> Generar</Button>
              {puedeExportar ? (
                <div className="ml-auto flex gap-2">
                  <Button type="button" variant="outline" disabled={!filas.length} onClick={() => descargar("csv")}><Download className="size-4" /> CSV</Button>
                  <Button type="button" disabled={!filas.length} onClick={() => descargar("xlsx")}><FileSpreadsheet className="size-4" /> Excel</Button>
                </div>
              ) : (
                <p className="ml-auto self-center text-xs text-muted-foreground">Tu rol no tiene permiso para descargar reportes.</p>
              )}
            </form>
          </Card>

          {datos.isFetching ? (
            <Card className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Generando reporte…</Card>
          ) : datos.error ? (
            <Card className="p-6 text-sm text-destructive">{(datos.error as Error).message}</Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium tabular-nums">{filas.length.toLocaleString("es-CO")} filas</span>
                {Object.entries(totales).slice(0, 6).map(([k, v]) => (
                  <span key={k} className="rounded-md bg-muted px-2 py-0.5 text-xs">{etiqueta(k)}: <strong className="tabular-nums">{fmt(v)}</strong></span>
                ))}
              </div>
              <SimpleTable
                filas={pag.visibles}
                getKey={(_, i) => String(i)}
                orden={orden}
                onOrden={setOrden}
                vacio={reporteId === "tardanzas" ? "No hay llegadas tarde. Recuerda que se necesitan turnos asignados (módulo Turnos)." : "No hay datos para estos filtros o para tu alcance."}
                columnas={columnas.map((c) => ({
                  key: c,
                  orden: c,
                  header: <span className="whitespace-nowrap">{etiqueta(c)}</span>,
                  className: typeof datos.data?.[0]?.[c] === "number" ? "text-right tabular-nums" : "",
                  cell: (r: Fila) => <span className={c === "empleado" ? "font-medium" : ""}>{fmt(r[c])}</span>,
                }))}
              />
              <Paginador {...pag.paginador} />
            </>
          )}
          <p className="text-xs text-muted-foreground">
            ¿Necesitas corregir algo? Las marcaciones se revisan en <Link to="/asistencia" className="text-primary underline">Control diario</Link> y las novedades en <Link to="/novedades" className="text-primary underline">Novedades</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
