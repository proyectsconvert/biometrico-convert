import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarSearch, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock, Download, FileSpreadsheet, Loader2,
  MessageSquareWarning, RotateCcw, SearchX, UserX, XCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { descargarCsv } from "@/lib/biometria";
import * as XLSX from "xlsx";
import { escribirLibro } from "@/lib/exportar";
import { colorTipo, diaSemana, rangoFechas } from "@/lib/novedades";
import { Paginador, usePaginado } from "@/components/simple-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Concepto = { clave: string; etiqueta: string; reportado: number; biometrico: number };
export type FilaConciliacion = {
  id: string;
  document: string;
  full_name: string | null;
  position: string | null;
  campaign_label: string | null;
  campana_empleado: string | null;
  period_start: string;
  period_end: string;
  encontrado: boolean;
  hay_biometria: boolean;
  dias_asiste: number;
  dias_marcados: number;
  trabajadas: number;
  asiste_sin_marca: number;
  asiste_incompleta: number;
  marca_en_novedad: number;
  conceptos: Concepto[];
  ajustes: number;
  bonificacion: number;
  comisiones: number;
  observaciones: string | null;
  estado: "coherente" | "advertencia" | "inconsistente" | "sin_biometria" | "no_encontrado";
  review_status: "pendiente" | "aprobado" | "observado" | "rechazado" | "respondido";
  review_comment: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

const REVISION: Record<FilaConciliacion["review_status"], { label: string; clase: string }> = {
  pendiente: { label: "Pendiente de revisión", clase: "bg-sky-100 text-sky-800 hover:bg-sky-100 dark:bg-sky-950 dark:text-sky-300" },
  aprobado: { label: "Aprobado", clase: "bg-emerald-600 text-white hover:bg-emerald-600" },
  observado: { label: "Observado", clase: "bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300" },
  rechazado: { label: "Rechazado", clase: "bg-red-600 text-white hover:bg-red-600" },
  respondido: { label: "Respondido · 2ª revisión", clase: "bg-violet-100 text-violet-900 hover:bg-violet-100 dark:bg-violet-950 dark:text-violet-300" },
};

const h = (v: number) => (v ? v.toLocaleString("es-CO", { maximumFractionDigits: 2 }) : "0");
const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const fechaCorta = (f: string) => `${f.slice(8)}/${f.slice(5, 7)}`;
/** Etiqueta sin el factor de recargo: «Extras diurnas (1,25)» → «Extras diurnas». */
const nombreConcepto = (e: string) => e.replace(/\s*\(.*\)\s*$/, "");

/** Columna de la plantilla (y su ajuste) → tipo de hora en el archivo de Adecco. */
const ADECCO: { horas: string; ajuste: string; novedad: string }[] = [
  { horas: "horas_nocturnas", ajuste: "ajuste_horas_nocturnas", novedad: "Recargo Nocturno 35%" },
  { horas: "horas_extra_diurnas", ajuste: "ajuste_extra_diurnas", novedad: "Horas Extras Diurnas 1.25%" },
  { horas: "horas_dom_fest_090", ajuste: "ajuste_dom_fest_090", novedad: "Recargo Dominical Diurno 90%" },
  { horas: "horas_dom_fest_190", ajuste: "ajuste_dom_fest_190", novedad: "Hora Dominical o Festiva Ordinaria 190%" },
  { horas: "horas_extra_nocturnas", ajuste: "ajuste_extra_nocturnas", novedad: "Horas Extras Nocturnas 1.75%" },
];

/** Solo se concilian quienes reportan horas; asistencia, descansos y faltas van en «Novedades por día». */
const reportaHoras = (x: FilaConciliacion) => x.conceptos.some((c) => c.reportado > 0);

type Sugerencia = {
  tipo: "aprobar" | "observar" | "revisar" | "esperar" | "crear";
  titulo: string;
  detalle: string;
  comentario?: string;
};

/** Qué sugiere el sistema para cada persona, a partir del cruce con el biométrico. */
function sugerir(x: FilaConciliacion, tol: number): Sugerencia {
  if (x.estado === "no_encontrado") {
    return { tipo: "crear", titulo: "No se puede validar", detalle: `La cédula ${x.document} no existe en Empleados. Créala para poder cruzarla con el biométrico.` };
  }
  if (x.estado === "sin_biometria") {
    return { tipo: "esperar", titulo: "Faltan marcaciones del biométrico", detalle: `No hay marcaciones cargadas del ${fechaCorta(x.period_start)} al ${fechaCorta(x.period_end)}. Carga esos CSV en Importaciones antes de aprobar.` };
  }
  const faltan = x.conceptos.filter((c) => c.reportado - c.biometrico > tol);
  const dias = [
    x.asiste_sin_marca ? `${x.asiste_sin_marca} día(s) con «Asiste» sin marcación` : "",
    x.asiste_incompleta ? `${x.asiste_incompleta} día(s) con «Asiste» y marcación incompleta` : "",
    x.marca_en_novedad ? `${x.marca_en_novedad} día(s) con marcación en un día de novedad` : "",
  ].filter(Boolean);
  if (faltan.length) {
    const lista = faltan.map((c) => `${nombreConcepto(c.etiqueta)}: reporta ${h(c.reportado)} h y el biométrico respalda ${h(c.biometrico)} h (faltan ${h(c.reportado - c.biometrico)} h)`);
    return {
      tipo: "observar",
      titulo: "No cuadra: sugerimos observar",
      detalle: lista.join(" · "),
      comentario: `${lista.join(". ")}.${dias.length ? ` Además: ${dias.join(", ")}.` : ""} Por favor corregir o adjuntar soporte.`,
    };
  }
  if (dias.length) {
    return {
      tipo: "revisar",
      titulo: "Las horas cuadran, pero hay días por revisar",
      detalle: `${dias.join(" · ")}. Abre el detalle por día y decide si apruebas u observas.`,
      comentario: `Las horas reportadas cuadran con el biométrico, pero hay ${dias.join(", ")}. Por favor revisar.`,
    };
  }
  return { tipo: "aprobar", titulo: "Cuadra: sugerimos aprobar", detalle: "El biométrico respalda todas las horas reportadas." };
}

const ESTILO: Record<Sugerencia["tipo"], { caja: string; icono: ReactNode; chip: string }> = {
  aprobar: { caja: "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40", icono: <CheckCircle2 className="size-4 text-emerald-600" />, chip: "Cuadran" },
  revisar: { caja: "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40", icono: <CalendarSearch className="size-4 text-amber-600" />, chip: "Revisar días" },
  observar: { caja: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40", icono: <XCircle className="size-4 text-red-600" />, chip: "No cuadran" },
  esperar: { caja: "border-sky-300 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40", icono: <Clock className="size-4 text-sky-600" />, chip: "Sin biometría" },
  crear: { caja: "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40", icono: <UserX className="size-4 text-zinc-500" />, chip: "No encontrados" },
};

export function ConciliacionNovedades({
  desde, hasta, puedeAprobar, campanas = [], personas = [], buscar = "", documentosCampanas = null,
}: {
  desde: string; hasta: string; puedeAprobar: boolean;
  campanas?: string[]; personas?: string[]; buscar?: string; documentosCampanas?: string[] | null;
}) {
  const qc = useQueryClient();
  const acceso = useAccess();
  const [filtro, setFiltro] = useState<Sugerencia["tipo"] | "todos" | "pendientes">("todos");
  const [abierta, setAbierta] = useState<string | null>(null);
  const [observar, setObservar] = useState<{ fila: FilaConciliacion; comentario: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const tolerancia = useQuery({
    queryKey: ["reglas", "tolerancia_conciliacion_horas"],
    queryFn: async () => {
      const { data } = await supabase.from("rules").select("value").eq("key", "tolerancia_conciliacion_horas").maybeSingle();
      return Number(data?.value ?? 0.5);
    },
  });
  const tol = tolerancia.data ?? 0.5;

  const conc = useQuery({
    queryKey: ["nov-conciliacion", desde, hasta],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("conciliacion_novedades" as never, { _desde: desde, _hasta: hasta } as never);
      if (error) throw error;
      return (data as unknown as FilaConciliacion[]) ?? [];
    },
  });

  // Mismos filtros que el resto de Novedades: campaña (por Empleados o por la etiqueta de la plantilla), personas y búsqueda
  const filtradas = useMemo(() => {
    const docs = documentosCampanas ? new Set(documentosCampanas) : null;
    const q = norm(buscar);
    return (conc.data ?? []).filter((x) => {
      if (campanas.length) {
        const deCampana = docs?.has(x.document) || campanas.some((c) => norm(x.campana_empleado) === norm(c) || norm(x.campaign_label).includes(norm(c)));
        if (!deCampana) return false;
      }
      if (personas.length && !personas.includes(x.document)) return false;
      if (q && !norm(`${x.document} ${x.full_name} ${x.position} ${x.campaign_label} ${x.campana_empleado}`).includes(q)) return false;
      return true;
    });
  }, [conc.data, campanas, personas, buscar, documentosCampanas]);

  const conHoras = useMemo(() => filtradas.filter(reportaHoras).map((x) => ({ fila: x, sug: sugerir(x, tol) })), [filtradas, tol]);
  const sinHoras = filtradas.length - conHoras.length;
  const visibles = useMemo(
    () => conHoras.filter(({ fila, sug }) => filtro === "todos" || (filtro === "pendientes" ? fila.review_status === "pendiente" : sug.tipo === filtro)),
    [conHoras, filtro],
  );
  const pag = usePaginado(visibles, 10);
  // Al cambiar filtros se vuelve a la primera página
  const claveFiltros = `${filtro}|${campanas.join()}|${personas.join()}|${buscar}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { pag.reiniciar(); }, [claveFiltros]);

  const cuenta = (t: Sugerencia["tipo"]) => conHoras.filter((x) => x.sug.tipo === t).length;
  const aprobables = conHoras.filter((x) => x.sug.tipo === "aprobar" && x.fila.review_status === "pendiente");
  // Si la búsqueda deja una sola persona, se abre su detalle
  const unica = conHoras.length === 1 && (personas.length === 1 || Boolean(buscar)) ? conHoras[0]!.fila.id : null;
  useEffect(() => {
    if (unica) setAbierta(unica);
  }, [unica]);

  async function revisar(ids: string[], estado: "aprobado" | "observado" | "pendiente", comentario?: string) {
    setTrabajando(true);
    const { data, error } = await supabase.rpc("revisar_novedades" as never, { _ids: ids, _estado: estado, _comentario: comentario ?? null } as never);
    setTrabajando(false);
    if (error) {
      toast.error("No se pudo registrar la revisión", { description: error.message });
      return false;
    }
    toast.success(estado === "aprobado" ? `${data} aprobado(s)` : estado === "observado" ? "Observación registrada" : "Revisión reabierta");
    void qc.invalidateQueries({ queryKey: ["nov-conciliacion"] });
    return true;
  }

  const aprobadas = filtradas.filter((x) => x.review_status === "aprobado");

  /** Archivo para Adecco: una fila por persona y tipo de hora, solo de lo aprobado (horas + ajuste). */
  async function exportarAdecco() {
    if (!aprobadas.length) {
      toast.info("No hay novedades aprobadas", { description: "Solo se exportan las personas con revisión «Aprobado» en el periodo y filtros actuales." });
      return;
    }
    const { data, error } = await supabase
      .from("novelty_totals")
      .select(`id, document, ${ADECCO.flatMap((t) => [t.horas, t.ajuste]).join(", ")}`)
      .in("id", aprobadas.map((x) => x.id));
    if (error) {
      toast.error("No se pudo generar el archivo", { description: error.message });
      return;
    }
    const porId = new Map(aprobadas.map((x) => [x.id, x]));
    const filasAdecco: (string | number)[][] = [];
    for (const t of (data ?? []) as unknown as Record<string, string | number | null>[]) {
      const x = porId.get(String(t["id"]))!;
      for (const tipo of ADECCO) {
        const cantidad = Math.round((Number(t[tipo.horas] ?? 0) + Number(t[tipo.ajuste] ?? 0)) * 100) / 100;
        if (cantidad !== 0) filasAdecco.push([String(t["document"]), tipo.novedad, cantidad, x.campana_empleado ?? x.campaign_label ?? ""]);
      }
    }
    filasAdecco.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || ADECCO.findIndex((t) => t.novedad === a[1]) - ADECCO.findIndex((t) => t.novedad === b[1]));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["Identificación", "Novedad", "cantidad", "observaciones"], ...filasAdecco]);
    ws["!cols"] = [{ wch: 16 }, { wch: 42 }, { wch: 10 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, ws, "Adecco");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Novedades aprobadas para Adecco"],
      [`Periodo: ${desde} a ${hasta}`],
      [`Personas aprobadas: ${aprobadas.length} · Filas: ${filasAdecco.length}`],
      ["Cantidad = horas reportadas + ajuste de ese tipo de hora."],
    ]), "Información");
    escribirLibro(wb, `adecco_novedades_${desde}_${hasta}.xlsx`);
    toast.success(`${filasAdecco.length} filas de ${aprobadas.length} personas aprobadas`);
  }

  function exportar() {
    descargarCsv(
      `conciliacion_novedades_${desde}_${hasta}`,
      conHoras.map(({ fila: x, sug }) => {
        const fila: Record<string, unknown> = {
          documento: x.document,
          empleado: x.full_name ?? "",
          cargo: x.position ?? "",
          campana: x.campana_empleado ?? x.campaign_label ?? "",
          periodo: `${x.period_start} a ${x.period_end}`,
          resultado: ESTILO[sug.tipo].chip,
          sugerencia: `${sug.titulo}. ${sug.detalle}`,
        };
        for (const c of x.conceptos) {
          fila[`${nombreConcepto(c.etiqueta)} reportado`] = c.reportado;
          fila[`${nombreConcepto(c.etiqueta)} biometrico`] = c.biometrico;
        }
        return {
          ...fila,
          ajustes: x.ajustes,
          bonificacion: x.bonificacion,
          comisiones: x.comisiones,
          revision: REVISION[x.review_status].label,
          comentario_revision: x.review_comment ?? "",
          revisado_por: x.reviewed_by ?? "",
          observaciones_plantilla: x.observaciones ?? "",
        };
      }),
    );
  }

  const chips: { k: typeof filtro; t: string; v: number; icono?: ReactNode }[] = [
    { k: "todos", t: "Todas", v: conHoras.length },
    { k: "aprobar", t: "Cuadran", v: cuenta("aprobar"), icono: ESTILO.aprobar.icono },
    { k: "revisar", t: "Revisar días", v: cuenta("revisar"), icono: ESTILO.revisar.icono },
    { k: "observar", t: "No cuadran", v: cuenta("observar"), icono: ESTILO.observar.icono },
    { k: "esperar", t: "Sin biometría", v: cuenta("esperar"), icono: ESTILO.esperar.icono },
    { k: "crear", t: "No encontrados", v: cuenta("crear"), icono: ESTILO.crear.icono },
    { k: "pendientes", t: "Pendientes de revisión", v: conHoras.filter((x) => x.fila.review_status === "pendiente").length },
  ];

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-start gap-3 p-4 text-sm">
        <CircleHelp className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">¿Qué es la conciliación?</p>
          <p className="text-muted-foreground">
            Compara las <b>horas que reporta el supervisor</b> (nocturnas, dominicales/festivos y extras) con las que <b>respalda el biométrico</b>.
            Si lo reportado no supera lo marcado en más de {h(tol)} h, cuadra y se sugiere aprobar; si no, se sugiere observar con el comentario ya escrito.
          </p>
          {sinHoras > 0 ? (
            <p className="text-muted-foreground">
              <b>{sinHoras} persona(s)</b> de la plantilla no reportan horas (solo asistencia, descanso o faltas): no necesitan conciliación y se revisan en «Novedades por día».
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          {acceso.can("novedades", "exportar_adecco") ? (
            <Button variant="outline" size="sm" onClick={() => void exportarAdecco()} title="Solo las personas aprobadas: una fila por tipo de hora">
              <FileSpreadsheet className="size-4" /> Exportar Adecco ({aprobadas.length} aprobadas)
            </Button>
          ) : null}
          {acceso.can("novedades", "exportar") ? (
            <Button variant="outline" size="sm" onClick={exportar} disabled={!conHoras.length}>
              <Download className="size-4" /> Exportar
            </Button>
          ) : null}
          {puedeAprobar && aprobables.length ? (
            <Button size="sm" disabled={trabajando} onClick={() => revisar(aprobables.map((x) => x.fila.id), "aprobado")}>
              <CheckCircle2 className="size-4" /> Aprobar las {aprobables.length} que cuadran
            </Button>
          ) : null}
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <button
            key={c.k}
            type="button"
            onClick={() => setFiltro(c.k)}
            className={cn(
              "flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm transition-colors hover:border-primary",
              filtro === c.k && "border-primary bg-primary/10 font-medium",
              !c.v && c.k !== "todos" && "opacity-50",
            )}
          >
            {c.icono}
            {c.t}
            <span className="rounded-full bg-muted px-2 text-xs tabular-nums">{conc.isLoading ? "…" : c.v}</span>
          </button>
        ))}
      </div>

      {conc.isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Cruzando las novedades con el biométrico…</p>
      ) : conc.error ? (
        <p className="py-10 text-center text-sm text-destructive">{(conc.error as Error).message}</p>
      ) : !conc.data?.length ? (
        <Vacio texto="No hay plantillas de novedades con horas para este periodo." />
      ) : !visibles.length ? (
        <Vacio texto={filtradas.length ? "Nadie en esta categoría con los filtros actuales." : "Ninguna persona coincide con los filtros (campaña, persona o búsqueda)."} />
      ) : (
        <div className="space-y-3">
          {pag.visibles.map(({ fila: x, sug }) => (
            <TarjetaPersona
              key={x.id}
              x={x}
              sug={sug}
              tol={tol}
              abierta={abierta === x.id}
              alAbrir={() => setAbierta((a) => (a === x.id ? null : x.id))}
              puedeAprobar={puedeAprobar}
              trabajando={trabajando}
              alAprobar={() => revisar([x.id], "aprobado")}
              alObservar={() => setObservar({ fila: x, comentario: sug.comentario ?? "" })}
              alReabrir={() => revisar([x.id], "pendiente")}
            />
          ))}
        </div>
      )}

      {visibles.length > 10 ? <Paginador {...pag.paginador} /> : null}

      <ObservarDialog
        estado={observar}
        onClose={() => setObservar(null)}
        onGuardar={async (comentario) => {
          if (observar && (await revisar([observar.fila.id], "observado", comentario))) setObservar(null);
        }}
      />
    </div>
  );
}

function Vacio({ texto }: { texto: string }) {
  return (
    <Card className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
      <SearchX className="size-6" />
      {texto}
    </Card>
  );
}

function TarjetaPersona({ x, sug, tol, abierta, alAbrir, puedeAprobar, trabajando, alAprobar, alObservar, alReabrir }: {
  x: FilaConciliacion; sug: Sugerencia; tol: number; abierta: boolean; alAbrir: () => void; puedeAprobar: boolean; trabajando: boolean;
  alAprobar: () => void; alObservar: () => void; alReabrir: () => void;
}) {
  const e = ESTILO[sug.tipo];
  const conceptos = x.conceptos.filter((c) => c.reportado > 0 || c.biometrico > 0);
  const extras = [x.ajustes ? `ajustes ${h(x.ajustes)} h` : "", x.bonificacion ? `bonificación ${h(x.bonificacion)}` : "", x.comisiones ? `comisiones ${h(x.comisiones)}` : ""].filter(Boolean);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="font-medium">{x.full_name}</p>
          <p className="text-xs text-muted-foreground">
            {x.document} · {x.campana_empleado ?? x.campaign_label ?? "Sin campaña"} · periodo {fechaCorta(x.period_start)} al {fechaCorta(x.period_end)}
          </p>
        </div>
        <div className="text-right">
          <Badge variant="secondary" className={REVISION[x.review_status].clase}>{REVISION[x.review_status].label}</Badge>
          {x.reviewed_by ? <p className="mt-1 text-[11px] text-muted-foreground">por {x.reviewed_by}</p> : null}
        </div>
      </div>

      <div className={cn("mx-4 flex items-start gap-2 rounded-lg border p-3 text-sm", e.caja)}>
        <span className="mt-0.5">{e.icono}</span>
        <div className="min-w-0">
          <p className="font-medium">{sug.titulo}</p>
          <p className="text-xs text-muted-foreground">{sug.detalle}</p>
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-end">
        <table className="w-full max-w-xl text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pb-1 font-medium">Horas</th>
              <th className="pb-1 text-right font-medium">Reportadas</th>
              <th className="pb-1 text-right font-medium">Biométrico</th>
              <th className="pb-1 pl-4 font-medium">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {conceptos.map((c) => {
              const dif = c.reportado - c.biometrico;
              const falta = x.hay_biometria && dif > tol;
              return (
                <tr key={c.clave} className="border-t">
                  <td className="py-1.5">{nombreConcepto(c.etiqueta)}</td>
                  <td className="py-1.5 text-right tabular-nums">{h(c.reportado)} h</td>
                  <td className="py-1.5 text-right tabular-nums">{x.hay_biometria ? `${h(c.biometrico)} h` : "—"}</td>
                  <td className={cn("py-1.5 pl-4 text-xs", falta ? "font-medium text-destructive" : "text-muted-foreground")}>
                    {!x.hay_biometria ? "sin datos" : falta ? `faltan ${h(dif)} h` : c.reportado ? "✓ respaldado" : "no reportadas"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={alAbrir}>
            {abierta ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Detalle por día
          </Button>
          {puedeAprobar ? (
            <>
              {x.review_status !== "pendiente" ? (
                <Button size="sm" variant="outline" disabled={trabajando} onClick={alReabrir}><RotateCcw className="size-4" /> Reabrir</Button>
              ) : null}
              {x.review_status !== "observado" ? (
                <Button size="sm" variant={sug.tipo === "observar" ? "default" : "outline"} disabled={trabajando} onClick={alObservar}>
                  <MessageSquareWarning className="size-4" /> {sug.tipo === "observar" ? "Observar (comentario sugerido)" : "Observar"}
                </Button>
              ) : null}
              {x.review_status !== "aprobado" ? (
                <Button size="sm" variant={sug.tipo === "aprobar" ? "default" : "outline"} disabled={trabajando || sug.tipo === "esperar" || sug.tipo === "crear"} onClick={alAprobar}
                  title={sug.tipo === "esperar" || sug.tipo === "crear" ? "No se puede aprobar sin validar contra el biométrico" : undefined}>
                  <CheckCircle2 className="size-4" /> Aprobar
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {extras.length || x.review_comment || x.observaciones ? (
        <div className="space-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
          {extras.length ? <p><AlertTriangle className="mr-1 inline size-3.5" />No se validan con el biométrico: {extras.join(" · ")}.</p> : null}
          {x.review_comment ? <p><b>Comentario de revisión:</b> {x.review_comment}</p> : null}
          {x.observaciones ? <p><b>Observaciones de la plantilla:</b> {x.observaciones}</p> : null}
        </div>
      ) : null}

      {abierta ? <div className="border-t bg-muted/20"><DetalleDias fila={x} /></div> : null}
    </Card>
  );
}

function ObservarDialog({ estado, onClose, onGuardar }: { estado: { fila: FilaConciliacion; comentario: string } | null; onClose: () => void; onGuardar: (c: string) => void }) {
  const [comentario, setComentario] = useState("");
  useEffect(() => { setComentario(estado?.comentario ?? ""); }, [estado]);
  return (
    <Dialog open={Boolean(estado)} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Observar novedades de {estado?.fila.full_name}</DialogTitle>
          <DialogDescription>El comentario queda en el historial y le indica al supervisor qué corregir o justificar. Puedes editar la sugerencia.</DialogDescription>
        </DialogHeader>
        <Textarea value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Ej: reporta 6 h extra diurnas y el biométrico solo respalda 3 h. Adjuntar soporte." rows={5} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={comentario.trim().length < 5} onClick={() => onGuardar(comentario)}>Guardar observación</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Dia = { work_date: string; novelty_type: string };
type Jornada = { work_date: string; first_in: string | null; last_out: string | null; worked_minutes: number; overtime_minutes: number; night_minutes: number; sunday_holiday_minutes: number; status: string };

const hm = (m: number) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : "—");

function DetalleDias({ fila }: { fila: FilaConciliacion }) {
  const datos = useQuery({
    queryKey: ["nov-conciliacion", "dias", fila.id],
    queryFn: async () => {
      const [n, a] = await Promise.all([
        supabase.from("novelty_entries").select("work_date, novelty_type").eq("document", fila.document).gte("work_date", fila.period_start).lte("work_date", fila.period_end),
        dbAny.from("asistencia_reporte").select("work_date, first_in, last_out, worked_minutes, overtime_minutes, night_minutes, sunday_holiday_minutes, status").eq("document", fila.document).gte("work_date", fila.period_start).lte("work_date", fila.period_end),
      ]);
      if (n.error) throw n.error;
      if (a.error) throw a.error;
      return { dias: new Map(((n.data ?? []) as Dia[]).map((d) => [d.work_date, d.novelty_type])), jornadas: new Map(((a.data ?? []) as Jornada[]).map((j) => [j.work_date, j])) };
    },
  });
  if (datos.isLoading) return <p className="p-4 text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Cruzando con el biométrico…</p>;
  const fechas = rangoFechas(fila.period_start, fila.period_end);
  return (
    <div className="overflow-x-auto px-4 py-3">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="py-1 font-medium">Día</th>
            <th className="font-medium">Plantilla</th>
            <th className="font-medium">Entrada</th>
            <th className="font-medium">Salida</th>
            <th className="font-medium">Horas</th>
            <th className="font-medium">Extra</th>
            <th className="font-medium">Nocturnas</th>
            <th className="font-medium">Dom/Fest</th>
            <th className="font-medium">Cruce</th>
          </tr>
        </thead>
        <tbody>
          {fechas.map((f) => {
            const tipo = datos.data?.dias.get(f);
            const j = datos.data?.jornadas.get(f);
            const alerta =
              !fila.hay_biometria ? "sin biometría"
              : tipo === "Asiste" && !j ? "Asiste sin marcación"
              : tipo === "Asiste" && j?.status === "incompleta" ? "Marcación incompleta"
              : tipo && tipo !== "Asiste" && j?.status === "completa" ? `Marcó en día de ${tipo.toLowerCase()}`
              : !tipo && j ? "Marcó sin novedad en plantilla"
              : null;
            return (
              <tr key={f} className="border-t">
                <td className="py-1 tabular-nums">{diaSemana(f)} {fechaCorta(f)}</td>
                <td>{tipo ? <span className={cn("rounded px-1.5 py-0.5", colorTipo(tipo))}>{tipo}</span> : <span className="text-muted-foreground">—</span>}</td>
                <td className="tabular-nums">{j?.first_in?.slice(11, 16) ?? "—"}</td>
                <td className="tabular-nums">{j?.last_out?.slice(11, 16) ?? "—"}</td>
                <td className="tabular-nums">{hm(j?.worked_minutes ?? 0)}</td>
                <td className="tabular-nums">{hm(j?.overtime_minutes ?? 0)}</td>
                <td className="tabular-nums">{hm(j?.night_minutes ?? 0)}</td>
                <td className="tabular-nums">{hm(j?.sunday_holiday_minutes ?? 0)}</td>
                <td className={cn(alerta && alerta !== "sin biometría" ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{alerta ?? "✓"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
