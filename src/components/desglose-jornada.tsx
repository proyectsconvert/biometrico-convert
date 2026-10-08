import {
  RECARGO_DOMINICAL,
  TIPOS,
  desglosarJornada,
  duracion,
  hhmm,
  totalesPorTipo,
  useFestivos,
  useReglasHoras,
  type TipoTramo,
} from "@/lib/desglose-horas";
import { cn } from "@/lib/utils";

const COLOR: Record<TipoTramo, string> = {
  ordinaria: "bg-muted text-muted-foreground",
  recargo_nocturno: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
  extra_diurna: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  extra_nocturna: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
};

/**
 * Desglose de las horas de una jornada: totales por tipo con su recargo y la explicación tramo por
 * tramo («de 10:08 a 18:08 jornada ordinaria; de 19:00 a 20:26 hora extra nocturna (1,75)…»).
 */
export function DesgloseJornada({
  jornada,
}: {
  jornada: {
    first_in: string | null;
    last_out: string | null;
    worked_minutes: number | null;
    overtime_minutes: number | null;
    overtime_night_minutes?: number | null;
    night_minutes?: number | null;
    sunday_holiday_minutes?: number | null;
    break_applied_minutes?: number | null;
  };
}) {
  const reglas = useReglasHoras();
  const festivos = useFestivos();
  if (!reglas.data || !festivos.data) return null;
  const tramos = desglosarJornada(jornada, reglas.data, festivos.data);
  if (!tramos.length) {
    return <p className="text-xs text-muted-foreground">Sin entrada y salida completas: no hay horas para desglosar.</p>;
  }
  const t = totalesPorTipo(tramos);
  // El cuadro usa lo calculado por el motor; los tramos explican de dónde sale
  const extras = Math.max(0, jornada.overtime_minutes ?? 0);
  const extraNoct = Math.min(extras, Math.max(0, jornada.overtime_night_minutes ?? t.extra_nocturna));
  const recargoNoct = Math.max(0, (jornada.night_minutes ?? t.recargo_nocturno + extraNoct) - extraNoct);
  const motor: Record<TipoTramo, number> = {
    ordinaria: Math.max(0, (jornada.worked_minutes ?? 0) - extras - recargoNoct),
    recargo_nocturno: recargoNoct,
    extra_diurna: extras - extraNoct,
    extra_nocturna: extraNoct,
  };
  const dominical = jornada.sunday_holiday_minutes ?? t.dominical;
  const filas: { tipo: TipoTramo; min: number }[] = (
    ["ordinaria", "recargo_nocturno", "extra_diurna", "extra_nocturna"] as TipoTramo[]
  ).map((tipo) => ({ tipo, min: motor[tipo] }));

  return (
    <div className="grid gap-4 rounded-lg border bg-card p-3 md:grid-cols-[minmax(0,22rem)_1fr]">
      <div>
        <p className="mb-1.5 text-xs font-medium">
          Horas extra: {extras ? duracion(extras) : "ninguna"} · total trabajado {duracion(jornada.worked_minutes ?? 0)}
        </p>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th className="pb-1 font-medium">Tipo</th>
              <th className="pb-1 text-right font-medium">Recargo</th>
              <th className="pb-1 text-right font-medium">Horas</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.tipo} className={cn("border-t", !f.min && "text-muted-foreground")}>
                <td className="py-1">{TIPOS[f.tipo].etiqueta}</td>
                <td className="py-1 text-right tabular-nums">{TIPOS[f.tipo].recargo}</td>
                <td className="py-1 text-right tabular-nums">{f.min ? duracion(f.min) : "—"}</td>
              </tr>
            ))}
            {dominical ? (
              <tr className="border-t">
                <td className="py-1">Dominical / festivo (se suma al tipo)</td>
                <td className="py-1 text-right tabular-nums">{RECARGO_DOMINICAL}</td>
                <td className="py-1 text-right tabular-nums">{duracion(dominical)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {jornada.break_applied_minutes ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Se descontaron {duracion(jornada.break_applied_minutes)} de descanso de lo trabajado.
          </p>
        ) : null}
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium">Cómo se calculó</p>
        <ol className="space-y-1 text-xs">
          {tramos.map((x, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-28 tabular-nums">
                {hhmm(x.desde)} a {hhmm(x.hasta)}
              </span>
              <span className="w-12 text-right tabular-nums text-muted-foreground">{duracion(x.minutos)}</span>
              <span className={cn("rounded px-1.5 py-0.5", COLOR[x.tipo])}>
                {TIPOS[x.tipo].etiqueta}
                {TIPOS[x.tipo].recargo !== "—" ? ` (${TIPOS[x.tipo].recargo})` : ""}
                {x.dominical ? ` + dominical/festivo (${RECARGO_DOMINICAL})` : ""}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[11px] text-muted-foreground">
          La jornada ordinaria llega hasta las horas configuradas en Reglas de cálculo; lo que pasa de ahí es extra. Es nocturna
          entre {reglas.data.nocIni} y {reglas.data.nocFin}.
        </p>
      </div>
    </div>
  );
}
