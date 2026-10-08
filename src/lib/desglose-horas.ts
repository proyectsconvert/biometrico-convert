import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";

/**
 * Desglose de una jornada en tramos (jornada ordinaria, recargo nocturno, extra diurna, extra
 * nocturna, dominical/festivo), con las mismas reglas que el motor (recalcular_asistencia):
 * - lo trabajado hasta «horas_extra_despues» es jornada ordinaria; lo que pasa de ahí, al final del
 *   día, es extra (el motor guarda cuántos minutos: overtime_minutes);
 * - cada tramo es nocturno si cae entre «nocturna_inicio» y «nocturna_fin»;
 * - es dominical/festivo si cae en domingo o en un festivo activo (y la regla lo aplica).
 */

/**
 * Quién ve horas extra, nocturnas y recargos: el permiso «Cálculo horas extra» de Control diario
 * (Roles y permisos). De inicio lo tienen Administración y Nómina; el Super Administrador, siempre.
 */
export function useVeHoras() {
  const acceso = useAccess();
  return acceso.can("asistencia", "calculo_horas_extra");
}

export type ReglasHoras = { nocIni: string; nocFin: string; dominical: boolean };

export function useReglasHoras() {
  return useQuery({
    queryKey: ["reglas", "desglose-horas"],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("rules")
        .select("key, value")
        .in("key", ["nocturna_inicio", "nocturna_fin", "aplica_dominical_festivo"]);
      const v = new Map((data ?? []).map((r) => [r.key, r.value as unknown]));
      return {
        nocIni: String(v.get("nocturna_inicio") ?? "19:00"),
        nocFin: String(v.get("nocturna_fin") ?? "06:00"),
        dominical: v.get("aplica_dominical_festivo") !== false,
      } satisfies ReglasHoras;
    },
  });
}

/** Festivos activos (fecha ISO) para marcar los tramos dominicales/festivos. */
export function useFestivos() {
  return useQuery({
    queryKey: ["festivos", "activos"],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data } = await supabase.from("holidays").select("holiday_date").eq("is_active", true);
      return new Set((data ?? []).map((h) => String(h.holiday_date)));
    },
  });
}

export type TipoTramo = "ordinaria" | "recargo_nocturno" | "extra_diurna" | "extra_nocturna";

/** Recargo de cada tipo, como en la plantilla de novedades. */
export const TIPOS: Record<TipoTramo, { etiqueta: string; recargo: string }> = {
  ordinaria: { etiqueta: "Jornada ordinaria diurna", recargo: "—" },
  recargo_nocturno: { etiqueta: "Recargo nocturno", recargo: "0,35" },
  extra_diurna: { etiqueta: "Hora extra diurna", recargo: "1,25" },
  extra_nocturna: { etiqueta: "Hora extra nocturna", recargo: "1,75" },
};
/** Recargo dominical/festivo que se suma (plantilla: 0,90 y 1,90). */
export const RECARGO_DOMINICAL = "0,90";

export type Tramo = { desde: Date; hasta: Date; minutos: number; tipo: TipoTramo; dominical: boolean };

const ms = (iso: string) => Date.parse(`${iso.slice(0, 19)}Z`);
const minutosDe = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const esNocturno = (minDelDia: number, ini: number, fin: number) =>
  ini > fin ? minDelDia >= ini || minDelDia < fin : minDelDia >= ini && minDelDia < fin;

/**
 * Reparte [entrada, salida] en tramos con las mismas fronteras que usa el motor: las extras son los
 * últimos «overtime_minutes» antes de la salida, y se corta en cada inicio y fin del horario
 * nocturno y en cada medianoche (dominical/festivo). Las fechas se tratan como hora local del
 * biométrico (sin zona), igual que en la base. Cada tramo se redondea al minuto, como el motor.
 */
export function desglosarJornada(
  j: { first_in: string | null; last_out: string | null; overtime_minutes: number | null },
  reglas: ReglasHoras,
  festivos: Set<string>,
): Tramo[] {
  if (!j.first_in || !j.last_out) return [];
  const a = ms(j.first_in);
  const b = ms(j.last_out);
  if (!(b > a)) return [];
  const inicioExtra = Math.max(a, b - Math.max(0, j.overtime_minutes ?? 0) * 60_000);
  const ini = minutosDe(reglas.nocIni);
  const fin = minutosDe(reglas.nocFin);
  // Fronteras: entrada, salida, inicio de extras, inicio/fin nocturno y medianoches del rango
  const cortes = new Set<number>([a, b, inicioExtra]);
  const DIA = 864e5;
  for (let d = Math.floor(a / DIA) * DIA - DIA; d <= b; d += DIA) {
    for (const t of [d, d + ini * 60_000, d + fin * 60_000]) if (t > a && t < b) cortes.add(t);
  }
  const puntos = [...cortes].sort((x, y) => x - y);
  const tramos: Tramo[] = [];
  for (let i = 0; i < puntos.length - 1; i++) {
    const desde = puntos[i]!;
    const hasta = puntos[i + 1]!;
    const medio = new Date((desde + hasta) / 2);
    const noct = esNocturno(medio.getUTCHours() * 60 + medio.getUTCMinutes(), ini, fin);
    const esExtra = desde >= inicioExtra;
    const tipo: TipoTramo = esExtra ? (noct ? "extra_nocturna" : "extra_diurna") : noct ? "recargo_nocturno" : "ordinaria";
    const dominical = reglas.dominical && (medio.getUTCDay() === 0 || festivos.has(medio.toISOString().slice(0, 10)));
    const ult = tramos.at(-1);
    if (ult && ult.tipo === tipo && ult.dominical === dominical) ult.hasta = new Date(hasta);
    else tramos.push({ desde: new Date(desde), hasta: new Date(hasta), minutos: 0, tipo, dominical });
  }
  for (const t of tramos) t.minutos = Math.round((t.hasta.getTime() - t.desde.getTime()) / 60_000);
  return tramos.filter((t) => t.minutos > 0);
}

/** Minutos por tipo (y cuántos de ellos son dominicales/festivos). */
export function totalesPorTipo(tramos: Tramo[]) {
  const t = { ordinaria: 0, recargo_nocturno: 0, extra_diurna: 0, extra_nocturna: 0, dominical: 0 };
  for (const x of tramos) {
    t[x.tipo] += x.minutos;
    if (x.dominical) t.dominical += x.minutos;
  }
  return t;
}

export const hhmm = (d: Date) => d.toISOString().slice(11, 16);
export const duracion = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
