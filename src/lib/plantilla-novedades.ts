import { CONCEPTOS, DIAS_CORTOS, TIPOS_NOVEDAD } from "@/lib/novedades";

export type PersonaNovedades = {
  document: string;
  full_name: string;
  position: string | null;
  campana: string | null;
};

/**
 * Plantilla de novedades en el mismo formato que lee «Cargar plantillas»: empresa, periodo,
 * encabezado DOCUMENTO / EMPLEADO / CARGO / CAMPAÑA, una columna por día (fila de fechas debajo),
 * conceptos de horas y OBSERVACIONES. Prellenada con lo ya reportado y con listas desplegables.
 */
export async function descargarPlantillaNovedades({
  empresa,
  titulo,
  fechas,
  personas,
  dia,
  totales,
}: {
  empresa: string;
  titulo: string;
  fechas: string[];
  personas: PersonaNovedades[];
  dia: (documento: string, fecha: string) => string | undefined;
  totales: (
    documento: string,
  ) =>
    | (Partial<Record<string, number | string | null>> & { observaciones?: string | null })
    | undefined;
}) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Convert-IA";
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
  const fecha = (f: string) => {
    const [y, m, d] = f.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!));
  };

  const listas = wb.addWorksheet("Listas", { state: "veryHidden" });
  TIPOS_NOVEDAD.forEach((t, i) => {
    listas.getCell(i + 1, 1).value = t;
  });

  const ws = wb.addWorksheet("Novedades", { views: [{ state: "frozen", xSplit: 3, ySplit: 6 }] });
  const FIJAS = ["No.", "DOCUMENTO No.", "EMPLEADO", "CARGO", "CAMPAÑA"];
  const cDia = FIJAS.length + 1;
  const cCon = cDia + fechas.length;
  const cObs = cCon + CONCEPTOS.length;
  ws.columns = [
    { width: 6 },
    { width: 16 },
    { width: 36 },
    { width: 24 },
    { width: 22 },
    ...fechas.map(() => ({ width: 13 })),
    ...CONCEPTOS.map(() => ({ width: 14 })),
    { width: 36 },
  ];

  ws.getCell(1, 1).value = empresa;
  ws.getCell(1, 1).font = { bold: true, size: 13 };
  ws.getCell(2, 1).value = "Periodo";
  ws.getCell(2, 2).value = fecha(fechas[0]!);
  ws.getCell(3, 1).value = "al";
  ws.getCell(3, 2).value = fecha(fechas[fechas.length - 1]!);
  for (const r of [2, 3]) {
    ws.getCell(r, 2).numFmt = "dd/mm/yyyy";
    ws.getCell(r, 1).font = { bold: true };
  }
  ws.getCell(4, 1).value = titulo;
  ws.getCell(4, 1).font = { italic: true, color: { argb: "FF6B7280" } };

  // Encabezado (fila 5) y fechas debajo de cada día (fila 6)
  FIJAS.forEach((t, i) => {
    ws.getCell(5, i + 1).value = t;
  });
  fechas.forEach((f, k) => {
    ws.getCell(5, cDia + k).value = DIAS_CORTOS[fecha(f).getUTCDay()];
    ws.getCell(6, cDia + k).value = fecha(f);
    ws.getCell(6, cDia + k).numFmt = "dd/mm/yyyy";
  });
  CONCEPTOS.forEach((c, k) => {
    ws.getCell(5, cCon + k).value = c.etiqueta
      .replace(/^Dom\. y fest\./, "Horas dominicales y festivas")
      .replace(/^Extras/, "Horas extras")
      .replace(/^Ajuste ext\./, "Ajuste horas extras")
      .replace(/^Ajuste dom\./, "Ajuste horas dominicales y festivas")
      .replace(/^Ajuste nocturnas/, "Ajuste horas nocturnas");
  });
  ws.getCell(5, cObs).value = "OBSERVACIONES";
  for (const r of [5, 6]) {
    ws.getRow(r).height = r === 5 ? 30 : 18;
    for (let c = 1; c <= cObs; c++) {
      const cell = ws.getCell(r, c);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: c >= cDia && c < cCon ? OSCURO : VERDE },
      };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = borde;
    }
  }

  const tipoValido = {
    type: "list" as const,
    allowBlank: true,
    formulae: [`Listas!$A$1:$A$${TIPOS_NOVEDAD.length}`],
    showErrorMessage: true,
    errorStyle: "warning" as const,
    errorTitle: "Novedad fuera de la lista",
    error: "Elige una novedad de la lista (Asiste, Descanso, Incapacidad, Vacaciones…).",
  };
  const horasValidas = {
    type: "decimal" as const,
    operator: "greaterThanOrEqual" as const,
    allowBlank: true,
    formulae: [0],
    showErrorMessage: true,
    errorStyle: "stop" as const,
    errorTitle: "Valor no válido",
    error: "Escribe un número de horas (0 o más).",
  };
  personas.forEach((p, i) => {
    const r = 7 + i;
    const t = totales(p.document);
    ws.getCell(r, 1).value = i + 1;
    ws.getCell(r, 2).value = p.document;
    ws.getCell(r, 2).numFmt = "@";
    ws.getCell(r, 3).value = p.full_name;
    ws.getCell(r, 4).value = p.position ?? "";
    ws.getCell(r, 5).value = p.campana ?? "";
    fechas.forEach((f, k) => {
      const cell = ws.getCell(r, cDia + k);
      cell.value = dia(p.document, f) ?? null;
      cell.dataValidation = tipoValido;
      cell.alignment = { horizontal: "center" };
      if (fecha(f).getUTCDay() === 0)
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DOMINGO } };
    });
    CONCEPTOS.forEach((c, k) => {
      const cell = ws.getCell(r, cCon + k);
      const v = t?.[c.campo];
      cell.value = typeof v === "number" && v !== 0 ? v : null;
      cell.dataValidation = horasValidas;
    });
    ws.getCell(r, cObs).value = t?.observaciones ?? null;
    for (let c = 1; c <= cObs; c++) ws.getCell(r, c).border = borde;
  });

  let r = 7 + personas.length + 1;
  for (const n of [
    "NOTA:",
    "1. Elige la novedad de cada día en la lista desplegable. Una casilla vacía no se carga.",
    "2. Las horas van en número (ej. 2 o 1,5). Los ajustes suman o restan a lo reportado.",
    "3. No cambies los títulos ni la fila de fechas. Súbela en Novedades → «Cargar plantillas».",
    "4. Lo cargado queda pendiente de revisión de Nómina, con trazabilidad de quién lo cargó y cuándo.",
  ]) {
    ws.getCell(r, 2).value = n;
    ws.getCell(r, 2).font = { bold: n === "NOTA:", size: 10 };
    r++;
  }

  const ins = wb.addWorksheet("Instrucciones");
  ins.columns = [{ width: 26 }, { width: 90 }];
  [
    ["Plantilla de novedades", ""],
    ["", ""],
    [
      "Cómo usarla",
      "1) Descárgala desde Novedades → «Descargar plantilla». Trae tu personal y lo ya reportado en el periodo.",
    ],
    [
      "",
      "2) Llena la novedad de cada día y las horas. No cambies los títulos ni la fila de fechas.",
    ],
    [
      "",
      "3) Súbela en Novedades → «Cargar plantillas». Cada carga queda registrada en «Plantillas cargadas» y en la auditoría.",
    ],
    ["Novedades válidas", TIPOS_NOVEDAD.join(", ")],
    ["Conceptos de horas", CONCEPTOS.map((c) => c.etiqueta).join(", ")],
  ].forEach(([a, b], i) => {
    ins.getCell(i + 1, 1).value = a;
    ins.getCell(i + 1, 2).value = b;
    ins.getCell(i + 1, 2).alignment = { wrapText: true };
  });
  ins.getCell(1, 1).font = { bold: true, size: 14 };
  wb.views = [
    { x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 1, visibility: "visible" },
  ];

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  );
  const a = document.createElement("a");
  const ahora = new Date();
  a.href = url;
  // La hora en el nombre evita el bloqueo de «plantilla ya cargada con este nombre»
  a.download = `Plantilla_novedades_${titulo.replace(/[^\p{L}\p{N}]+/gu, "_")}_${fechas[0]}_${fechas[fechas.length - 1]}_${String(ahora.getHours()).padStart(2, "0")}${String(ahora.getMinutes()).padStart(2, "0")}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
