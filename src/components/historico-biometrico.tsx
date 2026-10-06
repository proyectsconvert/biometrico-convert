import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  DatabaseZap,
  Layers,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Square,
  Zap,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  cancelarReproceso,
  estadoReproceso,
  iniciarReproceso,
  reintentarReproceso,
  type TrabajoReproceso,
} from "@/lib/reproceso.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mensajeLimpio } from "@/lib/errores-red";
import { cn } from "@/lib/utils";

type Mes = {
  mes: string;
  dias_mes: number;
  dias_con_datos: number;
  dias_sin_datos: string[];
  personas: number;
  archivos: number;
};
type Archivo = { id: string; filename: string; started_at: string };

const nombreMes = (m: string) =>
  new Date(`${m}T12:00:00`)
    .toLocaleDateString("es-CO", { month: "long", year: "numeric" })
    .replace(/^./, (c) => c.toUpperCase());
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
    return m
      ? { fecha: m[1]!, parte: Number(m[2]) }
      : { fecha: f.started_at.slice(0, 10).replace(/-/g, ""), parte: 0 };
  };
  const x = clave(a);
  const y = clave(b);
  return x.fecha === y.fecha ? y.parte - x.parte : x.fecha.localeCompare(y.fecha);
}

/** Cobertura del histórico por mes y reproceso completo desde los archivos originales. */
export function HistoricoBiometrico({ puedeReconstruir }: { puedeReconstruir: boolean }) {
  const qc = useQueryClient();
  const iniciar = useServerFn(iniciarReproceso);
  const consultar = useServerFn(estadoReproceso);
  const cancelar = useServerFn(cancelarReproceso);
  const reintentar = useServerFn(reintentarReproceso);
  const [abierto, setAbierto] = useState(false);
  const [expandido, setExpandido] = useState(false);
  const [releerTodo, setReleerTodo] = useState(false);
  const [enviando, setEnviando] = useState(false);

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

  // El reproceso corre en el servidor: se consulta su avance (cada 2 s mientras está en curso)
  const estado = useQuery({
    queryKey: ["importaciones", "reproceso"],
    enabled: puedeReconstruir,
    queryFn: () => consultar(),
    refetchInterval: (q) =>
      q.state.data?.trabajo?.status === "en_curso" ? 2000 : abierto ? 10000 : false,
  });
  const trabajo = estado.data?.trabajo ?? null;
  const enCurso = trabajo?.status === "en_curso";
  const [ultimoEstado, setUltimoEstado] = useState<string | null>(null);
  useEffect(() => {
    if (!trabajo) return;
    if (ultimoEstado === "en_curso" && trabajo.status !== "en_curso") {
      if (trabajo.status === "completado")
        toast.success(
          trabajo.modo === "verificar" ? "Verificación terminada" : "Histórico reprocesado",
          { description: trabajo.fase ?? "" },
        );
      else if (trabajo.status === "error")
        toast.error("El reproceso se detuvo", {
          description: mensajeLimpio(trabajo.errores.at(-1) ?? ""),
        });
      void qc.invalidateQueries();
    }
    setUltimoEstado(trabajo.status);
  }, [trabajo, ultimoEstado, qc]);

  async function accion(fn: () => Promise<unknown>) {
    setEnviando(true);
    try {
      await fn();
      await estado.refetch();
    } catch (e) {
      toast.error("No se pudo completar", { description: (e as Error).message });
    } finally {
      setEnviando(false);
    }
  }
  const archivosConError = trabajo
    ? Object.values(trabajo.archivos).filter((a) => a.estado === "error")
    : [];
  const reintentados = trabajo
    ? Object.values(trabajo.archivos).filter((a) => a.intentos > 1 && a.estado === "ok").length
    : 0;

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-semibold">
            <Layers className="size-4" /> Histórico consolidado
          </p>
          <p className="text-xs text-muted-foreground">
            Capa cruda: todas las filas de todos los CSV, tal cual (incluidas las repetidas). Capa
            limpia: un evento por cada marca distinta, ordenado por persona y hora; de ahí salen la
            entrada (primera marca del día) y la salida (última), sin importar la puerta.
          </p>
        </div>
        {puedeReconstruir ? (
          <Button variant="outline" onClick={() => setAbierto(true)}>
            {enCurso ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <DatabaseZap className="size-4" />
            )}{" "}
            {enCurso ? "Reproceso en curso…" : "Reprocesar todo"}
          </Button>
        ) : null}
      </div>

      {cobertura.isLoading ? (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline size-4 animate-spin" />
          Revisando cobertura…
        </p>
      ) : !meses.length ? (
        <p className="text-sm text-muted-foreground">Aún no hay marcaciones cargadas.</p>
      ) : (
        <div className="space-y-2">
          {visibles.map((m) => {
            const pct = Math.round((m.dias_con_datos / m.dias_mes) * 100);
            return (
              <div
                key={m.mes}
                className="grid items-center gap-2 text-sm sm:grid-cols-[150px_1fr_auto]"
              >
                <span className="font-medium">{nombreMes(m.mes)}</span>
                <div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        pct === 100 ? "bg-emerald-500" : pct >= 60 ? "bg-primary" : "bg-amber-500",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {m.dias_sin_datos.length ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Sin datos los días: {rangos(m.dias_sin_datos)} — carga los CSV de esas fechas.
                    </p>
                  ) : null}
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {m.dias_con_datos}/{m.dias_mes} días · {m.personas} personas · {m.archivos}{" "}
                  archivos
                </span>
              </div>
            );
          })}
          {meses.length > 4 ? (
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-primary"
              onClick={() => setExpandido(!expandido)}
            >
              {expandido ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {expandido ? "Ver menos" : `Ver los ${meses.length} meses`}
            </button>
          ) : null}
        </div>
      )}

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Reprocesar todo el histórico</DialogTitle>
            <DialogDescription>
              Como combinar todos los CSV en Power Query y volver a calcular. Corre en el servidor:
              puedes cerrar esta ventana o la pestaña.
            </DialogDescription>
          </DialogHeader>
          {trabajo &&
          (enCurso ||
            trabajo.status !== "completado" ||
            Date.now() - Date.parse(trabajo.finished_at ?? trabajo.created_at) < 3_600_000) ? (
            <div className="space-y-3 rounded-lg border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">
                  {trabajo.modo === "verificar" ? "Verificación · " : ""}
                  {trabajo.status === "en_curso"
                    ? trabajo.fase
                    : trabajo.status === "completado"
                      ? (trabajo.fase ?? "Terminado")
                      : trabajo.status === "error"
                        ? "Se detuvo"
                        : trabajo.status === "cancelado"
                          ? "Cancelado"
                          : "Interrumpido"}
                </p>
                {trabajo.conexion ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                      trabajo.conexion === "directa"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Zap className="size-3" />{" "}
                    {trabajo.conexion === "directa" ? "Conexión directa a la base" : "Por la API"}
                  </span>
                ) : null}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    trabajo.status === "error"
                      ? "bg-destructive"
                      : trabajo.status === "completado"
                        ? "bg-emerald-500"
                        : "bg-primary",
                  )}
                  style={{
                    width: `${trabajo.total ? Math.min(100, (100 * trabajo.hechos) / trabajo.total) : enCurso ? 5 : 100}%`,
                  }}
                />
              </div>
              <p className="text-xs tabular-nums text-muted-foreground">
                {trabajo.hechos} de {trabajo.total}
                {trabajo.detalle ? ` · ${trabajo.detalle}` : ""}
                {reintentados ? ` · ${reintentados} archivos se recuperaron con reintentos` : ""}
              </p>
              {trabajo.status === "completado" && trabajo.resultado ? (
                <p className="flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                  {trabajo.modo === "verificar"
                    ? `${String(trabajo.resultado["completos"] ?? 0)} de ${String(trabajo.resultado["archivos"] ?? 0)} archivos completos`
                    : `${Number(trabajo.resultado["filas_crudas"] ?? 0).toLocaleString("es-CO")} filas de ${String(trabajo.resultado["archivos"] ?? 0)} archivos → ${Number(trabajo.resultado["eventos_limpios"] ?? 0).toLocaleString("es-CO")} eventos · ${String(trabajo.resultado["minutos"] ?? "")} min`}
                </p>
              ) : null}
              {archivosConError.length || trabajo.errores.length ? (
                <ul className="max-h-36 space-y-0.5 overflow-auto rounded-md border border-destructive/40 p-2 text-xs text-destructive">
                  {archivosConError.map((a) => (
                    <li key={a.nombre}>
                      {a.nombre}: {mensajeLimpio(a.error)} ({a.intentos} intentos)
                    </li>
                  ))}
                  {/* Los últimos errores distintos, ya resumidos (un corte del proxy llega como página HTML) */}
                  {[
                    ...new Set(
                      trabajo.errores
                        .filter((e) => !archivosConError.some((a) => e.startsWith(a.nombre)))
                        .map((e) => mensajeLimpio(e)),
                    ),
                  ]
                    .slice(-6)
                    .map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                </ul>
              ) : null}
              {estado.data?.reanudado ? (
                <p className="text-xs text-muted-foreground">
                  El servidor se había reiniciado: el reproceso se reanudó donde iba.
                </p>
              ) : null}
            </div>
          ) : null}
          {!enCurso ? (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                <li>
                  Revisa que cada archivo tenga su capa cruda completa y relee solo los que falten
                  (con reintentos automáticos).
                </li>
                <li>
                  Por tramos de días, en orden cronológico: une todo, deja un evento por cada marca
                  distinta, marca repetidas y recalcula las jornadas.
                </li>
                <li>Actualiza las estadísticas de cada archivo y verifica el resultado.</li>
              </ol>
              <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <Checkbox
                  checked={releerTodo}
                  onCheckedChange={(v) => setReleerTodo(Boolean(v))}
                  className="mt-0.5"
                />
                <span>
                  Volver a leer todos los archivos del almacenamiento
                  <span className="block text-xs text-muted-foreground">
                    Normalmente no hace falta: los archivos incompletos se releen solos. Márcalo
                    solo si cambió la forma de leer los CSV (mucho más lento).
                  </span>
                </span>
              </label>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Puedes cerrar esta ventana o la pestaña: el reproceso sigue en el servidor y aquí
              verás el avance cuando vuelvas.
            </p>
          )}
          <DialogFooter className="flex-wrap gap-2">
            {enCurso && trabajo ? (
              <Button
                variant="outline"
                disabled={enviando}
                onClick={() => void accion(() => cancelar({ data: { id: trabajo.id } }))}
              >
                <Square className="size-4" /> Cancelar
              </Button>
            ) : null}
            {!enCurso &&
            trabajo &&
            ["error", "cancelado", "interrumpido"].includes(trabajo.status) ? (
              <Button
                variant="outline"
                disabled={enviando}
                onClick={() => void accion(() => reintentar({ data: { id: trabajo.id } }))}
              >
                <RotateCcw className="size-4" /> Reintentar desde donde iba
              </Button>
            ) : null}
            {!enCurso ? (
              <>
                <Button
                  variant="outline"
                  disabled={enviando}
                  onClick={() =>
                    void accion(() => iniciar({ data: { modo: "verificar", releerTodo: false } }))
                  }
                >
                  <ShieldCheck className="size-4" /> Solo verificar archivos
                </Button>
                <Button
                  disabled={enviando}
                  onClick={() =>
                    void accion(() => iniciar({ data: { modo: "completo", releerTodo } }))
                  }
                >
                  {enviando ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <DatabaseZap className="size-4" />
                  )}{" "}
                  Reprocesar
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={() => setAbierto(false)}>
                Seguir en segundo plano
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
