/**
 * Los cortes de un proxy (p. ej. el 504 de Cloudflare a los 100 s) llegan como una página HTML
 * completa en el mensaje de error. Se resumen en una línea legible.
 */
export function mensajeLimpio(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  if (/<html|<!doctype/i.test(m)) {
    const titulo = /<title>([^<]*)<\/title>/i.exec(m)?.[1]?.split("|").pop()?.trim();
    return `La conexión se cortó (${titulo || "respuesta HTML del proxy"}) mientras la base seguía trabajando`;
  }
  return m.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Corte de red o de un proxy (no un error de la base): conviene esperar y reintentar. */
export function esCorte(mensaje: string): boolean {
  return /se cortó|fetch failed|gateway|time-?out|timed out|\b50[234]\b|\b52[0-4]\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|other side closed|terminated|CONNECTION_(CLOSED|ENDED|DESTROYED)/i.test(
    mensaje,
  );
}
