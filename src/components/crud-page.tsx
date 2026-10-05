import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Download, X } from "lucide-react";
import { toast } from "sonner";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { descargarCsv } from "@/lib/biometria";
import { PageHeader } from "@/components/app-shell";
import { Paginador, SimpleTable, ordenarFilas, type Columna, type Orden } from "@/components/simple-table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type Campo = {
  name: string;
  label: string;
  type?: "text" | "number" | "time" | "date" | "email" | "switch" | "textarea" | "select" | "lista";
  required?: boolean;
  options?: { value: string; label: string }[];
  fuente?: { tabla: string; valor?: string; etiqueta?: string };
  readOnlyOnEdit?: boolean;
  placeholder?: string;
  ayuda?: string;
};

// Las pantallas genéricas trabajan con filas de forma dinámica.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Registro = any;

export type Filtro = {
  key: string;
  label: string;
  opciones: { value: string; label: string }[];
  aplicar: (fila: Registro, valor: string) => boolean;
  /** Valor seleccionado al abrir la pantalla (por defecto "todos"). */
  inicial?: string;
  /** Texto de la opción sin filtro (por defecto «<label>: todos»). */
  etiquetaTodos?: string;
};

const SIN_VALOR = "__vacio__";

export function CrudPage({
  titulo,
  descripcion,
  tabla,
  modulo,
  select = "*",
  orden = "created_at",
  ordenAsc = false,
  columnas,
  campos,
  sinTenant = false,
  permitirCrear = true,
  permitirEliminar = true,
  buscarEn = [],
  accionesExtra,
  filtros = [],
  accionesMasivas,
  seleccionSinEditar = false,
  accionesFila,
  aviso,
}: {
  titulo: string;
  descripcion?: string;
  tabla: string;
  modulo: string;
  select?: string;
  orden?: string;
  ordenAsc?: boolean;
  columnas: Columna<Registro>[];
  campos: Campo[];
  sinTenant?: boolean;
  permitirCrear?: boolean;
  permitirEliminar?: boolean;
  buscarEn?: string[];
  accionesExtra?: ReactNode;
  /** Filtros de lista desplegable aplicados en el navegador ("todos" = sin filtro). */
  filtros?: Filtro[];
  /** Activa la selección múltiple; recibe las filas elegidas y una función para limpiar. */
  accionesMasivas?: (seleccion: Registro[], limpiar: () => void) => ReactNode;
  /** Permite seleccionar filas aunque no se pueda editar (p. ej. para enviar solicitudes). */
  seleccionSinEditar?: boolean;
  /** Botones adicionales en la columna de acciones de cada fila. */
  accionesFila?: ((fila: Registro) => ReactNode) | undefined;
  /** Contenido opcional bajo el encabezado (avisos, resúmenes). */
  aviso?: (filas: Registro[]) => ReactNode;
}) {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState<Registro | null>(null);
  const [form, setForm] = useState<Registro>({});
  const [busqueda, setBusqueda] = useState("");
  const [valoresFiltro, setValoresFiltro] = useState<Record<string, string>>(() =>
    Object.fromEntries(filtros.filter((f) => f.inicial).map((f) => [f.key, f.inicial!])),
  );
  const [pagina, setPagina] = useState(0);
  const [tamano, setTamano] = useState(20);
  const [ordenTabla, setOrdenTabla] = useState<Orden | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());

  const lista = useQuery({
    queryKey: [tabla, "lista"],
    queryFn: async () => {
      // Trae todos los registros por bloques de 1.000 (límite de la API).
      const out: Registro[] = [];
      for (let i = 0; i < 50; i++) {
        const { data, error } = await dbAny
          .from(tabla)
          .select(select)
          .order(orden, { ascending: ordenAsc })
          .order("id", { ascending: true })
          .range(i * 1000, i * 1000 + 999);
        if (error) throw error;
        out.push(...((data ?? []) as unknown as Registro[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    },
  });

  const guardar = useMutation({
    mutationFn: async (valores: Registro) => {
      const payload: Registro = { ...valores };
      for (const campo of campos) {
        if (campo.type === "lista") {
          const v = payload[campo.name];
          payload[campo.name] = (Array.isArray(v) ? v : String(v ?? "").split(","))
            .map((x: string) => x.trim())
            .filter(Boolean);
        } else if (payload[campo.name] === "" || payload[campo.name] === SIN_VALOR) payload[campo.name] = null;
      }
      if (editando) {
        const { error } = await dbAny
          .from(tabla)
          .update(payload)
          .eq("id", editando.id as string);
        if (error) throw error;
      } else {
        // En registros nuevos, los campos vacíos toman el valor por defecto de la base
        for (const k of Object.keys(payload)) if (payload[k] === null) delete payload[k];
        if (!sinTenant) payload.tenant_id = acceso.tenantId;
        const { error } = await dbAny.from(tabla).insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editando ? "Registro actualizado" : "Registro creado");
      setAbierto(false);
      setEditando(null);
      qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error("No se pudo guardar", { description: e.message }),
  });

  const eliminar = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await dbAny.from(tabla).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Registro eliminado");
      qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error("No se pudo eliminar", { description: e.message }),
  });

  const filas = useMemo(() => {
    let datos = lista.data ?? [];
    for (const f of filtros) {
      const v = valoresFiltro[f.key];
      if (v && v !== "todos") datos = datos.filter((fila) => f.aplicar(fila, v));
    }
    if (!busqueda.trim() || buscarEn.length === 0) return datos;
    const q = busqueda.toLowerCase();
    return datos.filter((f) => buscarEn.some((c) => String(f[c] ?? "").toLowerCase().includes(q)));
  }, [lista.data, busqueda, buscarEn, filtros, valoresFiltro]);

  // Volver a la primera página cuando cambian los filtros
  useEffect(() => setPagina(0), [busqueda, valoresFiltro]);

  const ordenadas = useMemo(() => ordenarFilas(filas, ordenTabla), [filas, ordenTabla]);
  const visibles = ordenadas.slice(pagina * tamano, (pagina + 1) * tamano);
  const seleccionadas = (lista.data ?? []).filter((f) => seleccion.has(String(f.id)));
  const limpiarSeleccion = () => setSeleccion(new Set());
  const todasFiltradas = filas.length > 0 && filas.every((f) => seleccion.has(String(f.id)));

  const puedeCrear = permitirCrear && acceso.can(modulo, "crear");
  const puedeEditar = acceso.can(modulo, "editar");
  const puedeEliminar = permitirEliminar && acceso.can(modulo, "eliminar");

  const columnaSeleccion: Columna<Registro>[] =
    (accionesMasivas && seleccionSinEditar) || puedeEditar
      ? [
          {
            key: "_sel",
            className: "w-10",
            header: (
              <Checkbox
                aria-label="Seleccionar todos los registros filtrados"
                checked={todasFiltradas}
                onCheckedChange={(v) =>
                  setSeleccion(v ? new Set(filas.map((f) => String(f.id))) : new Set())
                }
              />
            ),
            cell: (fila: Registro) => (
              <Checkbox
                aria-label="Seleccionar"
                checked={seleccion.has(String(fila.id))}
                onCheckedChange={(v) =>
                  setSeleccion((prev) => {
                    const n = new Set(prev);
                    if (v) n.add(String(fila.id));
                    else n.delete(String(fila.id));
                    return n;
                  })
                }
              />
            ),
          },
        ]
      : [];

  // Una columna es ordenable si declara «orden» o si su clave es un campo del registro
  const muestra = lista.data?.[0];
  const columnasOrdenables: Columna<Registro>[] = columnas.map((c) => {
    const col = c.orden ?? (muestra && c.key in muestra ? c.key : undefined);
    return col ? { ...c, orden: col } : c;
  });

  const columnasConAcciones: Columna<Registro>[] = [
    ...columnaSeleccion,
    ...columnasOrdenables,
    ...(puedeEditar || puedeEliminar || accionesFila
      ? [
          {
            key: "acciones",
            header: "",
            className: "w-24 text-right",
            cell: (fila: Registro) => (
              <div className="flex justify-end gap-1">
                {accionesFila?.(fila)}
                {puedeEditar ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Editar"
                    onClick={() => {
                      setEditando(fila);
                      const inicial: Registro = {};
                      for (const c of campos) inicial[c.name] = fila[c.name] ?? "";
                      setForm(inicial);
                      setAbierto(true);
                    }}
                  >
                    <Pencil className="size-4" />
                  </Button>
                ) : null}
                {puedeEliminar ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Eliminar"
                    onClick={() => {
                      if (confirm("¿Eliminar este registro?")) eliminar.mutate(fila.id as string);
                    }}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
  ];

  // Exporta lo filtrado; las relaciones { name } se aplanan a su nombre.
  const exportar = () =>
    descargarCsv(
      tabla,
      filas.map((f) => {
        const plano: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(f)) {
          if (k === "tenant_id") continue;
          plano[k] =
            v && typeof v === "object"
              ? ((v as { name?: string }).name ?? JSON.stringify(v))
              : v;
        }
        return plano;
      }),
    );

  return (
    <div>
      <PageHeader
        titulo={titulo}
        descripcion={descripcion}
        acciones={
          <>
            {accionesExtra}
            {acceso.can(modulo, "exportar") ? (
              <Button variant="outline" onClick={exportar} disabled={!filas.length}>
                <Download className="size-4" /> Exportar
              </Button>
            ) : null}
            {puedeCrear ? (
              <Button
                onClick={() => {
                  setEditando(null);
                  const inicial: Registro = {};
                  for (const c of campos) inicial[c.name] = c.type === "switch" ? true : "";
                  setForm(inicial);
                  setAbierto(true);
                }}
              >
                <Plus className="size-4" /> Nuevo
              </Button>
            ) : null}
          </>
        }
      />

      {aviso && lista.data ? aviso(lista.data) : null}

      {buscarEn.length > 0 || filtros.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {buscarEn.length > 0 ? (
            <Input
              className="max-w-sm"
              placeholder="Buscar..."
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
          ) : null}
          {filtros.map((f) => (
            <Select
              key={f.key}
              value={valoresFiltro[f.key] ?? "todos"}
              onValueChange={(v) => setValoresFiltro((prev) => ({ ...prev, [f.key]: v }))}
            >
              <SelectTrigger className="w-52" aria-label={f.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">{f.etiquetaTodos ?? `${f.label}: todos`}</SelectItem>
                {f.opciones.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {filas.length.toLocaleString("es-CO")} registros
          </span>
        </div>
      ) : null}

      {seleccionadas.length > 0 && (accionesMasivas || puedeEditar) ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">{seleccionadas.length} seleccionados</span>
          {accionesMasivas?.(seleccionadas, limpiarSeleccion)}
          {puedeEditar ? (
            <EdicionMasiva tabla={tabla} campos={campos} seleccion={seleccionadas} limpiar={limpiarSeleccion} />
          ) : null}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={limpiarSeleccion}>
            <X className="size-4" /> Quitar selección
          </Button>
        </div>
      ) : null}

      <SimpleTable
        columnas={columnasConAcciones}
        filas={visibles}
        orden={ordenTabla}
        onOrden={setOrdenTabla}
        cargando={lista.isLoading}
        getKey={(f, i) => String(f.id ?? i)}
      />
      <Paginador pagina={pagina} tamano={tamano} total={filas.length} onCambio={setPagina} onTamano={setTamano} />

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editando ? "Editar registro" : "Nuevo registro"}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              guardar.mutate(form);
            }}
          >
            {campos.map((campo) => (
              <CampoForm
                key={campo.name}
                campo={campo}
                valor={form[campo.name]}
                editando={Boolean(editando)}
                onChange={(v) => setForm((prev: Registro) => ({ ...prev, [campo.name]: v }))}
              />
            ))}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={guardar.isPending}>
                Guardar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Aplica el mismo valor de un campo a todos los registros seleccionados (queda en la auditoría). */
function EdicionMasiva({ tabla, campos, seleccion, limpiar }: { tabla: string; campos: Campo[]; seleccion: Registro[]; limpiar: () => void }) {
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [campo, setCampo] = useState("");
  const [valor, setValor] = useState<unknown>("");
  const [trabajando, setTrabajando] = useState(false);
  // Los identificadores (código, documento, nombre obligatorio) no se cambian en bloque
  const editables = campos.filter((c) => !c.required && !c.readOnlyOnEdit && c.type !== "lista");
  const elegido = editables.find((c) => c.name === campo);
  if (!editables.length) return null;

  async function aplicar() {
    if (!elegido) return;
    const v = valor === "" || valor === SIN_VALOR ? null : valor;
    if (!confirm(`¿Cambiar «${elegido.label}» en ${seleccion.length} registros?`)) return;
    setTrabajando(true);
    try {
      const ids = seleccion.map((f) => f.id as string);
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await dbAny.from(tabla).update({ [elegido.name]: v }).in("id", ids.slice(i, i + 200));
        if (error) throw error;
      }
      toast.success(`«${elegido.label}» actualizado en ${ids.length} registros`);
      setAbierto(false);
      setCampo("");
      setValor("");
      limpiar();
      void qc.invalidateQueries();
    } catch (e) {
      toast.error("No se pudo actualizar", { description: (e as Error).message });
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setAbierto(true)}>
        <Pencil className="size-4" /> Editar en bloque
      </Button>
      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Editar {seleccion.length} registros</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Campo a cambiar</Label>
              <Select value={campo} onValueChange={(v) => { setCampo(v); setValor(campos.find((c) => c.name === v)?.type === "switch" ? true : ""); }}>
                <SelectTrigger><SelectValue placeholder="Elige el campo" /></SelectTrigger>
                <SelectContent>
                  {editables.map((c) => <SelectItem key={c.name} value={c.name}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {elegido ? <CampoForm campo={{ ...elegido, label: "Nuevo valor" }} valor={valor} editando={false} onChange={setValor} /> : null}
            <p className="text-xs text-muted-foreground">El cambio queda en la auditoría con el valor anterior de cada registro.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbierto(false)}>Cancelar</Button>
            <Button onClick={() => void aplicar()} disabled={!elegido || trabajando}>Aplicar a {seleccion.length}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CampoForm({
  campo,
  valor,
  editando,
  onChange,
}: {
  campo: Campo;
  valor: unknown;
  editando: boolean;
  onChange: (v: unknown) => void;
}) {
  const opcionesRemotas = useQuery({
    queryKey: ["opciones", campo.fuente?.tabla],
    enabled: Boolean(campo.fuente),
    queryFn: async () => {
      const fuente = campo.fuente!;
      const valorCol = fuente.valor ?? "id";
      const etiquetaCol = fuente.etiqueta ?? "name";
      const columnas: string = `${valorCol}, ${etiquetaCol}`;
      const { data, error } = await dbAny.from(fuente.tabla).select(columnas).order(etiquetaCol);
      if (error) throw error;
      return (data ?? []).map((row) => {
        const r = row as unknown as Record<string, unknown>;
        return { value: String(r[valorCol]), label: String(r[etiquetaCol]) };
      });
    },
  });

  const opciones = campo.options ?? opcionesRemotas.data ?? [];
  const deshabilitado = editando && campo.readOnlyOnEdit;
  const ayuda = campo.ayuda ? <p className="text-xs text-muted-foreground">{campo.ayuda}</p> : null;

  if (campo.type === "switch") {
    return (
      <div className="rounded-md border px-3 py-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={campo.name}>{campo.label}</Label>
          <Switch id={campo.name} checked={Boolean(valor)} onCheckedChange={(v) => onChange(v)} />
        </div>
        {ayuda}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={campo.name}>{campo.label}</Label>
      {campo.type === "select" || campo.fuente ? (
        <Select
          value={valor ? String(valor) : ""}
          onValueChange={(v) => onChange(v)}
          disabled={Boolean(deshabilitado)}
        >
          <SelectTrigger id={campo.name}>
            <SelectValue placeholder="Selecciona una opción" />
          </SelectTrigger>
          <SelectContent>
            {/* Las listas de otras tablas permiten dejar el dato vacío */}
            {campo.fuente && !campo.required ? (
              <SelectItem value={SIN_VALOR} className="text-muted-foreground">
                — Sin asignar —
              </SelectItem>
            ) : null}
            {opciones.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : campo.type === "textarea" ? (
        <Textarea
          id={campo.name}
          value={valor === null || valor === undefined ? "" : String(valor)}
          required={campo.required}
          placeholder={campo.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={campo.name}
          type={campo.type === "lista" ? "text" : (campo.type ?? "text")}
          value={valor === null || valor === undefined ? "" : Array.isArray(valor) ? valor.join(", ") : String(valor)}
          required={campo.required}
          disabled={Boolean(deshabilitado)}
          placeholder={campo.placeholder}
          onChange={(e) =>
            onChange(campo.type === "number" ? Number(e.target.value) : e.target.value)
          }
        />
      )}
      {ayuda}
    </div>
  );
}
