/**
 * Reglas de la conciliación de novedades (plantilla del supervisor frente al biométrico).
 *
 * - Solo se concilian los bloques de horas que se reportan (> 0). Lo que no se reporta no se muestra
 *   ni se menciona en observaciones: no debe leerse como horas pendientes de pago.
 * - Si el biométrico respalda igual o más de lo reportado, cuadra.
 * - Si respalda un poco menos (dentro de la tolerancia), se revisa; si respalda menos, más allá de la
 *   tolerancia, no cuadra. Los días trabajados sin marcación son informativos: no cambian el resultado.
 */
export type ConceptoConciliacion = {
  clave: string;
  etiqueta: string;
  reportado: number;
  /** Lo que respalda el biométrico (en nocturnas y extras diurnas incluye la bolsa de extras nocturnas). */
  biometrico: number;
  /** Horas de extras nocturnas no reportadas que respaldan este concepto. */
  de_extra_nocturna?: number;
  /** En extras nocturnas: cuántas se usaron para respaldar nocturnas o extras diurnas. */
  usado_en_otros?: number;
};

/** «(incluye 0,73 h de extra nocturna)» cuando el concepto se respalda con la bolsa de extras nocturnas. */
export const notaBolsa = (c: ConceptoConciliacion) =>
  Number(c.de_extra_nocturna) > 0.009
    ? `incluye ${Number(c.de_extra_nocturna).toLocaleString("es-CO", { maximumFractionDigits: 2 })} h de extra nocturna`
    : null;

type Cruce = {
  estado: string;
  hay_biometria: boolean;
  asiste_sin_marca: number;
  asiste_incompleta: number;
  conceptos: ConceptoConciliacion[];
};

export type ResultadoConciliacion =
  "coherente" | "advertencia" | "inconsistente" | "sin_biometria" | "no_encontrado";

/** Bloques de horas que el supervisor reporta (los demás no se concilian). */
export const conceptosReportados = (x: Pick<Cruce, "conceptos">) =>
  (x.conceptos ?? []).filter((c) => Number(c.reportado) > 0);

/** Bloques donde se reporta más de lo que respalda el biométrico (más allá de la tolerancia). */
export const conceptosQueFaltan = (x: Pick<Cruce, "conceptos">, tol: number) =>
  conceptosReportados(x).filter((c) => c.reportado - c.biometrico > tol);

/** Bloques con una diferencia menor: el biométrico respalda un poco menos, dentro de la tolerancia. */
export const conceptosConDiferenciaMenor = (x: Pick<Cruce, "conceptos">, tol: number) =>
  conceptosReportados(x).filter((c) => {
    const dif = c.reportado - c.biometrico;
    return dif > 0.01 && dif <= tol;
  });

/**
 * Días trabajados sin marcación o con una sola marcación. Son informativos (se ven en el detalle por
 * día): el resultado lo deciden las horas.
 */
export function diasPorRevisar(x: Pick<Cruce, "asiste_sin_marca" | "asiste_incompleta">) {
  return [
    x.asiste_sin_marca ? `${x.asiste_sin_marca} día(s) trabajados sin marcación` : "",
    x.asiste_incompleta ? `${x.asiste_incompleta} día(s) trabajados con marcación incompleta` : "",
  ].filter(Boolean);
}

export function resultadoConciliacion(x: Cruce, tol: number): ResultadoConciliacion {
  if (x.estado === "no_encontrado") return "no_encontrado";
  if (!x.hay_biometria || x.estado === "sin_biometria") return "sin_biometria";
  if (conceptosQueFaltan(x, tol).length) return "inconsistente";
  if (conceptosConDiferenciaMenor(x, tol).length) return "advertencia";
  return "coherente";
}

export type HorasAdecco = { noct: number; ed: number; en: number };
export type Movimiento = { de: keyof HorasAdecco; a: keyof HorasAdecco; horas: number };

/** Lo que el biométrico clasifica en cada tipo, sin la bolsa de extras nocturnas de la conciliación. */
export function biometricoReal(conceptos: ConceptoConciliacion[]): HorasAdecco {
  const c = (k: string) => conceptos.find((x) => x.clave === k);
  const real = (k: string) => Math.max(0, Number(c(k)?.biometrico ?? 0) - Number(c(k)?.de_extra_nocturna ?? 0));
  return { noct: real("nocturnas"), ed: real("extra_diurnas"), en: Number(c("extra_nocturnas")?.biometrico ?? 0) };
}

/**
 * Reparte las horas reportadas (y aprobadas) en el recargo que les da el biométrico, hora por hora:
 * 1. en cada tipo se queda lo que el biométrico respalda;
 * 2. lo que sobra pasa al tipo donde el biométrico tiene horas libres: nocturnas o extras diurnas que
 *    en realidad fueron extras nocturnas → 1,75; extras nocturnas que fueron nocturnas o extras
 *    diurnas → 0,35 o 1,25;
 * 3. lo que el biométrico no puede reclasificar se queda como se reportó (Nómina ya lo aprobó).
 * El total de horas nunca cambia.
 */
export function reclasificarHoras(rep: HorasAdecco, bio: HorasAdecco) {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const queda = { noct: Math.min(rep.noct, bio.noct), ed: Math.min(rep.ed, bio.ed), en: Math.min(rep.en, bio.en) };
  const sobra = { noct: rep.noct - queda.noct, ed: rep.ed - queda.ed, en: rep.en - queda.en };
  const libre = { noct: bio.noct - queda.noct, ed: bio.ed - queda.ed, en: bio.en - queda.en };
  const final = { ...rep };
  const movimientos: Movimiento[] = [];
  const mover = (de: keyof HorasAdecco, a: keyof HorasAdecco) => {
    const h = r2(Math.min(sobra[de], libre[a]));
    if (h <= 0) return;
    sobra[de] -= h;
    libre[a] -= h;
    final[de] = r2(final[de] - h);
    final[a] = r2(final[a] + h);
    movimientos.push({ de, a, horas: h });
  };
  mover("noct", "en");
  mover("ed", "en");
  mover("en", "noct");
  mover("en", "ed");
  return { final, movimientos };
}
