import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, MessageSquareWarning, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { descargarCsv } from "@/lib/biometria";
import { colorTipo, diaSemana, rangoFechas } from "@/lib/novedades";
import { Paginador, SimpleTable, usePaginado } from "@/components/simple-table";
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
  review_status: "pendiente" | "aprobado" | "observado";
  review_comment: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

const ESTADO: Record<FilaConciliacion["estado"], { label: string; punto: string; texto: string }> = {
  coherente: { label: "Coherente", punto: "bg-emerald-500", texto: "El biométrico respalda lo reportado." },
  advertencia: { label: "Revisar días", punto: "bg-amber-500", texto: "Las horas cuadran, pero hay días que no coinciden con las marcaciones." },
  inconsistente: { label: "Inconsistente", punto: "bg-red-500", texto: "Se reportan más horas de las que respalda el biométrico." },
  sin_biometria: { label: "Sin biometría", punto: "bg-sky-500", texto: "No hay marcaciones cargadas para este periodo." },
  no_encontrado: { label: "No encontrado", punto: "bg-zinc-400", texto: "El documento no existe en Empleados." },
};
const REVISION: Record<FilaConciliacion["review_status"], { label: string; clase: string }> = {
  pendiente: { label: "Pendiente", clase: "bg-sky-100 text-sky-800 hover:bg-sky-100 dark:bg-sky-950 dark:text-sky-300" },
  aprobado: { label: "Aprobado", clase: "bg-emerald-600 text-white hover:bg-emerald-600" },
  observado: { label: "Observado", clase: "bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300" },
};

const h = (v: number) => (v ? v.toLocaleString("es-CO", { maximumFractionDigits: 2 }) : "0");

export function ConciliacionNovedades({ desde, hasta, puedeAprobar }: { desde: string; hasta: string; puedeAprobar: boolean }) {
  const qc = useQueryClient();
  const acceso = useAccess();
  const [filtro, setFiltro] = useState<string>("todos");
  const [abierta, setAbierta] = useState<string | null>(null);
  const [observar, setObservar] = useState<FilaConciliacion | null>(null);
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
  const filas = useMemo(() => conc.data ?? [], [conc.data]);
  const cuenta = (f: (x: FilaConciliacion) => boolean) => filas.filter(f).length;
  const visibles = useMemo(
    () =>
      filas.filter((x) =>
        filtro === "todos" ? true : filtro.startsWith("rev:") ? x.review_status === filtro.slice(4) : x.estado === filtro,
      ),
    [filas, filtro],
  );
  const pag = usePaginado(visibles, 20);
  const sinBiometria = filas.length > 0 && filas.every((x) => x.estado === "sin_biometria" || x.estado === "no_encontrado");
  const coherentesPendientes = filas.filter((x) => x.estado === "coherente" && x.review_status === "pendiente");

  async function revisar(ids: string[], estado: "aprobado" | "observado" | "pendiente", comentario?: string) {
    setTrabajando(true);
    const { data, error } = await supabase.rpc("revisar_novedades" as never, { _ids: ids, _estado: estado, _comentario: comentario ?? null } as never);
    setTrabajando(false);
    if (error) {
      toast.error("No se pudo registrar la revisión", { description: error.message });
      return false;
    }
    toast.success(
      estado === "aprobado" ? `${data} aprobado(s)` : estado === "observado" ? "Observación registrada" : "Revisión reabierta",
    );
    void qc.invalidateQueries({ queryKey: ["nov-conciliacion"] });
    return true;
  }

  function exportar() {
    descargarCsv(
      `conciliacion_novedades_${desde}_${hasta}`,
      filas.map((x) => {
        const fila: Record<string, unknown> = {
          documento: x.document,
          empleado: x.full_name ?? "",
          cargo: x.position ?? "",
          campana: x.campaign_label ?? "",
          periodo: `${x.period_start} a ${x.period_end}`,
          validacion: ESTADO[x.estado].label,
          dias_asiste_plantilla: x.dias_asiste,
          dias_con_marcacion: x.dias_marcados,
          asiste_sin_marcacion: x.asiste_sin_marca,
          marca_en_dia_de_novedad: x.marca_en_novedad,
        };
        for (const c of x.conceptos) {
          fila[`${c.etiqueta} reportado`] = c.reportado;
          fila[`${c.etiqueta} biometrico`] = c.biometrico;
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

  const tarjetas = [
    { k: "todos", t: "Personas", v: filas.length, punto: "" },
    { k: "coherente", t: "Coherentes", v: cuenta((x) => x.estado === "coherente"), punto: ESTADO.coherente.punto },
    { k: "advertencia", t: "Revisar días", v: cuenta((x) => x.estado === "advertencia"), punto: ESTADO.advertencia.punto },
    { k: "inconsistente", t: "Inconsistentes", v: cuenta((x) => x.estado === "inconsistente"), punto: ESTADO.inconsistente.punto },
    { k: "sin_biometria", t: "Sin biometría", v: cuenta((x) => x.estado === "sin_biometria"), punto: ESTADO.sin_biometria.punto },
    { k: "rev:pendiente", t: "Pendientes de aprobar", v: cuenta((x) => x.review_status === "pendiente"), punto: "" },
  ];

  return (
    <div className="space-y-3">
      {sinBiometria ? (
        <Card className="border-sky-300 bg-sky-50 p-4 text-sm dark:bg-sky-950/40">
          <p className="font-medium">No hay marcaciones del biométrico para este periodo ({desde} a {hasta}).</p>
          <p className="text-muted-foreground">
            La plantilla se cargó, pero no hay con qué validarla. Carga los CSV del biométrico de esas fechas en{" "}
            <Link to="/importaciones" className="text-primary underline">Importaciones</Link>: el cruce se hace automáticamente.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {tarjetas.map((c) => (
          <button
            key={c.k}
            type="button"
            onClick={() => setFiltro(c.k)}
            className={cn("rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary", filtro === c.k && "border-primary ring-1 ring-primary")}
          >
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {c.punto ? <span className={cn("size-2 rounded-full", c.punto)} /> : null}
              {c.t}
            </p>
            <p className="text-xl font-semibold tabular-nums">{conc.isLoading ? "…" : c.v}</p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Se compara lo reportado en la plantilla con lo que respalda el biométrico. Coherente si lo reportado no supera lo marcado en más de {h(tol)} h (ajústalo en Reglas de cálculo). Los ajustes, bonificaciones y comisiones no se validan con el biométrico.
        </p>
        <div className="flex gap-2">
          {acceso.can("novedades", "exportar") ? (
            <Button variant="outline" size="sm" onClick={exportar} disabled={!filas.length}>
              <Download className="size-4" /> Exportar
            </Button>
          ) : null}
          {puedeAprobar && coherentesPendientes.length ? (
            <Button size="sm" disabled={trabajando} onClick={() => revisar(coherentesPendientes.map((x) => x.id), "aprobado")}>
              <CheckCircle2 className="size-4" /> Aprobar coherentes ({coherentesPendientes.length})
            </Button>
          ) : null}
        </div>
      </div>

      <SimpleTable<FilaConciliacion>
        cargando={conc.isLoading}
        filas={pag.visibles}
        getKey={(x) => x.id}
        expandida={abierta}
        onFilaClick={(x) => setAbierta((a) => (a === x.id ? null : x.id))}
        detalle={(x) => <DetalleDias fila={x} />}
        vacio={conc.error ? (conc.error as Error).message : "No hay plantillas de novedades cargadas para este periodo."}
        columnas={[
          { key: "x", header: "", className: "w-6", cell: (x) => (abierta === x.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4 text-muted-foreground" />) },
          {
            key: "p",
            header: "Empleado",
            cell: (x) => (
              <div>
                <p className="font-medium">{x.full_name}</p>
                <p className="text-xs text-muted-foreground">{x.document}{x.campaign_label ? ` · ${x.campaign_label}` : ""}</p>
              </div>
            ),
          },
          {
            key: "v",
            header: "Validación",
            cell: (x) => (
              <span className="flex items-center gap-1.5 text-xs font-medium" title={ESTADO[x.estado].texto}>
                <span className={cn("size-2.5 rounded-full", ESTADO[x.estado].punto)} />
                {ESTADO[x.estado].label}
              </span>
            ),
          },
          ...[0, 1, 2, 3].map((i) => ({
            key: `c${i}`,
            header: <span className="text-xs">{["Nocturnas", "Dom./fest.", "Extra diurna", "Extra nocturna"][i]}<br /><span className="font-normal text-muted-foreground">reportado / biom.</span></span>,
            cell: (x: FilaConciliacion) => {
              const c = x.conceptos[i]!;
              const exceso = x.hay_biometria && c.reportado - c.biometrico > tol;
              if (!c.reportado && !c.biometrico) return <span className="text-muted-foreground">—</span>;
              return (
                <span className={cn("tabular-nums text-xs", exceso && "font-semibold text-destructive")} title={exceso ? `Faltan ${h(c.reportado - c.biometrico)} h de respaldo biométrico` : undefined}>
                  {h(c.reportado)} / {x.hay_biometria ? h(c.biometrico) : "?"}
                </span>
              );
            },
          })),
          {
            key: "d",
            header: "Días",
            cell: (x) => (
              <div className="text-xs">
                <p className="tabular-nums">{x.dias_asiste} asiste · {x.dias_marcados} marcados</p>
                {x.hay_biometria && x.asiste_sin_marca ? <p className="text-amber-700 dark:text-amber-400">{x.asiste_sin_marca} «Asiste» sin marcación</p> : null}
                {x.hay_biometria && x.marca_en_novedad ? <p className="text-amber-700 dark:text-amber-400">{x.marca_en_novedad} con marcación en día de novedad</p> : null}
              </div>
            ),
          },
          {
            key: "r",
            header: "Revisión nómina",
            cell: (x) => (
              <div className="max-w-52 text-xs">
                <Badge variant="secondary" className={REVISION[x.review_status].clase}>{REVISION[x.review_status].label}</Badge>
                {x.review_comment ? <p className="mt-1 line-clamp-2 text-muted-foreground" title={x.review_comment}>{x.review_comment}</p> : null}
                {x.reviewed_by ? <p className="text-[11px] text-muted-foreground">{x.reviewed_by}</p> : null}
              </div>
            ),
          },
          {
            key: "a",
            header: "",
            className: "w-36 text-right",
            cell: (x) =>
              puedeAprobar ? (
                <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  {x.review_status !== "aprobado" ? (
                    <Button size="sm" variant="ghost" title="Aprobar" disabled={trabajando} onClick={() => revisar([x.id], "aprobado")}>
                      <CheckCircle2 className="size-4 text-emerald-600" />
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" title="Observar (requiere comentario)" disabled={trabajando} onClick={() => setObservar(x)}>
                    <MessageSquareWarning className="size-4 text-amber-600" />
                  </Button>
                  {x.review_status !== "pendiente" ? (
                    <Button size="sm" variant="ghost" title="Volver a pendiente" disabled={trabajando} onClick={() => revisar([x.id], "pendiente")}>
                      <RotateCcw className="size-4" />
                    </Button>
                  ) : null}
                </div>
              ) : null,
          },
        ]}
      />

      <Paginador {...pag.paginador} />

      <ObservarDialog
        fila={observar}
        onClose={() => setObservar(null)}
        onGuardar={async (comentario) => {
          if (observar && (await revisar([observar.id], "observado", comentario))) setObservar(null);
        }}
      />
    </div>
  );
}

function ObservarDialog({ fila, onClose, onGuardar }: { fila: FilaConciliacion | null; onClose: () => void; onGuardar: (c: string) => void }) {
  const [comentario, setComentario] = useState("");
  return (
    <Dialog open={Boolean(fila)} onOpenChange={(v) => { if (!v) { setComentario(""); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Observar novedades de {fila?.full_name}</DialogTitle>
          <DialogDescription>
            {fila ? ESTADO[fila.estado].texto : ""} Escribe qué debe corregir o justificar el supervisor; queda en el historial.
          </DialogDescription>
        </DialogHeader>
        <Textarea value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Ej: reporta 6 h extra diurnas y el biométrico solo respalda 3 h. Adjuntar soporte." rows={4} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={comentario.trim().length < 5} onClick={() => { onGuardar(comentario); setComentario(""); }}>Guardar observación</Button>
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
    <div className="overflow-x-auto px-8 py-3">
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
                <td className="py-1 tabular-nums">{diaSemana(f)} {f.slice(8)}/{f.slice(5, 7)}</td>
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
      {fila.observaciones ? <p className="mt-2 text-xs"><span className="font-medium">Observaciones de la plantilla:</span> {fila.observaciones}</p> : null}
    </div>
  );
}
