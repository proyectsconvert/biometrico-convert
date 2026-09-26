import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Upload,
  RefreshCw,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  X,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { hashArchivo } from "@/lib/biometria";
import { procesarImportacion, eliminarImportacion } from "@/lib/importaciones.functions";
import { PageHeader } from "@/components/app-shell";
import { HistoricoBiometrico } from "@/components/historico-biometrico";
import { SimpleTable, Paginador, usePaginado } from "@/components/simple-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/importaciones")({
  head: () => ({ meta: [{ title: "Importaciones — Convert-IA" }] }),
  component: Importaciones,
});

type ImportRow = {
  id: string;
  filename: string;
  status: string;
  rows_found: number;
  rows_valid: number;
  rows_ignored: number;
  rows_duplicated: number;
  rows_raw: number;
  rows_new: number;
  rows_existing: number;
  rows_repeated_in_file: number;
  error_message: string | null;
  started_at: string;
};

type Estado = "en_cola" | "subiendo" | "en_bucket" | "procesando" | "listo" | "omitido" | "error";
type Item = { id: string; file: File; estado: Estado; mensaje?: string | undefined };

const ETIQUETA: Record<Estado, string> = {
  en_cola: "En cola",
  subiendo: "Subiendo",
  en_bucket: "En espera",
  procesando: "Procesando",
  listo: "Completado",
  omitido: "Omitido",
  error: "Error",
};

/** «50.000 filas · 12.345 nuevas · 37.655 ya estaban en otros archivos · 11.200 válidas» */
function resumenCarga(r: { filas: number; nuevas?: number; ya_existian?: number; repetidas_en_archivo?: number; validas: number }) {
  const n = (x: number | undefined) => (x ?? 0).toLocaleString("es-CO");
  return [
    `${n(r.filas)} filas`,
    `${n(r.nuevas)} nuevas en el histórico`,
    r.ya_existian ? `${n(r.ya_existian)} ya estaban en otros archivos` : null,
    r.repetidas_en_archivo ? `${n(r.repetidas_en_archivo)} repetidas en el mismo archivo` : null,
    `${n(r.validas)} marcaciones válidas`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Varios archivos a la vez: la subida y la inserción corren en paralelo; el cálculo de cada
// archivo se serializa en la base (candado por empresa), así que no chocan entre sí.
const SUBIDAS_SIMULTANEAS = 4;
async function enParalelo<T>(lista: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, lista.length) }, async () => {
      while (i < lista.length) await fn(lista[i++]!);
    }),
  );
}

// Los reportes del biométrico comparten un prefijo largo; lo que los distingue está al final (…_1.csv, …_2.csv)
const nombreCorto = (n: string) => (n.length > 34 ? `${n.slice(0, 16)}…${n.slice(-16)}` : n);

function Importaciones() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const procesar = useServerFn(procesarImportacion);
  const eliminar = useServerFn(eliminarImportacion);
  const inputRef = useRef<HTMLInputElement>(null);
  const [abierto, setAbierto] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [arrastrando, setArrastrando] = useState(false);
  const [corriendo, setCorriendo] = useState(false);
  const [procesandoId, setProcesandoId] = useState<string | null>(null);
  const [procesandoLote, setProcesandoLote] = useState(false);
  // Cuántos archivos se procesan a la vez (se recuerda en este navegador)
  const [simultaneos, setSimultaneosState] = useState(() => {
    try {
      return Number(localStorage.getItem("convertia.importaciones.simultaneos")) || 3;
    } catch {
      return 3;
    }
  });
  const setSimultaneos = (n: number) => {
    setSimultaneosState(n);
    try {
      localStorage.setItem("convertia.importaciones.simultaneos", String(n));
    } catch {
      /* sin almacenamiento */
    }
  };

  const lista = useQuery({
    queryKey: ["importaciones"],
    refetchInterval: corriendo || procesandoLote || !!procesandoId ? 3000 : false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("biometric_imports")
        .select("id, filename, status, rows_found, rows_valid, rows_ignored, rows_duplicated, rows_raw, rows_new, rows_existing, rows_repeated_in_file, error_message, started_at")
        .order("started_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as ImportRow[];
    },
  });

  const actualizar = (id: string, cambio: Partial<Item>) =>
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...cambio } : x)));

  function agregar(files: FileList | File[]) {
    const nuevos = Array.from(files).map<Item>((file) => {
      const esCsv = file.name.toLowerCase().endsWith(".csv");
      return {
        id: crypto.randomUUID(),
        file,
        estado: esCsv ? "en_cola" : "omitido",
        mensaje: esCsv ? undefined : "Solo se aceptan archivos .csv",
      };
    });
    setItems((prev) => {
      const nombres = new Set(prev.map((p) => p.file.name.toLowerCase()));
      return [
        ...prev,
        ...nuevos.map((n) =>
          nombres.has(n.file.name.toLowerCase())
            ? { ...n, estado: "omitido" as Estado, mensaje: "Archivo repetido en esta carga" }
            : (nombres.add(n.file.name.toLowerCase()), n),
        ),
      ];
    });
  }

  // Fase 1: subir el archivo al bucket y registrarlo como pendiente. Devuelve el id a procesar.
  async function subirUno(it: Item): Promise<string | null> {
    const tenantId = acceso.tenantId!;
    const file = it.file;
    try {
      actualizar(it.id, { estado: "subiendo", mensaje: undefined });
      const hash = await hashArchivo(file);
      const ruta = `${tenantId}/${hash}-${file.name}`;

      const { data: mismoNombre } = await supabase
        .from("biometric_imports")
        .select("id, status, storage_path")
        .eq("tenant_id", tenantId)
        .ilike("filename", file.name)
        .limit(1);

      if (mismoNombre?.length) {
        const existente = mismoNombre[0]!;
        if (existente.status !== "pendiente" && existente.status !== "error") {
          actualizar(it.id, { estado: "omitido", mensaje: "Ya existe un archivo procesado con este nombre" });
          return null;
        }
        // Registrado antes pero sin procesar: asegurar el archivo en el bucket y dejarlo en cola
        await supabase.storage
          .from("biometrico")
          .upload(existente.storage_path || ruta, file, { upsert: true, contentType: "text/csv" });
        actualizar(it.id, { estado: "en_bucket", mensaje: "En el bucket, esperando turno" });
        return existente.id;
      }

      const { error: eUp } = await supabase.storage
        .from("biometrico")
        .upload(ruta, file, { upsert: true, contentType: "text/csv" });
      if (eUp) throw new Error(`No se pudo subir: ${eUp.message}`);

      const { data: imp, error: eImp } = await supabase
        .from("biometric_imports")
        .insert({
          tenant_id: tenantId,
          filename: file.name,
          file_hash: hash,
          storage_path: ruta,
          status: "pendiente",
          created_by: acceso.userId,
        })
        .select("id")
        .single();
      if (eImp) {
        if (eImp.code === "23505") {
          actualizar(it.id, { estado: "omitido", mensaje: "Este archivo ya fue cargado anteriormente (mismo contenido)" });
          return null;
        }
        throw eImp;
      }
      actualizar(it.id, { estado: "en_bucket", mensaje: "En el bucket, esperando turno" });
      return imp.id;
    } catch (e) {
      actualizar(it.id, { estado: "error", mensaje: (e as Error).message });
      return null;
    }
  }

  // Fase 2: procesar un archivo que ya está en el bucket
  async function procesarItem(it: Item, importId: string) {
    try {
      actualizar(it.id, { estado: "procesando", mensaje: "Calculando entradas y salidas..." });
      qc.invalidateQueries({ queryKey: ["importaciones"] });
      const r = await procesar({ data: { importId } });
      actualizar(it.id, {
        estado: "listo",
        mensaje: resumenCarga(r),
      });
    } catch (e) {
      actualizar(it.id, { estado: "error", mensaje: (e as Error).message });
    } finally {
      qc.invalidateQueries({ queryKey: ["importaciones"] });
    }
  }

  async function iniciar() {
    if (!acceso.tenantId) {
      toast.error("Tu usuario no está asignado a una empresa.");
      return;
    }
    setCorriendo(true);
    const pendientes = items.filter((i) => i.estado === "en_cola" || i.estado === "error");
    // 1. Todos los archivos al bucket primero: quedan visibles como «pendiente» en la lista
    const ids = new Map<string, string>();
    await enParalelo(pendientes, SUBIDAS_SIMULTANEAS, async (it) => {
      const id = await subirUno(it);
      if (id) ids.set(it.id, id);
    });
    qc.invalidateQueries({ queryKey: ["importaciones"] });
    // 2. Procesarlos poco a poco, N a la vez
    await enParalelo(
      pendientes.filter((it) => ids.has(it.id)),
      simultaneos,
      (it) => procesarItem(it, ids.get(it.id)!),
    );
    setCorriendo(false);
    qc.invalidateQueries();
    toast.success("Carga finalizada");
  }

  async function handleProcesarExistente(importId: string, filename: string) {
    try {
      setProcesandoId(importId);
      toast.info(`Procesando ${filename}...`);
      const r = await procesar({ data: { importId } });
      toast.success(`${filename}: ${resumenCarga(r)}`);
      qc.invalidateQueries({ queryKey: ["importaciones"] });
      qc.invalidateQueries({ queryKey: ["asistencia"] });
      qc.invalidateQueries({ queryKey: ["marcaciones"] });
    } catch (e) {
      toast.error(`Error procesando ${filename}: ${(e as Error).message}`);
    } finally {
      setProcesandoId(null);
    }
  }

  async function procesarTodosPendientes() {
    const pendientes = lista.data?.filter((f) => f.status === "pendiente" || f.status === "error") ?? [];
    if (!pendientes.length) return;
    setProcesandoLote(true);
    let ok = 0;
    let err = 0;
    await enParalelo(pendientes, simultaneos, async (p) => {
      try {
        setProcesandoId(p.id);
        await procesar({ data: { importId: p.id } });
        ok++;
        qc.invalidateQueries({ queryKey: ["importaciones"] });
      } catch (e) {
        err++;
        console.error(e);
      }
    });
    setProcesandoId(null);
    setProcesandoLote(false);
    qc.invalidateQueries({ queryKey: ["importaciones"] });
    qc.invalidateQueries({ queryKey: ["asistencia"] });
    qc.invalidateQueries({ queryKey: ["marcaciones"] });
    if (err > 0) {
      toast.warning(`Finalizado: ${ok} procesados correctamente, ${err} con error.`);
    } else {
      toast.success(`Se procesaron ${ok} archivos exitosamente.`);
    }
  }

  async function handleEliminar(importId: string, filename: string) {
    if (!confirm(`¿Eliminar la importación de "${filename}" y sus marcaciones asociadas?`)) return;
    try {
      setProcesandoId(importId);
      await eliminar({ data: { importId } });
      toast.success(`Importación "${filename}" eliminada.`);
      qc.invalidateQueries({ queryKey: ["importaciones"] });
      qc.invalidateQueries({ queryKey: ["asistencia"] });
      qc.invalidateQueries({ queryKey: ["marcaciones"] });
    } catch (e) {
      toast.error(`Error eliminando: ${(e as Error).message}`);
    } finally {
      setProcesandoId(null);
    }
  }

  const puedeImportar = acceso.can("importaciones", "crear") || acceso.can("importaciones", "importar");
  const puedeEliminar = acceso.can("importaciones", "eliminar") || acceso.can("importaciones", "crear");
  const hayPendientes = items.some((i) => i.estado === "en_cola" || i.estado === "error");
  const hechos = items.filter((i) => ["listo", "omitido", "error"].includes(i.estado)).length;
  const pagImport = usePaginado(lista.data ?? [], 20);
  const pendientesEnBd = lista.data?.filter((f) => f.status === "pendiente" || f.status === "error") ?? [];

  return (
    <div>
      <PageHeader
        titulo="Importaciones"
        descripcion="Carga varios reportes del biométrico a la vez. Se guardan en el almacenamiento, se limpian, se omiten repetidos y se recalcula la asistencia."
        acciones={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => qc.invalidateQueries({ queryKey: ["importaciones"] })}>
              <RefreshCw className="size-4" /> Actualizar
            </Button>
            {puedeImportar && pendientesEnBd.length > 0 && !corriendo ? (
              <SelectorSimultaneos valor={simultaneos} onChange={setSimultaneos} disabled={procesandoLote} />
            ) : null}
            {puedeImportar && pendientesEnBd.length > 0 && !corriendo ? (
              <Button
                variant="default"
                disabled={procesandoLote}
                onClick={procesarTodosPendientes}
                className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
              >
                {procesandoLote ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4 fill-current" />
                )}
                Procesar pendientes ({pendientesEnBd.length})
              </Button>
            ) : null}
            {puedeImportar ? (
              <Button onClick={() => setAbierto(true)}>
                <Upload className="size-4" /> Cargar archivos
              </Button>
            ) : null}
          </div>
        }
      />

      <HistoricoBiometrico puedeReconstruir={puedeImportar || acceso.can("asistencia", "editar")} />

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col p-6 overflow-hidden">
          <DialogHeader className="pb-2 border-b">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="text-xl font-bold font-display">Cargar archivos del biométrico</DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Sube múltiples reportes CSV. Se calculan automáticamente entradas y salidas en segundo plano.
                </p>
              </div>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
            <div
              onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
              onDragLeave={() => setArrastrando(false)}
              onDrop={(e) => {
                e.preventDefault();
                setArrastrando(false);
                if (!corriendo) agregar(e.dataTransfer.files);
              }}
              onClick={() => !corriendo && inputRef.current?.click()}
              className={cn(
                "group relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-all duration-200",
                arrastrando
                  ? "border-primary bg-primary/10 scale-[0.99]"
                  : "border-border/80 bg-muted/20 hover:border-primary/50 hover:bg-muted/40",
                corriendo && "pointer-events-none opacity-60",
              )}
            >
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-transform group-hover:scale-110">
                <Upload className="size-7" />
              </div>
              <div>
                <p className="font-semibold text-base">Arrastra tus archivos CSV aquí</p>
                <p className="text-xs text-muted-foreground mt-1">
                  o haz clic para explorar en tu equipo · Procesamiento multi-archivo sin límite
                </p>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-medium bg-background px-3 py-1 rounded-full border">
                <span>Regla automática:</span>
                <span className="text-primary font-semibold">1ª marca = Entrada · Última marca = Salida</span>
              </div>
            </div>

            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) agregar(e.target.files);
                e.target.value = "";
              }}
            />

            {items.length ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs px-1 text-muted-foreground">
                  <span>Archivos en lista ({items.length})</span>
                  {corriendo && (
                    <span className="text-primary font-medium animate-pulse">
                      {hechos} de {items.length} completados
                    </span>
                  )}
                </div>

                <div className="divide-y divide-border/60 rounded-xl border bg-card/60 backdrop-blur-sm max-h-[300px] overflow-y-auto">
                  {items.map((it) => (
                    <div
                      key={it.id}
                      className="flex items-center justify-between gap-3 p-3 transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <FileText className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-foreground">{it.file.name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[11px] text-muted-foreground">
                              {(it.file.size / 1024 / 1024).toFixed(1)} MB
                            </span>
                            {it.mensaje && (
                              <span
                                className={cn(
                                  "text-[11px] truncate max-w-[320px]",
                                  it.estado === "error"
                                    ? "text-destructive font-medium"
                                    : it.estado === "listo"
                                    ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                    : "text-muted-foreground",
                                )}
                              >
                                · {it.mensaje}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <EstadoItem estado={it.estado} />
                        {!corriendo && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            onClick={() => setItems((prev) => prev.filter((p) => p.id !== it.id))}
                          >
                            <X className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter className="pt-3 border-t flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {corriendo
                ? `${items.filter((i) => i.estado === "en_bucket").length} en espera · ${items.filter((i) => i.estado === "procesando").length} procesando · ${hechos} de ${items.length} terminados. Puedes cerrar esta ventana, pero no la pestaña.`
                : items.length > 0
                ? `${items.length} archivo(s) listos para procesar`
                : "Selecciona archivos para comenzar"}
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <SelectorSimultaneos valor={simultaneos} onChange={setSimultaneos} disabled={corriendo} />
              {corriendo ? (
                <Button variant="outline" size="sm" onClick={() => setAbierto(false)}>
                  Continuar en segundo plano
                </Button>
              ) : (
                items.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setItems([])}>
                    Limpiar lista
                  </Button>
                )
              )}
              <Button
                disabled={!hayPendientes || corriendo}
                size="sm"
                onClick={iniciar}
                className="gap-2 shadow-md shadow-primary/20"
              >
                {corriendo ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Procesando…
                  </>
                ) : (
                  <>
                    <Upload className="size-4" /> Iniciar carga
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dock flotante de progreso en segundo plano */}
      {corriendo && !abierto ? (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-2xl border border-primary/30 bg-card/95 backdrop-blur-md p-4 shadow-2xl animate-in slide-in-from-bottom-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Loader2 className="size-5 animate-spin" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold">Procesando importaciones en segundo plano</p>
            <p className="text-[11px] text-muted-foreground">
              {hechos} de {items.length} archivos procesados
            </p>
            <div className="h-1 w-44 bg-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${items.length ? (hechos / items.length) * 100 : 0}%` }}
              />
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setAbierto(true)} className="ml-2 h-8 text-xs">
            Ver detalles
          </Button>
        </div>
      ) : null}

      <SimpleTable<ImportRow>
        cargando={lista.isLoading}
        filas={pagImport.visibles}
        getKey={(f) => f.id}
        vacio="Aún no se han cargado archivos del biométrico."
        columnas={[
          {
            key: "archivo",
            header: "Archivo",
            cell: (f) => (
              <div className="max-w-[280px]">
                <p className="font-medium truncate" title={f.filename}>{nombreCorto(f.filename)}</p>
                {f.error_message ? <p className="text-xs text-destructive truncate" title={f.error_message}>{f.error_message}</p> : null}
              </div>
            ),
          },
          {
            key: "estado",
            header: "Estado",
            cell: (f) => (
              <Badge variant={f.status.startsWith("completado") ? "default" : f.status === "error" ? "destructive" : "secondary"}>
                {f.status.replace("_", " ")}
              </Badge>
            ),
          },
          { key: "found", header: "Filas del CSV", cell: (f) => <span className="tabular-nums" title="Todas las filas quedan guardadas en la capa cruda">{(f.rows_raw || f.rows_found).toLocaleString("es-CO")}</span> },
          {
            key: "nuevas",
            header: "Nuevas en el histórico",
            cell: (f) => (f.rows_raw ? <span className="tabular-nums font-medium">{f.rows_new.toLocaleString("es-CO")}</span> : <span className="text-xs text-muted-foreground" title="Cargado antes de la capa cruda: reconstruye el histórico para verlo">—</span>),
          },
          {
            key: "existian",
            header: "Ya estaban",
            cell: (f) =>
              f.rows_raw ? (
                <span className="tabular-nums text-muted-foreground" title="Eventos idénticos que ya venían en otro archivo (mismo segundo, lector, evento y persona). No se pierde nada: quedan en la capa cruda.">
                  {f.rows_existing.toLocaleString("es-CO")}
                  {f.rows_repeated_in_file ? ` · ${f.rows_repeated_in_file.toLocaleString("es-CO")} rep. en el archivo` : ""}
                </span>
              ) : "—",
          },
          { key: "valid", header: "Marcaciones válidas", cell: (f) => <span className="tabular-nums">{f.rows_valid.toLocaleString("es-CO")}</span> },
          { key: "fecha", header: "Cargado", cell: (f) => new Date(f.started_at).toLocaleString("es-CO") },
          {
            key: "acciones",
            header: "Acciones",
            cell: (f) => {
              const estaProcesando = procesandoId === f.id || procesandoLote;
              const esPendienteOError = f.status === "pendiente" || f.status === "error";
              return (
                <div className="flex items-center gap-1.5">
                  {esPendienteOError ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={estaProcesando}
                      onClick={() => handleProcesarExistente(f.id, f.filename)}
                      className="h-8 gap-1.5 text-xs text-primary border-primary/40 hover:bg-primary/10"
                      title={f.status === "error" ? "Reintentar procesamiento desde almacenamiento" : "Procesar archivo guardado en almacenamiento"}
                    >
                      {procesandoId === f.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5 fill-primary/20" />
                      )}
                      {f.status === "error" ? "Reintentar" : "Procesar"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={estaProcesando}
                      onClick={() => handleProcesarExistente(f.id, f.filename)}
                      className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                      title="Volver a procesar y recalcular asistencia"
                    >
                      {procesandoId === f.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      Reprocesar
                    </Button>
                  )}
                  {puedeEliminar ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={estaProcesando}
                      onClick={() => handleEliminar(f.id, f.filename)}
                      className="h-8 px-2 text-xs text-destructive hover:bg-destructive/10"
                      title="Eliminar importación"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            },
          },
        ]}
      />
      <Paginador {...pagImport.paginador} />
    </div>
  );
}

function EstadoItem({ estado }: { estado: Estado }) {
  if (estado === "listo") return <CheckCircle2 className="size-4 text-emerald-500" aria-label={ETIQUETA[estado]} />;
  if (estado === "error") return <XCircle className="size-4 text-destructive" aria-label={ETIQUETA[estado]} />;
  if (estado === "subiendo" || estado === "procesando")
    return <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{ETIQUETA[estado]}</span>;
  return <Badge variant={estado === "omitido" ? "outline" : "secondary"}>{ETIQUETA[estado]}</Badge>;
}

function SelectorSimultaneos({ valor, onChange, disabled }: { valor: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Archivos que se procesan al mismo tiempo">
      A la vez
      <select
        className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
        value={valor}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}
