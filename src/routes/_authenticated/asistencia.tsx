import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, Loader2, RefreshCw, Search, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { recalcularAsistencia } from "@/lib/asistencia.functions";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { descargarCsv } from "@/lib/biometria";
import { PageHeader } from "@/components/app-shell";
import { Paginador, SimpleTable, type Orden } from "@/components/simple-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { MultiSelectFilter } from "@/components/multi-select-filter";
import { useFiltroCampanaPersonas } from "@/lib/filtro-personas";

export const Route = createFileRoute("/_authenticated/asistencia")({
  head: () => ({ meta: [{ title: "Control diario — Convert-IA" }] }),
  component: Asistencia,
});

type Fila = {
  id: string;
  work_date: string;
  document: string;
  full_name: string;
  position: string | null;
  employer_name: string | null;
  campaign_name: string | null;
  cost_center_name: string | null;
  shift_name: string | null;
  first_in: string | null;
  last_out: string | null;
  worked_minutes: number | null;
  stay_minutes: number;
  break_applied_minutes: number;
  expected_minutes: number | null;
  late_minutes: number | null;
  overtime_minutes: number;
  night_minutes: number;
  sunday_holiday_minutes: number;
  is_rest_day: boolean;
  is_manual: boolean;
  status: string;
  en_reportes: boolean;
};

type Evento = {
  id: number;
  event_at: string;
  device_name: string | null;
  door: string | null;
  event_type: string;
  is_attendance: boolean;
  is_duplicate: boolean;
};

type Filtros = {
  desde: string;
  hasta: string;
  texto: string;
  personal: string;
  estado: string;
  campanas: string[];
  personas: string[];
};

const COLUMNAS =
  "id, work_date, document, full_name, position, employer_name, campaign_name, cost_center_name, shift_name, first_in, last_out, worked_minutes, expected_minutes, late_minutes, overtime_minutes, night_minutes, sunday_holiday_minutes, is_rest_day, is_manual, status, en_reportes, stay_minutes, break_applied_minutes";

const ESTADOS: Record<string, { label: string; clase: string }> = {
  completa: { label: "Completa", clase: "bg-emerald-600 text-white hover:bg-emerald-600" },
  incompleta: { label: "Incompleta", clase: "border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/60 dark:text-amber-300" },
  sin_marcacion: { label: "Sin marcación", clase: "bg-destructive/15 text-destructive hover:bg-destructive/15" },
};

function horas(min: number | null | undefined) {
  if (!min) return "0:00";
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}
const hora = (v: string | null) => (v ? v.slice(11, 16) : "—");
const fechaLocal = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aplicarFiltros(q: any, f: Filtros) {
  q = q.gte("work_date", f.desde).lte("work_date", f.hasta);
  if (f.personal === "reportes") q = q.eq("en_reportes", true);
  else if (f.personal === "excluidos") q = q.eq("en_reportes", false);
  else if (f.personal === "sin") q = q.is("employer_id", null);
  else if (f.personal !== "todos") q = q.eq("employer_id", f.personal);
  if (f.estado !== "todos") q = q.eq("status", f.estado);
  if (f.campanas && f.campanas.length > 0) q = q.in("campaign_id", f.campanas);
  if (f.personas && f.personas.length > 0) q = q.in("document", f.personas);
  const t = f.texto.trim();
  if (t) {
    if (/^\d+$/.test(t)) {
      q = q.eq("document", t);
    } else {
      const clean = t.replace(/[%,()]/g, " ").trim();
      q = q.or(`full_name.ilike.%${clean}%,campaign_name.ilike.%${clean}%,position.ilike.%${clean}%`);
    }
  }
  return q;
}

function Asistencia() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [f, setF] = useState<Filtros>({
    desde: fechaLocal(),
    hasta: fechaLocal(),
    texto: "",
    personal: "reportes",
    estado: "todos",
    campanas: [],
    personas: [],
  });
  const [texto, setTexto] = useState("");
  const [pagina, setPagina] = useState(0);
  const [TAMANO, setTamano] = useState(50);
  // Orden por defecto: fecha más reciente y nombre; clic en un encabezado para cambiarlo
  const [orden, setOrden] = useState<Orden | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ordenar = (q: any) =>
    orden
      ? q.order(orden.col, { ascending: orden.asc, nullsFirst: false }).order("full_name")
      : q.order("work_date", { ascending: false }).order("full_name");
  const [abierta, setAbierta] = useState<string | null>(null);
  const [anclado, setAnclado] = useState(false);
  const [exportando, setExportando] = useState(false);

  // Abrir en el último día con datos, no en «hoy» (que suele estar vacío)
  const ultimo = useQuery({
    queryKey: ["asistencia", "ultimo-dia"],
    queryFn: async () => {
      const { data } = await supabase.from("attendance_daily").select("work_date").order("work_date", { ascending: false }).limit(1);
      return (data?.[0]?.work_date as string | undefined) ?? null;
    },
  });
  useEffect(() => {
    if (!anclado && ultimo.isSuccess) {
      setAnclado(true);
      if (ultimo.data) setF((p) => ({ ...p, desde: ultimo.data!, hasta: ultimo.data! }));
    }
  }, [anclado, ultimo.isSuccess, ultimo.data]);

  useEffect(() => { setPagina(0); setAbierta(null); }, [f]);

  const empleadores = useQuery({
    queryKey: ["employers", "opciones"],
    queryFn: async () => {
      const { data } = await dbAny.from("employers").select("id, name, include_in_reports").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const campanas = useQuery({
    queryKey: ["campaigns", "opciones"],
    queryFn: async () => {
      const { data } = await dbAny.from("campaigns").select("id, name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });


  const todasCampanas = (campanas.data ?? []).map((c) => ({ value: c.id, label: c.name }));
  // Campañas y personas coherentes entre sí y en orden alfabético
  const { opcionesCampanas, opcionesPersonas, placeholderCampanas, placeholderPersonas } = useFiltroCampanaPersonas({ opcionesCampanas: todasCampanas, campanas: f.campanas, personas: f.personas, alCambiarPersonas: (personas) => setF((p) => ({ ...p, personas })) });

  const lista = useQuery({
    queryKey: ["asistencia", "lista", f, pagina, TAMANO, orden],
    enabled: anclado,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const q = ordenar(aplicarFiltros(dbAny.from("asistencia_reporte").select(COLUMNAS, { count: "exact" }), f))
        .range(pagina * TAMANO, pagina * TAMANO + TAMANO - 1);
      const { data, error, count } = await q;
      if (error) throw error;
      return { filas: (data ?? []) as Fila[], total: count ?? 0 };
    },
  });

  // Conteo por estado con los mismos filtros (sin el filtro de estado)
  const resumen = useQuery({
    queryKey: ["asistencia", "resumen", { ...f, estado: "todos" }],
    enabled: anclado,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const base = { ...f, estado: "todos" };
      const contar = async (estado: string) => {
        const { count, error } = await aplicarFiltros(dbAny.from("asistencia_reporte").select("id", { count: "exact", head: true }), { ...base, estado });
        if (error) throw error;
        return count ?? 0;
      };
      const [total, completa, incompleta] = await Promise.all([contar("todos"), contar("completa"), contar("incompleta")]);
      return { total, completa, incompleta };
    },
  });

  const recalcularServidor = useServerFn(recalcularAsistencia);
  const recalcular = useMutation({
    mutationFn: async () => {
      await recalcularServidor({ data: { desde: f.desde, hasta: f.hasta } });
    },
    onSuccess: () => {
      toast.success("Asistencia recalculada");
      void qc.invalidateQueries({ queryKey: ["asistencia"] });
    },
    onError: (e: Error) => toast.error("No se pudo recalcular", { description: e.message }),
  });

  async function exportar() {
    setExportando(true);
    try {
      const todas: Fila[] = [];
      for (let i = 0; i < 100; i++) {
        const { data, error } = await ordenar(aplicarFiltros(dbAny.from("asistencia_reporte").select(COLUMNAS), f))
          .range(i * 1000, i * 1000 + 999);
        if (error) throw error;
        todas.push(...((data ?? []) as Fila[]));
        if (!data || data.length < 1000) break;
      }
      descargarCsv(
        `control_diario_${f.desde}_${f.hasta}`,
        todas.map((x) => ({
          fecha: x.work_date,
          documento: x.document,
          empleado: x.full_name,
          empleador: x.employer_name ?? "",
          campana: x.campaign_name ?? "",
          centro_costo: x.cost_center_name ?? "",
          turno: x.shift_name ?? "",
          entrada: hora(x.first_in),
          salida: hora(x.last_out),
          tiempo_en_empresa: horas(x.stay_minutes),
          descanso_descontado: horas(x.break_applied_minutes),
          horas_trabajadas: horas(x.worked_minutes),
          horas_esperadas: horas(x.expected_minutes),
          horas_extra: horas(x.overtime_minutes),
          horas_nocturnas: horas(x.night_minutes),
          horas_dom_festivo: horas(x.sunday_holiday_minutes),
          minutos_tarde: x.late_minutes ?? 0,
          estado: ESTADOS[x.status]?.label ?? x.status,
        })),
      );
    } catch (e) {
      toast.error("No se pudo exportar", { description: (e as Error).message });
    } finally {
      setExportando(false);
    }
  }

  const hayFiltrosActivos =
    f.campanas.length > 0 ||
    f.personas.length > 0 ||
    f.personal !== "reportes" ||
    f.estado !== "todos" ||
    Boolean(f.texto);

  const r = resumen.data;
  const filas = lista.data?.filas ?? [];

  return (
    <div>
      <PageHeader
        titulo="Control diario"
        descripcion="Entrada (primera marcación exitosa) y salida (última) de cada persona por día. Haz clic en una fila para ver todas sus marcaciones."
        acciones={
          <>
            {acceso.can("asistencia", "exportar") ? (
              <Button variant="outline" onClick={exportar} disabled={exportando || !r?.total}>
                {exportando ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Exportar
              </Button>
            ) : null}
            {acceso.can("asistencia", "editar") ? (
              <Button onClick={() => recalcular.mutate()} disabled={recalcular.isPending}>
                <RefreshCw className={cn("size-4", recalcular.isPending && "animate-spin")} /> Recalcular
              </Button>
            ) : null}
          </>
        }
      />

      <Card className="mb-4 p-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); setF((p) => ({ ...p, texto })); }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="desde">Desde</Label>
            <Input id="desde" type="date" value={f.desde} onChange={(e) => setF((p) => ({ ...p, desde: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hasta">Hasta</Label>
            <Input id="hasta" type="date" value={f.hasta} onChange={(e) => setF((p) => ({ ...p, hasta: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Campañas</Label>
            <MultiSelectFilter
              title="Campañas"
              placeholder={placeholderCampanas}
              searchPlaceholder="Buscar campaña…"
              options={opcionesCampanas}
              selected={f.campanas}
              onChange={(campanas) => setF((p) => ({ ...p, campanas }))}
              triggerClassName="w-48"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Personas</Label>
            <MultiSelectFilter
              title="Personas"
              placeholder={placeholderPersonas}
              searchPlaceholder="Buscar por cédula o nombre…"
              options={opcionesPersonas}
              selected={f.personas}
              onChange={(personas) => setF((p) => ({ ...p, personas }))}
              triggerClassName="w-52"
              popoverWidth="w-[340px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Personal</Label>
            <Select value={f.personal} onValueChange={(v) => setF((p) => ({ ...p, personal: v }))}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="reportes">Solo en reportes</SelectItem>
                <SelectItem value="todos">Todo el personal</SelectItem>
                <SelectItem value="excluidos">Excluidos</SelectItem>
                <SelectItem value="sin">Sin empleador</SelectItem>
                {(empleadores.data ?? []).map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="q">Búsqueda libre</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="q"
                className="pl-9"
                placeholder="Cédula, nombre, cargo, etc."
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit"><Search className="size-4" /> Filtrar</Button>
            {hayFiltrosActivos && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setTexto("");
                  setF((p) => ({
                    ...p,
                    texto: "",
                    campanas: [],
                    personas: [],
                    personal: "reportes",
                    estado: "todos",
                  }));
                }}
              >
                <X className="size-4 mr-1" /> Limpiar
              </Button>
            )}
          </div>
        </form>
      </Card>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {[
          { k: "todos", t: "Jornadas", v: r?.total },
          { k: "completa", t: "Completas", v: r?.completa },
          { k: "incompleta", t: "Incompletas (1 marcación)", v: r?.incompleta },
        ].map((c) => (
          <button
            key={c.k}
            type="button"
            onClick={() => setF((p) => ({ ...p, estado: c.k }))}
            className={cn("rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary", f.estado === c.k && "border-primary ring-1 ring-primary")}
          >
            <p className="text-xs text-muted-foreground">{c.t}</p>
            <p className="text-2xl font-semibold tabular-nums">{c.v === undefined ? "…" : c.v.toLocaleString("es-CO")}</p>
          </button>
        ))}
      </div>

      <SimpleTable<Fila>
        cargando={lista.isLoading || !anclado}
        filas={filas}
        getKey={(x) => x.id}
        orden={orden}
        onOrden={(o) => { setOrden(o); setPagina(0); }}
        expandida={abierta}
        onFilaClick={(x) => setAbierta((a) => (a === x.id ? null : x.id))}
        detalle={(x) => <MarcacionesDelDia fila={x} />}
        vacio="No hay jornadas para estos filtros. Si acabas de importar, pulsa Recalcular o revisa el rango de fechas."
        columnas={[
          { key: "x", header: "", className: "w-6", cell: (x) => (abierta === x.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4 text-muted-foreground" />) },
          { key: "fecha", orden: "work_date", header: "Fecha", cell: (x) => <span className="tabular-nums">{x.work_date}</span> },
          {
            key: "empleado", orden: "full_name",
            header: "Empleado",
            cell: (x) => (
              <div>
                <p className="font-medium">{x.full_name}</p>
                <p className="text-xs text-muted-foreground">
                  {x.document}
                  {x.campaign_name ? ` · ${x.campaign_name}` : ""}
                  {x.cost_center_name ? ` · ${x.cost_center_name}` : ""}
                </p>
              </div>
            ),
          },
          {
            key: "empleador", orden: "employer_name",
            header: "Empleador",
            cell: (x) => <span className={cn("text-xs", !x.en_reportes && "text-muted-foreground line-through")}>{x.employer_name ?? "Sin empleador"}</span>,
          },
          { key: "in", orden: "hora_entrada", header: "Entrada", cell: (x) => <span className="tabular-nums">{hora(x.first_in)}</span> },
          { key: "out", orden: "hora_salida", header: "Salida", cell: (x) => <span className="tabular-nums">{hora(x.last_out)}</span> },
          { key: "estancia", orden: "stay_minutes", header: "En empresa", cell: (x) => <span className="tabular-nums" title="Tiempo total entre la primera y la última marcación">{horas(x.stay_minutes)}</span> },
          { key: "desc", orden: "break_applied_minutes", header: "Descanso", cell: (x) => <span className="tabular-nums text-muted-foreground">{x.break_applied_minutes ? `−${horas(x.break_applied_minutes)}` : "—"}</span> },
          { key: "trab", orden: "worked_minutes", header: "Horas", cell: (x) => <span className="tabular-nums">{horas(x.worked_minutes)}</span> },
          { key: "extra", orden: "overtime_minutes", header: "Extra", cell: (x) => <span className="tabular-nums">{x.overtime_minutes ? horas(x.overtime_minutes) : "—"}</span> },
          { key: "noct", orden: "night_minutes", header: "Nocturnas", cell: (x) => <span className="tabular-nums">{x.night_minutes ? horas(x.night_minutes) : "—"}</span> },
          { key: "dom", orden: "sunday_holiday_minutes", header: "Dom/Fest.", cell: (x) => (x.sunday_holiday_minutes ? horas(x.sunday_holiday_minutes) : x.is_rest_day ? "descanso" : "—") },
          { key: "tarde", orden: "late_minutes", header: "Tarde", cell: (x) => (x.late_minutes ? `${x.late_minutes} min` : "—") },
          {
            key: "estado", orden: "status",
            header: "Estado",
            cell: (x) => (
              <Badge className={ESTADOS[x.status]?.clase} variant="secondary">
                {ESTADOS[x.status]?.label ?? x.status}{x.is_manual ? " · ajustada" : ""}
              </Badge>
            ),
          },
        ]}
      />
      <Paginador pagina={pagina} tamano={TAMANO} total={lista.data?.total ?? 0} onCambio={setPagina} onTamano={setTamano} opciones={[10, 20, 30, 40, 50, 100]} />
    </div>
  );
}

function MarcacionesDelDia({ fila }: { fila: Fila }) {
  const fin = fila.last_out && fila.last_out > `${fila.work_date}T23:59:59` ? fila.last_out : `${fila.work_date}T23:59:59`;
  const eventos = useQuery({
    queryKey: ["marcaciones", "dia", fila.document, fila.work_date],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("biometric_events")
        .select("id, event_at, device_name, door, event_type, is_attendance, is_duplicate")
        .eq("document", fila.document)
        .gte("event_at", `${fila.work_date}T00:00:00`)
        .lte("event_at", fin)
        .order("event_at");
      if (error) throw error;
      return (data ?? []) as Evento[];
    },
  });

  if (eventos.isLoading) return <p className="p-4 text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Cargando marcaciones…</p>;
  const lista = eventos.data ?? [];
  if (!lista.length) return <p className="p-4 text-sm text-muted-foreground">No hay eventos del biométrico para esta jornada.</p>;

  return (
    <div className="px-10 py-3">
      <ol className="space-y-1 border-l pl-4">
        {lista.map((e) => {
          const esEntrada = fila.first_in && e.event_at.slice(0, 19) === fila.first_in.slice(0, 19);
          const esSalida = fila.last_out && e.event_at.slice(0, 19) === fila.last_out.slice(0, 19);
          return (
            <li key={e.id} className={cn("flex flex-wrap items-center gap-x-3 text-xs", !e.is_attendance && "text-muted-foreground")}>
              <span className="w-16 font-medium tabular-nums">{e.event_at.slice(11, 19)}</span>
              <span className="min-w-56">{e.device_name ?? "—"}{e.door ? ` · ${e.door}` : ""}</span>
              <span>{e.event_type}</span>
              {esEntrada ? <Badge className="h-5 bg-emerald-600 text-white hover:bg-emerald-600">Entrada tomada</Badge> : null}
              {esSalida ? <Badge className="h-5 bg-sky-600 text-white hover:bg-sky-600">Salida tomada</Badge> : null}
              {e.is_duplicate ? <Badge variant="secondary" className="h-5">duplicada</Badge> : null}
              {!e.is_attendance ? <Badge variant="outline" className="h-5">no cuenta</Badge> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
