import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { descargarCsv } from "@/lib/biometria";
import {
  CONCEPTOS,
  TIPOS_NOVEDAD,
  colorTipo,
  diaSemana,
  leerPlantilla,
  rangoFechas,
  type CampoConcepto,
} from "@/lib/novedades";
import { PageHeader } from "@/components/app-shell";
import { ConciliacionNovedades } from "@/components/conciliacion-novedades";
import { SimpleTable, Paginador, usePaginado } from "@/components/simple-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/novedades")({
  head: () => ({ meta: [{ title: "Novedades — Convert-IA" }] }),
  component: Novedades,
});

type Entrada = {
  id: string;
  document: string;
  full_name: string | null;
  position: string | null;
  campaign_label: string | null;
  work_date: string;
  novelty_type: string;
  source: string;
  status: string;
  notes: string | null;
};

type Reporte = {
  id: string;
  filename: string;
  sheet_name: string | null;
  campaign_label: string | null;
  period_start: string | null;
  period_end: string | null;
  employees_count: number;
  days_count: number;
  status: string;
  error_message: string | null;
  created_at: string;
};

type Total = { id: string; document: string; full_name: string | null; campaign_label: string | null; period_start: string; period_end: string; observaciones: string | null; source: string } & Record<CampoConcepto, number>;

const iso = (d: Date) => d.toISOString().slice(0, 10);
function quincenaActual() {
  const h = new Date();
  const y = h.getFullYear();
  const m = h.getMonth();
  return h.getDate() <= 15
    ? { desde: iso(new Date(Date.UTC(y, m, 1))), hasta: iso(new Date(Date.UTC(y, m, 15))) }
    : { desde: iso(new Date(Date.UTC(y, m, 16))), hasta: iso(new Date(Date.UTC(y, m + 1, 0))) };
}

async function traerTodo<T>(armar: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = [];
  for (let i = 0; i < 30; i++) {
    const { data, error } = await armar(i * 1000, i * 1000 + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function Novedades() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const q0 = quincenaActual();
  const [desde, setDesde] = useState(q0.desde);
  const [hasta, setHasta] = useState(q0.hasta);
  const [texto, setTexto] = useState("");
  const [buscar, setBuscar] = useState("");
  const [cargaAbierta, setCargaAbierta] = useState(false);
  const [manualAbierta, setManualAbierta] = useState(false);
  const [generarAbierta, setGenerarAbierta] = useState(false);
  const [celda, setCelda] = useState<{ document: string; nombre: string; fecha: string; entrada?: Entrada } | null>(null);

  const puedeImportar = acceso.can("novedades", "importar");
  const puedeCrear = acceso.can("novedades", "crear");
  const puedeAprobar = acceso.can("novedades", "aprobar");
  const puedeEliminar = acceso.can("novedades", "eliminar");
  const [conExcluidos, setConExcluidos] = useState(false);
  const [campanasSel, setCampanasSel] = useState<string[]>([]);
  const [personasSel, setPersonasSel] = useState<string[]>([]);

  // Documentos del personal que no cuenta en reportes (seguridad, aseo, contratistas)
  const excluidos = useQuery({
    queryKey: ["employees", "documentos-excluidos"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("documentos_excluidos" as never);
      if (error) throw error;
      return new Set((data as unknown as string[] | null) ?? []);
    },
  });

  const campanas = useQuery({
    queryKey: ["campaigns", "opciones-nov"],
    queryFn: async () => {
      const { data } = await supabase.from("campaigns").select("id, name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const empleados = useQuery({
    queryKey: ["empleados-opciones-nov"],
    queryFn: async () => {
      const { data } = await supabase
        .from("employees")
        .select("id, document, full_name, position")
        .order("full_name")
        .limit(3000);
      return (data ?? []) as { id: string; document: string; full_name: string; position: string | null }[];
    },
  });

  const opcionesCampanas = (campanas.data ?? []).map((c) => ({ value: c.name, label: c.name }));
  const opcionesPersonas = (empleados.data ?? []).map((e) => ({
    value: e.document,
    label: e.full_name,
    sublabel: `${e.document}${e.position ? ` · ${e.position}` : ""}`,
  }));

  const entradas = useQuery({
    queryKey: ["nov-entradas", desde, hasta, campanasSel, personasSel, buscar],
    queryFn: () =>
      traerTodo<Entrada>((a, b) => {
        let q = supabase
          .from("novelty_entries")
          .select("id, document, full_name, position, campaign_label, work_date, novelty_type, source, status, notes")
          .gte("work_date", desde)
          .lte("work_date", hasta)
          .order("full_name")
          .order("work_date")
          .range(a, b);
        if (campanasSel.length > 0) q = q.in("campaign_label", campanasSel);
        if (personasSel.length > 0) q = q.in("document", personasSel);
        const t = buscar.trim();
        if (t) q = /^\d+$/.test(t) ? q.eq("document", t) : q.or(`full_name.ilike.%${t}%,campaign_label.ilike.%${t}%`);
        return q;
      }),
  });

  const totales = useQuery({
    queryKey: ["nov-totales", desde, hasta, campanasSel, personasSel, buscar],
    queryFn: async () => {
      let q = supabase.from("novelty_totals").select("*").lte("period_start", hasta).gte("period_end", desde).order("full_name").limit(1000);
      if (campanasSel.length > 0) q = q.in("campaign_label", campanasSel);
      if (personasSel.length > 0) q = q.in("document", personasSel);
      const t = buscar.trim();
      if (t) q = /^\d+$/.test(t) ? q.eq("document", t) : q.or(`full_name.ilike.%${t}%,campaign_label.ilike.%${t}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Total[];
    },
  });

  const reportes = useQuery({
    queryKey: ["nov-reportes"],
    queryFn: async () => {
      const { data, error } = await supabase.from("novelty_reports").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as Reporte[];
    },
  });

  const visible = (doc: string) => conExcluidos || !excluidos.data?.has(doc);
  const entradasVis = useMemo(
    () => (entradas.data ? entradas.data.filter((e) => visible(e.document)) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entradas.data, excluidos.data, conExcluidos],
  );
  const totalesVis = useMemo(
    () => (totales.data ? totales.data.filter((t) => visible(t.document)) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [totales.data, excluidos.data, conExcluidos],
  );

  const [anclado, setAnclado] = useState(false);
  useEffect(() => {
    if (anclado || !reportes.isSuccess) return;
    setAnclado(true);
    const ultimo = reportes.data.find((r) => r.period_start && r.period_end);
    if (ultimo) {
      setDesde(ultimo.period_start!);
      setHasta(ultimo.period_end!);
    }
  }, [anclado, reportes.isSuccess, reportes.data]);

  const refrescar = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["nov-conciliacion"] });
    void qc.invalidateQueries({ queryKey: ["nov-entradas"] });
    void qc.invalidateQueries({ queryKey: ["nov-totales"] });
    void qc.invalidateQueries({ queryKey: ["nov-reportes"] });
  }, [qc]);

  const fechas = useMemo(() => rangoFechas(desde, hasta), [desde, hasta]);
  const matriz = useMemo(() => {
    const m = new Map<string, { document: string; nombre: string; cargo: string | null; campana: string | null; dias: Map<string, Entrada> }>();
    for (const e of entradasVis ?? []) {
      let p = m.get(e.document);
      if (!p) {
        p = { document: e.document, nombre: e.full_name ?? e.document, cargo: e.position, campana: e.campaign_label, dias: new Map() };
        m.set(e.document, p);
      }
      p.dias.set(e.work_date, e);
    }
    return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [entradasVis]);

  const pagMatriz = usePaginado(matriz, 20);
  const resumen = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of entradasVis ?? []) c.set(e.novelty_type, (c.get(e.novelty_type) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [entradasVis]);

  const pendientes = (entradasVis ?? []).filter((e) => e.status === "pendiente" && e.source === "manual");

  async function revisar(ids: string[], status: "aprobada" | "rechazada") {
    const { error } = await supabase
      .from("novelty_entries")
      .update({ status, reviewed_by: acceso.userId, reviewed_at: new Date().toISOString() })
      .in("id", ids);
    if (error) { toast.error(error.message); return; }
    toast.success(status === "aprobada" ? "Novedades aprobadas" : "Novedades rechazadas");
    refrescar();
  }

  function exportarMatriz() {
    descargarCsv(
      `novedades_${desde}_${hasta}`,
      matriz.map((p, i) => {
        const fila: Record<string, unknown> = { "No.": i + 1, "DOCUMENTO No.": p.document, EMPLEADO: p.nombre, CARGO: p.cargo ?? "", CAMPAÑA: p.campana ?? "" };
        for (const f of fechas) fila[`${diaSemana(f)} ${f}`] = p.dias.get(f)?.novelty_type ?? "";
        const t = totalesVis?.find((x) => x.document === p.document);
        for (const k of CONCEPTOS) fila[k.etiqueta] = t?.[k.campo] ?? 0;
        fila["OBSERVACIONES"] = t?.observaciones ?? "";
        return fila;
      }),
    );
  }

  return (
    <div>
      <PageHeader
        titulo="Novedades"
        descripcion="Carga la plantilla de novedades de la quincena: se cruza automáticamente con el biométrico y Nómina aprueba u observa cada persona."
        acciones={
          <>
            {puedeCrear ? (
              <Button variant="outline" onClick={() => setGenerarAbierta(true)}>
                <RefreshCw className="size-4" /> Desde asistencia
              </Button>
            ) : null}
            {puedeCrear ? (
              <Button variant="outline" onClick={() => setManualAbierta(true)}>
                <Plus className="size-4" /> Registrar novedad
              </Button>
            ) : null}
            {puedeImportar ? (
              <Button onClick={() => setCargaAbierta(true)}>
                <Upload className="size-4" /> Cargar plantillas
              </Button>
            ) : null}
          </>
        }
      />

      <Card className="mb-4 p-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setBuscar(texto);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="desde">Desde</Label>
            <Input id="desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hasta">Hasta</Label>
            <Input id="hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Campañas</Label>
            <MultiSelectFilter
              title="Campañas"
              placeholder="Todas las campañas"
              searchPlaceholder="Buscar campaña…"
              options={opcionesCampanas}
              selected={campanasSel}
              onChange={setCampanasSel}
              triggerClassName="w-48"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Personas</Label>
            <MultiSelectFilter
              title="Personas"
              placeholder="Todas las personas"
              searchPlaceholder="Buscar por cédula o nombre…"
              options={opcionesPersonas}
              selected={personasSel}
              onChange={setPersonasSel}
              triggerClassName="w-52"
              popoverWidth="w-[340px]"
            />
          </div>
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="q">Búsqueda libre</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="q"
                className="pl-9"
                placeholder="Cédula, nombre, cargo o texto…"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit"><Search className="size-4" /> Filtrar</Button>
            {(campanasSel.length > 0 || personasSel.length > 0 || Boolean(buscar) || conExcluidos) && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setTexto("");
                  setBuscar("");
                  setCampanasSel([]);
                  setPersonasSel([]);
                  setConExcluidos(false);
                }}
              >
                <X className="size-4 mr-1" /> Limpiar
              </Button>
            )}
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Switch checked={conExcluidos} onCheckedChange={setConExcluidos} />
            Incluir personal excluido
          </label>
        </form>
      </Card>

      <Tabs defaultValue="conciliacion">
        <TabsList className="mb-3">
          <TabsTrigger value="conciliacion">Conciliación con biométrico</TabsTrigger>
          <TabsTrigger value="matriz">Novedades por día</TabsTrigger>
          {pendientes.length ? <TabsTrigger value="pendientes">Manuales pendientes ({pendientes.length})</TabsTrigger> : null}
          <TabsTrigger value="plantillas">Plantillas cargadas</TabsTrigger>
        </TabsList>

        <TabsContent value="conciliacion">
          <ConciliacionNovedades desde={desde} hasta={hasta} puedeAprobar={puedeAprobar} />
        </TabsContent>

        <TabsContent value="matriz">
          <div className="mb-2 flex justify-end">
            {acceso.can("novedades", "exportar") ? (
              <Button variant="outline" size="sm" onClick={exportarMatriz} disabled={!matriz.length}>
                <Download className="size-4" /> Exportar
              </Button>
            ) : null}
          </div>
          <Card className="overflow-hidden p-0">
            <div className="max-h-[65vh] overflow-auto">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-muted">
                  <tr>
                    <th className="sticky left-0 z-20 min-w-64 bg-muted px-3 py-2 text-left font-medium">Empleado</th>
                    {fechas.map((f) => (
                      <th key={f} className={cn("min-w-20 px-1 py-2 text-center font-medium", diaSemana(f) === "dom" && "bg-accent/20 text-foreground")}>
                        <div>{diaSemana(f)}</div>
                        <div className="text-muted-foreground">{f.slice(8)}/{f.slice(5, 7)}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entradas.isLoading ? (
                    <tr><td colSpan={fechas.length + 1} className="p-6 text-center text-muted-foreground"><Loader2 className="mx-auto size-5 animate-spin" /></td></tr>
                  ) : !matriz.length ? (
                    <tr><td colSpan={fechas.length + 1} className="p-8 text-center text-muted-foreground">No hay novedades en este rango. Carga una plantilla, regístralas o genéralas desde la asistencia.</td></tr>
                  ) : (
                    pagMatriz.visibles.map((p) => (
                      <tr key={p.document} className="border-t">
                        <td className="sticky left-0 bg-card px-3 py-1.5">
                          <p className="font-medium">{p.nombre}</p>
                          <p className="text-[11px] text-muted-foreground">{p.document} · {p.campana ?? "sin campaña"}</p>
                        </td>
                        {fechas.map((f) => {
                          const e = p.dias.get(f);
                          return (
                            <td key={f} className="p-0.5 text-center">
                              <button
                                type="button"
                                disabled={!puedeCrear}
                                onClick={() => setCelda({ document: p.document, nombre: p.nombre, fecha: f, ...(e ? { entrada: e } : {}) })}
                                className={cn(
                                  "w-full truncate rounded px-1 py-1 text-[11px] transition-opacity hover:opacity-80",
                                  e ? colorTipo(e.novelty_type) : "text-muted-foreground/40",
                                  e?.status === "pendiente" && e.source === "manual" && "ring-1 ring-accent",
                                  e?.status === "rechazada" && "line-through opacity-60",
                                )}
                                title={e ? `${e.novelty_type} · ${e.source} · ${e.status}${e.notes ? ` · ${e.notes}` : ""}` : "Sin novedad"}
                              >
                                {e?.novelty_type ?? "·"}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
          <Paginador {...pagMatriz.paginador} />
          <p className="mt-2 text-xs text-muted-foreground">Haz clic en un día para cambiar la novedad. El borde morado indica que está pendiente de aprobación.</p>
        </TabsContent>

        <TabsContent value="pendientes">
          {puedeAprobar && pendientes.length ? (
            <div className="mb-2 flex justify-end gap-2">
                            <Button size="sm" onClick={() => revisar(pendientes.map((p) => p.id), "aprobada")}><CheckCircle2 className="size-4" /> Aprobar todas</Button>
            </div>
          ) : null}
          <SimpleTable<Entrada>
            filas={pendientes}
            getKey={(e) => e.id}
            vacio="No hay novedades manuales pendientes de aprobación."
            columnas={[
              { key: "f", header: "Fecha", cell: (e) => `${diaSemana(e.work_date)} ${e.work_date}` },
              { key: "p", header: "Empleado", cell: (e) => (<div><p className="font-medium">{e.full_name}</p><p className="text-xs text-muted-foreground">{e.document}</p></div>) },
              { key: "t", header: "Novedad", cell: (e) => <span className={cn("rounded px-2 py-0.5 text-xs", colorTipo(e.novelty_type))}>{e.novelty_type}</span> },
              { key: "n", header: "Notas", cell: (e) => e.notes ?? "" },
              { key: "a", header: "", cell: (e) => puedeAprobar ? (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => revisar([e.id], "rechazada")}><XCircle className="size-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => revisar([e.id], "aprobada")}><CheckCircle2 className="size-4 text-primary" /></Button>
                </div>
              ) : null },
            ]}
          />
        </TabsContent>

        <TabsContent value="plantillas">
          <SimpleTable<Reporte>
            cargando={reportes.isLoading}
            filas={reportes.data ?? []}
            getKey={(r) => r.id}
            vacio="Aún no se han cargado plantillas."
            columnas={[
              { key: "f", header: "Archivo", cell: (r) => (<div className="flex items-center gap-2"><FileSpreadsheet className="size-4 text-primary" /><div><p className="font-medium">{r.filename}</p><p className="text-xs text-muted-foreground">Hoja: {r.sheet_name ?? "—"}</p></div></div>) },
              { key: "c", header: "Campaña", cell: (r) => r.campaign_label ?? "—" },
              { key: "p", header: "Periodo", cell: (r) => `${r.period_start ?? "?"} → ${r.period_end ?? "?"}` },
              { key: "e", header: "Personas", cell: (r) => r.employees_count },
              { key: "d", header: "Días", cell: (r) => r.days_count },
              { key: "s", header: "Estado", cell: (r) => <Badge variant={r.status === "error" ? "destructive" : r.status === "procesado" ? "default" : "secondary"} title={r.error_message ?? ""}>{r.status}</Badge> },
              { key: "t", header: "Cargado", cell: (r) => new Date(r.created_at).toLocaleString("es-CO") },
              { key: "x", header: "", cell: (r) => puedeEliminar ? (
                <Button size="sm" variant="ghost" onClick={async () => {
                  if (!confirm(`¿Eliminar la plantilla ${r.filename} y todas sus novedades?`)) return;
                  const { error } = await supabase.from("novelty_reports").delete().eq("id", r.id);
                  if (error) toast.error(error.message); else { toast.success("Plantilla eliminada"); refrescar(); }
                }}><Trash2 className="size-4" /></Button>
              ) : null },
            ]}
          />
        </TabsContent>
      </Tabs>

      <CargaPlantillas abierta={cargaAbierta} onClose={() => setCargaAbierta(false)} onListo={refrescar} tenantId={acceso.tenantId} />
      <RegistroManual abierta={manualAbierta} onClose={() => setManualAbierta(false)} onListo={refrescar} tenantId={acceso.tenantId} />
      <GenerarAsistencia abierta={generarAbierta} onClose={() => setGenerarAbierta(false)} onListo={refrescar} desde0={desde} hasta0={hasta} />
      <EditarCelda celda={celda} onClose={() => setCelda(null)} onListo={refrescar} tenantId={acceso.tenantId} puedeEliminar={puedeEliminar} />
    </div>
  );
}

/* ---------------- Carga de plantillas ---------------- */

type EstadoArchivo = { archivo: File; estado: "en_cola" | "leyendo" | "guardando" | "listo" | "omitido" | "error"; detalle?: string };

function CargaPlantillas({ abierta, onClose, onListo, tenantId }: { abierta: boolean; onClose: () => void; onListo: () => void; tenantId: string | null }) {
  const [archivos, setArchivos] = useState<EstadoArchivo[]>([]);
  const [trabajando, setTrabajando] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const agregar = (lista: FileList | null) => {
    if (!lista) return;
    const nuevos = [...lista].filter((f) => /\.(xlsx|xlsm|xls)$/i.test(f.name));
    if (nuevos.length < lista.length) toast.warning("Solo se aceptan archivos de Excel (.xlsx, .xls).");
    setArchivos((prev) => [...prev, ...nuevos.filter((n) => !prev.some((p) => p.archivo.name === n.name)).map((archivo) => ({ archivo, estado: "en_cola" as const }))]);
  };

  const actualizar = (nombre: string, cambio: Partial<EstadoArchivo>) =>
    setArchivos((prev) => prev.map((a) => (a.archivo.name === nombre ? { ...a, ...cambio } : a)));

  async function procesar() {
    if (!tenantId) { toast.error("Tu usuario no tiene empresa asignada."); return; }
    setTrabajando(true);
    for (const item of archivos) {
      if (item.estado !== "en_cola" && item.estado !== "error") continue;
      const nombre = item.archivo.name;
      try {
        const { data: previo } = await supabase.from("novelty_reports").select("id, status").ilike("filename", nombre.replace(/[%_]/g, "\\$&")).maybeSingle();
        if (previo && previo.status !== "error") {
          actualizar(nombre, { estado: "omitido", detalle: "Ya existe una plantilla cargada con este mismo nombre." });
          continue;
        }
        if (previo) await supabase.from("novelty_reports").delete().eq("id", previo.id);

        actualizar(nombre, { estado: "leyendo", detalle: "Leyendo el Excel…" });
        const p = await leerPlantilla(item.archivo);

        actualizar(nombre, { estado: "guardando", detalle: `${p.empleados.length} personas · ${p.fechas.length} días` });
        const { data: rep, error: eRep } = await supabase
          .from("novelty_reports")
          .insert({
            tenant_id: tenantId,
            filename: nombre,
            sheet_name: p.hoja,
            company_name: p.empresa,
            campaign_label: p.empleados[0]?.campaign_label ?? null,
            period_start: p.periodoInicio,
            period_end: p.periodoFin,
            employees_count: p.empleados.length,
            days_count: p.fechas.length,
            status: "procesando",
          })
          .select("id")
          .single();
        if (eRep) throw eRep;

        // Empleados: enlaza por documento y crea los que no existan (si hay permiso)
        const docs = p.empleados.map((e) => e.document);
        const idPorDoc = new Map<string, string>();
        for (let i = 0; i < docs.length; i += 300) {
          const { data } = await supabase.from("employees").select("id, document").in("document", docs.slice(i, i + 300));
          for (const e of data ?? []) idPorDoc.set(e.document, e.id);
        }
        const { data: camps } = await supabase.from("campaigns").select("id, name, code");
        const nc = (v: string | null | undefined) => (v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const campanaDe = (label: string | null) => {
          const l = nc(label);
          if (!l) return null;
          return (camps ?? []).find((c) => l === nc(c.name) || l === nc(c.code) || l.includes(nc(c.name)))?.id ?? null;
        };
        const faltantes = p.empleados.filter((e) => !idPorDoc.has(e.document));
        if (faltantes.length) {
          const { data: creados } = await supabase
            .from("employees")
            .upsert(faltantes.map((e) => ({ tenant_id: tenantId, document: e.document, full_name: e.full_name, position: e.position, campaign_id: campanaDe(e.campaign_label) })), { onConflict: "tenant_id,document", ignoreDuplicates: true })
            .select("id, document");
          for (const e of creados ?? []) idPorDoc.set(e.document, e.id);
        }

        const filas = p.empleados.flatMap((e) =>
          Object.entries(e.dias).map(([fecha, tipo]) => ({
            tenant_id: tenantId,
            report_id: rep.id,
            employee_id: idPorDoc.get(e.document) ?? null,
            document: e.document,
            full_name: e.full_name,
            position: e.position,
            campaign_label: e.campaign_label,
            work_date: fecha,
            novelty_type: tipo,
            source: "plantilla",
            status: "reportada",
          })),
        );
        for (let i = 0; i < filas.length; i += 1000) {
          const { error } = await supabase.from("novelty_entries").upsert(filas.slice(i, i + 1000), { onConflict: "tenant_id,document,work_date" });
          if (error) throw error;
        }
        const tot = p.empleados.map((e) => ({
          tenant_id: tenantId,
          report_id: rep.id,
          employee_id: idPorDoc.get(e.document) ?? null,
          document: e.document,
          full_name: e.full_name,
          position: e.position,
          campaign_label: e.campaign_label,
          period_start: p.periodoInicio,
          period_end: p.periodoFin,
          observaciones: e.observaciones,
          source: "plantilla",
          ...e.conceptos,
        }));
        const { error: eTot } = await supabase.from("novelty_totals").upsert(tot, { onConflict: "tenant_id,document,period_start,period_end" });
        if (eTot) throw eTot;

        await supabase
          .from("novelty_reports")
          .update({ status: p.advertencias.length ? "con_advertencias" : "procesado", error_message: p.advertencias.join(" ") || null })
          .eq("id", rep.id);
        actualizar(nombre, {
          estado: "listo",
          detalle: `${p.empleados.length} personas · ${filas.length} novedades · ${p.periodoInicio} → ${p.periodoFin}${p.advertencias.length ? ` · ${p.advertencias.length} advertencias` : ""}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Error desconocido";
        await supabase.from("novelty_reports").update({ status: "error", error_message: msg }).ilike("filename", nombre.replace(/[%_]/g, "\\$&"));
        actualizar(nombre, { estado: "error", detalle: msg });
      }
    }
    setTrabajando(false);
    onListo();
  }

  const etiqueta: Record<EstadoArchivo["estado"], string> = { en_cola: "En cola", leyendo: "Leyendo", guardando: "Guardando", listo: "Completado", omitido: "Omitido", error: "Error" };

  return (
    <Dialog open={abierta} onOpenChange={(v) => { if (!v && !trabajando) { setArchivos([]); onClose(); } }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cargar plantillas de novedades</DialogTitle>
          <DialogDescription>
            Arrastra uno o varios Excel con el formato de reporte de novedades (el nombre del archivo puede variar). Si ya existe una plantilla con el mismo nombre, se omite.
          </DialogDescription>
        </DialogHeader>
        <div
          onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
          onDragLeave={() => setArrastrando(false)}
          onDrop={(e) => { e.preventDefault(); setArrastrando(false); agregar(e.dataTransfer.files); }}
          onClick={() => input.current?.click()}
          className={cn("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors", arrastrando ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}
        >
          <FileSpreadsheet className="size-8 text-primary" />
          <p className="text-sm font-medium">Arrastra aquí tus archivos o haz clic para elegirlos</p>
          <p className="text-xs text-muted-foreground">.xlsx · varios a la vez</p>
          <input ref={input} type="file" accept=".xlsx,.xlsm,.xls" multiple hidden onChange={(e) => { agregar(e.target.files); e.target.value = ""; }} />
        </div>
        {archivos.length ? (
          <ul className="max-h-72 space-y-1.5 overflow-auto">
            {archivos.map((a) => (
              <li key={a.archivo.name} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{a.archivo.name}</p>
                  {a.detalle ? <p className={cn("text-xs", a.estado === "error" ? "text-destructive" : "text-muted-foreground")}>{a.detalle}</p> : null}
                </div>
                <Badge variant={a.estado === "error" ? "destructive" : a.estado === "listo" ? "default" : a.estado === "omitido" ? "outline" : "secondary"} className="shrink-0">
                  {a.estado === "leyendo" || a.estado === "guardando" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                  {etiqueta[a.estado]}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={trabajando} onClick={() => { setArchivos([]); onClose(); }}>Cerrar</Button>
          <Button disabled={trabajando || !archivos.some((a) => a.estado === "en_cola" || a.estado === "error")} onClick={procesar}>
            {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Procesar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Registro manual ---------------- */

type Emp = { id: string; document: string; full_name: string; position: string | null; campaigns: { name: string } | null };

function useEmpleados(activo: boolean) {
  return useQuery({
    queryKey: ["nov-empleados"],
    enabled: activo,
    queryFn: () => traerTodo<Emp>((a, b) => supabase.from("employees").select("id, document, full_name, position, campaigns(name)").order("full_name").range(a, b) as unknown as PromiseLike<{ data: Emp[] | null; error: unknown }>),
  });
}

function RegistroManual({ abierta, onClose, onListo, tenantId }: { abierta: boolean; onClose: () => void; onListo: () => void; tenantId: string | null }) {
  const empleados = useEmpleados(abierta);
  const [emp, setEmp] = useState("");
  const [tipo, setTipo] = useState<string>("Incapacidad");
  const [desde, setDesde] = useState(iso(new Date()));
  const [hasta, setHasta] = useState(iso(new Date()));
  const [notas, setNotas] = useState("");
  const [guardando, setGuardando] = useState(false);

  const elegido = (empleados.data ?? []).find((e) => `${e.full_name} · ${e.document}` === emp || e.document === emp.trim());

  async function guardar() {
    if (!tenantId || !elegido) { toast.error("Elige un empleado de la lista."); return; }
    if (hasta < desde) { toast.error("La fecha final no puede ser anterior a la inicial."); return; }
    const dias = rangoFechas(desde, hasta);
    setGuardando(true);
    const { error } = await supabase.from("novelty_entries").upsert(
      dias.map((d) => ({
        tenant_id: tenantId,
        employee_id: elegido.id,
        document: elegido.document,
        full_name: elegido.full_name,
        position: elegido.position,
        campaign_label: elegido.campaigns?.name ?? null,
        work_date: d,
        novelty_type: tipo,
        source: "manual",
        status: "pendiente",
        notes: notas || null,
        report_id: null,
      })),
      { onConflict: "tenant_id,document,work_date" },
    );
    setGuardando(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Novedad registrada en ${dias.length} día(s); queda pendiente de aprobación.`);
    setEmp(""); setNotas("");
    onListo(); onClose();
  }

  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar novedad</DialogTitle>
          <DialogDescription>Aplica a cada día del rango. Reemplaza lo que haya en esos días y queda pendiente de aprobación.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Empleado</Label>
            <Input list="nov-emps" placeholder={empleados.isLoading ? "Cargando…" : "Escribe nombre o documento"} value={emp} onChange={(e) => setEmp(e.target.value)} />
            <datalist id="nov-emps">
              {(empleados.data ?? []).map((e) => <option key={e.id} value={`${e.full_name} · ${e.document}`} />)}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label>Tipo de novedad</Label>
            <Select value={tipo} onValueChange={setTipo}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TIPOS_NOVEDAD.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Desde</Label><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Hasta</Label><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Notas / soporte</Label><Textarea value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej: incapacidad EPS No. 012345" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={guardar} disabled={guardando || !elegido}>{guardando ? <Loader2 className="size-4 animate-spin" /> : null} Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Generar desde asistencia ---------------- */

function GenerarAsistencia({ abierta, onClose, onListo, desde0, hasta0 }: { abierta: boolean; onClose: () => void; onListo: () => void; desde0: string; hasta0: string }) {
  const [desde, setDesde] = useState(desde0);
  const [hasta, setHasta] = useState(hasta0);
  const [trabajando, setTrabajando] = useState(false);
  async function generar() {
    setTrabajando(true);
    const { data, error } = await supabase.rpc("generar_novedades_desde_asistencia", { _desde: desde, _hasta: hasta });
    setTrabajando(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Se generaron ${data ?? 0} novedades desde la asistencia.`);
    onListo(); onClose();
  }
  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generar novedades desde la asistencia</DialogTitle>
          <DialogDescription>
            Usa el control diario calculado con el biométrico: marca Asiste, Descanso, Ausente o Marcación incompleta, y suma horas nocturnas, dominicales y extra. No reemplaza novedades que ya existan.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Desde</Label><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Hasta</Label><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={generar} disabled={trabajando}>{trabajando ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Generar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Editar un día ---------------- */

function EditarCelda({ celda, onClose, onListo, tenantId, puedeEliminar }: {
  celda: { document: string; nombre: string; fecha: string; entrada?: Entrada } | null;
  onClose: () => void; onListo: () => void; tenantId: string | null; puedeEliminar: boolean;
}) {
  const [tipo, setTipo] = useState("");
  const [notas, setNotas] = useState("");
  const clave = celda ? `${celda.document}-${celda.fecha}` : "";
  const [claveActual, setClaveActual] = useState("");
  if (celda && clave !== claveActual) {
    setClaveActual(clave);
    setTipo(celda.entrada?.novelty_type ?? "Asiste");
    setNotas(celda.entrada?.notes ?? "");
  }

  async function guardar() {
    if (!celda || !tenantId) return;
    const base = celda.entrada;
    const { error } = await supabase.from("novelty_entries").upsert(
      {
        tenant_id: tenantId,
        document: celda.document,
        full_name: base?.full_name ?? celda.nombre,
        position: base?.position ?? null,
        campaign_label: base?.campaign_label ?? null,
        work_date: celda.fecha,
        novelty_type: tipo,
        source: "manual",
        status: "pendiente",
        notes: notas || null,
      },
      { onConflict: "tenant_id,document,work_date" },
    );
    if (error) { toast.error(error.message); return; }
    toast.success("Novedad actualizada (pendiente de aprobación)");
    onListo(); onClose();
  }

  async function eliminar() {
    if (!celda?.entrada) return;
    const { error } = await supabase.from("novelty_entries").delete().eq("id", celda.entrada.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Novedad eliminada");
    onListo(); onClose();
  }

  return (
    <Dialog open={Boolean(celda)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{celda?.nombre}</DialogTitle>
          <DialogDescription>
            {celda ? `${diaSemana(celda.fecha)} ${celda.fecha}` : ""}
            {celda?.entrada ? ` · origen: ${celda.entrada.source} · ${celda.entrada.status}` : " · sin novedad"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Novedad</Label>
            <Select value={tipo} onValueChange={setTipo}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {[...new Set([...TIPOS_NOVEDAD, ...(tipo ? [tipo] : [])])].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Notas</Label><Textarea value={notas} onChange={(e) => setNotas(e.target.value)} /></div>
        </div>
        <DialogFooter className="gap-2">
          {celda?.entrada && puedeEliminar ? <Button variant="ghost" onClick={eliminar}><Trash2 className="size-4" /> Eliminar</Button> : null}
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={guardar}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
