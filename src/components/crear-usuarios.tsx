import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import * as XLSX from "xlsx";
import {
  ArrowRight, Briefcase, Check, CheckCircle2, Download, Eye, EyeOff, FileSpreadsheet, Headphones, Loader2,
  PencilLine, Search, ShieldCheck, Upload, UserCog, UserPlus, Users, Wallet, Wand2, X, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import {
  crearUsuarios, editarUsuariosMasivo, exportarUsuarios, grupoDeRol,
  type FilaEdicion, type GrupoRol, type NuevoUsuario, type ResultadoEdicion,
} from "@/lib/usuarios.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Resultado = { email: string; ok: boolean; error?: string };
type Rol = { id: string; code: string; name: string };
type Campana = { id: string; code: string | null; name: string };
type Celdas = Partial<Record<string, string>>;

const SIN_CAMPANA = "__ninguna__";

/** Plantilla de carga masiva por tipo de rol: columnas y explicación. */
const PLANTILLAS: Record<GrupoRol, { titulo: string; icono: ReactNode; columnas: string[]; ayuda: string[] }> = {
  basico: {
    titulo: "Administrador / Nómina",
    icono: <ShieldCheck className="size-5" />,
    columnas: ["correo", "nombre", "contrasena", "rol"],
    ayuda: ["Ven toda la plataforma: no llevan campañas."],
  },
  campanas: {
    titulo: "Supervisor / Coordinador / Back Office",
    icono: <Users className="size-5" />,
    columnas: ["correo", "nombre", "contrasena", "rol", "campanas"],
    ayuda: ["campanas: una o más, separadas por comas (ej: CAMPAÑA 1, CAMPAÑA 2). Solo verán esas campañas."],
  },
  asesor: {
    titulo: "Asesor",
    icono: <Headphones className="size-5" />,
    columnas: ["correo", "nombre", "contrasena", "rol", "campana", "cedula"],
    ayuda: [
      "cedula: documento del empleado al que se vincula. Si el empleado no existe, o ya está vinculado a otro usuario, no se crea: créalo o revísalo en Empleados.",
      "campana: máximo una. Vacía = solo ve su propia información; con campaña ve a las personas de esa campaña.",
    ],
  },
};

/** Qué pide y cómo se ve cada rol en el formulario. */
function infoRol(code: string): { icono: ReactNode; detalle: string } {
  switch (code) {
    case "super_admin": return { icono: <ShieldCheck className="size-5" />, detalle: "Todo, en todas las empresas" };
    case "admin": return { icono: <ShieldCheck className="size-5" />, detalle: "Toda la plataforma · sin campañas" };
    case "nomina": return { icono: <Wallet className="size-5" />, detalle: "Toda la plataforma · sin campañas" };
    case "supervisor": return { icono: <Users className="size-5" />, detalle: "Una o más campañas" };
    case "coordinador": return { icono: <Users className="size-5" />, detalle: "Una o más campañas" };
    case "bo": return { icono: <Briefcase className="size-5" />, detalle: "Una o más campañas" };
    case "asesor": return { icono: <Headphones className="size-5" />, detalle: "Cédula del empleado · máx. 1 campaña" };
    default: return { icono: <UserCog className="size-5" />, detalle: "Rol personalizado · sin campañas" };
  }
}

const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const claveColumna = (k: string) => norm(k).replace(/\s+/g, "_").replace("contraseña", "contrasena").replace("campaña", "campana");

function generarContrasena() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint32Array(10));
  return Array.from(r, (n) => abc[n % abc.length]).join("") + "*1";
}

async function leerHoja(file: File, hoja: string) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[hoja] ?? wb.Sheets[wb.SheetNames[0]!]!;
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
  const [enc = [], ...resto] = aoa;
  const columnas = enc.map((c) => claveColumna(String(c)));
  const filas = resto.map((f) => Object.fromEntries(columnas.map((c, i) => [c, String(f[i] ?? "").trim()])) as Celdas);
  return { columnas, filas };
}

function useCatalogos() {
  const roles = useQuery({
    queryKey: ["crear-usuarios", "roles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("roles").select("id, code, name").order("name");
      if (error) throw error;
      return (data ?? []) as Rol[];
    },
  });
  const campanas = useQuery({
    queryKey: ["crear-usuarios", "campanas"],
    queryFn: async () => {
      const { data, error } = await supabase.from("campaigns").select("id, code, name").order("name");
      if (error) throw error;
      return (data ?? []) as Campana[];
    },
  });
  return { roles: roles.data ?? [], campanas: campanas.data ?? [], cargando: roles.isLoading };
}

export function CrearUsuarios({ alTerminar }: { alTerminar: () => void }) {
  const acceso = useAccess();
  const [abierto, setAbierto] = useState<"uno" | "masivo" | "edicion" | null>(null);
  const cerrar = () => setAbierto(null);
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <Button onClick={() => setAbierto("uno")}><UserPlus className="size-4" /> Nuevo usuario</Button>
      <Button variant="outline" onClick={() => setAbierto("masivo")}><Upload className="size-4" /> Carga masiva</Button>
      {acceso.isSuperAdmin ? (
        <Button variant="outline" onClick={() => setAbierto("edicion")}><PencilLine className="size-4" /> Edición masiva</Button>
      ) : null}
      {abierto === "uno" ? <NuevoUsuarioDialog onClose={cerrar} alTerminar={alTerminar} /> : null}
      {abierto === "masivo" ? <CargaMasivaDialog onClose={cerrar} alTerminar={alTerminar} /> : null}
      {abierto === "edicion" ? <EdicionMasivaDialog onClose={cerrar} alTerminar={alTerminar} /> : null}
    </div>
  );
}

// ───────────── Piezas visuales compartidas ─────────────

function Seccion({ n, titulo, children, apagada }: { n: number; titulo: string; children: ReactNode; apagada?: boolean }) {
  return (
    <section className={cn("space-y-3", apagada && "pointer-events-none opacity-40")}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-primary text-xs text-primary-foreground">{n}</span>
        {titulo}
      </h3>
      <div className="pl-8">{children}</div>
    </section>
  );
}

function Tarjeta({ activa, onClick, icono, titulo, detalle }: { activa: boolean; onClick: () => void; icono: ReactNode; titulo: string; detalle: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex items-start gap-3 rounded-xl border p-3 text-left transition-all hover:border-primary/60 hover:bg-muted/50",
        activa && "border-primary bg-primary/5 ring-2 ring-primary/20",
      )}
    >
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground", activa && "bg-primary text-primary-foreground")}>{icono}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{titulo}</span>
        <span className="block text-xs text-muted-foreground">{detalle}</span>
      </span>
      {activa ? <Check className="absolute right-2 top-2 size-4 text-primary" /> : null}
    </button>
  );
}

function Pasos({ pasos, actual }: { pasos: string[]; actual: number }) {
  return (
    <ol className="flex items-center gap-2 text-xs">
      {pasos.map((p, i) => (
        <li key={p} className="flex items-center gap-2">
          <span className={cn(
            "grid size-6 place-items-center rounded-full border font-semibold",
            i < actual && "border-primary bg-primary text-primary-foreground",
            i === actual && "border-primary text-primary",
            i > actual && "text-muted-foreground",
          )}>{i < actual ? <Check className="size-3.5" /> : i + 1}</span>
          <span className={cn(i === actual ? "font-medium" : "text-muted-foreground", "hidden sm:inline")}>{p}</span>
          {i < pasos.length - 1 ? <ArrowRight className="size-3.5 text-muted-foreground" /> : null}
        </li>
      ))}
    </ol>
  );
}

function ZonaArchivo({ archivo, alElegir, texto }: { archivo: File | null; alElegir: (f: File) => void; texto: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [encima, setEncima] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => ref.current?.click()}
      onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setEncima(true); }}
      onDragLeave={() => setEncima(false)}
      onDrop={(e) => { e.preventDefault(); setEncima(false); const f = e.dataTransfer.files?.[0]; if (f) alElegir(f); }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors hover:border-primary/60 hover:bg-muted/40",
        encima && "border-primary bg-primary/5",
      )}
    >
      <FileSpreadsheet className="size-8 text-muted-foreground" />
      {archivo ? (
        <p className="text-sm font-medium">{archivo.name}</p>
      ) : (
        <>
          <p className="text-sm font-medium">{texto}</p>
          <p className="text-xs text-muted-foreground">Arrastra el archivo aquí o haz clic para elegirlo (.xlsx o .csv)</p>
        </>
      )}
      <input ref={ref} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) alElegir(f); e.target.value = ""; }} />
    </div>
  );
}

function ListaErrores({ titulo, errores }: { titulo: string; errores: string[] }) {
  if (!errores.length) return null;
  return (
    <div className="max-h-36 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
      <p className="mb-1 font-medium">{titulo}</p>
      {errores.map((e) => <p key={e}>{e}</p>)}
    </div>
  );
}

function Resumen({ ok, error, extra }: { ok: number; error: number; extra?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline" className="gap-1 border-success/40 text-success"><CheckCircle2 className="size-3.5" />{ok} correctos</Badge>
      {error ? <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive"><XCircle className="size-3.5" />{error} con error</Badge> : null}
      {extra ? <Badge variant="outline">{extra}</Badge> : null}
    </div>
  );
}

// ───────────── Nuevo usuario (uno a uno) ─────────────

function NuevoUsuarioDialog({ onClose, alTerminar }: { onClose: () => void; alTerminar: () => void }) {
  const crear = useServerFn(crearUsuarios);
  const acceso = useAccess();
  const { roles, campanas, cargando: cargandoRoles } = useCatalogos();
  const [rolId, setRolId] = useState("");
  const [f, setF] = useState({ full_name: "", email: "", password: "", documento: "" });
  const [verClave, setVerClave] = useState(false);
  const [elegidas, setElegidas] = useState<string[]>([]);
  const [buscar, setBuscar] = useState("");
  const [campanaAsesor, setCampanaAsesor] = useState(SIN_CAMPANA);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  const visibles = roles.filter((r) => r.code !== "super_admin" || acceso.isSuperAdmin);
  const rol = roles.find((r) => r.id === rolId);
  const grupo = rol ? grupoDeRol(rol.code) : null;
  const empleado = useEmpleadoPorCedula(grupo === "asesor" ? f.documento : "");
  const campanasFiltradas = campanas.filter((c) => norm(c.name).includes(norm(buscar)));

  const datosOk = Boolean(f.full_name.trim() && /\S+@\S+\.\S+/.test(f.email) && f.password.length >= 8);
  const accesoOk = grupo === "basico" || (grupo === "campanas" && elegidas.length > 0) || (grupo === "asesor" && Boolean(empleado.data && !empleado.data.user_id));

  async function guardar() {
    if (!rol) return;
    setCargando(true);
    setError("");
    try {
      const nombreCampana = (id: string) => campanas.find((c) => c.id === id)?.name ?? "";
      const usuario: NuevoUsuario = {
        full_name: f.full_name, email: f.email, password: f.password,
        rol: rol.code,
        campanas:
          grupo === "campanas" ? elegidas.map(nombreCampana).join(",")
            : grupo === "asesor" && campanaAsesor !== SIN_CAMPANA ? nombreCampana(campanaAsesor) : "",
        documento: grupo === "asesor" ? f.documento : undefined,
      };
      const r = await crear({ data: { usuarios: [usuario] } });
      const res = r.resultados[0];
      if (!res?.ok) return setError(res?.error ?? "No se pudo crear");
      toast.success(`Usuario ${f.email} creado`, { description: res.error });
      alTerminar();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><UserPlus className="size-5 text-primary" /> Nuevo usuario</DialogTitle>
          <DialogDescription>Elige el rol y completa solo los datos que ese rol necesita.</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <Seccion n={1} titulo="Rol">
            {cargandoRoles ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Cargando roles…</p> : (
              <div className="grid gap-2 sm:grid-cols-2">
                {visibles.map((r) => (
                  <Tarjeta key={r.id} activa={r.id === rolId} onClick={() => { setRolId(r.id); setError(""); }} icono={infoRol(r.code).icono} titulo={r.name} detalle={infoRol(r.code).detalle} />
                ))}
              </div>
            )}
          </Seccion>

          <Seccion n={2} titulo="Datos del usuario" apagada={!rol}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="nu-nombre">Nombre completo</Label>
                <Input id="nu-nombre" placeholder="Ej: CONVERTIA" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nu-correo">Correo</Label>
                <Input id="nu-correo" type="email" placeholder="usuario@convertia.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nu-clave">Contraseña</Label>
                <div className="flex gap-1">
                  <div className="relative flex-1">
                    <Input id="nu-clave" type={verClave ? "text" : "password"} placeholder="Mínimo 8 caracteres" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="pr-9" />
                    <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setVerClave(!verClave)} aria-label={verClave ? "Ocultar" : "Mostrar"}>
                      {verClave ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  <Button type="button" variant="outline" size="icon" title="Generar contraseña" onClick={() => { setF({ ...f, password: generarContrasena() }); setVerClave(true); }}>
                    <Wand2 className="size-4" />
                  </Button>
                </div>
                {f.password && f.password.length < 8 ? <p className="text-xs text-destructive">Faltan {8 - f.password.length} caracteres.</p> : null}
              </div>
            </div>
          </Seccion>

          {grupo && grupo !== "basico" ? (
            <Seccion n={3} titulo={grupo === "asesor" ? "Empleado y campaña" : "Campañas que puede ver"} apagada={!datosOk}>
              {grupo === "campanas" ? (
                <div className="space-y-2">
                  {elegidas.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {elegidas.map((id) => (
                        <Badge key={id} variant="secondary" className="gap-1">
                          {campanas.find((c) => c.id === id)?.name}
                          <button type="button" onClick={() => setElegidas(elegidas.filter((x) => x !== id))} aria-label="Quitar"><X className="size-3" /></button>
                        </Badge>
                      ))}
                    </div>
                  ) : <p className="text-xs text-muted-foreground">Elige una o más campañas.</p>}
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input className="pl-8" placeholder="Buscar campaña…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
                  </div>
                  <div className="grid max-h-44 gap-1 overflow-auto rounded-lg border p-1.5 sm:grid-cols-2">
                    {campanasFiltradas.map((c) => {
                      const on = elegidas.includes(c.id);
                      return (
                        <button key={c.id} type="button" onClick={() => setElegidas(on ? elegidas.filter((x) => x !== c.id) : [...elegidas, c.id])}
                          className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted", on && "bg-primary/10 font-medium")}>
                          <span className={cn("grid size-4 place-items-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>{on ? <Check className="size-3" /> : null}</span>
                          {c.name}
                        </button>
                      );
                    })}
                    {!campanasFiltradas.length ? <p className="p-2 text-xs text-muted-foreground">Sin resultados.</p> : null}
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="nu-cedula">Cédula del empleado</Label>
                    <Input id="nu-cedula" inputMode="numeric" placeholder="Ej: 012345" value={f.documento} onChange={(e) => setF({ ...f, documento: e.target.value })} />
                    <EstadoEmpleado cedula={f.documento} consulta={empleado} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Campaña (máximo una)</Label>
                    <Select value={campanaAsesor} onValueChange={setCampanaAsesor}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SIN_CAMPANA}>Sin campaña (solo ve lo suyo)</SelectItem>
                        {campanas.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </Seccion>
          ) : null}

          {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <p className="self-center text-xs text-muted-foreground">
            {rol ? <>Rol <b>{rol.name}</b>{grupo === "campanas" ? ` · ${elegidas.length} campañas` : ""}</> : "Elige un rol para empezar"}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button disabled={cargando || !rol || !datosOk || !accesoOk} onClick={guardar}>
              {cargando ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Crear usuario
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useEmpleadoPorCedula(cedula: string) {
  const [doc, setDoc] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDoc(cedula.replace(/[.\s]/g, "")), 400);
    return () => clearTimeout(t);
  }, [cedula]);
  return useQuery({
    queryKey: ["crear-usuarios", "empleado", doc],
    enabled: doc.length >= 4,
    queryFn: async () => {
      const { data, error } = await supabase.from("employees").select("id, full_name, user_id").eq("document", doc).maybeSingle();
      if (error) throw error;
      return data as { id: string; full_name: string; user_id: string | null } | null;
    },
  });
}

function EstadoEmpleado({ cedula, consulta }: { cedula: string; consulta: ReturnType<typeof useEmpleadoPorCedula> }) {
  const base = "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs";
  if (cedula.replace(/[.\s]/g, "").length < 4) return <p className="text-xs text-muted-foreground">El asesor queda vinculado a este empleado.</p>;
  if (consulta.isFetching) return <p className={cn(base, "text-muted-foreground")}><Loader2 className="size-3.5 animate-spin" />Buscando…</p>;
  if (!consulta.data) return <p className={cn(base, "bg-destructive/10 text-destructive")}><XCircle className="size-3.5" />No existe: créalo primero en Empleados.</p>;
  if (consulta.data.user_id) return <p className={cn(base, "bg-destructive/10 text-destructive")}><XCircle className="size-3.5" />{consulta.data.full_name} ya tiene otro usuario.</p>;
  return <p className={cn(base, "bg-success/10 text-success")}><CheckCircle2 className="size-3.5" />{consulta.data.full_name}</p>;
}

// ───────────── Carga masiva por tipo de rol ─────────────

function CargaMasivaDialog({ onClose, alTerminar }: { onClose: () => void; alTerminar: () => void }) {
  const crear = useServerFn(crearUsuarios);
  const { roles, campanas } = useCatalogos();
  const [tipo, setTipo] = useState<GrupoRol | null>(null);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [filas, setFilas] = useState<NuevoUsuario[]>([]);
  const [errores, setErrores] = useState<string[]>([]);
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [cargando, setCargando] = useState(false);
  const p = tipo ? PLANTILLAS[tipo] : null;
  const rolesDelTipo = useMemo(() => roles.filter((r) => tipo && grupoDeRol(r.code) === tipo && r.code !== "super_admin"), [roles, tipo]);
  const paso = resultados.length ? 3 : filas.length || errores.length ? 2 : tipo ? 1 : 0;

  function elegirTipo(g: GrupoRol) {
    setTipo(g); setArchivo(null); setFilas([]); setErrores([]); setResultados([]);
  }

  function descargar() {
    if (!tipo || !p) return;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([p.columnas]);
    ws["!cols"] = p.columnas.map((c) => ({ wch: ["correo", "nombre", "campanas"].includes(c) ? 34 : 16 }));
    XLSX.utils.book_append_sheet(wb, ws, "Usuarios");
    const max = Math.max(rolesDelTipo.length, tipo === "basico" ? 0 : campanas.length, 1);
    const valores = Array.from({ length: max }, (_, i) => ({
      rol: rolesDelTipo[i]?.code ?? "",
      ...(tipo === "basico" ? {} : { campana: campanas[i]?.name ?? "" }),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(valores), "Valores válidos");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      [`Carga masiva de usuarios: ${p.titulo}`],
      ["1. Llena la hoja «Usuarios», una fila por usuario. No cambies los títulos de las columnas."],
      ["2. contrasena: mínimo 8 caracteres. rol: uno de la hoja «Valores válidos»."],
      ...p.ayuda.map((a, i) => [`${i + 3}. ${a}`]),
      [""],
      [LEYENDA],
    ]), "Instrucciones");
    XLSX.writeFile(wb, `plantilla_usuarios_${tipo}.xlsx`);
    toast.info("Plantilla descargada", { description: AVISO });
  }

  async function leer(file: File) {
    if (!tipo || !p) return;
    setArchivo(file); setResultados([]);
    try {
      const { columnas, filas: raw } = await leerHoja(file, "Usuarios");
      const faltan = p.columnas.filter((c) => !columnas.includes(c));
      if (faltan.length) { setFilas([]); setErrores([`Al archivo le faltan las columnas: ${faltan.join(", ")}. Descarga la plantilla de ${p.titulo}.`]); return; }
      const errs: string[] = [];
      const out: NuevoUsuario[] = [];
      const correos = new Set<string>();
      raw.forEach((r, i) => {
        const fila = i + 2;
        const correo = (r["correo"] ?? "").toLowerCase();
        if (!correo) return;
        const rol = roles.find((x) => norm(x.code) === norm(r["rol"]) || norm(x.name) === norm(r["rol"]));
        if (!/\S+@\S+\.\S+/.test(correo)) return void errs.push(`Fila ${fila}: correo «${correo}» no válido.`);
        if (correos.has(correo)) return void errs.push(`Fila ${fila}: el correo ${correo} está repetido.`);
        if (!rol) return void errs.push(`Fila ${fila}: el rol «${r["rol"] ?? ""}» no existe.`);
        if (grupoDeRol(rol.code) !== tipo) return void errs.push(`Fila ${fila}: el rol «${r["rol"]}» no va en la plantilla ${p.titulo}.`);
        if (!r["nombre"]) return void errs.push(`Fila ${fila}: falta el nombre.`);
        if ((r["contrasena"] ?? "").length < 8) return void errs.push(`Fila ${fila}: la contraseña debe tener al menos 8 caracteres.`);
        if (tipo === "campanas" && !r["campanas"]) return void errs.push(`Fila ${fila}: indica al menos una campaña.`);
        if (tipo === "asesor" && !r["cedula"]) return void errs.push(`Fila ${fila}: falta la cédula del asesor.`);
        correos.add(correo);
        out.push({
          email: correo, full_name: r["nombre"] ?? "", password: r["contrasena"] ?? "", rol: rol.code,
          campanas: tipo === "campanas" ? r["campanas"] : tipo === "asesor" ? r["campana"] : "",
          documento: tipo === "asesor" ? r["cedula"] : undefined,
        });
      });
      setFilas(out);
      setErrores(errs.length || out.length ? errs : ["El archivo no tiene usuarios."]);
    } catch (e) {
      setFilas([]); setErrores([`No se pudo leer el archivo: ${(e as Error).message}`]);
    }
  }

  async function enviar() {
    setCargando(true);
    try {
      const r = await crear({ data: { usuarios: filas } });
      setResultados(r.resultados);
      const creados = r.resultados.filter((x) => x.ok).length;
      (creados ? toast.success : toast.error)(`${creados} de ${r.resultados.length} usuarios creados`);
      alTerminar();
    } catch (e) {
      toast.error("No se pudo crear", { description: (e as Error).message });
    } finally {
      setCargando(false);
    }
  }

  const ok = resultados.filter((r) => r.ok).length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="size-5 text-primary" /> Carga masiva de usuarios</DialogTitle>
          <DialogDescription>Cada tipo de rol tiene su propia plantilla con solo las columnas que necesita.</DialogDescription>
        </DialogHeader>
        <Pasos pasos={["Tipo de rol", "Plantilla y archivo", "Revisar", "Resultado"]} actual={paso} />

        <div className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(PLANTILLAS) as GrupoRol[]).map((g) => (
              <Tarjeta key={g} activa={tipo === g} onClick={() => elegirTipo(g)} icono={PLANTILLAS[g].icono} titulo={PLANTILLAS[g].titulo} detalle={`${PLANTILLAS[g].columnas.length} columnas`} />
            ))}
          </div>

          {p ? (
            <div className="grid gap-4 rounded-xl border bg-muted/30 p-4 md:grid-cols-2">
              <div className="space-y-3">
                <p className="text-sm font-medium">Columnas de la plantilla</p>
                <div className="flex flex-wrap gap-1.5">{p.columnas.map((c) => <Badge key={c} variant="secondary" className="font-mono text-[11px]">{c}</Badge>)}</div>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  <li>Roles: {rolesDelTipo.map((r) => r.code).join(", ") || "—"}.</li>
                  {p.ayuda.map((a) => <li key={a}>{a}</li>)}
                </ul>
                <Button variant="outline" size="sm" onClick={descargar}><Download className="size-4" /> Descargar plantilla</Button>
              </div>
              <ZonaArchivo archivo={archivo} alElegir={(f) => void leer(f)} texto="Sube la plantilla llena" />
            </div>
          ) : null}

          <ListaErrores titulo="Filas que no se crearán:" errores={errores} />

          {filas.length && !resultados.length ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{filas.length} usuarios listos para crear</p>
              <div className="max-h-56 overflow-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-left"><tr>
                    <th className="p-2">Correo</th><th className="p-2">Nombre</th><th className="p-2">Rol</th>
                    {tipo !== "basico" ? <th className="p-2">{tipo === "asesor" ? "Campaña · cédula" : "Campañas"}</th> : null}
                  </tr></thead>
                  <tbody>
                    {filas.map((u) => (
                      <tr key={u.email} className="border-t">
                        <td className="p-2">{u.email}</td><td className="p-2">{u.full_name}</td><td className="p-2">{u.rol}</td>
                        {tipo !== "basico" ? <td className="p-2">{tipo === "asesor" ? `${u.campanas || "sin campaña"} · ${u.documento}` : u.campanas}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {resultados.length ? (
            <div className="space-y-2">
              <Resumen ok={ok} error={resultados.length - ok} />
              <div className="max-h-60 space-y-1 overflow-auto rounded-lg border p-2 text-xs">
                {resultados.map((r) => (
                  <p key={r.email} className={cn("flex items-start gap-1.5", r.ok ? "text-success" : "text-destructive")}>
                    {r.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <XCircle className="mt-0.5 size-3.5 shrink-0" />}
                    <span><b>{r.email}</b>: {r.ok ? (r.error ?? "creado") : r.error}</span>
                  </p>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{resultados.length ? "Cerrar" : "Cancelar"}</Button>
          {!resultados.length ? (
            <Button disabled={cargando || !filas.length} onClick={enviar}>
              {cargando ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />} {cargando ? "Creando…" : `Crear ${filas.length || ""} usuarios`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────── Edición masiva (solo super administrador) ─────────────

const COLS_EDICION = ["id", "correo", "nombre", "rol", "campanas", "cedula", "activo", "contrasena_nueva"] as const;

function EdicionMasivaDialog({ onClose, alTerminar }: { onClose: () => void; alTerminar: () => void }) {
  const exportar = useServerFn(exportarUsuarios);
  const editar = useServerFn(editarUsuariosMasivo);
  const [descargando, setDescargando] = useState(false);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [filas, setFilas] = useState<FilaEdicion[]>([]);
  const [errores, setErrores] = useState<string[]>([]);
  const [previa, setPrevia] = useState<{ resultados: ResultadoEdicion[]; sinCambios: number } | null>(null);
  const [final, setFinal] = useState<{ resultados: ResultadoEdicion[]; sinCambios: number } | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const paso = final ? 3 : previa ? 2 : archivo ? 1 : 0;

  async function descargar() {
    setDescargando(true);
    try {
      const { filas: usuarios, roles, campanas } = await exportar();
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(usuarios, { header: [...COLS_EDICION] });
      ws["!cols"] = [38, 34, 34, 14, 40, 14, 8, 18].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, "Usuarios");
      const max = Math.max(roles.length, campanas.length, 2);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Array.from({ length: max }, (_, i) => ({
        rol: roles[i] ?? "", campana: campanas[i] ?? "", activo: ["si", "no"][i] ?? "",
      }))), "Valores válidos");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ["Edición masiva de usuarios"],
        ["1. Cambia solo lo que necesites. Se actualizan únicamente las celdas distintas a lo que hay en la plataforma."],
        ["2. Puedes borrar las filas que no vas a cambiar: los usuarios que no vengan en el archivo no se tocan."],
        ["3. No cambies la columna id: identifica al usuario (así puedes cambiarle el correo)."],
        ["4. contrasena_nueva: déjala vacía para no cambiarla; si escribes una (mín. 8 caracteres), se cambia solo la contraseña."],
        ["5. campanas: separadas por comas. cedula: vincula el usuario con ese empleado (obligatoria para asesores)."],
        ["6. activo: si o no. Un usuario inactivo no puede iniciar sesión."],
        [""],
        [LEYENDA],
      ]), "Instrucciones");
      XLSX.writeFile(wb, `usuarios_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.info(`${usuarios.length} usuarios descargados`, { description: AVISO });
    } catch (e) {
      toast.error("No se pudo descargar", { description: (e as Error).message });
    } finally {
      setDescargando(false);
    }
  }

  async function leer(file: File) {
    setArchivo(file); setPrevia(null); setFinal(null); setErrores([]);
    setTrabajando(true);
    try {
      const { columnas, filas: raw } = await leerHoja(file, "Usuarios");
      if (!columnas.includes("id")) { setFilas([]); setErrores(["El archivo no tiene la columna id. Usa el archivo que descargas aquí."]); return; }
      const presentes = COLS_EDICION.filter((c) => c !== "id" && columnas.includes(c));
      const out: FilaEdicion[] = [];
      const errs: string[] = [];
      raw.forEach((r, i) => {
        const id = r["id"] ?? "";
        if (!id) return;
        if (!/^[0-9a-f-]{36}$/i.test(id)) return void errs.push(`Fila ${i + 2}: id «${id}» no válido.`);
        const fila: FilaEdicion = { id, fila: i + 2 };
        for (const c of presentes) {
          const v = r[c] ?? "";
          if (c === "contrasena_nueva") { if (v) fila.contrasena_nueva = v; } else fila[c] = v;
        }
        out.push(fila);
      });
      setFilas(out);
      setErrores(errs);
      if (!out.length) { setErrores([...errs, "El archivo no tiene usuarios."]); return; }
      setPrevia(await editar({ data: { filas: out, aplicar: false } }));
    } catch (e) {
      setErrores([`No se pudo revisar el archivo: ${(e as Error).message}`]);
    } finally {
      setTrabajando(false);
    }
  }

  async function aplicar() {
    setTrabajando(true);
    try {
      const r = await editar({ data: { filas, aplicar: true } });
      setFinal(r);
      const ok = r.resultados.filter((x) => !x.error).length;
      toast.success(`${ok} usuarios actualizados`);
      alTerminar();
    } catch (e) {
      toast.error("No se pudieron aplicar los cambios", { description: (e as Error).message });
    } finally {
      setTrabajando(false);
    }
  }

  const vista = final ?? previa;
  const conCambios = vista?.resultados.filter((r) => !r.error) ?? [];
  const conError = vista?.resultados.filter((r) => r.error) ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><PencilLine className="size-5 text-primary" /> Edición masiva de usuarios</DialogTitle>
          <DialogDescription>Solo se cambia lo que modificaste: celda por celda. Los usuarios que no vengan en el archivo quedan igual.</DialogDescription>
        </DialogHeader>
        <Pasos pasos={["Descargar", "Subir", "Revisar cambios", "Aplicado"]} actual={paso} />

        <div className="space-y-5">
          {!final ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col justify-between gap-3 rounded-xl border bg-muted/30 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">1. Descarga los usuarios</p>
                  <p className="text-xs text-muted-foreground">Un Excel con todos los usuarios. Edita lo que necesites; puedes borrar las filas que no vas a cambiar. La contraseña solo se cambia si escribes una en «contrasena_nueva».</p>
                </div>
                <Button variant="outline" onClick={descargar} disabled={descargando}>
                  {descargando ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Descargar todos los usuarios
                </Button>
              </div>
              <ZonaArchivo archivo={archivo} alElegir={(f) => void leer(f)} texto="2. Sube el archivo editado" />
            </div>
          ) : null}

          {trabajando && !previa ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Comparando con la plataforma…</p> : null}
          <ListaErrores titulo="Filas no válidas:" errores={errores} />

          {vista ? (
            <div className="space-y-3">
              <Resumen ok={conCambios.length} error={conError.length} extra={`${vista.sinCambios} sin cambios (no se tocan)`} />
              {conCambios.length ? (
                <div className="max-h-80 overflow-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted text-left"><tr><th className="p-2">Usuario</th><th className="p-2">Campo</th><th className="p-2">Antes</th><th className="p-2">Después</th></tr></thead>
                    <tbody>
                      {conCambios.flatMap((r) => r.cambios.map((c, i) => (
                        <tr key={`${r.id}-${c.campo}`} className={cn(i === 0 && "border-t")}>
                          <td className="p-2 align-top">{i === 0 ? <><b>{r.nombre}</b><span className="block text-muted-foreground">{r.correo}</span></> : null}</td>
                          <td className="p-2">{c.campo}</td>
                          <td className="p-2 text-muted-foreground line-through">{c.antes || "—"}</td>
                          <td className="p-2 font-medium text-success">{c.despues || "—"}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-sm text-muted-foreground">No hay cambios para aplicar.</p>}
              <ListaErrores
                titulo={final ? "No se aplicaron:" : "No se aplicarán (revisa y vuelve a subir):"}
                errores={conError.map((r) => `${r.fila ? `Fila ${r.fila} · ` : ""}${r.correo || r.id}: ${r.error}`)}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{final ? "Cerrar" : "Cancelar"}</Button>
          {previa && !final ? (
            <Button disabled={trabajando || !conCambios.length} onClick={aplicar}>
              {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Aplicar cambios a {conCambios.length} usuarios
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
