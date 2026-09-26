export type FilaBiometrica = {
  /** Línea del CSV (la 1 es el encabezado), para trazabilidad en la capa cruda. */
  linea: number;
  event_at: string;
  door: string | null;
  device_code: string;
  device_name: string | null;
  user_group: string | null;
  raw_user: string | null;
  document: string | null;
  biometric_name: string | null;
  event_type: string;
};

/** Divide una línea CSV respetando comillas. */
export function dividirLineaCsv(linea: string): string[] {
  const out: string[] = [];
  let actual = "";
  let enComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (ch === '"') {
      if (enComillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else {
        enComillas = !enComillas;
      }
    } else if (ch === "," && !enComillas) {
      out.push(actual);
      actual = "";
    } else {
      actual += ch;
    }
  }
  out.push(actual);
  return out.map((v) => v.trim());
}

/**
 * Normaliza el campo "Usuarios" del biométrico.
 * `012345(CONVERTIA)` -> documento 012345 + nombre
 * `012345` -> documento 012345
 */
export function normalizarUsuario(valor: string | null | undefined): {
  document: string | null;
  name: string | null;
} {
  const limpio = (valor ?? "").trim();
  if (!limpio) return { document: null, name: null };
  const conNombre = limpio.match(/^\s*([0-9A-Za-z.\-]+)\s*\((.+)\)\s*$/);
  if (conNombre) {
    return {
      document: soloDigitos(conNombre[1] ?? ""),
      name: (conNombre[2] ?? "").trim().toUpperCase(),
    };
  }
  const doc = soloDigitos(limpio);
  return { document: doc, name: null };
}

function soloDigitos(valor: string): string | null {
  const d = valor.replace(/\D/g, "");
  return d.length > 0 ? d : null;
}

/** Un evento cuenta como marcación solo si es una autenticación exitosa de una persona. */
export function esAutenticacionExitosa(evento: string): boolean {
  // «Actualización parcial del usuario exitosa (BioStar)» también dice «exitosa»: es administrativo
  // Igual que es_marcacion_valida() en la base: BioStar exporta en español o en inglés
  const e = (evento ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (
    (e.includes("autenticacion exitosa") || e.includes("authentication succeeded")) &&
    !e.includes("fallida") &&
    !e.includes("failed")
  );
}

export function parsearFilas(lineas: string[], encabezado: string[]): FilaBiometrica[] {
  const idx = (nombre: string) =>
    encabezado.findIndex((h) => h.toLowerCase().replace(/^\ufeff/, "").trim() === nombre);
  const iFecha = idx("fecha");
  const iPuerta = idx("puertas");
  const iDevId = idx("id dispositivo");
  const iDev = idx("dispositivos");
  const iGrupo = idx("grupo usuario");
  const iUsuario = idx("usuarios");
  const iEvento = idx("evento");

  const filas: FilaBiometrica[] = [];
  for (const [i, linea] of lineas.entries()) {
    if (!linea.trim()) continue;
    const c = dividirLineaCsv(linea);
    const fecha = c[iFecha];
    const deviceCode = c[iDevId];
    const evento = c[iEvento] ?? "";
    if (!fecha || !deviceCode) continue;
    const { document, name } = normalizarUsuario(c[iUsuario]);
    filas.push({
      linea: i + 2,
      event_at: fecha.replace(" ", "T"),
      door: c[iPuerta] || null,
      device_code: deviceCode,
      device_name: c[iDev] || null,
      user_group: c[iGrupo] || null,
      raw_user: c[iUsuario] || null,
      document,
      biometric_name: name,
      event_type: evento,
    });
  }
  return filas;
}

export async function hashArchivo(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function descargarCsv(nombre: string, filas: Record<string, unknown>[]) {
  if (filas.length === 0) return;
  const columnas = Object.keys(filas[0] ?? {});
  const escapar = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const contenido =
    "\ufeff" +
    [
      columnas.join(";"),
      ...filas.map((f) => columnas.map((c) => escapar(f[c])).join(";")),
    ].join("\n");
  const blob = new Blob([contenido], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre.endsWith(".csv") ? nombre : `${nombre}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
