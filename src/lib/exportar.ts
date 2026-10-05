import * as XLSX from "xlsx";

/**
 * Escribe un libro de Excel con la fecha de generación: se agrega al final de la hoja
 * «Información» o «Instrucciones» si existe.
 */
export function escribirLibro(wb: XLSX.WorkBook, nombre: string) {
  const hoja = wb.SheetNames.find((n) => /^(informaci[oó]n|instrucciones)$/i.test(n));
  const fecha = `Generado el ${new Date().toLocaleString("es-CO")}`;
  if (hoja)
    XLSX.utils.sheet_add_aoa(wb.Sheets[hoja]!, [[""], [fecha]], {
      origin: -1,
    });
  XLSX.writeFile(wb, nombre.endsWith(".xlsx") ? nombre : `${nombre}.xlsx`);
}
