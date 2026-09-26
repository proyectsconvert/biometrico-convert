import { Fragment, useState, type ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type Columna<T> = {
  key: string;
  header: ReactNode;
  cell: (fila: T) => ReactNode;
  className?: string;
  /** Si se indica, el encabezado permite ordenar por este campo. */
  orden?: string;
};

export type Orden = { col: string; asc: boolean };

export function SimpleTable<T>({
  columnas,
  filas,
  cargando,
  vacio = "No hay registros para mostrar.",
  getKey,
  onFilaClick,
  expandida,
  detalle,
  orden,
  onOrden,
}: {
  columnas: Columna<T>[];
  filas: T[];
  cargando?: boolean | undefined;
  vacio?: string;
  getKey: (fila: T, index: number) => string;
  onFilaClick?: ((fila: T) => void) | undefined;
  /** Clave de la fila expandida; se muestra `detalle` debajo de ella. */
  expandida?: string | null;
  detalle?: (fila: T) => ReactNode;
  orden?: Orden | null;
  onOrden?: (orden: Orden) => void;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              {columnas.map((c) => (
                <TableHead key={c.key} className={c.className}>
                  {c.orden && onOrden ? (
                    <button
                      type="button"
                      className={cn(
                        "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted hover:text-foreground",
                        orden?.col === c.orden && "font-semibold text-foreground",
                      )}
                      onClick={() => onOrden({ col: c.orden!, asc: orden?.col === c.orden ? !orden?.asc : true })}
                      title="Ordenar"
                    >
                      {c.header}
                      {orden?.col === c.orden ? (
                        orden.asc ? <ArrowUp className="size-3.5 shrink-0" /> : <ArrowDown className="size-3.5 shrink-0" />
                      ) : (
                        <ArrowUpDown className="size-3.5 shrink-0 opacity-40" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {cargando ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {columnas.map((c) => (
                    <TableCell key={c.key}>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : filas.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columnas.length}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {vacio}
                </TableCell>
              </TableRow>
            ) : (
              filas.map((fila, i) => {
                const k = getKey(fila, i);
                const abierta = expandida === k && detalle;
                return (
                  <Fragment key={k}>
                    <TableRow
                      className={cn(onFilaClick && "cursor-pointer", abierta && "bg-muted/40")}
                      onClick={onFilaClick ? () => onFilaClick(fila) : undefined}
                    >
                      {columnas.map((c) => (
                        <TableCell key={c.key} className={c.className}>
                          {c.cell(fila)}
                        </TableCell>
                      ))}
                    </TableRow>
                    {abierta ? (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={columnas.length} className="p-0">
                          {detalle(fila)}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

export const TAMANOS_PAGINA = [10, 20, 30, 40, 50];

/** Paginación: «Mostrar [20] por página · 1–20 de 420 · Anterior / Siguiente». */
export function Paginador({
  pagina,
  tamano,
  total,
  onCambio,
  onTamano,
  opciones = TAMANOS_PAGINA,
}: {
  pagina: number;
  tamano: number;
  total: number;
  onCambio: (pagina: number) => void;
  onTamano?: (tamano: number) => void;
  opciones?: number[];
}) {
  if (total <= (onTamano ? Math.min(...opciones) : tamano)) return null;
  const paginas = Math.max(1, Math.ceil(total / tamano));
  const desde = total ? pagina * tamano + 1 : 0;
  const hasta = Math.min(total, (pagina + 1) * tamano);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-3 text-sm text-muted-foreground">
      {onTamano ? (
        <label className="flex items-center gap-1.5">
          Mostrar
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
            value={tamano}
            onChange={(e) => {
              onTamano(Number(e.target.value));
              onCambio(0);
            }}
          >
            {opciones.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          por página
        </label>
      ) : null}
      <span className="tabular-nums">
        {desde.toLocaleString("es-CO")}–{hasta.toLocaleString("es-CO")} de {total.toLocaleString("es-CO")}
      </span>
      <Button variant="outline" size="sm" disabled={pagina === 0} onClick={() => onCambio(0)} aria-label="Primera página">«</Button>
      <Button variant="outline" size="sm" disabled={pagina === 0} onClick={() => onCambio(pagina - 1)}>Anterior</Button>
      <span className="tabular-nums">Pág. {pagina + 1} de {paginas}</span>
      <Button variant="outline" size="sm" disabled={pagina >= paginas - 1} onClick={() => onCambio(pagina + 1)}>Siguiente</Button>
      <Button variant="outline" size="sm" disabled={pagina >= paginas - 1} onClick={() => onCambio(paginas - 1)} aria-label="Última página">»</Button>
    </div>
  );
}

/** Paginación en el navegador para listas ya cargadas. */
export function usePaginado<T>(filas: T[], inicial = 20) {
  const [pagina, setPagina] = useState(0);
  const [tamano, setTamano] = useState(inicial);
  const paginas = Math.max(1, Math.ceil(filas.length / tamano));
  // Si la lista se achica (filtros), no quedarse en una página vacía
  const actual = Math.min(pagina, paginas - 1);
  return {
    visibles: filas.slice(actual * tamano, (actual + 1) * tamano),
    paginador: { pagina: actual, tamano, total: filas.length, onCambio: setPagina, onTamano: setTamano },
    reiniciar: () => setPagina(0),
  };
}

/** Ordena en el navegador por una ruta de campo («campaigns.name»); vacíos al final. */
export function ordenarFilas<T>(filas: T[], orden: Orden | null): T[] {
  if (!orden) return filas;
  const valor = (f: T) =>
    orden.col.split(".").reduce<unknown>((v, k) => (v == null ? v : (v as Record<string, unknown>)[k]), f);
  return [...filas].sort((a, b) => {
    const x = valor(a);
    const y = valor(b);
    if (x == null || x === "") return 1;
    if (y == null || y === "") return -1;
    const c =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), "es", { numeric: true, sensitivity: "base" });
    return orden.asc ? c : -c;
  });
}
