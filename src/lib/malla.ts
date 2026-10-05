import * as XLSX from "xlsx";

/** Novedades válidas en la malla (sin tildes, como las guarda la base). */
export const NOVEDADES_MALLA = [
  "DESCANSO",
  "VACACIONES",
  "INCAPACIDAD",
  "DIA DE LA FAMILIA",
  "LICENCIA DE MATERNIDAD",
  "LICENCIA DE PATERNIDAD",
  "LICENCIA DE LUTO",
  "FESTIVO",
  "LICENCIA REMUNERADA",
  "LICENCIA NO REMUNERADA",
  "PERMISO",
  "CALAMIDAD DOMESTICA",
  "SUSPENSION",
] as const;

const DIAS_LARGOS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export const sinTildes = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

/** Horas de la lista desplegable: cada 30 minutos, formato 24 h. */
export const HORAS_LISTA = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
);

export type FilaMalla = {
  fila: number;
  documento: string;
  fecha: string;
  ingreso?: string | null;
  salida?: string | null;
  novedad?: string | null;
  nota?: string | null;
  borrar?: boolean;
};

export type PersonaPlantilla = {
  document: string;
  full_name: string;
  position: string | null;
  campana: string | null;
};
/** Valor de una persona en un día: horario, novedad o nada. */
export type DiaPlantilla = { ingreso: string; salida: string } | { novedad: string } | null;

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const deIso = (s: string) => new Date(`${s}T12:00:00`);

/** Convierte lo que venga en una celda de hora a "HH:MM" (24 h); null si no es una hora. */
export function aHora(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    const frac = v - Math.floor(v);
    if (frac === 0 && v >= 1) return null;
    const min = Math.round(frac * 1440) % 1440;
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  }
  if (v instanceof Date)
    return `${String(v.getHours()).padStart(2, "0")}:${String(v.getMinutes()).padStart(2, "0")}`;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (m[3]?.startsWith("p") && h < 12) h += 12;
  if (m[3]?.startsWith("a") && h === 12) h = 0;
  if (h > 23 || mi > 59) return `${h}:${String(mi).padStart(2, "0")}`; // la base lo reporta como hora no válida
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** Fecha de un encabezado de la plantilla (número de serie de Excel, texto dd/mm/aaaa o Date). */
function aFecha(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && v > 1) {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : null;
  }
  if (v instanceof Date) return iso(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const anio = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${anio}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`; // día primero (Colombia)
  }
  return null;
}

const esDocumento = (v: unknown) =>
  /^(cc|c\.?\s?c\.?|documento|n[uú]mero de documento|c[eé]dula|identificaci[oó]n)$/i.test(
    String(v ?? "").trim(),
  );
const esIngreso = (v: unknown) => /^(ingreso|entrada|inicio)/i.test(String(v ?? "").trim());
const esSalida = (v: unknown) => /^(salida|fin)/i.test(String(v ?? "").trim());

/**
 * Lee una malla de Excel: la plantilla de la plataforma o el «Formato de mallas» de las campañas
 * (fila de días, fila de fechas, encabezado CC | NOMBRE | ... | INGRESO | SALIDA por día).
 */
export async function leerPlantillaMalla(
  archivo: File,
): Promise<{ filas: FilaMalla[]; avisos: string[]; personas: number; fechas: string[] }> {
  const wb = XLSX.read(await archivo.arrayBuffer(), { cellDates: false });
  const avisos: string[] = [];
  for (const nombre of wb.SheetNames) {
    const ws = wb.Sheets[nombre]!;
    const m = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    const h = m.findIndex((r) => r.some(esDocumento));
    if (h < 0) continue;
    const enc = m[h]!;
    const cDoc = enc.findIndex(esDocumento);
    const cObs = enc.findIndex((v) => /^observaci/i.test(String(v ?? "")));
    // Pares INGRESO/SALIDA con su fecha en las filas de arriba (celdas combinadas: el valor está en la primera)
    const pares: { ci: number; cs: number; fecha: string }[] = [];
    for (let j = 0; j < enc.length - 1; j++) {
      if (!esIngreso(enc[j]) || !esSalida(enc[j + 1])) continue;
      let fecha: string | null = null;
      for (let k = h - 1; k >= 0 && k >= h - 3 && !fecha; k--)
        fecha = aFecha(m[k]?.[j]) ?? aFecha(m[k]?.[j + 1]);
      if (fecha) pares.push({ ci: j, cs: j + 1, fecha });
      else avisos.push(`La columna ${XLSX.utils.encode_col(j)} no tiene fecha encima; se ignoró.`);
      j++;
    }
    if (!pares.length) {
      avisos.push(`La hoja «${nombre}» no tiene columnas INGRESO/SALIDA con fecha.`);
      continue;
    }

    const filas: FilaMalla[] = [];
    const docs = new Set<string>();
    for (let i = h + 1; i < m.length; i++) {
      const r = m[i] ?? [];
      const doc = String(r[cDoc] ?? "")
        .replace(/\.0$/, "")
        .replace(/[^\dA-Za-z]/g, "");
      if (!doc || !/\d{4,}/.test(doc)) continue; // notas, filas vacías o la leyenda
      docs.add(doc);
      const nota = cObs >= 0 && r[cObs] ? String(r[cObs]).trim() : null;
      for (const p of pares) {
        const vi = r[p.ci],
          vs = r[p.cs];
        if ((vi === null || vi === "") && (vs === null || vs === "")) continue; // vacío: no se modifica
        const ti = aHora(vi),
          ts = aHora(vs);
        const textoI = typeof vi === "string" && !ti ? sinTildes(vi) : null;
        const textoS = typeof vs === "string" && !ts ? sinTildes(vs) : null;
        if (textoI === "BORRAR" || textoI === "QUITAR")
          filas.push({ fila: i + 1, documento: doc, fecha: p.fecha, borrar: true });
        else if (textoI || (!ti && textoS))
          filas.push({
            fila: i + 1,
            documento: doc,
            fecha: p.fecha,
            novedad: textoI ?? textoS,
            nota,
          });
        else
          filas.push({
            fila: i + 1,
            documento: doc,
            fecha: p.fecha,
            ingreso: ti ?? (vi == null ? null : String(vi)),
            salida: ts ?? (vs == null ? null : String(vs)),
            nota,
          });
      }
    }
    return { filas, avisos, personas: docs.size, fechas: pares.map((p) => p.fecha) };
  }
  return {
    filas: [],
    avisos: avisos.length
      ? avisos
      : ["No se encontró una hoja con la columna CC (documento) y columnas INGRESO/SALIDA."],
    personas: 0,
    fechas: [],
  };
}

/** Genera la plantilla de malla con listas desplegables, prellenada con la programación actual. */
export async function descargarPlantillaMalla({
  personas,
  fechas,
  valor,
  titulo,
}: {
  personas: PersonaPlantilla[];
  fechas: string[];
  valor: (documento: string, fecha: string) => DiaPlantilla;
  titulo: string;
}) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Convert-IA";
  wb.created = new Date();

  const OSCURO = "FF0E3B43",
    VERDE = "FF16A34A",
    DOMINGO = "FFFFF4E5",
    BORDE = "FFD4D4D8";
  const borde = {
    top: { style: "thin", color: { argb: BORDE } },
    left: { style: "thin", color: { argb: BORDE } },
    bottom: { style: "thin", color: { argb: BORDE } },
    right: { style: "thin", color: { argb: BORDE } },
  } as const;
  const FIJAS = ["CC", "NOMBRE", "CARGO", "CAMPAÑA"];
  const cIni = FIJAS.length + 1; // primera columna de días (1-indexada)
  const cObs = cIni + fechas.length * 2;

  // Hoja oculta con las opciones de la lista desplegable
  const listas = wb.addWorksheet("Listas", { state: "veryHidden" });
  const opciones = [...HORAS_LISTA, ...NOVEDADES_MALLA];
  opciones.forEach((o, i) => {
    listas.getCell(i + 1, 1).value = o;
  });

  const ws = wb.addWorksheet("Malla", {
    views: [{ state: "frozen", xSplit: FIJAS.length, ySplit: 3 }],
  });
  ws.columns = [
    { width: 14 },
    { width: 38 },
    { width: 24 },
    { width: 22 },
    ...fechas.flatMap(() => [{ width: 10 }, { width: 10 }]),
    { width: 36 },
  ];
  const desde = deIso(fechas[0]!).toLocaleDateString("es-CO");
  const hasta = deIso(fechas[fechas.length - 1]!).toLocaleDateString("es-CO");
  ws.mergeCells(1, 1, 1, FIJAS.length);
  ws.getCell(1, 1).value = `FORMATO DE MALLAS · ${titulo}`;
  ws.mergeCells(2, 1, 2, FIJAS.length);
  ws.getCell(2, 1).value = `Del ${desde} al ${hasta}`;
  fechas.forEach((f, k) => {
    const c = cIni + k * 2;
    const d = deIso(f);
    ws.mergeCells(1, c, 1, c + 1);
    ws.getCell(1, c).value = DIAS_LARGOS[d.getDay()];
    ws.mergeCells(2, c, 2, c + 1);
    ws.getCell(2, c).value = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    ws.getCell(2, c).numFmt = "dd/mm/yyyy";
    ws.getCell(3, c).value = "INGRESO";
    ws.getCell(3, c + 1).value = "SALIDA";
  });
  FIJAS.forEach((t, i) => {
    ws.getCell(3, i + 1).value = t;
  });
  ws.mergeCells(1, cObs, 2, cObs);
  ws.getCell(1, cObs).value = "OBSERVACIONES";
  ws.getCell(3, cObs).value = "OBSERVACIONES";
  for (let r = 1; r <= 3; r++) {
    ws.getRow(r).height = r === 3 ? 20 : 22;
    for (let c = 1; c <= cObs; c++) {
      const cell = ws.getCell(r, c);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: r === 1 && c === 1 ? 13 : 10 };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: r === 3 ? VERDE : OSCURO },
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: c <= FIJAS.length && r < 3 ? "left" : "center",
      };
      cell.border = borde;
    }
  }

  const filasVacias = 15; // para quien se agregue a mano (debe existir en Empleados)
  const total = personas.length + filasVacias;
  personas.forEach((p, i) => {
    const r = 4 + i;
    ws.getCell(r, 1).value = p.document;
    ws.getCell(r, 2).value = p.full_name;
    ws.getCell(r, 3).value = p.position ?? "";
    ws.getCell(r, 4).value = p.campana ?? "";
    fechas.forEach((f, k) => {
      const v = valor(p.document, f);
      if (!v) return;
      const c = cIni + k * 2;
      if ("novedad" in v) {
        ws.getCell(r, c).value = v.novedad;
        ws.getCell(r, c + 1).value = v.novedad;
      } else {
        ws.getCell(r, c).value = v.ingreso;
        ws.getCell(r, c + 1).value = v.salida;
      }
    });
  });
  const validacion = {
    type: "list" as const,
    allowBlank: true,
    formulae: [`Listas!$A$1:$A$${opciones.length}`],
    showErrorMessage: true,
    errorStyle: "warning" as const,
    errorTitle: "Valor fuera de la lista",
    error:
      "Usa una hora de la lista (24 h) o una novedad. Puedes escribir otra hora en formato 24 h, por ejemplo 07:15.",
    showInputMessage: false,
  };
  for (let i = 0; i < total; i++) {
    const r = 4 + i;
    ws.getCell(r, 1).numFmt = "@";
    for (let c = 1; c <= cObs; c++) {
      const cell = ws.getCell(r, c);
      cell.border = borde;
      if (c >= cIni && c < cObs) {
        cell.dataValidation = validacion;
        cell.alignment = { horizontal: "center" };
        const dia = deIso(fechas[Math.floor((c - cIni) / 2)]!).getDay();
        if (dia === 0)
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DOMINGO } };
      }
    }
  }

  let r = 4 + total + 1;
  const notas = [
    "NOTA:",
    "1. Escribe las horas en formato 24 h (07:00, 14:00, 21:30) o elígelas de la lista desplegable de cada casilla.",
    "2. Para un día con novedad (DESCANSO, VACACIONES, INCAPACIDAD, ...) elígela en INGRESO; SALIDA puede quedar vacía.",
    "3. Una casilla vacía no modifica lo que ya está programado. Para quitar un día escribe BORRAR en INGRESO.",
    "4. Solo se programa personal activo que exista en Empleados (columna CC = número de documento).",
    "5. Si la salida es menor que el ingreso (p. ej. 22:00 a 06:00) se toma como turno nocturno.",
  ];
  for (const n of notas) {
    ws.mergeCells(r, 1, r, Math.min(cObs, FIJAS.length + 8));
    ws.getCell(r, 1).value = n;
    ws.getCell(r, 1).font = { bold: n === "NOTA:", size: 10 };
    r++;
  }

  // Instrucciones
  const ins = wb.addWorksheet("Instrucciones");
  ins.columns = [{ width: 28 }, { width: 90 }];
  const lineas: [string, string][] = [
    ["Plantilla de malla de turnos", ""],
    ["", ""],
    [
      "Cómo usarla",
      "1) Descárgala desde Turnos → Malla semanal → «Descargar plantilla». Viene con el personal activo y lo ya programado.",
    ],
    ["", "2) Llena INGRESO y SALIDA de cada día, o una novedad. Los domingos están resaltados."],
    [
      "",
      "3) Súbela en Turnos → Malla semanal → «Cargar plantilla». La plataforma revisa cada fila y muestra los errores antes de guardar.",
    ],
    [
      "",
      "4) Cada horario (ingreso–salida) queda en el catálogo de la campaña; si no existe se crea solo.",
    ],
    [
      "",
      "5) También se acepta el «Formato de mallas» anterior (CC, NOMBRE, CARGO e INGRESO/SALIDA por día).",
    ],
    ["", ""],
    [
      "Prioridad",
      "La malla de un día manda sobre la rotación o el horario fijo asignado a la persona.",
    ],
    ["", ""],
    ["Novedades válidas", NOVEDADES_MALLA.join(", ")],
  ];
  lineas.forEach(([a, b], i) => {
    ins.getCell(i + 1, 1).value = a;
    ins.getCell(i + 1, 2).value = b;
    ins.getCell(i + 1, 2).alignment = { wrapText: true };
  });
  ins.getCell(1, 1).font = { bold: true, size: 14 };
  ins.getCell(3, 1).font = { bold: true };
  ins.getCell(9, 1).font = { bold: true };
  ins.getCell(11, 1).font = { bold: true };
  wb.views = [
    { x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 1, visibility: "visible" },
  ];

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `Malla_${titulo.replace(/[^\p{L}\p{N}]+/gu, "_")}_${fechas[0]}_${fechas[fechas.length - 1]}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
