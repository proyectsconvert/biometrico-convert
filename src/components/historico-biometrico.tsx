import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, DatabaseZap, Layers, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { estadoCapaCruda, finalizarReconstruccion, recargarCrudo, reconstruirMes } from "@/lib/importaciones.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Mes = { mes: string; dias_mes: number; dias_con_datos: number; dias_sin_datos: string[]; personas: number; archivos: number };
type Archivo = { id: string; filename: string; started_at: string };
type Progreso = { fase: string; hechos: number; total: number; errores: string[]; detalle?: string };

const nombreMes = (m: string) =>
  new Date(`${m}T12:00:00`).toLocaleDateString("es-CO", { month: "long", year: "numeric" }).replace(/^./, (c) => c.toUpperCase());
const rangos = (dias: string[]) => {
  // 2025-02-01, 02, 03, 05 → «1–3, 5»
  const n = dias.map((d) => Number(d.slice(8)));
  const out: string[] = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j]! + 1) j++;
    out.push(i === j ? `${n[i]}` : `${n[i]}–${n[j]}`);
    i = j;
  }
  return out.join(", ");
};

/**
 * Orden cronológico de los reportes de BioStar: primero la fecha de la exportación
 * (Report_20250321_…), y dentro de ella del número más alto (lo más antiguo) al _1 (lo más reciente).
 */
export function ordenCronologico(a: Archivo, b: Archivo) {
  const clave = (f: Archivo) => {
    const m = f.filename.match(/Report_(\d{8})_[^_]+_(\d+)\.csv$/i);
    return m ? { fecha: m[1]!, parte: Number(m[2]) } : { fecha: f.started_at.slice(0, 10).replace(/-/g, ""), parte: 0 };
  };
  const x = clave(a);
  const y = clave(b);
  return x.fecha === y.fecha ? y.parte - x.parte : x.fecha.localeCompare(y.fecha);
}

async function enParalelo<T>(lista: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => { while (i < lista.length) await fn(lista[i++]!); }));
}

/** Cobertura del histórico por mes y reproceso completo desde los archivos originales. */
export function HistoricoBiometrico({ puedeReconstruir }: { puedeReconstruir: boolean }) {
  const qc = useQueryClient();
  const recargar = useServerFn(recargarCrudo);
  const estado = useServerFn(estadoCapaCruda);
  const porMes = useServerFn(reconstruirMes);
  const finalizar = useServerFn(finalizarReconstruccion);
  const [abierto, setAbierto] = useState(false);
  const [expandido, setExpandido] = useState(false);
  const [recargarArchivos, setRecargarArchivos] = useState(true);
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const trabajando = Boolean(progreso && progreso.fase !== "listo");

  const cobertura = useQuery({
    queryKey: ["importaciones", "cobertura"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("cobertura_historico" as never);
      if (error) throw error;
      return (data as unknown as Mes[]) ?? [];
    },
  });
  const meses = cobertura.data ?? [];
  const visibles = expandido ? meses : meses.slice(0, 4);

  async function ejecutar() {
    const inicio = Date.now();
    const errores: string[] = [];
    try {
      // 1. Capa cruda de cada archivo, en orden cronológico
      const { data: imps, error } = await supabase.from("biometric_imports").select("id, filename, started_at").limit(5000);
      if (error) throw error;
      const inicial = await estado();
      const pendientes = new Set(inicial.sinCrudo);
      const archivos = ((imps ?? []) as Archivo[]).filter((a) => recargarArchivos || pendientes.has(a.id)).sort(ordenCronologico);
      let hechos = 0;
      setProgreso({ fase: "Leyendo los archivos originales (capa cruda)", hechos, total: archivos.length, errores });
      await enParalelo(archivos, 3, async (a) => {
        try {
          await recargar({ data: { importId: a.id } });
        } catch (e) {
          errores.push(`${a.filename}: ${(e as Error).message}`);
        }
        hechos++;
        setProgreso({ fase: "Leyendo los archivos originales (capa cruda)", hechos, total: archivos.length, errores: [...errores], detalle: a.filename });
      });
      if (errores.length) throw new Error(`${errores.length} archivos no se pudieron leer; revisa la lista y vuelve a intentar.`);

      // 2. Capa limpia y jornadas, mes por mes
      const { tramos: lista } = await estado();
      for (const [i, t] of lista.entries()) {
        setProgreso({ fase: "Ordenando, limpiando y recalculando por tramos", hechos: i, total: lista.length, errores, detalle: t.etiqueta });
        await porMes({ data: { ini: t.ini, fin: t.fin, recalcular: t.recalcular } });
      }

      // 3. Cierre
      setProgreso({ fase: "Cerrando: estadísticas por archivo", hechos: lista.length, total: lista.length, errores });
      const r = await finalizar();
      setProgreso({ fase: "listo", hechos: lista.length, total: lista.length, errores });
      toast.success("Histórico reprocesado", {
        description: `${r.filas_crudas.toLocaleString("es-CO")} filas de ${archivos.length} archivos → ${r.eventos_limpios.toLocaleString("es-CO")} eventos en el histórico limpio · ${Math.round((Date.now() - inicio) / 60000)} min`,
      });
      void qc.invalidateQueries();
    } catch (e) {
      setProgreso((p) => (p ? { ...p, fase: "error", errores: [...(p.errores ?? []), (e as Error).message] } : null));
      toast.error("El reproceso se detuvo", { description: (e as Error).message });
    }
  }

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-semibold"><Layers className="size-4" /> Histórico consolidado</p>
          <p className="text-xs text-muted-foreground">
            Capa cruda: todas las filas de todos los CSV, tal cual (incluidas las repetidas). Capa limpia: un evento por cada marca distinta, ordenado por persona y hora; de ahí salen la entrada (primera marca del día) y la salida (última), sin importar la puerta.
          </p>
        </div>
        {puedeReconstruir ? (
          <Button variant="outline" onClick={() => { setProgreso(null); setAbierto(true); }}><DatabaseZap className="size-4" /> Reprocesar todo</Button>
        ) : null}
      </div>

      {cobertura.isLoading ? (
        <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Revisando cobertura…</p>
      ) : !meses.length ? (
        <p className="text-sm text-muted-foreground">Aún no hay marcaciones cargadas.</p>
      ) : (
        <div className="space-y-2">
          {visibles.map((m) => {
            const pct = Math.round((m.dias_con_datos / m.dias_mes) * 100);
            return (
              <div key={m.mes} className="grid items-center gap-2 text-sm sm:grid-cols-[150px_1fr_auto]">
                <span className="font-medium">{nombreMes(m.mes)}</span>
                <div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className={cn("h-full rounded-full", pct === 100 ? "bg-emerald-500" : pct >= 60 ? "bg-primary" : "bg-amber-500")} style={{ width: `${pct}%` }} />
                  </div>
                  {m.dias_sin_datos.length ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Sin datos los días: {rangos(m.dias_sin_datos)} — carga los CSV de esas fechas.</p>
                  ) : null}
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">{m.dias_con_datos}/{m.dias_mes} días · {m.personas} personas · {m.archivos} archivos</span>
              </div>
            );
          })}
          {meses.length > 4 ? (
            <button type="button" className="flex items-center gap-1 text-xs text-primary" onClick={() => setExpandido(!expandido)}>
              {expandido ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {expandido ? "Ver menos" : `Ver los ${meses.length} meses`}
            </button>
          ) : null}
        </div>
      )}

      <Dialog open={abierto} onOpenChange={(v) => !trabajando && setAbierto(v)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reprocesar todo el histórico</DialogTitle>
            <DialogDescription>Como combinar todos los CSV en Power Query y volver a calcular.</DialogDescription>
          </DialogHeader>
          {!progreso ? (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                <li>Lee de nuevo cada archivo guardado, en orden cronológico, y guarda todas sus filas (capa cruda).</li>
                <li>Por tramos de días (en orden cronológico): une todo, deja un evento por cada marca distinta, lo ordena por persona y hora, marca repetidas y recalcula las jornadas.</li>
                <li>Actualiza las estadísticas de cada archivo.</li>
              </ol>
              <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <Checkbox checked={recargarArchivos} onCheckedChange={(v) => setRecargarArchivos(Boolean(v))} className="mt-0.5" />
                <span>
                  Volver a leer todos los archivos del almacenamiento
                  <span className="block text-xs text-muted-foreground">Desmárcalo para usar la capa cruda ya guardada (más rápido); los archivos que no la tengan se leen igual.</span>
                </span>
              </label>
              <p className="text-xs text-muted-foreground">Puede tardar varios minutos. No cierres esta pestaña mientras corre.</p>
            </>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="font-medium">{progreso.fase === "listo" ? "Terminado" : progreso.fase === "error" ? "Se detuvo" : progreso.fase}</p>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-all", progreso.fase === "error" ? "bg-destructive" : "bg-primary")} style={{ width: `${progreso.total ? (100 * progreso.hechos) / progreso.total : 0}%` }} />
              </div>
              <p className="text-xs tabular-nums text-muted-foreground">{progreso.hechos} de {progreso.total}{progreso.detalle ? ` · ${progreso.detalle}` : ""}</p>
              {progreso.errores.length ? (
                <ul className="max-h-32 space-y-0.5 overflow-auto rounded-md border border-destructive/40 p-2 text-xs text-destructive">
                  {progreso.errores.map((e) => <li key={e}>{e}</li>)}
                </ul>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={trabajando} onClick={() => setAbierto(false)}>{progreso?.fase === "listo" ? "Cerrar" : "Cancelar"}</Button>
            {!progreso || progreso.fase === "error" ? (
              <Button onClick={() => void ejecutar()}><DatabaseZap className="size-4" /> {progreso ? "Reintentar" : "Reprocesar"}</Button>
            ) : trabajando ? (
              <Button disabled><Loader2 className="size-4 animate-spin" /> Procesando…</Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
