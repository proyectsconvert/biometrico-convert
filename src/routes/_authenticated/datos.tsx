import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, EyeOff, Eye, Trash2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { depurarDatos } from "@/lib/datos.functions";
import { PageHeader } from "@/components/app-shell";
import { Paginador, SimpleTable, ordenarFilas, usePaginado, type Orden } from "@/components/simple-table";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/datos")({
  head: () => ({ meta: [{ title: "Calidad y depuración de datos — Convert-IA" }] }),
  component: Datos,
});

type Dia = {
  dia: string; eventos: number; validas: number; duplicadas: number; sin_documento: number;
  no_validas: number; archivos: number; personas: number; completas: number; incompletas: number;
};
type Archivo = { id: string; filename: string; status: string; rows_found: number; aportadas: number; desde: string; hasta: string };
type Calidad = {
  resumen: { eventos: number; validas: number; duplicadas: number; sin_documento: number; sin_empleado: number; archivos: number; personas: number };
  empleados_sin_nombre: number;
  dispositivos_sin_confirmar: number;
  dias: Dia[];
  archivos: Archivo[];
};
type Modo = "eliminar" | "ocultar" | "mostrar";
const ALCANCES = [
  { v: "marcaciones", l: "Marcaciones del biométrico" },
  { v: "asistencia", l: "Control diario de asistencia" },
  { v: "novedades", l: "Novedades por día" },
] as const;

const hoy = () => new Date().toISOString().slice(0, 10);
const haceDias = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const n = (x: number) => (x ?? 0).toLocaleString("es-CO");

function Datos() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const depurar = useServerFn(depurarDatos);
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoy());
  const [dDesde, setDDesde] = useState(haceDias(90));
  const [dHasta, setDHasta] = useState(haceDias(60));
  const [alcance, setAlcance] = useState<string[]>(["marcaciones", "asistencia", "novedades"]);
  const [motivo, setMotivo] = useState("");
  const [confirmar, setConfirmar] = useState<Modo | null>(null);
  const [texto, setTexto] = useState("");
  const [corriendo, setCorriendo] = useState(false);
  const puedeDepurar = acceso.can("datos", "depurar");
  const [anclado, setAnclado] = useState(false);
  const [ordenDias, setOrdenDias] = useState<Orden | null>({ col: "dia", asc: false });
  const ultimo = useQuery({
    queryKey: ["calidad-datos", "ultimo-dia"],
    queryFn: async () => {
      const { data } = await supabase.from("biometric_events").select("event_at").order("event_at", { ascending: false }).limit(1);
      return (data?.[0]?.event_at as string | undefined)?.slice(0, 10) ?? null;
    },
  });
  useEffect(() => {
    if (anclado || !ultimo.isSuccess) return;
    setAnclado(true);
    if (ultimo.data) {
      setHasta(ultimo.data);
      setDesde(new Date(new Date(`${ultimo.data}T12:00:00`).getTime() - 29 * 864e5).toISOString().slice(0, 10));
    }
  }, [anclado, ultimo.isSuccess, ultimo.data]);
  const rango = (dias: number | "mes") => {
    const base = ultimo.data ? new Date(`${ultimo.data}T12:00:00`) : new Date();
    const fin = base.toISOString().slice(0, 10);
    setHasta(fin);
    setDesde(dias === "mes" ? `${fin.slice(0, 8)}01` : new Date(base.getTime() - (dias - 1) * 864e5).toISOString().slice(0, 10));
  };

  const calidad = useQuery({
    queryKey: ["calidad-datos", desde, hasta],
    enabled: anclado,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("calidad_datos", { _desde: desde, _hasta: hasta });
      if (error) throw error;
      return data as unknown as Calidad;
    },
  });

  const historial = useQuery({
    queryKey: ["depuraciones"],
    enabled: puedeDepurar,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("data_cleanups")
        .select("id, desde, hasta, modo, alcance, filas, motivo, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  async function ejecutar() {
    if (!confirmar) return;
    setCorriendo(true);
    try {
      const r = await depurar({
        data: { desde: dDesde, hasta: dHasta, modo: confirmar, alcance: alcance as ("marcaciones" | "asistencia" | "novedades")[], motivo },
      });
      toast.success(`${n(r.filas)} registros afectados`);
      setConfirmar(null);
      setTexto("");
      setMotivo("");
      qc.invalidateQueries();
    } catch (e) {
      toast.error("No se pudo completar", { description: (e as Error).message });
    } finally {
      setCorriendo(false);
    }
  }

  const c = calidad.data;
  const r = c?.resumen;
  const pct = r && r.eventos ? Math.round((r.validas / r.eventos) * 100) : 0;
  const alertas: string[] = [];
  if (r?.sin_documento) alertas.push(`${n(r.sin_documento)} registros sin documento (no se cuentan como marcación).`);
  if (r?.sin_empleado) alertas.push(`${n(r.sin_empleado)} registros con documento sin empleado enlazado.`);
  if (c?.empleados_sin_nombre) alertas.push(`${n(c.empleados_sin_nombre)} empleados creados desde el biométrico sin nombre real.`);
  if (c?.dispositivos_sin_confirmar) alertas.push(`${n(c.dispositivos_sin_confirmar)} lectores nuevos sin revisar en Dispositivos (su clasificación es informativa; no cambia la entrada/salida).`);
  const diasSinDatos = (() => {
    if (!c) return 0;
    const set = new Set(c.dias.map((d) => d.dia));
    let k = 0;
    for (let t = new Date(desde).getTime(); t <= new Date(hasta).getTime(); t += 864e5) {
      if (!set.has(new Date(t).toISOString().slice(0, 10))) k++;
    }
    return k;
  })();
  const diasOrdenados = useMemo(() => ordenarFilas(c?.dias ?? [], ordenDias), [c, ordenDias]);
  const pagDias = usePaginado(diasOrdenados, 10);
  const pagArch = usePaginado(c?.archivos ?? [], 10);
  // Franja de cobertura: todos los días del rango, con o sin datos
  const franja = useMemo(() => {
    if (!c) return [] as { dia: string; personas: number }[];
    const m = new Map(c.dias.map((d) => [d.dia, d.personas]));
    const out: { dia: string; personas: number }[] = [];
    for (let t = new Date(`${desde}T12:00:00`).getTime(); t <= new Date(`${hasta}T12:00:00`).getTime() && out.length < 400; t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10);
      out.push({ dia: d, personas: m.get(d) ?? 0 });
    }
    return out;
  }, [c, desde, hasta]);
  const maxPersonas = Math.max(1, ...franja.map((d) => d.personas));
  if (diasSinDatos) alertas.push(`${diasSinDatos} días del rango no tienen ninguna marcación cargada.`);

  return (
    <div>
      <PageHeader
        titulo="Calidad y depuración de datos"
        descripcion="Comprueba que la información cargada esté completa y limpia, y borra u oculta periodos para agilizar la plataforma."
      />
      <Tabs defaultValue="calidad">
        <TabsList>
          <TabsTrigger value="calidad">Verificación</TabsTrigger>
          {puedeDepurar ? <TabsTrigger value="depurar">Borrar u ocultar</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="calidad" className="space-y-4">
          <Card className="flex flex-wrap items-end gap-3 p-4">
            <div className="space-y-1"><Label>Desde</Label><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></div>
            <div className="space-y-1"><Label>Hasta</Label><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></div>
            <div className="flex gap-1 pb-0.5">
              <Button variant="ghost" size="sm" onClick={() => rango(7)}>7 días</Button>
              <Button variant="ghost" size="sm" onClick={() => rango(30)}>30 días</Button>
              <Button variant="ghost" size="sm" onClick={() => rango("mes")}>Mes del último dato</Button>
            </div>
            {calidad.isFetching ? <Loader2 className="mb-2 size-4 animate-spin text-muted-foreground" /> : null}
            {ultimo.data ? <p className="ml-auto pb-2 text-xs text-muted-foreground">Último dato cargado: {ultimo.data}</p> : null}
          </Card>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Kpi t="Registros leídos" v={n(r?.eventos ?? 0)} />
            <Kpi t="Marcaciones válidas" v={`${n(r?.validas ?? 0)} (${pct}%)`} nota="Solo autenticaciones exitosas con huella o tarjeta; puertas y eventos de BioStar no cuentan" />
            <Kpi t="Duplicadas descartadas" v={n(r?.duplicadas ?? 0)} />
            <Kpi t="Personas con marcación" v={n(r?.personas ?? 0)} />
            <Kpi t="Archivos que aportan" v={n(r?.archivos ?? 0)} />
          </div>

          <Card className="p-4">
            {alertas.length ? (
              <ul className="space-y-1.5 text-sm">
                {alertas.map((a) => (
                  <li key={a} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />{a}</li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-success" /> Sin problemas detectados en este rango.</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Cuando varios CSV cubren las mismas fechas, cada marcación se guarda una sola vez: lo que trae un archivo nuevo se suma a lo que ya existía y lo repetido se descarta. La columna "Archivos" muestra cuántos CSV aportaron a cada día.
            </p>
          </Card>

          {franja.length ? (
            <Card className="p-4">
              <p className="mb-2 text-sm font-medium">Cobertura del rango <span className="font-normal text-muted-foreground">· personas con marcación por día (rojo = día sin datos)</span></p>
              <div className="flex h-16 items-end gap-0.5">
                {franja.map((d) => (
                  <div
                    key={d.dia}
                    title={`${d.dia}: ${d.personas} personas`}
                    className={d.personas ? "flex-1 rounded-t bg-primary/70 hover:bg-primary" : "flex-1 rounded-t bg-destructive/60"}
                    style={{ height: d.personas ? `${Math.max(8, (d.personas / maxPersonas) * 100)}%` : "100%", opacity: d.personas ? 1 : 0.35 }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>{desde}</span><span>{hasta}</span></div>
            </Card>
          ) : null}

          <h3 className="font-display text-sm font-semibold">Cobertura por día</h3>
          <SimpleTable<Dia>
            cargando={calidad.isLoading}
            filas={pagDias.visibles}
            orden={ordenDias}
            onOrden={setOrdenDias}
            getKey={(d) => d.dia}
            vacio="No hay marcaciones en este rango."
            columnas={[
              { key: "dia", orden: "dia", header: "Día", cell: (d) => new Date(d.dia + "T12:00").toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) },
              { key: "ev", orden: "eventos", header: "Registros", cell: (d) => n(d.eventos) },
              { key: "val", orden: "validas", header: "Válidas", cell: (d) => n(d.validas) },
              { key: "dup", orden: "duplicadas", header: "Duplicadas", cell: (d) => n(d.duplicadas) },
              { key: "nv", header: "No válidas", cell: (d) => n(d.no_validas + d.sin_documento) },
              { key: "per", orden: "personas", header: "Personas", cell: (d) => n(d.personas) },
              { key: "arc", orden: "archivos", header: "Archivos", cell: (d) => <Badge variant={d.archivos > 1 ? "default" : "outline"}>{d.archivos}</Badge> },
              { key: "com", orden: "completas", header: "Jornadas completas", cell: (d) => n(d.completas) },
              { key: "inc", orden: "incompletas", header: "Incompletas", cell: (d) => (d.incompletas ? <span className="text-destructive">{n(d.incompletas)}</span> : "0") },
            ]}
          />

          <Paginador {...pagDias.paginador} />

          <h3 className="font-display text-sm font-semibold">Aporte de cada archivo en el rango</h3>
          <SimpleTable<Archivo>
            cargando={calidad.isLoading}
            filas={pagArch.visibles}
            getKey={(a) => a.id}
            vacio="Ningún archivo aporta datos a este rango."
            columnas={[
              { key: "f", header: "Archivo", cell: (a) => <span className="font-medium">{a.filename}</span> },
              { key: "r", header: "Fechas", cell: (a) => `${a.desde} → ${a.hasta}` },
              { key: "l", header: "Filas del CSV", cell: (a) => n(a.rows_found) },
              { key: "a", header: "Registros nuevos aportados", cell: (a) => n(a.aportadas) },
              { key: "s", header: "Estado", cell: (a) => <Badge variant="outline">{a.status.replace("_", " ")}</Badge> },
            ]}
          />
          <Paginador {...pagArch.paginador} />
        </TabsContent>

        {puedeDepurar ? (
          <TabsContent value="depurar" className="space-y-4">
            <Card className="space-y-4 p-4">
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1"><Label>Desde</Label><Input type="date" value={dDesde} onChange={(e) => setDDesde(e.target.value)} /></div>
                <div className="space-y-1"><Label>Hasta</Label><Input type="date" value={dHasta} onChange={(e) => setDHasta(e.target.value)} /></div>
              </div>
              <div className="space-y-2">
                <Label>Qué información</Label>
                {ALCANCES.map((a) => (
                  <label key={a.v} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={alcance.includes(a.v)}
                      onCheckedChange={(v) => setAlcance((p) => (v ? [...p, a.v] : p.filter((x) => x !== a.v)))}
                    />
                    {a.l}
                  </label>
                ))}
              </div>
              <div className="space-y-1">
                <Label>Motivo (queda en auditoría)</Label>
                <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: periodo ya liquidado" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!alcance.length || motivo.trim().length < 3} onClick={() => setConfirmar("ocultar")}>
                  <EyeOff className="size-4" /> Ocultar periodo
                </Button>
                <Button variant="outline" disabled={!alcance.length || motivo.trim().length < 3} onClick={() => setConfirmar("mostrar")}>
                  <Eye className="size-4" /> Volver a mostrar
                </Button>
                <Button variant="destructive" disabled={!alcance.length || motivo.trim().length < 3} onClick={() => setConfirmar("eliminar")}>
                  <Trash2 className="size-4" /> Borrar definitivamente
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Ocultar deja de mostrar el periodo en toda la plataforma (panel, asistencia, resultados, novedades) sin perderlo; se puede volver a mostrar. Borrar no se puede deshacer; los archivos originales siguen en el historial de importaciones.
              </p>
            </Card>

            <h3 className="font-display text-sm font-semibold">Historial</h3>
            <SimpleTable
              cargando={historial.isLoading}
              filas={historial.data ?? []}
              getKey={(h) => h.id}
              vacio="Aún no se ha depurado información."
              columnas={[
                { key: "c", header: "Fecha", cell: (h) => new Date(h.created_at).toLocaleString("es-CO") },
                { key: "m", header: "Acción", cell: (h) => <Badge variant={h.modo === "eliminar" ? "destructive" : "outline"}>{h.modo}</Badge> },
                { key: "r", header: "Periodo", cell: (h) => `${h.desde} → ${h.hasta}` },
                { key: "a", header: "Información", cell: (h) => h.alcance.join(", ") },
                { key: "f", header: "Registros", cell: (h) => n(h.filas) },
                { key: "mo", header: "Motivo", cell: (h) => h.motivo ?? "" },
              ]}
            />
          </TabsContent>
        ) : null}
      </Tabs>

      <Dialog open={Boolean(confirmar)} onOpenChange={(v) => !v && !corriendo && setConfirmar(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmar === "eliminar" ? "Borrar definitivamente" : confirmar === "ocultar" ? "Ocultar periodo" : "Volver a mostrar"}
            </DialogTitle>
            <DialogDescription>
              Del {dDesde} al {dHasta}: {alcance.join(", ")}.
            </DialogDescription>
          </DialogHeader>
          {confirmar === "eliminar" ? (
            <div className="space-y-1">
              <Label>Escribe BORRAR para confirmar</Label>
              <Input value={texto} onChange={(e) => setTexto(e.target.value)} />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={corriendo} onClick={() => setConfirmar(null)}>Cancelar</Button>
            <Button
              variant={confirmar === "eliminar" ? "destructive" : "default"}
              disabled={corriendo || (confirmar === "eliminar" && texto !== "BORRAR")}
              onClick={ejecutar}
            >
              {corriendo ? <Loader2 className="size-4 animate-spin" /> : null} Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Kpi({ t, v, nota }: { t: string; v: string; nota?: string }) {
  return (
    <Card className="p-4" title={nota}>
      <p className="text-xs text-muted-foreground">{t}</p>
      <p className="mt-1 font-display text-xl font-semibold">{v}</p>
      {nota ? <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{nota}</p> : null}
    </Card>
  );
}
