import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2, ChevronDown, ChevronRight, Clock, FileUp, Loader2, MessageSquare, MessageSquareReply, MessageSquareWarning,
  Paperclip, RotateCcw, SearchX, Timer, X, XCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { CONCEPTOS, colorTipo, type CampoConcepto } from "@/lib/novedades";
import { ChipArchivo, VisorDocumento, subirEvidencias, type Archivo } from "@/components/visor-documento";
import { Paginador, usePaginado } from "@/components/simple-table";
import { CruceBiometrico, DetalleDiasPersona, type FilaConciliacion } from "@/components/conciliacion-novedades";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type TotalResumen = {
  id: string; document: string; full_name: string | null; campaign_label: string | null; period_start: string; period_end: string;
  observaciones: string | null; source: string; review_status: Estado; review_comment: string | null; reviewed_at: string | null;
} & Record<CampoConcepto, number>;
export type EntradaResumen = { document: string; full_name: string | null; campaign_label: string | null; work_date: string; novelty_type: string; status: string; source: string };
type Estado = "pendiente" | "aprobado" | "observado" | "rechazado" | "respondido";
type Evento = { id: string; total_id: string; tipo: string; comentario: string | null; archivos: Archivo[]; created_at: string; profiles: { full_name: string | null } | null };

export const ESTADO_REVISION: Record<Estado, { label: string; clase: string; ayuda: string }> = {
  pendiente: { label: "Pendiente de revisión", clase: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300", ayuda: "Nómina aún no la revisa." },
  aprobado: { label: "Aprobado", clase: "bg-emerald-600 text-white", ayuda: "Nómina la aprobó." },
  observado: { label: "Observado", clase: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300", ayuda: "Nómina pidió aclaración: el supervisor debe responder." },
  rechazado: { label: "Rechazado", clase: "bg-red-600 text-white", ayuda: "Nómina la negó. El supervisor puede refutar con evidencia." },
  respondido: { label: "Respondido · 2ª revisión", clase: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-300", ayuda: "El supervisor respondió: Nómina debe revisar de nuevo." },
};
const EVENTO: Record<string, { label: string; icono: ReactNode }> = {
  aprobado: { label: "aprobó", icono: <CheckCircle2 className="size-3.5 text-emerald-600" /> },
  observado: { label: "observó", icono: <MessageSquareWarning className="size-3.5 text-amber-600" /> },
  rechazado: { label: "rechazó", icono: <XCircle className="size-3.5 text-red-600" /> },
  pendiente: { label: "reabrió la revisión", icono: <RotateCcw className="size-3.5 text-sky-600" /> },
  respondido: { label: "respondió y envió a segunda revisión", icono: <MessageSquareReply className="size-3.5 text-violet-600" /> },
  comentario: { label: "comentó", icono: <MessageSquare className="size-3.5 text-muted-foreground" /> },
  horas: { label: "registró horas", icono: <Timer className="size-3.5 text-muted-foreground" /> },
};

const h = (v: number) => v.toLocaleString("es-CO", { maximumFractionDigits: 2 });
const fecha = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
const fechaHora = (f: string) => new Date(f).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
/** Horas por concepto (horas + ajuste) con valor distinto de cero. */
function horasDe(t: TotalResumen) {
  const base = CONCEPTOS.filter((c) => !c.campo.startsWith("ajuste_"));
  return base
    .map((c) => {
      const ajuste = CONCEPTOS.find((a) => a.campo === `ajuste_${c.campo.replace(/^horas_/, "")}` || a.campo === `ajuste_${c.campo}`);
      return { etiqueta: c.etiqueta, horas: Number(t[c.campo] ?? 0), ajuste: ajuste ? Number(t[ajuste.campo] ?? 0) : 0 };
    })
    .filter((x) => x.horas || x.ajuste);
}

type Persona = { document: string; nombre: string; campana: string | null; dias: Map<string, number>; totales: TotalResumen[]; desde: string | null; hasta: string | null };
type Accion = { modo: "observado" | "rechazado" | "responder" | "comentar"; total: TotalResumen; nombre: string };

export function ResumenNovedades({ totales, entradas, cargando, puedeAprobar, puedeResponder, tenantId, onCambio }: {
  totales: TotalResumen[]; entradas: EntradaResumen[]; cargando: boolean; puedeAprobar: boolean; puedeResponder: boolean;
  tenantId: string | null; onCambio: () => void;
}) {
  const [filtro, setFiltro] = useState<Estado | "todos" | "solo_dias">("todos");
  const [abierta, setAbierta] = useState<string | null>(null);
  const [accion, setAccion] = useState<Accion | null>(null);
  const [archivo, setArchivo] = useState<Archivo | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const personas = useMemo(() => {
    const m = new Map<string, Persona>();
    const obtener = (doc: string, nombre: string | null, campana: string | null) => {
      let p = m.get(doc);
      if (!p) { p = { document: doc, nombre: nombre ?? doc, campana, dias: new Map(), totales: [], desde: null, hasta: null }; m.set(doc, p); }
      return p;
    };
    for (const e of entradas) {
      const p = obtener(e.document, e.full_name, e.campaign_label);
      p.dias.set(e.novelty_type, (p.dias.get(e.novelty_type) ?? 0) + 1);
      if (!p.desde || e.work_date < p.desde) p.desde = e.work_date;
      if (!p.hasta || e.work_date > p.hasta) p.hasta = e.work_date;
    }
    for (const t of totales) obtener(t.document, t.full_name, t.campaign_label).totales.push(t);
    return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }, [totales, entradas]);

  const estadoDe = (p: Persona): Estado | "solo_dias" => {
    if (!p.totales.length) return "solo_dias";
    const orden: Estado[] = ["respondido", "observado", "rechazado", "pendiente", "aprobado"];
    return orden.find((e) => p.totales.some((t) => t.review_status === e)) ?? "pendiente";
  };
  const visibles = useMemo(() => personas.filter((p) => filtro === "todos" || estadoDe(p) === filtro), [personas, filtro]);
  const pag = usePaginado(visibles, 10);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { pag.reiniciar(); }, [filtro]);
  const cuenta = (e: Estado | "solo_dias") => personas.filter((p) => estadoDe(p) === e).length;

  const ids = totales.map((t) => t.id);
  const eventos = useQuery({
    queryKey: ["nov-historial", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const out: Evento[] = [];
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase
          .from("novelty_review_events" as never)
          .select("id, total_id, tipo, comentario, archivos, created_at, profiles(full_name)")
          .in("total_id", ids.slice(i, i + 150))
          .order("created_at");
        if (error) throw error;
        out.push(...((data ?? []) as unknown as Evento[]));
      }
      return out;
    },
  });
  const eventosDe = (id: string) => (eventos.data ?? []).filter((e) => e.total_id === id);

  // Cruce con el biométrico (el mismo de la conciliación de Nómina; cada rol ve solo su personal)
  const rango = useMemo(() => {
    if (!totales.length) return null;
    return [
      totales.reduce((m, x) => (x.period_start < m ? x.period_start : m), totales[0]!.period_start),
      totales.reduce((m, x) => (x.period_end > m ? x.period_end : m), totales[0]!.period_end),
    ] as const;
  }, [totales]);
  const cruce = useQuery({
    queryKey: ["nov-conciliacion", rango?.[0], rango?.[1]],
    enabled: Boolean(rango) && abierta !== null,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("conciliacion_novedades" as never, { _desde: rango![0], _hasta: rango![1] } as never);
      if (error) throw error;
      // Misma forma (lista) que la pestaña Conciliación: comparten la caché con esta clave
      return (data as unknown as FilaConciliacion[]) ?? [];
    },
  });
  const crucePorId = useMemo(
    () => new Map((Array.isArray(cruce.data) ? cruce.data : []).map((f) => [f.id, f])),
    [cruce.data],
  );
  const tolerancia = useQuery({
    queryKey: ["reglas", "tolerancia_conciliacion_horas"],
    queryFn: async () => {
      const { data } = await supabase.from("rules").select("value").eq("key", "tolerancia_conciliacion_horas").maybeSingle();
      return Number(data?.value ?? 0.5);
    },
  });

  async function revisar(t: TotalResumen, estado: "aprobado" | "observado" | "rechazado" | "pendiente", comentario?: string) {
    setTrabajando(true);
    const { error } = await supabase.rpc("revisar_novedades" as never, { _ids: [t.id], _estado: estado, _comentario: comentario ?? null } as never);
    setTrabajando(false);
    if (error) { toast.error("No se pudo registrar la revisión", { description: error.message }); return false; }
    toast.success(estado === "aprobado" ? "Aprobado" : estado === "observado" ? "Observación enviada al supervisor" : estado === "rechazado" ? "Rechazo registrado" : "Revisión reabierta");
    onCambio();
    void eventos.refetch();
    return true;
  }

  async function comentar(t: TotalResumen, comentario: string, archivos: File[], enviar: boolean) {
    if (!tenantId) { toast.error("Tu usuario no tiene empresa asignada."); return false; }
    setTrabajando(true);
    try {
      const adjuntos = await subirEvidencias(archivos, tenantId, t.id);
      const { data, error } = await supabase.rpc("comentar_novedad" as never, { _id: t.id, _comentario: comentario, _archivos: adjuntos, _enviar: enviar } as never);
      if (error) throw error;
      toast.success(data === "respondido" ? "Respuesta enviada a Nómina para segunda revisión" : "Comentario guardado");
      onCambio();
      void eventos.refetch();
      return true;
    } catch (e) {
      toast.error("No se pudo guardar", { description: (e as Error).message });
      return false;
    } finally {
      setTrabajando(false);
    }
  }

  const chips: { k: typeof filtro; t: string }[] = [
    { k: "todos", t: "Todas" },
    { k: "respondido", t: "Respondidas (2ª revisión)" },
    { k: "observado", t: "Observadas" },
    { k: "rechazado", t: "Rechazadas" },
    { k: "pendiente", t: "Pendientes" },
    { k: "aprobado", t: "Aprobadas" },
    { k: "solo_dias", t: "Solo días" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => {
          const v = c.k === "todos" ? personas.length : cuenta(c.k);
          return (
            <button key={c.k} type="button" onClick={() => setFiltro(c.k)}
              className={cn("flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm transition-colors hover:border-primary",
                filtro === c.k && "border-primary bg-primary/10 font-medium", !v && c.k !== "todos" && "opacity-50")}>
              {c.t}<span className="rounded-full bg-muted px-2 text-xs tabular-nums">{cargando ? "…" : v}</span>
            </button>
          );
        })}
      </div>

      {cargando ? (
        <p className="py-10 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Cargando novedades…</p>
      ) : !visibles.length ? (
        <Card className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
          <SearchX className="size-6" />
          {personas.length ? "Nadie en esta categoría." : "No hay novedades reportadas con estos filtros. Carga una plantilla, registra novedades o reporta horas."}
        </Card>
      ) : (
        <div className="space-y-3">
          {pag.visibles.map((p) => {
            const estado = estadoDe(p);
            const abiertaP = abierta === p.document;
            return (
              <Card key={p.document} className="overflow-hidden">
                <button type="button" onClick={() => setAbierta(abiertaP ? null : p.document)} className="flex w-full flex-wrap items-start justify-between gap-3 p-4 text-left hover:bg-muted/30">
                  <div className="flex min-w-0 items-start gap-2">
                    {abiertaP ? <ChevronDown className="mt-0.5 size-4 shrink-0" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0">
                      <p className="font-medium">{p.nombre}</p>
                      <p className="text-xs text-muted-foreground">{p.document}{p.campana ? ` · ${p.campana}` : ""}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {[...p.dias.entries()].sort((a, b) => b[1] - a[1]).map(([tipo, n]) => (
                          <span key={tipo} className={cn("rounded px-1.5 py-0.5 text-[11px]", colorTipo(tipo))}>{tipo}: {n}</span>
                        ))}
                        {p.totales.flatMap(horasDe).map((x, i) => (
                          <span key={`${x.etiqueta}-${i}`} className="rounded border px-1.5 py-0.5 text-[11px]">{x.etiqueta}: {h(x.horas + x.ajuste)} h</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  {estado === "solo_dias" ? (
                    <Badge variant="outline">Solo días reportados</Badge>
                  ) : (
                    <Badge className={ESTADO_REVISION[estado].clase} title={ESTADO_REVISION[estado].ayuda}>{ESTADO_REVISION[estado].label}</Badge>
                  )}
                </button>

                {abiertaP ? (
                  <div className="space-y-3 border-t bg-muted/20 p-4">
                    {!p.totales.length ? (
                      <>
                        <p className="text-sm text-muted-foreground">Esta persona solo tiene días reportados (asistencia, descanso, faltas…): no hay horas que revisar.</p>
                        {p.desde && p.hasta ? <DetalleDiasPersona document={p.document} desde={p.desde} hasta={p.hasta} /> : null}
                      </>
                    ) : null}
                    {p.totales.map((t) => (
                      <div key={t.id} className="space-y-3 rounded-lg border bg-card p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium">
                            Periodo {fecha(t.period_start)} al {fecha(t.period_end)}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">{t.source === "manual" ? "registrado en la plataforma" : "desde plantilla"}</span>
                          </p>
                          <Badge className={ESTADO_REVISION[t.review_status].clase}>{ESTADO_REVISION[t.review_status].label}</Badge>
                        </div>
                        {horasDe(t).length ? (
                          <table className="w-full max-w-lg text-sm">
                            <thead><tr className="text-left text-xs text-muted-foreground"><th className="pb-1 font-medium">Horas</th><th className="pb-1 text-right font-medium">Reportadas</th><th className="pb-1 text-right font-medium">Ajuste</th><th className="pb-1 text-right font-medium">Total</th></tr></thead>
                            <tbody>
                              {horasDe(t).map((x) => (
                                <tr key={x.etiqueta} className="border-t">
                                  <td className="py-1">{x.etiqueta}</td>
                                  <td className="py-1 text-right tabular-nums">{h(x.horas)}</td>
                                  <td className="py-1 text-right tabular-nums text-muted-foreground">{x.ajuste ? h(x.ajuste) : "—"}</td>
                                  <td className="py-1 text-right font-medium tabular-nums">{h(x.horas + x.ajuste)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : <p className="text-xs text-muted-foreground">Sin horas reportadas en este periodo.</p>}
                        {(
                          crucePorId.get(t.id) ? (
                            <CruceBiometrico fila={crucePorId.get(t.id)!} tol={tolerancia.data ?? 0.5} />
                          ) : cruce.isLoading ? (
                            <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline size-3.5 animate-spin" />Cruzando con el biométrico…</p>
                          ) : null
                        )}
                        {t.observaciones ? <p className="text-xs"><b>Observaciones de la plantilla:</b> {t.observaciones}</p> : null}

                        <Historial eventos={eventosDe(t.id)} cargando={eventos.isLoading} onAbrir={setArchivo} />

                        <div className="flex flex-wrap justify-end gap-2">
                          {puedeResponder && ["observado", "rechazado"].includes(t.review_status) ? (
                            <Button size="sm" disabled={trabajando} onClick={() => setAccion({ modo: "responder", total: t, nombre: p.nombre })}>
                              <MessageSquareReply className="size-4" /> {t.review_status === "rechazado" ? "Refutar con evidencia" : "Responder con evidencia"}
                            </Button>
                          ) : null}
                          {puedeResponder || puedeAprobar ? (
                            <Button size="sm" variant="outline" disabled={trabajando} onClick={() => setAccion({ modo: "comentar", total: t, nombre: p.nombre })}>
                              <Paperclip className="size-4" /> Comentar / adjuntar
                            </Button>
                          ) : null}
                          {puedeAprobar ? (
                            <>
                              {t.review_status !== "pendiente" ? (
                                <Button size="sm" variant="ghost" disabled={trabajando} onClick={() => void revisar(t, "pendiente")}><RotateCcw className="size-4" /> Reabrir</Button>
                              ) : null}
                              {t.review_status !== "rechazado" ? (
                                <Button size="sm" variant="outline" disabled={trabajando} onClick={() => setAccion({ modo: "rechazado", total: t, nombre: p.nombre })}><XCircle className="size-4" /> Rechazar</Button>
                              ) : null}
                              {t.review_status !== "observado" ? (
                                <Button size="sm" variant="outline" disabled={trabajando} onClick={() => setAccion({ modo: "observado", total: t, nombre: p.nombre })}><MessageSquareWarning className="size-4" /> Observar</Button>
                              ) : null}
                              {t.review_status !== "aprobado" ? (
                                <Button size="sm" disabled={trabajando} onClick={() => void revisar(t, "aprobado")}><CheckCircle2 className="size-4" /> Aprobar</Button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
      {visibles.length > 10 ? <Paginador {...pag.paginador} /> : null}

      <AccionDialog
        accion={accion}
        trabajando={trabajando}
        onClose={() => setAccion(null)}
        onGuardar={async (comentario, archivos, enviar) => {
          if (!accion) return;
          const ok = accion.modo === "observado" || accion.modo === "rechazado"
            ? await revisar(accion.total, accion.modo, comentario)
            : await comentar(accion.total, comentario, archivos, accion.modo === "responder" || enviar);
          if (ok) setAccion(null);
        }}
      />
      <VisorDocumento archivo={archivo} onClose={() => setArchivo(null)} />
    </div>
  );
}

function Historial({ eventos, cargando, onAbrir }: { eventos: Evento[]; cargando: boolean; onAbrir: (a: Archivo) => void }) {
  if (cargando) return <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline size-3 animate-spin" />Cargando historial…</p>;
  if (!eventos.length) return <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="size-3.5" />Sin revisiones ni comentarios todavía.</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Historial</p>
      <ol className="space-y-2 border-l pl-4">
        {eventos.map((e) => {
          const m = EVENTO[e.tipo] ?? EVENTO["comentario"]!;
          return (
            <li key={e.id} className="relative text-sm">
              <span className="absolute -left-[22px] top-0.5 grid size-5 place-items-center rounded-full border bg-card">{m.icono}</span>
              <p className="text-xs"><b>{e.profiles?.full_name ?? "Usuario"}</b> {m.label} <span className="text-muted-foreground">· {fechaHora(e.created_at)}</span></p>
              {e.comentario ? <p className="mt-0.5 whitespace-pre-wrap text-sm">{e.comentario}</p> : null}
              {e.archivos?.length ? <div className="mt-1 flex flex-wrap gap-1.5">{e.archivos.map((a) => <ChipArchivo key={a.path} archivo={a} onAbrir={onAbrir} />)}</div> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const TITULOS: Record<Accion["modo"], { titulo: string; ayuda: string; boton: string; archivos: boolean }> = {
  observado: { titulo: "Observar", ayuda: "Explica qué debe aclarar o corregir el supervisor. Le llegará en su resumen.", boton: "Enviar observación", archivos: false },
  rechazado: { titulo: "Rechazar", ayuda: "Explica por qué se niega. El supervisor podrá refutar con evidencia.", boton: "Rechazar", archivos: false },
  responder: { titulo: "Responder a Nómina", ayuda: "Explica o refuta y adjunta la evidencia (PDF, fotos, documentos). Vuelve a Nómina para segunda revisión.", boton: "Enviar a segunda revisión", archivos: true },
  comentar: { titulo: "Comentar o adjuntar", ayuda: "Agrega información o evidencia al historial.", boton: "Guardar", archivos: true },
};

function AccionDialog({ accion, trabajando, onClose, onGuardar }: {
  accion: Accion | null; trabajando: boolean; onClose: () => void; onGuardar: (comentario: string, archivos: File[], enviar: boolean) => void;
}) {
  const [comentario, setComentario] = useState("");
  const [archivos, setArchivos] = useState<File[]>([]);
  const [enviar, setEnviar] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setComentario(""); setArchivos([]); setEnviar(false); }, [accion]);
  if (!accion) return null;
  const t = TITULOS[accion.modo];
  const exigeComentario = accion.modo !== "comentar" || !archivos.length;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.titulo} · {accion.nombre}</DialogTitle>
          <DialogDescription>{t.ayuda}</DialogDescription>
        </DialogHeader>
        <Textarea rows={5} value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Escribe aquí…" />
        {t.archivos ? (
          <div className="space-y-2">
            <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}><FileUp className="size-4" /> Adjuntar evidencia</Button>
            <input ref={input} type="file" multiple className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.xls,.xlsx,.txt"
              onChange={(e) => {
                // leer los archivos antes de limpiar el campo (si no, la lista queda vacía)
                const nuevos = Array.from(e.target.files ?? []);
                setArchivos((a) => [...a, ...nuevos]);
                e.target.value = "";
              }} />
            {archivos.length ? (
              <div className="flex flex-wrap gap-1.5">
                {archivos.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                    <Paperclip className="size-3" />{f.name}
                    <button type="button" onClick={() => setArchivos(archivos.filter((_, j) => j !== i))} aria-label="Quitar"><X className="size-3" /></button>
                  </span>
                ))}
              </div>
            ) : <p className="text-xs text-muted-foreground">PDF, imágenes, Word, Excel o texto · máximo 10 MB por archivo.</p>}
          </div>
        ) : null}
        {accion.modo === "comentar" && ["pendiente", "observado", "rechazado"].includes(accion.total.review_status) ? (
          <label className="flex items-center gap-2 text-sm"><Switch checked={enviar} onCheckedChange={setEnviar} /> Enviar a Nómina para revisión</label>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={trabajando || (exigeComentario && comentario.trim().length < 3)} onClick={() => onGuardar(comentario, archivos, enviar)}>
            {trabajando ? <Loader2 className="size-4 animate-spin" /> : null} {t.boton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
