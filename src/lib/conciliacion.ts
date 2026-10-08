/**
 * Reglas de la conciliación de novedades (plantilla del supervisor frente al biométrico).
 *
 * - Solo se concilian los bloques de horas que se reportan (> 0). Lo que no se reporta no se muestra
 *   ni se menciona en observaciones: no debe leerse como horas pendientes de pago.
 * - Si el biométrico respalda igual o más de lo reportado, cuadra. Solo se revisa cuando se reporta
 *   más de lo que respalda el biométrico (por horas o por días con «Asiste» sin respaldo).
 */
export type ConceptoConciliacion = {
  clave: string;
  etiqueta: string;
  reportado: number;
  biometrico: number;
};

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

/**
 * Días donde lo reportado supera lo marcado: «Asiste» sin marcación o con una sola marcación.
 * Marcar en un día de novedad (o sin novedad) es más biométrico que reporte: no se revisa.
 */
export function diasPorRevisar(x: Pick<Cruce, "asiste_sin_marca" | "asiste_incompleta">) {
  return [
    x.asiste_sin_marca ? `${x.asiste_sin_marca} día(s) con «Asiste» sin marcación` : "",
    x.asiste_incompleta ? `${x.asiste_incompleta} día(s) con «Asiste» y marcación incompleta` : "",
  ].filter(Boolean);
}

export function resultadoConciliacion(x: Cruce, tol: number): ResultadoConciliacion {
  if (x.estado === "no_encontrado") return "no_encontrado";
  if (!x.hay_biometria || x.estado === "sin_biometria") return "sin_biometria";
  if (conceptosQueFaltan(x, tol).length) return "inconsistente";
  if (diasPorRevisar(x).length) return "advertencia";
  return "coherente";
}
