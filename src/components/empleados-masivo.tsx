import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { Check, Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Ref = { id: string; name: string; code?: string | null };
type Campos = {
  full_name: string;
  position: string | null;
  email: string | null;
  employer_id: string | null;
  campaign_id: string | null;
  cost_center_id: string | null;
  shift_id: string | null;
  hire_date: string | null;
  termination_date: string | null;
  status: "activo" | "inactivo";
  biometric_group: string | null;
};
type Actual = Campos & { document: string };
type Cambio = { campo: string; antes: string; despues: string };
type Plan = {
  nuevos: (Partial<Campos> & { document: string; full_name: string })[];
  cambios: { document: string; full_name: string; valores: Partial<Campos>; detalle: Cambio[] }[];
  sinCambios: number;
};

/** Columna del Excel → campo del empleado (el documento es la llave y no se edita). */
const COLUMNAS: { col: string; campo: keyof Campos; titulo: string }[] = [
  { col: "nombre", campo: "full_name", titulo: "Nombre" },
  { col: "empleador", campo: "employer_id", titulo: "Empleador" },
  { col: "estado", campo: "status", titulo: "Estado" },
  { col: "cargo", campo: "position", titulo: "Cargo" },
  { col: "correo", campo: "email", titulo: "Correo" },
  { col: "campana", campo: "campaign_id", titulo: "Campaña" },
  { col: "centro_costo", campo: "cost_center_id", titulo: "Centro de costo" },
  { col: "turno", campo: "shift_id", titulo: "Turno" },
  { col: "fecha_ingreso", campo: "hire_date", titulo: "Fecha de ingreso" },
  { col: "fecha_retiro", campo: "termination_date", titulo: "Fecha de retiro" },
  { col: "grupo_biometrico", campo: "biometric_group", titulo: "Grupo biométrico" },
];
const COLS = ["documento", ...COLUMNAS.map((c) => c.col)];

const norm = (v: unknown) =>
  String(v ?? "").replace(/\u00a0/g, " ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const claveColumna = (k: string) => norm(k).replace(/\s+/g, "_").replace("campaña", "campana");

function fecha(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return undefined; // no se entiende: se reporta y no se toca
}

async function todos<T>(tabla: "employees", select: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 50; i++) {
    const { data, error } = await supabase.from(tabla).select(select).order("full_name").range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const SELECT = "document, full_name, position, email, employer_id, campaign_id, cost_center_id, shift_id, hire_date, termination_date, status, biometric_group";

export function EmpleadosMasivo() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [errores, setErrores] = useState<string[]>([]);
  const [resultado, setResultado] = useState<string | null>(null);

  async function refs() {
    const [c, cc, t, em] = await Promise.all([
      supabase.from("campaigns").select("id, name, code"),
      supabase.from("cost_centers").select("id, name, code"),
      supabase.from("shifts").select("id, name, code"),
      dbAny.from("employers").select("id, name, code:nit"),
    ]);
    return {
      campanas: (c.data ?? []) as Ref[],
      centros: (cc.data ?? []) as Ref[],
      turnos: (t.data ?? []) as Ref[],
      empleadores: (em.data ?? []) as Ref[],
    };
  }

  async function descargar() {
    setTrabajando(true);
    try {
      const { campanas, centros, turnos, empleadores } = await refs();
      const nombre = (lista: Ref[], id: string | null) => lista.find((x) => x.id === id)?.name ?? "";
      const puedeExportar = acceso.can("empleados", "exportar");
      const emps = !puedeExportar ? [] : await todos<Actual>("employees", SELECT);
      const datos = emps.map((e) => ({
        documento: e.document,
        nombre: e.full_name,
        empleador: nombre(empleadores, e.employer_id),
        estado: e.status ?? "activo",
        cargo: e.position ?? "",
        correo: e.email ?? "",
        campana: nombre(campanas, e.campaign_id),
        centro_costo: nombre(centros, e.cost_center_id),
        turno: nombre(turnos, e.shift_id),
        fecha_ingreso: e.hire_date ?? "",
        fecha_retiro: e.termination_date ?? "",
        grupo_biometrico: e.biometric_group ?? "",
      }));
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(datos.length ? datos : [Object.fromEntries(COLS.map((c) => [c, ""]))], { header: COLS });
      ws["!cols"] = [14, 34, 34, 10, 28, 28, 22, 22, 16, 14, 14, 22].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, "Empleados");
      const grupos = [...new Set(emps.map((e) => e.biometric_group).filter(Boolean))].sort() as string[];
      const max = Math.max(campanas.length, centros.length, turnos.length, empleadores.length, grupos.length, 2);
      const listas = Array.from({ length: max }, (_, i) => ({
        empleadores: empleadores[i]?.name ?? "",
        campanas: campanas[i]?.name ?? "",
        centros_costo: centros[i]?.name ?? "",
        turnos: turnos[i]?.name ?? "",
        estados: ["activo", "inactivo"][i] ?? "",
        grupos_biometricos: grupos[i] ?? "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(listas), "Valores válidos");
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ["Instrucciones"],
          ["1. Edita la hoja «Empleados». El documento identifica a cada persona: si existe se actualiza, si no existe se crea."],
          ["2. Solo se guarda lo que cambies: las personas y los datos que dejes igual no se tocan. Puedes borrar las filas que no vas a cambiar."],
          ["3. Si quitas una columna completa, ese dato no se modifica. Una celda vacía en una columna presente borra ese dato."],
          ["4. Usa en empleador, campaña, centro de costo y turno los nombres de la hoja «Valores válidos». Si un nombre no existe, ese dato no se cambia."],
          ["   El empleador define si la persona cuenta en el panel y los reportes (ej. seguridad o aseo no cuentan)."],
          ["5. Fechas en formato AAAA-MM-DD o DD/MM/AAAA. Estado: activo o inactivo."],
          ["6. Fecha de retiro: el ausentismo de la persona se cuenta solo hasta esa fecha."],
          [""],
        ]),
        "Instrucciones",
      );
      XLSX.writeFile(wb, `empleados_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.info("Plantilla descargada", { description: "Contiene información de Convertia: no la compartas con personas ajenas a la organización." });
    } catch (e) {
      toast.error("No se pudo generar la plantilla", { description: (e as Error).message });
    } finally {
      setTrabajando(false);
    }
  }

  async function leer(file: File) {
    setTrabajando(true);
    setResultado(null);
    setPlan(null);
    try {
      const [{ campanas, centros, turnos, empleadores }, actuales] = await Promise.all([refs(), todos<Actual>("employees", SELECT)]);
      const porDoc = new Map(actuales.map((e) => [e.document, e]));
      const listas: Partial<Record<keyof Campos, Ref[]>> = { employer_id: empleadores, campaign_id: campanas, cost_center_id: centros, shift_id: turnos };
      const nombreRef = (campo: keyof Campos, id: unknown) => listas[campo]?.find((x) => x.id === id)?.name ?? "";
      // Exacto por nombre o código; si no, solo una coincidencia parcial única
      const buscar = (lista: Ref[], v: string) => {
        const n = norm(v);
        const exacto = lista.find((x) => norm(x.name) === n || norm(x.code) === n);
        if (exacto) return exacto.id;
        const parciales = lista.filter((x) => norm(x.name).includes(n));
        return parciales.length === 1 ? parciales[0]!.id : undefined;
      };

      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets["Empleados"] ?? wb.Sheets[wb.SheetNames[0]!]!;
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
      const [enc = [], ...resto] = aoa;
      const columnas = enc.map((c) => claveColumna(String(c)));
      if (!columnas.includes("documento")) throw new Error("El archivo no tiene la columna «documento».");
      const presentes = COLUMNAS.filter((c) => columnas.includes(c.col));

      const errs: string[] = [];
      const vistos = new Set<string>();
      const p: Plan = { nuevos: [], cambios: [], sinCambios: 0 };
      resto.forEach((valores, i) => {
        const r = Object.fromEntries(columnas.map((c, j) => [c, valores[j]]));
        const fila = i + 2;
        const doc = String(r["documento"] ?? "").replace(/[.\s]/g, "");
        if (!doc) return;
        if (!/^[0-9A-Za-z-]{1,20}$/.test(doc)) return void errs.push(`Fila ${fila}: documento «${doc}» no válido.`);
        if (vistos.has(doc)) return void errs.push(`Fila ${fila}: documento ${doc} repetido.`);
        vistos.add(doc);

        // Valor del archivo por campo presente (undefined = no se entiende: se reporta y no se toca)
        const leidos: Partial<Campos> = {};
        for (const { col, campo, titulo } of presentes) {
          const bruto = r[col];
          const texto = String(bruto ?? "").replace(/\s+/g, " ").trim();
          let valor: unknown;
          if (campo === "full_name") valor = texto;
          else if (campo === "status") valor = !texto ? undefined : norm(texto) === "inactivo" ? "inactivo" : norm(texto) === "activo" ? "activo" : undefined;
          else if (campo === "email") valor = texto.toLowerCase() || null;
          else if (campo === "hire_date" || campo === "termination_date") valor = fecha(bruto);
          else if (listas[campo]) valor = texto ? buscar(listas[campo]!, texto) : null;
          else valor = texto || null;
          if (valor === undefined) {
            if (texto) errs.push(`Fila ${fila} (${doc}): ${titulo} «${texto}» no se reconoce; ese dato no se cambia.`);
            continue;
          }
          (leidos as Record<string, unknown>)[campo] = valor;
        }

        const actual = porDoc.get(doc);
        if (!actual) {
          if (!leidos.full_name) return void errs.push(`Fila ${fila}: el documento ${doc} es nuevo y le falta el nombre.`);
          p.nuevos.push({ ...leidos, document: doc, full_name: leidos.full_name });
          return;
        }
        if (leidos.full_name === "") delete leidos.full_name; // el nombre nunca queda vacío
        const valoresCambio: Partial<Campos> = {};
        const detalle: Cambio[] = [];
        for (const { campo, titulo } of presentes) {
          if (!(campo in leidos)) continue;
          const nuevo = (leidos as Record<string, unknown>)[campo] ?? null;
          const antes = (actual as Record<string, unknown>)[campo] ?? null;
          // espacios de más en el nombre no son un cambio
          const igual = campo === "full_name" ? String(nuevo).replace(/\s+/g, " ").trim() === String(antes ?? "").replace(/\s+/g, " ").trim() : nuevo === antes;
          if (igual) continue;
          (valoresCambio as Record<string, unknown>)[campo] = nuevo;
          const ver = (v: unknown) => (listas[campo] ? nombreRef(campo, v) : String(v ?? "")) || "—";
          detalle.push({ campo: titulo, antes: ver(antes), despues: ver(nuevo) });
        }
        if (detalle.length) p.cambios.push({ document: doc, full_name: actual.full_name, valores: valoresCambio, detalle });
        else p.sinCambios++;
      });
      setPlan(p);
      setErrores(errs);
      if (!p.nuevos.length && !p.cambios.length) toast.info("No hay cambios para guardar.", { description: `${p.sinCambios} empleados sin cambios.` });
    } catch (e) {
      toast.error("No se pudo leer el archivo", { description: (e as Error).message });
    } finally {
      setTrabajando(false);
    }
  }

  async function guardar() {
    if (!acceso.tenantId || !plan) {
      toast.error("Tu usuario no tiene empresa asignada.");
      return;
    }
    setTrabajando(true);
    let ok = 0;
    try {
      const tenant_id = acceso.tenantId;
      // Nuevos: se crean con los datos del archivo
      for (let i = 0; i < plan.nuevos.length; i += 500) {
        const lote = plan.nuevos.slice(i, i + 500).map((f) => ({ ...f, tenant_id }));
        const { error } = await supabase.from("employees").insert(lote as never);
        if (error) throw error;
        ok += lote.length;
      }
      // Existentes: solo los campos que cambiaron (agrupados por el mismo conjunto de campos)
      const grupos = new Map<string, typeof plan.cambios>();
      for (const c of plan.cambios) {
        const k = Object.keys(c.valores).sort().join(",");
        grupos.set(k, [...(grupos.get(k) ?? []), c]);
      }
      for (const lista of grupos.values()) {
        for (let i = 0; i < lista.length; i += 500) {
          const lote = lista.slice(i, i + 500).map((c) => ({ full_name: c.full_name, ...c.valores, document: c.document, tenant_id }));
          const { error } = await supabase.from("employees").upsert(lote as never, { onConflict: "tenant_id,document" });
          if (error) throw error;
          ok += lote.length;
        }
      }
      setResultado(`${plan.nuevos.length} empleados creados y ${plan.cambios.length} actualizados. ${plan.sinCambios} sin cambios (no se tocaron).`);
      toast.success(`${ok} empleados guardados`);
      setPlan(null);
      void qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (e) {
      toast.error("Error al guardar", { description: `${ok} guardados antes del error. ${(e as Error).message}` });
    } finally {
      setTrabajando(false);
    }
  }

  if (!acceso.can("empleados", "editar")) return null;
  const detalle = plan?.cambios.flatMap((c) => c.detalle.map((d) => ({ ...d, doc: c.document, nombre: c.full_name }))) ?? [];

  return (
    <>
      <Button variant="outline" onClick={() => { setAbierto(true); setPlan(null); setErrores([]); setResultado(null); }}>
        <FileSpreadsheet className="size-4" /> Edición masiva
      </Button>
      <Dialog open={abierto} onOpenChange={(v) => !trabajando && setAbierto(v)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="size-5 text-primary" /> Edición masiva de empleados</DialogTitle>
            <DialogDescription>
              Descarga todos tus empleados, edita en Excel lo que necesites y súbelo. Solo se guarda lo que cambió; los nuevos documentos se crean.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2 rounded-xl border bg-muted/30 p-4">
                <p className="font-medium">1. Descargar</p>
                <p className="text-xs text-muted-foreground">Incluye: documento, {COLUMNAS.map((c) => c.titulo.toLowerCase()).join(", ")}.</p>
                <Button variant="secondary" onClick={descargar} disabled={trabajando}>
                  {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} {acceso.can("empleados", "exportar") ? "Descargar empleados" : "Descargar plantilla vacía"}
                </Button>
              </div>
              <div className="space-y-2 rounded-xl border bg-muted/30 p-4">
                <p className="font-medium">2. Subir el archivo editado</p>
                <p className="text-xs text-muted-foreground">Verás los cambios antes de guardarlos.</p>
                <Input type="file" accept=".xlsx,.xls,.csv" disabled={trabajando} onChange={(e) => { const f = e.target.files?.[0]; if (f) void leer(f); e.target.value = ""; }} />
              </div>
            </div>

            {plan ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-primary/40">{plan.nuevos.length} nuevos</Badge>
                  <Badge variant="outline" className="border-primary/40">{plan.cambios.length} con cambios</Badge>
                  <Badge variant="outline">{plan.sinCambios} sin cambios (no se tocan)</Badge>
                </div>
                {detalle.length ? (
                  <div className="max-h-72 overflow-auto rounded-lg border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted text-left"><tr><th className="p-2">Empleado</th><th className="p-2">Campo</th><th className="p-2">Antes</th><th className="p-2">Después</th></tr></thead>
                      <tbody>
                        {detalle.slice(0, 300).map((d) => (
                          <tr key={`${d.doc}-${d.campo}`} className="border-t">
                            <td className="p-2"><b>{d.nombre}</b><span className="block text-muted-foreground">{d.doc}</span></td>
                            <td className="p-2">{d.campo}</td>
                            <td className="p-2 text-muted-foreground line-through">{d.antes}</td>
                            <td className="p-2 font-medium text-success">{d.despues}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {detalle.length > 300 ? <p className="p-2 text-center text-muted-foreground">… y {detalle.length - 300} cambios más.</p> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {errores.length ? (
              <div className="max-h-40 overflow-auto rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                <p className="mb-1 font-medium">{errores.length} observaciones (esas filas o datos no se aplicarán):</p>
                {errores.slice(0, 100).map((e) => <p key={e}>{e}</p>)}
              </div>
            ) : null}
            {resultado ? <p className="flex items-center gap-2 rounded-md bg-primary/10 p-3"><Check className="size-4 text-primary" />{resultado}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbierto(false)} disabled={trabajando}>Cerrar</Button>
            <Button onClick={guardar} disabled={trabajando || !plan || (!plan.nuevos.length && !plan.cambios.length)}>
              {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              Guardar {plan ? plan.nuevos.length + plan.cambios.length : ""} cambios
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
