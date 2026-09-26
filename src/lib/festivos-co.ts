/** Festivos de Colombia (Ley 51 de 1983, «Ley Emiliani») para un año. */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dia = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const sumar = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
/** Traslada al lunes siguiente si no cae en lunes. */
const alLunes = (d: Date) => sumar(d, (8 - d.getUTCDay()) % 7);

/** Domingo de Pascua (algoritmo de Meeus/Butcher, calendario gregoriano). */
function pascua(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), diaMes = ((h + l - 7 * m + 114) % 31) + 1;
  return dia(y, mes, diaMes);
}

export function festivosColombia(y: number): { fecha: string; descripcion: string }[] {
  const p = pascua(y);
  const lista: [Date, string][] = [
    [dia(y, 1, 1), "Año Nuevo"],
    [alLunes(dia(y, 1, 6)), "Reyes Magos"],
    [alLunes(dia(y, 3, 19)), "San José"],
    [sumar(p, -3), "Jueves Santo"],
    [sumar(p, -2), "Viernes Santo"],
    [dia(y, 5, 1), "Día del Trabajo"],
    [sumar(p, 43), "Ascensión del Señor"],
    [sumar(p, 64), "Corpus Christi"],
    [sumar(p, 71), "Sagrado Corazón"],
    [alLunes(dia(y, 6, 29)), "San Pedro y San Pablo"],
    [dia(y, 7, 20), "Día de la Independencia"],
    [dia(y, 8, 7), "Batalla de Boyacá"],
    [alLunes(dia(y, 8, 15)), "Asunción de la Virgen"],
    [alLunes(dia(y, 10, 12)), "Día de la Raza"],
    [alLunes(dia(y, 11, 1)), "Todos los Santos"],
    [alLunes(dia(y, 11, 11)), "Independencia de Cartagena"],
    [dia(y, 12, 8), "Inmaculada Concepción"],
    [dia(y, 12, 25), "Navidad"],
  ];
  return lista.map(([d, descripcion]) => ({ fecha: iso(d), descripcion })).sort((a, b) => a.fecha.localeCompare(b.fecha));
}
