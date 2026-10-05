/** Tipos y utilidades compartidas del módulo de Turnos. */

export type Campana = { id: string; name: string };
export type Turno = {
  id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  crosses_midnight: boolean;
  break_minutes: number;
  tolerance_in_minutes: number;
  tolerance_out_minutes: number;
  workdays: number[];
  status: string;
  campaign_id: string | null;
  color: string | null;
};
export type Rotacion = {
  id: string;
  code: string;
  name: string;
  campaign_id: string | null;
  semanas: string[];
  status: string;
};
export type Empleado = {
  id: string;
  document: string;
  full_name: string;
  position: string | null;
  campaign_id: string | null;
};
/** Turno del día: de la malla (horario o novedad), de una rotación o de un horario fijo. */
export type Programado = {
  employee_id: string;
  fecha: string;
  shift_id: string | null;
  laborable: boolean;
  assignment_id: string | null;
  rotation_id: string | null;
  semana: number | null;
  novedad: string | null;
  origen: "malla" | "rotacion" | "fijo";
};

export const COLORES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#9333ea",
  "#db2777",
  "#0891b2",
  "#ca8a04",
  "#64748b",
];
// Días como en la base (0 = domingo), mostrados de lunes a domingo
export const DIAS: [number, string, string][] = [
  [1, "L", "Lunes"],
  [2, "M", "Martes"],
  [3, "X", "Miércoles"],
  [4, "J", "Jueves"],
  [5, "V", "Viernes"],
  [6, "S", "Sábado"],
  [0, "D", "Domingo"],
];

export const hora = (t: string | null | undefined) => (t ? t.slice(0, 5) : "—");
export const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const deIso = (s: string) => new Date(`${s}T12:00:00`);
export const sumarDias = (s: string, n: number) => {
  const d = deIso(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
export const lunesDe = (s: string) => {
  const d = deIso(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
};
export const rangoFechas = (desde: string, hasta: string) => {
  const out: string[] = [];
  for (let f = desde; f <= hasta && out.length < 400; f = sumarDias(f, 1)) out.push(f);
  return out;
};
export const corta = (s: string) =>
  deIso(s).toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
export const hoy = () => iso(new Date());

/** Trae todas las filas de una consulta por bloques de 1.000 (límite de la API). */
export async function todas<T>(
  consulta: (
    desde: number,
    hasta: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
) {
  const out: T[] = [];
  for (let i = 0; i < 50; i++) {
    const { data, error } = await consulta(i * 1000, i * 1000 + 999);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as T[];
    out.push(...filas);
    if (filas.length < 1000) break;
  }
  return out;
}
