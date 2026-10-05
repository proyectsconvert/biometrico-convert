import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarPlus, Loader2, Timer, Users, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { alfabetico, useEmpleadosFiltro, type EmpleadoFiltro } from "@/lib/filtro-personas";
import { TIPOS_NOVEDAD, rangoFechas } from "@/lib/novedades";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Selector de personas (una o varias) con atajo para agregar a toda una campaña. */
function SelectorPersonas({ seleccion, onChange }: { seleccion: string[]; onChange: (docs: string[]) => void }) {
  const empleados = useEmpleadosFiltro();
  const lista = empleados.data ?? [];
  const campanas = useMemo(() => [...new Set(lista.map((e) => e.campana).filter(Boolean))].sort((a, b) => alfabetico(a!, b!)) as string[], [lista]);
  const opciones = lista.map((e) => ({ value: e.document, label: e.full_name, sublabel: [e.document, e.campana ?? "Sin campaña", e.position].filter(Boolean).join(" · ") }));
  const porDoc = new Map(lista.map((e) => [e.document, e]));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <MultiSelectFilter
          title="Personas" placeholder={empleados.isLoading ? "Cargando personas…" : "Elegir personas"} searchPlaceholder="Buscar por cédula o nombre…"
          options={opciones} selected={seleccion} onChange={onChange} triggerClassName="w-64" popoverWidth="w-[360px]"
        />
        {campanas.length > 1 ? (
          <Select value="" onValueChange={(c) => onChange([...new Set([...seleccion, ...lista.filter((e) => e.campana === c).map((e) => e.document)])])}>
            <SelectTrigger className="w-60"><Users className="mr-1 size-4" /><SelectValue placeholder="Agregar toda una campaña" /></SelectTrigger>
            <SelectContent>{campanas.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
      </div>
      {seleccion.length ? (
        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-auto">
          {seleccion.map((d) => (
            <Badge key={d} variant="secondary" className="gap-1">
              {porDoc.get(d)?.full_name ?? d}
              <button type="button" onClick={() => onChange(seleccion.filter((x) => x !== d))} aria-label="Quitar"><X className="size-3" /></button>
            </Badge>
          ))}
          {seleccion.length > 1 ? <button type="button" className="text-xs text-muted-foreground underline" onClick={() => onChange([])}>Quitar todas</button> : null}
        </div>
      ) : <p className="text-xs text-muted-foreground">Elige una o varias personas; con «Agregar toda una campaña» sumas a todo su personal.</p>}
    </div>
  );
}

/** Registrar días (asistencia, descanso, faltas, incapacidades…) a varias personas a la vez, sin Excel. */
export function RegistrarDias({ abierta, onClose, onListo, tenantId, desde0, hasta0 }: {
  abierta: boolean; onClose: () => void; onListo: () => void; tenantId: string | null; desde0: string; hasta0: string;
}) {
  const empleados = useEmpleadosFiltro();
  const [docs, setDocs] = useState<string[]>([]);
  const [tipo, setTipo] = useState<string>("Asiste");
  const [desde, setDesde] = useState(desde0);
  const [hasta, setHasta] = useState(hasta0);
  const [notas, setNotas] = useState("");
  const [guardando, setGuardando] = useState(false);
  useEffect(() => { if (abierta) { setDesde(desde0); setHasta(hasta0); } }, [abierta, desde0, hasta0]);
  const dias = desde && hasta && hasta >= desde ? rangoFechas(desde, hasta) : [];

  async function guardar() {
    if (!tenantId) { toast.error("Tu usuario no tiene empresa asignada."); return; }
    const porDoc = new Map((empleados.data ?? []).map((e) => [e.document, e]));
    const filas = docs.flatMap((d) => {
      const e = porDoc.get(d) as EmpleadoFiltro | undefined;
      return e ? dias.map((dia) => ({
        tenant_id: tenantId, employee_id: e.id, document: e.document, full_name: e.full_name, position: e.position,
        campaign_label: e.campana, work_date: dia, novelty_type: tipo, source: "manual", status: "pendiente", notes: notas || null, report_id: null,
      })) : [];
    });
    setGuardando(true);
    try {
      for (let i = 0; i < filas.length; i += 500) {
        const { error } = await supabase.from("novelty_entries").upsert(filas.slice(i, i + 500), { onConflict: "tenant_id,document,work_date" });
        if (error) throw error;
      }
      toast.success(`${tipo}: ${docs.length} persona(s) × ${dias.length} día(s) registrados`, { description: "Quedan pendientes de aprobación." });
      setDocs([]); setNotas("");
      onListo(); onClose();
    } catch (e) {
      toast.error("No se pudo registrar", { description: (e as Error).message });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarPlus className="size-5 text-primary" /> Registrar novedades por día</DialogTitle>
          <DialogDescription>Para una o varias personas y uno o varios días. Reemplaza lo que haya en esos días y queda pendiente de aprobación.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Personas</Label><SelectorPersonas seleccion={docs} onChange={setDocs} /></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Novedad</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TIPOS_NOVEDAD.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Desde</Label><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Hasta</Label><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Notas / soporte (opcional)</Label><Textarea rows={2} value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej: incapacidad EPS No. 012345" /></div>
          {docs.length && dias.length ? <p className="rounded-md bg-muted/50 p-2 text-sm">Se registrarán <b>{docs.length * dias.length}</b> novedades: {docs.length} persona(s) × {dias.length} día(s).</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={guardar} disabled={guardando || !docs.length || !dias.length}>{guardando ? <Loader2 className="size-4 animate-spin" /> : null} Registrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CONCEPTOS_HORAS: { campo: string; ajuste: string; etiqueta: string }[] = [
  { campo: "horas_extra_diurnas", ajuste: "ajuste_extra_diurnas", etiqueta: "Horas extras diurnas (1,25)" },
  { campo: "horas_extra_nocturnas", ajuste: "ajuste_extra_nocturnas", etiqueta: "Horas extras nocturnas (1,75)" },
  { campo: "horas_nocturnas", ajuste: "ajuste_horas_nocturnas", etiqueta: "Recargo nocturno (0,35)" },
  { campo: "horas_dom_fest_090", ajuste: "ajuste_dom_fest_090", etiqueta: "Dominical / festivo (0,90)" },
  { campo: "horas_dom_fest_190", ajuste: "ajuste_dom_fest_190", etiqueta: "Dominical / festivo (1,90)" },
];

/** Reportar horas (extras, nocturnas, dominicales) a una o varias personas para un periodo, sin Excel. */
export function ReportarHoras({ abierta, onClose, onListo, desde0, hasta0 }: {
  abierta: boolean; onClose: () => void; onListo: () => void; desde0: string; hasta0: string;
}) {
  const [docs, setDocs] = useState<string[]>([]);
  const [desde, setDesde] = useState(desde0);
  const [hasta, setHasta] = useState(hasta0);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [conAjustes, setConAjustes] = useState(false);
  const [comentario, setComentario] = useState("");
  const [guardando, setGuardando] = useState(false);
  useEffect(() => { if (abierta) { setDesde(desde0); setHasta(hasta0); } }, [abierta, desde0, hasta0]);

  // Con una sola persona se muestran las horas que ya tiene en ese periodo
  const [previo, setPrevio] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    setPrevio(null);
    if (docs.length !== 1 || !desde || !hasta) return;
    void supabase.from("novelty_totals").select("*").eq("document", docs[0]!).eq("period_start", desde).eq("period_end", hasta).maybeSingle()
      .then(({ data }) => setPrevio((data as Record<string, number> | null) ?? null));
  }, [docs, desde, hasta]);

  const enviados = Object.fromEntries(Object.entries(valores).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v.replace(",", "."))]));
  const invalidos = Object.values(enviados).some((v) => Number.isNaN(v) || v < -500 || v > 500);

  async function guardar() {
    setGuardando(true);
    const { data, error } = await supabase.rpc("guardar_horas_novedad" as never, { _documentos: docs, _desde: desde, _hasta: hasta, _valores: enviados, _comentario: comentario || null } as never);
    setGuardando(false);
    if (error) { toast.error("No se pudieron guardar las horas", { description: error.message }); return; }
    toast.success(`Horas registradas para ${data} persona(s)`, { description: "Quedan pendientes de revisión de Nómina." });
    setDocs([]); setValores({}); setComentario("");
    onListo(); onClose();
  }

  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Timer className="size-5 text-primary" /> Reportar horas</DialogTitle>
          <DialogDescription>Extras, recargos nocturnos y dominicales de una o varias personas. Escribe solo las horas que quieres registrar: los campos vacíos no se cambian.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Personas</Label><SelectorPersonas seleccion={docs} onChange={setDocs} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Periodo desde</Label><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Periodo hasta</Label><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></div>
          </div>
          <div className="rounded-lg border">
            <div className="grid grid-cols-[1fr_7rem_7rem] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
              <span>Concepto</span><span className="text-right">Horas</span><span className="text-right">{conAjustes ? "Ajuste" : ""}</span>
            </div>
            {CONCEPTOS_HORAS.map((c) => (
              <div key={c.campo} className="grid grid-cols-[1fr_7rem_7rem] items-center gap-2 border-b px-3 py-2 last:border-0">
                <span className="text-sm">
                  {c.etiqueta}
                  {previo ? <span className="block text-[11px] text-muted-foreground">Actual: {Number(previo[c.campo] ?? 0)} h{Number(previo[c.ajuste] ?? 0) ? ` · ajuste ${Number(previo[c.ajuste])}` : ""}</span> : null}
                </span>
                <Input inputMode="decimal" className="text-right" placeholder="—" value={valores[c.campo] ?? ""} onChange={(e) => setValores({ ...valores, [c.campo]: e.target.value })} />
                {conAjustes ? <Input inputMode="decimal" className="text-right" placeholder="—" value={valores[c.ajuste] ?? ""} onChange={(e) => setValores({ ...valores, [c.ajuste]: e.target.value })} /> : <span />}
              </div>
            ))}
          </div>
          <button type="button" className="text-xs text-primary underline" onClick={() => setConAjustes(!conAjustes)}>{conAjustes ? "Ocultar ajustes" : "Agregar ajustes (horas de periodos anteriores)"}</button>
          <div className="space-y-1.5"><Label>Comentario (opcional)</Label><Textarea rows={2} value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Ej: apoyo en campaña por alto volumen" /></div>
          {docs.length > 1 && Object.keys(enviados).length ? (
            <p className="rounded-md bg-muted/50 p-2 text-sm">A cada una de las <b>{docs.length}</b> personas se le registrarán estas horas en el periodo.</p>
          ) : null}
          {invalidos ? <p className="text-sm text-destructive">Revisa las horas: deben ser números.</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={guardar} disabled={guardando || !docs.length || !Object.keys(enviados).length || invalidos || !desde || !hasta || hasta < desde}>
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null} Guardar horas
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
