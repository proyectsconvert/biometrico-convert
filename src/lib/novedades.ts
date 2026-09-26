import * as XLSX from "xlsx";

export const TIPOS_NOVEDAD = [
  "Asiste",
  "Descanso",
  "Incapacidad",
  "Licencia No Remunerada",
  "Licencia Remunerada",
  "Licencia de Maternidad",
  "Licencia de Paternidad",
  "Vacaciones",
  "Permiso",
  "Calamidad Doméstica",
  "Ausente",
  "Suspensión",
  "Retiro",
  "Marcación incompleta",
] as const;

export const CONCEPTOS = [
  { campo: "horas_nocturnas", etiqueta: "Horas nocturnas (0,35)", patron: /^horas nocturnas/ },
  { campo: "ajuste_horas_nocturnas", etiqueta: "Ajuste nocturnas (0,35)", patron: /^ajuste horas nocturnas/ },
  { campo: "horas_dom_fest_090", etiqueta: "Dom. y fest. (0,90)", patron: /^horas dominicales.*0,?\.?90/ },
  { campo: "ajuste_dom_fest_090", etiqueta: "Ajuste dom. (0,90)", patron: /^ajuste horas dominicales.*0,?\.?90/ },
  { campo: "horas_dom_fest_190", etiqueta: "Dom. y fest. (1,90)", patron: /^horas dominicales.*1,?\.?90/ },
  { campo: "ajuste_dom_fest_190", etiqueta: "Ajuste dom. (1,90)", patron: /^ajuste horas dominicales.*1,?\.?90/ },
  { campo: "horas_extra_diurnas", etiqueta: "Extras diurnas (1,25)", patron: /^horas extras? diurnas/ },
  { campo: "ajuste_extra_diurnas", etiqueta: "Ajuste ext. diurnas", patron: /^ajuste horas extras? diurnas/ },
  { campo: "horas_extra_nocturnas", etiqueta: "Extras nocturnas (1,75)", patron: /^horas extras? nocturnas/ },
  { campo: "ajuste_extra_nocturnas", etiqueta: "Ajuste ext. nocturnas", patron: /^ajuste horas extras? nocturnas/ },
  { campo: "bonificacion", etiqueta: "Bonificación", patron: /^bonificaci/ },
  { campo: "comisiones", etiqueta: "Comisiones", patron: /^comisi/ },
] as const;

export type CampoConcepto = (typeof CONCEPTOS)[number]["campo"];

export type EmpleadoPlantilla = {
  document: string;
  full_name: string;
  position: string | null;
  campaign_label: string | null;
  dias: Record<string, string>;
  conceptos: Record<CampoConcepto, number>;
  observaciones: string | null;
};

export type PlantillaNovedades = {
  hoja: string;
  empresa: string | null;
  periodoInicio: string;
  periodoFin: string;
  fechas: string[];
  empleados: EmpleadoPlantilla[];
  advertencias: string[];
};

const limpiar = (v: unknown) =>
  String(v ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const norm = (v: unknown) =>
  limpiar(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()]/g, "")
    .trim();

function aFecha(v: unknown): string | null {
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = limpiar(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
}

const aNumero = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(limpiar(v).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const MAPA_TIPOS = new Map(TIPOS_NOVEDAD.map((t) => [norm(t), t as string]));

export function normalizarTipo(v: unknown): string {
  const n = norm(v);
  if (!n) return "";
  const exacto = MAPA_TIPOS.get(n);
  if (exacto) return exacto;
  if (n.startsWith("asist")) return "Asiste";
  if (n.startsWith("desc")) return "Descanso";
  if (n.startsWith("incap")) return "Incapacidad";
  if (n.startsWith("vacac")) return "Vacaciones";
  if (n.includes("no remun")) return "Licencia No Remunerada";
  if (n.startsWith("licencia")) return "Licencia Remunerada";
  if (n.startsWith("permis")) return "Permiso";
  if (n.startsWith("ausen") || n === "falla" || n.startsWith("inasist")) return "Ausente";
  const t = limpiar(v);
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Lee la plantilla de novedades (cualquier nombre de archivo, mismo formato). */
export async function leerPlantilla(archivo: File): Promise<PlantillaNovedades> {
  const wb = XLSX.read(await archivo.arrayBuffer(), { type: "array" });
  for (const hoja of wb.SheetNames) {
    const ws = wb.Sheets[hoja];
    if (!ws) continue;
    const filas = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
    const iHead = filas.findIndex((f) => f.some((c) => norm(c).startsWith("documento")));
    if (iHead < 0) continue;
    const head = filas[iHead]!;
    const filaFechas = filas[iHead + 1] ?? [];
    const colDoc = head.findIndex((c) => norm(c).startsWith("documento"));
    const colNom = head.findIndex((c) => norm(c).startsWith("empleado") || norm(c) === "nombre");
    const colCargo = head.findIndex((c) => norm(c).startsWith("cargo"));
    const colCamp = head.findIndex((c) => norm(c).startsWith("campana"));
    const colObs = head.findIndex((c) => norm(c).startsWith("observac"));

    const colsDia: { col: number; fecha: string }[] = [];
    filaFechas.forEach((c, i) => {
      const f = aFecha(c);
      if (f && i > colDoc) colsDia.push({ col: i, fecha: f });
    });
    const colsConcepto = CONCEPTOS.map((k) => ({
      campo: k.campo,
      col: head.findIndex((c) => k.patron.test(norm(c))),
    }));

    const advertencias: string[] = [];
    let empresa: string | null = null;
    let pIni: string | null = null;
    let pFin: string | null = null;
    for (const f of filas.slice(0, iHead)) {
      const textos = f.filter((c) => c !== null && limpiar(c) !== "");
      if (!textos.length) continue;
      const k = norm(textos[0]);
      if (k.startsWith("periodo")) pIni = aFecha(textos[1]);
      else if (k === "al" || k === "hasta") pFin = aFecha(textos[1]);
      else if (!empresa && /s\.?a\.?s|ltda|s\.a/i.test(limpiar(textos[0]))) empresa = limpiar(textos[0]);
    }

    const inicioDatos = colsDia.length ? iHead + 2 : iHead + 1;
    const empleados: EmpleadoPlantilla[] = [];
    const vistos = new Set<string>();
    for (const [idx, f] of filas.slice(inicioDatos).entries()) {
      const doc = limpiar(f[colDoc]).replace(/[.\s]/g, "").replace(/\.0$/, "");
      if (!/^\d{4,15}$/.test(doc)) continue;
      if (vistos.has(doc)) {
        advertencias.push(`Documento ${doc} repetido en la fila ${inicioDatos + idx + 1}; se toma la primera aparición.`);
        continue;
      }
      vistos.add(doc);
      const dias: Record<string, string> = {};
      for (const d of colsDia) {
        const t = normalizarTipo(f[d.col]);
        if (t) dias[d.fecha] = t;
      }
      const conceptos = {} as Record<CampoConcepto, number>;
      for (const c of colsConcepto) conceptos[c.campo] = c.col >= 0 ? aNumero(f[c.col]) : 0;
      empleados.push({
        document: doc,
        full_name: colNom >= 0 ? limpiar(f[colNom]) : doc,
        position: colCargo >= 0 ? limpiar(f[colCargo]) || null : null,
        campaign_label: colCamp >= 0 ? limpiar(f[colCamp]) || null : null,
        dias,
        conceptos,
        observaciones: colObs >= 0 ? limpiar(f[colObs]) || null : null,
      });
    }
    if (!empleados.length) continue;
    const fechas = colsDia.map((d) => d.fecha);
    if (!fechas.length) advertencias.push("No se encontraron columnas de días con fecha.");
    const ordenadas = [...fechas].sort();
    return {
      hoja,
      empresa,
      periodoInicio: pIni ?? ordenadas[0] ?? new Date().toISOString().slice(0, 10),
      periodoFin: pFin ?? ordenadas[ordenadas.length - 1] ?? new Date().toISOString().slice(0, 10),
      fechas,
      empleados,
      advertencias,
    };
  }
  throw new Error("No se encontró la tabla de personal (columna «DOCUMENTO») en ninguna hoja del archivo.");
}

export function colorTipo(t: string): string {
  const n = norm(t);
  if (n === "asiste") return "bg-primary/15 text-foreground";
  if (n === "descanso") return "bg-muted text-muted-foreground";
  if (n.startsWith("incap") || n.startsWith("licencia") || n.startsWith("vacac") || n.startsWith("calam"))
    return "bg-accent/20 text-foreground";
  if (n.startsWith("ausen") || n.startsWith("suspen") || n.startsWith("retiro"))
    return "bg-destructive/15 text-destructive";
  return "bg-secondary text-secondary-foreground";
}

export const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
export const diaSemana = (f: string) => DIAS_CORTOS[new Date(`${f}T12:00:00`).getDay()]!;

export function rangoFechas(desde: string, hasta: string): string[] {
  const out: string[] = [];
  const d = new Date(`${desde}T12:00:00`);
  const fin = new Date(`${hasta}T12:00:00`);
  while (d <= fin && out.length < 62) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}
