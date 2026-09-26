import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Ref = { id: string; name: string; code?: string | null };
type Fila = {
  document: string;
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
};

const COLS = ["documento", "nombre", "empleador", "cargo", "correo", "campana", "centro_costo", "turno", "fecha_ingreso", "fecha_retiro", "estado"] as const;

const norm = (v: unknown) =>
  String(v ?? "").replace(/\u00a0/g, " ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

function fecha(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
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

export function EmpleadosMasivo() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [filas, setFilas] = useState<Fila[]>([]);
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
      const emps = !puedeExportar ? [] : await todos<{ document: string; full_name: string; position: string | null; email: string | null; employer_id: string | null; campaign_id: string | null; cost_center_id: string | null; shift_id: string | null; hire_date: string | null; termination_date: string | null; status: string | null }>(
        "employees",
        "document, full_name, position, email, employer_id, campaign_id, cost_center_id, shift_id, hire_date, termination_date, status",
      );
      const datos = emps.map((e) => ({
        documento: e.document,
        nombre: e.full_name,
        empleador: nombre(empleadores, e.employer_id ?? null),
        cargo: e.position ?? "",
        correo: e.email ?? "",
        campana: nombre(campanas, e.campaign_id ?? null),
        centro_costo: nombre(centros, e.cost_center_id ?? null),
        turno: nombre(turnos, e.shift_id ?? null),
        fecha_ingreso: e.hire_date ?? "",
        fecha_retiro: e.termination_date ?? "",
        estado: e.status ?? "activo",
      }));
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(datos.length ? datos : [Object.fromEntries(COLS.map((c) => [c, ""]))], { header: [...COLS] });
      ws["!cols"] = [14, 34, 34, 28, 28, 18, 18, 14, 13, 13, 10].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, "Empleados");
      const max = Math.max(campanas.length, centros.length, turnos.length, empleadores.length, 2);
      const listas = Array.from({ length: max }, (_, i) => ({
        empleadores: empleadores[i]?.name ?? "",
        campanas: campanas[i]?.name ?? "",
        centros_costo: centros[i]?.name ?? "",
        turnos: turnos[i]?.name ?? "",
        estados: ["activo", "inactivo"][i] ?? "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(listas), "Valores válidos");
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ["Instrucciones"],
          ["1. Edita la hoja «Empleados». El documento identifica a cada persona: si existe se actualiza, si no existe se crea."],
          ["2. Usa en empleador, campaña, centro de costo y turno los nombres de la hoja «Valores válidos»."],
          ["   El empleador define si la persona cuenta en el panel y los reportes (ej. seguridad o aseo no cuentan)."],
          ["3. Fechas en formato AAAA-MM-DD o DD/MM/AAAA. Estado: activo o inactivo."],
          ["4. Una celda vacía borra ese dato. No cambies los títulos de las columnas."],
        ]),
        "Instrucciones",
      );
      XLSX.writeFile(wb, `empleados_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      toast.error("No se pudo generar la plantilla", { description: (e as Error).message });
    } finally {
      setTrabajando(false);
    }
  }

  async function leer(file: File) {
    setTrabajando(true);
    setResultado(null);
    try {
      const { campanas, centros, turnos, empleadores } = await refs();
      const buscar = (lista: Ref[], v: unknown, etiqueta: string, fila: number, errs: string[]) => {
        const n = norm(v);
        if (!n) return null;
        const r = lista.find((x) => norm(x.name) === n || norm(x.code) === n) ?? lista.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name)));
        if (!r) errs.push(`Fila ${fila}: ${etiqueta} «${String(v)}» no existe.`);
        return r?.id ?? null;
      };
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets["Empleados"] ?? wb.Sheets[wb.SheetNames[0]!]!;
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { raw: true, defval: "" });
      const errs: string[] = [];
      const vistos = new Set<string>();
      const out: Fila[] = [];
      raw.forEach((r0, i) => {
        const r = Object.fromEntries(Object.entries(r0).map(([k, v]) => [norm(k).replace(/\s+/g, "_").replace("campaña", "campana"), v]));
        const fila = i + 2;
        const doc = String(r["documento"] ?? "").replace(/[.\s]/g, "");
        if (!doc) return;
        if (!/^[0-9A-Za-z-]{4,20}$/.test(doc)) return void errs.push(`Fila ${fila}: documento «${doc}» no válido.`);
        if (vistos.has(doc)) return void errs.push(`Fila ${fila}: documento ${doc} repetido.`);
        vistos.add(doc);
        const nombre = String(r["nombre"] ?? "").replace(/\s+/g, " ").trim();
        if (!nombre) return void errs.push(`Fila ${fila}: falta el nombre.`);
        const estado = norm(r["estado"]) === "inactivo" ? "inactivo" : "activo";
        out.push({
          document: doc,
          full_name: nombre,
          position: String(r["cargo"] ?? "").trim() || null,
          email: String(r["correo"] ?? "").trim().toLowerCase() || null,
          employer_id: buscar(empleadores, r["empleador"] ?? r["empresa"], "empleador", fila, errs),
          campaign_id: buscar(campanas, r["campana"], "campaña", fila, errs),
          cost_center_id: buscar(centros, r["centro_costo"], "centro de costo", fila, errs),
          shift_id: buscar(turnos, r["turno"], "turno", fila, errs),
          hire_date: fecha(r["fecha_ingreso"]),
          termination_date: fecha(r["fecha_retiro"]),
          status: estado,
        });
      });
      setFilas(out);
      setErrores(errs);
      if (!out.length) toast.error("No se encontraron empleados en el archivo.");
    } catch (e) {
      toast.error("No se pudo leer el archivo", { description: (e as Error).message });
    } finally {
      setTrabajando(false);
    }
  }

  async function guardar() {
    if (!acceso.tenantId) {
      toast.error("Tu usuario no tiene empresa asignada.");
      return;
    }
    setTrabajando(true);
    let ok = 0;
    try {
      for (let i = 0; i < filas.length; i += 500) {
        const lote = filas.slice(i, i + 500).map((f) => ({ ...f, tenant_id: acceso.tenantId! }));
        const { error } = await supabase.from("employees").upsert(lote, { onConflict: "tenant_id,document" });
        if (error) throw error;
        ok += lote.length;
      }
      setResultado(`${ok} empleados creados o actualizados.`);
      toast.success(`${ok} empleados guardados`);
      setFilas([]);
      void qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (e) {
      toast.error("Error al guardar", { description: `${ok} guardados antes del error. ${(e as Error).message}` });
    } finally {
      setTrabajando(false);
    }
  }

  if (!acceso.can("empleados", "editar")) return null;

  return (
    <>
      <Button variant="outline" onClick={() => { setAbierto(true); setFilas([]); setErrores([]); setResultado(null); }}>
        <FileSpreadsheet className="size-4" /> Edición masiva
      </Button>
      <Dialog open={abierto} onOpenChange={(v) => !trabajando && setAbierto(v)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edición masiva de empleados</DialogTitle>
            <DialogDescription>
              Descarga la plantilla con todos tus empleados, edítala en Excel y súbela. Se actualizan por documento y se crean los nuevos.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <Button variant="secondary" onClick={descargar} disabled={trabajando}>
              {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} {acceso.can("empleados", "exportar") ? "1. Descargar plantilla con empleados" : "1. Descargar plantilla vacía"}
            </Button>
            <div className="space-y-1.5">
              <p className="font-medium">2. Subir plantilla editada</p>
              <Input type="file" accept=".xlsx,.xls,.csv" disabled={trabajando} onChange={(e) => { const f = e.target.files?.[0]; if (f) void leer(f); e.target.value = ""; }} />
            </div>
            {filas.length ? <p className="rounded-md bg-primary/10 p-3">{filas.length} empleados listos para guardar.</p> : null}
            {errores.length ? (
              <div className="max-h-40 overflow-auto rounded-md border border-destructive/40 p-3 text-xs text-destructive">
                <p className="mb-1 font-medium">{errores.length} observaciones (esas filas o datos no se aplicarán):</p>
                {errores.slice(0, 100).map((e) => <p key={e}>{e}</p>)}
              </div>
            ) : null}
            {resultado ? <p className="text-primary">{resultado}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbierto(false)} disabled={trabajando}>Cerrar</Button>
            <Button onClick={guardar} disabled={trabajando || !filas.length}>
              {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Guardar cambios
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
