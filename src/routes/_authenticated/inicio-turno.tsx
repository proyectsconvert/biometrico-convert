import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlarmClock,
  BellRing,
  CheckCheck,
  Clock,
  Fingerprint,
  Hourglass,
  Megaphone,
  Loader2,
  LogOut,
  MapPin,
  MonitorSmartphone,
  Search,
  ShieldAlert,
  Smartphone,
  Tablet,
  TimerReset,
  Users,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { PageHeader } from "@/components/app-shell";
import { Paginador, SimpleTable, usePaginado } from "@/components/simple-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/inicio-turno")({
  head: () => ({ meta: [{ title: "Inicio turno — Convert-IA" }] }),
  component: InicioTurno,
});

type Estado = "activo" | "vencido" | "en_extra" | "extra_vencida" | "finalizado" | "cierre_autorizado" | "sin_cierre";
type Turno = {
  id: string;
  user_id: string;
  employee_id: string | null;
  empleado: string | null;
  documento: string | null;
  usuario: string | null;
  campana: string | null;
  supervisores: string | null;
  inicio: string;
  fin: string | null;
  cierre: string | null;
  motivo_cierre: string | null;
  tipo_dispositivo: string | null;
  ip_inicio: string | null;
  ip_fin: string | null;
  ubicacion: { estado?: string; lat?: number; lon?: number; precision_m?: number } | null;
  validacion: { ok?: boolean; fallas?: string[]; ubicacion?: string; distancia_m?: number } | null;
  max_horas: number;
  limite: string;
  extra_autorizada_hasta: string | null;
  extra_autorizada_horas: number | null;
  estado: Estado;
  avisos: number;
  alarmas_abiertas: number;
  regla: string | null;
  dentro_de_rango: boolean | null;
  ultima_ubicacion_at: string | null;
};
type Alarma = {
  id: string;
  session_id: string | null;
  employee_id: string | null;
  tipo: string;
  severidad: "alta" | "media" | "info";
  detalle: string;
  estado: "abierta" | "atendida" | "informativa";
  repeticiones: number;
  ultima_at: string;
  created_at: string;
  employees: { full_name: string; document: string } | null;
};

const ESTADOS: Record<Estado, { label: string; clase: string }> = {
  activo: { label: "En turno", clase: "bg-emerald-600 text-white hover:bg-emerald-600" },
  vencido: { label: "Tiempo excedido", clase: "bg-red-600 text-white hover:bg-red-600" },
  en_extra: { label: "En horas extra", clase: "bg-violet-600 text-white hover:bg-violet-600" },
  extra_vencida: { label: "Extra excedida", clase: "bg-red-700 text-white hover:bg-red-700" },
  finalizado: { label: "Finalizado", clase: "bg-muted text-foreground hover:bg-muted" },
  cierre_autorizado: { label: "Cierre autorizado", clase: "bg-sky-100 text-sky-900 hover:bg-sky-100 dark:bg-sky-950 dark:text-sky-200" },
  sin_cierre: { label: "Sin cierre", clase: "bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-200" },
};
const ALARMAS: Record<string, string> = {
  inicio_bloqueado: "Inicio bloqueado",
  inicio_fuera_de_regla: "Inicio fuera de la regla",
  cierre_bloqueado: "Cierre bloqueado",
  cierre_otro_dispositivo: "Cierre desde otro dispositivo",
  cierre_fuera_de_regla: "Cierre con diferencias",
  turno_excedido: "Tiempo excedido",
  extra_excedida: "Extra excedida",
  extra_autorizada: "Extra autorizada",
  aviso_finalizar: "Aviso de finalizar",
  cierre_autorizado: "Cierre autorizado",
  dispositivo_no_autorizado: "Dispositivo no autorizado",
  sin_ubicacion: "Intentó iniciar sin ubicación",
  fuera_de_rango: "Fuera del rango",
  ubicacion_desactivada: "Desactivó la ubicación",
  bio_pendiente: "Biométrico pendiente",
  bio_sin_huella: "Sin huella de entrada",
  bio_inicio_antes_huella: "Inició antes de la huella",
  bio_fin_despues_salida: "Finalizó después de la salida",
  bio_sin_salida: "Sin huella de salida",
};
const DISPOSITIVO: Record<string, { l: string; icono: ReactNode }> = {
  pc: { l: "PC", icono: <MonitorSmartphone className="size-3.5" /> },
  movil: { l: "Celular", icono: <Smartphone className="size-3.5" /> },
  tablet: { l: "Tablet", icono: <Tablet className="size-3.5" /> },
};

const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
const hora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" }) : "—";
const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });
const duracion = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const ABIERTOS: Estado[] = ["activo", "vencido", "en_extra", "extra_vencida"];

type Accion = { tipo: "avisar" | "autorizar_extra" | "cerrar"; turno: Turno };

function InicioTurno() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const puedeGestionar = acceso.can("inicio_turno", "gestionar");
  const [desde, setDesde] = useState(hoy);
  const [hasta, setHasta] = useState(hoy);
  const [filtro, setFiltro] = useState<"todos" | "abiertos" | Estado>("todos");
  const [buscar, setBuscar] = useState("");
  const [accion, setAccion] = useState<Accion | null>(null);
  const [marcados, setMarcados] = useState<Set<string>>(() => new Set());
  const [masivo, setMasivo] = useState(false);
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Revisa vencimientos al abrir y cada minuto (el servidor también lo hace solo, sin el tablero abierto)
  useEffect(() => {
    const revisar = async () => {
      const { data } = await supabase.rpc("revisar_alarmas_turno" as never);
      if (Number(data) > 0) void qc.invalidateQueries({ queryKey: ["inicio-turno"] });
    };
    void revisar();
    const t = setInterval(() => void revisar(), 60_000);
    return () => clearInterval(t);
  }, [qc]);
  useEffect(() => {
    const conciliar = async () => {
      const desde30 = new Date(Date.now() - 30 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
      const { data } = await supabase.rpc("conciliar_turnos_biometrico" as never, { _desde: desde30, _hasta: hoy() } as never);
      if (Number(data) > 0) void qc.invalidateQueries({ queryKey: ["inicio-turno"] });
    };
    void conciliar();
    const t = setInterval(() => void conciliar(), 10 * 60_000);
    return () => clearInterval(t);
  }, [qc]);

  const turnos = useQuery({
    queryKey: ["inicio-turno", "turnos", desde, hasta],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("tablero_inicio_turno" as never, { _desde: desde, _hasta: hasta } as never);
      if (error) throw error;
      return (data as unknown as Turno[]) ?? [];
    },
  });
  const alarmas = useQuery({
    queryKey: ["inicio-turno", "alarmas", desde, hasta],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shift_alerts" as never)
        .select("id, session_id, employee_id, tipo, severidad, detalle, estado, repeticiones, ultima_at, created_at, employees(full_name, document)")
        .gte("created_at", `${desde}T00:00:00-05:00`)
        .lte("created_at", `${hasta}T23:59:59-05:00`)
        .order("ultima_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data as unknown as Alarma[]) ?? [];
    },
  });

  const lista = useMemo(() => turnos.data ?? [], [turnos.data]);
  const filas = useMemo(() => {
    const q = norm(buscar.trim());
    return lista.filter(
      (t) =>
        (filtro === "todos" || (filtro === "abiertos" ? ABIERTOS.includes(t.estado) : t.estado === filtro)) &&
        (!q || norm(`${t.empleado ?? ""} ${t.usuario ?? ""} ${t.documento ?? ""} ${t.campana ?? ""} ${t.supervisores ?? ""}`).includes(q)),
    );
  }, [lista, filtro, buscar]);
  const pag = usePaginado(filas, 20);
  const cuenta = (e: Estado[]) => lista.filter((t) => e.includes(t.estado)).length;
  const abiertas = (alarmas.data ?? []).filter((a) => a.estado === "abierta");
  // Selección para el aviso masivo: solo turnos abiertos que siguen en la lista
  const seleccionables = filas.filter((t) => ABIERTOS.includes(t.estado));
  const elegidos = lista.filter((t) => marcados.has(t.id) && ABIERTOS.includes(t.estado));
  const marcar = (ids: string[], si: boolean) =>
    setMarcados((p) => {
      const n = new Set(p);
      ids.forEach((id) => (si ? n.add(id) : n.delete(id)));
      return n;
    });

  async function atender(ids: string[]) {
    let fallas = 0;
    for (const id of ids) {
      const { error } = await supabase.rpc("atender_alarma_turno" as never, { _alarma: id, _nota: null } as never);
      if (error) fallas++;
    }
    if (fallas) toast.error(`No se pudieron atender ${fallas} alarma(s)`);
    else if (ids.length > 1) toast.success(`${ids.length} alarmas marcadas como atendidas`);
    void qc.invalidateQueries({ queryKey: ["inicio-turno"] });
  }

  const chips: { k: typeof filtro; t: string; v: number }[] = [
    { k: "todos", t: "Todos", v: lista.length },
    { k: "abiertos", t: "Abiertos", v: cuenta(ABIERTOS) },
    { k: "vencido", t: "Tiempo excedido", v: cuenta(["vencido"]) },
    { k: "en_extra", t: "En horas extra", v: cuenta(["en_extra"]) },
    { k: "extra_vencida", t: "Extra excedida", v: cuenta(["extra_vencida"]) },
    { k: "finalizado", t: "Finalizados", v: cuenta(["finalizado"]) },
    { k: "cierre_autorizado", t: "Cierre autorizado", v: cuenta(["cierre_autorizado"]) },
  ];

  return (
    <div>
      <PageHeader
        titulo="Inicio turno"
        descripcion="Turnos en curso y finalizados en tiempo real: quién inició, cuánto lleva, quién pasó el tiempo configurado y las alarmas. Se actualiza cada 30 segundos."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Indicador icono={<Users className="size-4" />} titulo="En turno ahora" valor={cuenta(["activo", "en_extra"])} />
        <Indicador icono={<AlarmClock className="size-4" />} titulo="Tiempo excedido" valor={cuenta(["vencido", "extra_vencida"])} alerta />
        <Indicador icono={<Hourglass className="size-4" />} titulo="En horas extra autorizadas" valor={cuenta(["en_extra"])} />
        <Indicador icono={<CheckCheck className="size-4" />} titulo="Finalizados" valor={cuenta(["finalizado", "cierre_autorizado", "sin_cierre"])} />
        <Indicador icono={<BellRing className="size-4" />} titulo="Alarmas abiertas" valor={abiertas.length} alerta />
      </div>

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1">
          <Label>Desde</Label>
          <Input type="date" value={desde} max={hasta} onChange={(e) => e.target.value && setDesde(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Hasta</Label>
          <Input type="date" value={hasta} min={desde} onChange={(e) => e.target.value && setHasta(e.target.value)} />
        </div>
        <div className="min-w-56 flex-1 space-y-1">
          <Label>Buscar</Label>
          <Input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Nombre, cédula, campaña o supervisor" />
        </div>
      </Card>

      <div className="mb-3 flex flex-wrap gap-2">
        {chips.map((c) => (
          <button
            key={c.k}
            type="button"
            onClick={() => setFiltro(c.k)}
            className={cn(
              "flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm hover:border-primary",
              filtro === c.k && "border-primary bg-primary/10 font-medium",
            )}
          >
            {c.t}
            <span className="rounded-full bg-muted px-2 text-xs tabular-nums">{c.v}</span>
          </button>
        ))}
      </div>

      {puedeGestionar && seleccionables.length ? (
        <Card className="mb-3 flex flex-wrap items-center gap-2 p-3 text-sm">
          <Megaphone className="size-4 text-primary" />
          <span className="font-medium">Zumbido masivo «Finalizar turno»:</span>
          <span className="text-muted-foreground">{elegidos.length} seleccionado(s)</span>
          <Button size="sm" variant="outline" onClick={() => marcar(seleccionables.map((t) => t.id), true)}>
            Seleccionar los {seleccionables.length} abiertos
          </Button>
          {cuenta(["vencido", "extra_vencida"]) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => marcar(seleccionables.filter((t) => t.estado === "vencido" || t.estado === "extra_vencida").map((t) => t.id), true)}
            >
              Seleccionar los de tiempo excedido
            </Button>
          ) : null}
          {elegidos.length ? (
            <Button size="sm" variant="ghost" onClick={() => setMarcados(new Set())}>
              Quitar selección
            </Button>
          ) : null}
          <Button size="sm" className="ml-auto" disabled={!elegidos.length} onClick={() => setMasivo(true)}>
            <BellRing className="size-4" /> Enviar zumbido a {elegidos.length || "…"}
          </Button>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div>
          <SimpleTable<Turno>
            cargando={turnos.isLoading}
            filas={pag.visibles}
            getKey={(t) => t.id}
            vacio="No hay turnos en este periodo."
            columnas={[
              ...(puedeGestionar
                ? [
                    {
                      key: "sel",
                      header: "",
                      cell: (t: Turno) =>
                        ABIERTOS.includes(t.estado) ? (
                          <Checkbox
                            aria-label="Seleccionar para aviso masivo"
                            checked={marcados.has(t.id)}
                            onCheckedChange={(v) => marcar([t.id], v === true)}
                          />
                        ) : null,
                    },
                  ]
                : []),
              {
                key: "persona",
                header: "Persona",
                cell: (t) => (
                  <div className="min-w-44">
                    <p className="font-medium">{t.empleado ?? t.usuario}</p>
                    <p className="text-xs text-muted-foreground">{[t.documento, t.campana].filter(Boolean).join(" · ") || t.usuario}</p>
                    {t.supervisores ? <p className="text-[11px] text-muted-foreground">Sup.: {t.supervisores}</p> : null}
                  </div>
                ),
              },
              {
                key: "tiempo",
                header: "Turno",
                cell: (t) => {
                  const fin = t.fin ? Date.parse(t.fin) : ahora;
                  return (
                    <div className="tabular-nums">
                      <p>
                        {hora(t.inicio)} – {t.fin ? hora(t.fin) : "…"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {duracion(fin - Date.parse(t.inicio))} h · máx. {t.max_horas} h
                      </p>
                    </div>
                  );
                },
              },
              {
                key: "estado",
                header: "Estado",
                cell: (t) => (
                  <div className="space-y-1">
                    <Badge className={ESTADOS[t.estado].clase}>{ESTADOS[t.estado].label}</Badge>
                    {ABIERTOS.includes(t.estado) ? (
                      <p className="text-[11px] text-muted-foreground">
                        {t.extra_autorizada_hasta ? `Extra hasta ${hora(t.extra_autorizada_hasta)}` : `Límite ${hora(t.limite)}`}
                        {t.avisos ? ` · ${t.avisos} alarma(s)` : ""}
                      </p>
                    ) : t.motivo_cierre ? (
                      <p className="max-w-40 truncate text-[11px] text-muted-foreground" title={t.motivo_cierre}>{t.motivo_cierre}</p>
                    ) : null}
                  </div>
                ),
              },
              {
                key: "equipo",
                header: "Equipo y lugar",
                cell: (t) => (
                  <div className="space-y-0.5 text-xs">
                    <p className="flex items-center gap-1">
                      {DISPOSITIVO[t.tipo_dispositivo ?? ""]?.icono}
                      {DISPOSITIVO[t.tipo_dispositivo ?? ""]?.l ?? "—"} · {t.ip_inicio ?? "sin IP"}
                    </p>
                    <p className="flex items-center gap-1 text-muted-foreground">
                      <MapPin className="size-3" />
                      {t.ubicacion?.estado === "ok" ? (
                        <a href={`https://www.google.com/maps?q=${t.ubicacion.lat},${t.ubicacion.lon}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          {t.validacion?.ubicacion ?? "ver mapa"}
                        </a>
                      ) : (
                        "sin ubicación"
                      )}
                    </p>
                    {ABIERTOS.includes(t.estado) && t.dentro_de_rango === false ? (
                      <p className="flex items-center gap-1 font-medium text-destructive">
                        <ShieldAlert className="size-3" /> inició fuera del rango
                      </p>
                    ) : null}
                    {t.validacion && t.validacion.ok === false ? (
                      <p className="flex items-center gap-1 text-destructive" title={(t.validacion.fallas ?? []).join("; ")}>
                        <ShieldAlert className="size-3" /> fuera de la regla
                      </p>
                    ) : null}
                  </div>
                ),
              },
              {
                key: "acciones",
                header: "",
                cell: (t) =>
                  puedeGestionar && ABIERTOS.includes(t.estado) ? (
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="outline" title="Enviar zumbido: le aparece una ventana emergente para que finalice el turno" onClick={() => setAccion({ tipo: "avisar", turno: t })}>
                        <BellRing className="size-4" /> Zumbido
                      </Button>
                      <Button size="sm" variant="outline" title="Autorizar horas extra" onClick={() => setAccion({ tipo: "autorizar_extra", turno: t })}>
                        <TimerReset className="size-4" /> Extra
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" title="Cierre autorizado (equipo perdido, olvido, fallas)" onClick={() => setAccion({ tipo: "cerrar", turno: t })}>
                        <LogOut className="size-4" /> Cerrar
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
          {filas.length > 20 ? <Paginador {...pag.paginador} /> : null}
        </div>

        <PanelAlarmas
          alarmas={alarmas.data ?? []}
          cargando={alarmas.isLoading}
          puedeGestionar={puedeGestionar}
          nombre={(a) => a.employees?.full_name ?? lista.find((t) => t.id === a.session_id)?.usuario ?? ""}
          onAtender={atender}
          onPersona={setBuscar}
        />
      </div>

      {masivo ? (
        <AvisoMasivoDialog
          turnos={elegidos}
          onClose={() => setMasivo(false)}
          onListo={() => {
            setMasivo(false);
            setMarcados(new Set());
            void qc.invalidateQueries({ queryKey: ["inicio-turno"] });
          }}
        />
      ) : null}

      {accion ? (
        <AccionDialog
          accion={accion}
          onClose={() => setAccion(null)}
          onListo={() => {
            setAccion(null);
            void qc.invalidateQueries({ queryKey: ["inicio-turno"] });
          }}
        />
      ) : null}
    </div>
  );
}

function Indicador({ icono, titulo, valor, alerta }: { icono: ReactNode; titulo: string; valor: number; alerta?: boolean }) {
  const activo = Boolean(alerta && valor > 0);
  return (
    <Card className={cn("p-4", activo && "border-destructive/40")}>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">{icono} {titulo}</p>
      <p className={cn("mt-1 font-display text-2xl font-semibold tabular-nums", activo && "text-destructive")}>{valor}</p>
    </Card>
  );
}

const TITULOS = {
  avisar: { t: "Enviar zumbido «Finalizar turno»", d: "Le aparece una ventana emergente con tu mensaje (y una notificación del sistema si tiene la página en segundo plano).", b: "Enviar zumbido" },
  autorizar_extra: { t: "Autorizar horas extra", d: "Las alarmas se pausan hasta que termine el tiempo autorizado; si no finaliza, vuelven.", b: "Autorizar" },
  cerrar: { t: "Cierre autorizado del turno", d: "Para equipo perdido, sesión cerrada u otras fallas. Queda trazado con tu nombre y el motivo.", b: "Cerrar turno" },
} as const;

function AccionDialog({ accion, onClose, onListo }: { accion: Accion; onClose: () => void; onListo: () => void }) {
  const [horas, setHoras] = useState("1");
  const [motivo, setMotivo] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const t = TITULOS[accion.tipo];
  const h = Number(horas.replace(",", "."));
  const valido =
    accion.tipo === "autorizar_extra" ? h >= 0.25 && h <= 8 : accion.tipo === "cerrar" ? motivo.trim().length >= 5 : true;

  async function confirmar() {
    setTrabajando(true);
    const { error } = await supabase.rpc("gestionar_turno" as never, {
      _sesion: accion.turno.id,
      _accion: accion.tipo,
      _horas: accion.tipo === "autorizar_extra" ? h : null,
      _motivo: motivo.trim() || null,
    } as never);
    setTrabajando(false);
    if (error) {
      toast.error("No se pudo completar", { description: error.message });
      return;
    }
    toast.success(accion.tipo === "avisar" ? "Zumbido enviado" : accion.tipo === "cerrar" ? "Turno cerrado" : `Se autorizaron ${horas} h extra`);
    onListo();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !trabajando && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.t}</DialogTitle>
          <DialogDescription>
            {accion.turno.empleado ?? accion.turno.usuario} · inició a las {hora(accion.turno.inicio)}. {t.d}
          </DialogDescription>
        </DialogHeader>
        {accion.tipo === "autorizar_extra" ? (
          <div className="space-y-2">
            <Label>Horas extra</Label>
            <div className="flex flex-wrap gap-2">
              {["0.5", "1", "1.5", "2", "3", "4"].map((v) => (
                <Button key={v} size="sm" variant={horas === v ? "default" : "outline"} onClick={() => setHoras(v)}>
                  {v.replace(".", ",")} h
                </Button>
              ))}
              <Input className="w-24" inputMode="decimal" value={horas} onChange={(e) => setHoras(e.target.value)} />
            </div>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label>{accion.tipo === "cerrar" ? "Motivo (obligatorio)" : "Mensaje o motivo (opcional)"}</Label>
          <Textarea
            rows={3}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={
              accion.tipo === "cerrar"
                ? "Ej: se le apagó el computador y no puede finalizar desde ese equipo"
                : accion.tipo === "autorizar_extra"
                  ? "Ej: cierre de mes"
                  : "Ej: ya cumpliste tu jornada, finaliza el turno por favor"
            }
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={trabajando}>Cancelar</Button>
          <Button variant={accion.tipo === "cerrar" ? "destructive" : "default"} disabled={!valido || trabajando} onClick={() => void confirmar()}>
            {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Clock className="size-4" />} {t.b}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Aviso «Finalizar turno» a varias personas a la vez: a cada una le aparece la ventana emergente. */
function AvisoMasivoDialog({ turnos, onClose, onListo }: { turnos: Turno[]; onClose: () => void; onListo: () => void }) {
  const [mensaje, setMensaje] = useState("");
  const [trabajando, setTrabajando] = useState(false);

  async function enviar() {
    setTrabajando(true);
    const { data, error } = await supabase.rpc("avisar_turnos" as never, {
      _sesiones: turnos.map((t) => t.id),
      _mensaje: mensaje.trim() || null,
    } as never);
    setTrabajando(false);
    if (error) {
      toast.error("No se pudo enviar el zumbido", { description: error.message });
      return;
    }
    const r = data as unknown as { enviados: number; omitidos: number };
    toast.success(`Zumbido enviado a ${r.enviados} persona(s)`, {
      description: r.omitidos ? `${r.omitidos} no se enviaron (turno ya finalizado o fuera de tu alcance).` : undefined,
    });
    onListo();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !trabajando && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Zumbido masivo «Finalizar turno»</DialogTitle>
          <DialogDescription>
            A cada persona le aparece una ventana emergente con tu mensaje y el botón para finalizar el turno.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-40 overflow-auto rounded-md border p-2 text-xs">
          {turnos.map((t) => (
            <p key={t.id} className="flex justify-between gap-2">
              <span className="truncate">{t.empleado ?? t.usuario}</span>
              <span className="shrink-0 text-muted-foreground">desde {hora(t.inicio)}</span>
            </p>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label>Mensaje (opcional)</Label>
          <Textarea
            rows={3}
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            placeholder="Ej: ya cumplieron la jornada, finalicen el turno por favor"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={trabajando}>Cancelar</Button>
          <Button disabled={!turnos.length || trabajando} onClick={() => void enviar()}>
            {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Megaphone className="size-4" />} Enviar a {turnos.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Categorías del panel de alarmas (para filtrar y para el ícono y color). */
const CATEGORIAS = {
  tiempo: { l: "Tiempo", icono: AlarmClock, color: "border-l-red-500", tipos: ["turno_excedido", "extra_excedida", "extra_autorizada"] },
  avisos: { l: "Zumbidos y cierres", icono: BellRing, color: "border-l-sky-500", tipos: ["aviso_finalizar", "cierre_autorizado"] },
  lugar: {
    l: "Lugar y equipo",
    icono: MapPin,
    color: "border-l-amber-500",
    tipos: [
      "fuera_de_rango",
      "sin_ubicacion",
      "ubicacion_desactivada",
      "dispositivo_no_autorizado",
      "inicio_bloqueado",
      "inicio_fuera_de_regla",
      "cierre_bloqueado",
      "cierre_otro_dispositivo",
      "cierre_fuera_de_regla",
    ],
  },
  bio: { l: "Biométrico", icono: Fingerprint, color: "border-l-violet-500", tipos: [] as string[] },
} as const;
type Categoria = keyof typeof CATEGORIAS;
const categoria = (tipo: string): Categoria =>
  tipo.startsWith("bio_")
    ? "bio"
    : ((Object.keys(CATEGORIAS) as Categoria[]).find((k) => (CATEGORIAS[k].tipos as readonly string[]).includes(tipo)) ?? "lugar");
const RANGO_SEVERIDAD = { alta: 0, media: 1, info: 2 } as const;
function haceCuanto(iso: string) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h ${min % 60 ? `${min % 60} min` : ""}`.trim();
  return fechaHora(iso);
}

/** Panel de alarmas: filtros por estado, categoría y persona; abiertas y graves primero; con desplazamiento. */
function PanelAlarmas({
  alarmas,
  cargando,
  puedeGestionar,
  nombre,
  onAtender,
  onPersona,
}: {
  alarmas: Alarma[];
  cargando: boolean;
  puedeGestionar: boolean;
  nombre: (a: Alarma) => string;
  onAtender: (ids: string[]) => Promise<void>;
  onPersona: (n: string) => void;
}) {
  const [estado, setEstado] = useState<"abierta" | "atendida" | "informativa" | "todas">("abierta");
  const [cat, setCat] = useState<Categoria | "todas">("todas");
  const [q, setQ] = useState("");
  const [orden, setOrden] = useState<"gravedad" | "recientes">("gravedad");
  const [atendiendo, setAtendiendo] = useState(false);

  const porEstado = (e: typeof estado) => alarmas.filter((a) => e === "todas" || a.estado === e);
  const visibles = useMemo(() => {
    const t = norm(q.trim());
    return porEstado(estado)
      .filter((a) => (cat === "todas" || categoria(a.tipo) === cat) && (!t || norm(`${nombre(a)} ${a.detalle} ${a.employees?.document ?? ""}`).includes(t)))
      .sort((a, b) =>
        orden === "recientes"
          ? Date.parse(b.ultima_at) - Date.parse(a.ultima_at)
          : Number(b.estado === "abierta") - Number(a.estado === "abierta") ||
            RANGO_SEVERIDAD[a.severidad] - RANGO_SEVERIDAD[b.severidad] ||
            Date.parse(b.ultima_at) - Date.parse(a.ultima_at),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alarmas, estado, cat, q, orden]);
  const abiertasVisibles = visibles.filter((a) => a.estado === "abierta");
  const ESTADOS_PANEL = [
    { k: "abierta", t: "Abiertas" },
    { k: "atendida", t: "Atendidas" },
    { k: "informativa", t: "Registro" },
    { k: "todas", t: "Todas" },
  ] as const;

  async function atenderTodas() {
    if (!confirm(`¿Marcar como atendidas las ${abiertasVisibles.length} alarmas abiertas que se ven en el panel?`)) return;
    setAtendiendo(true);
    await onAtender(abiertasVisibles.map((a) => a.id));
    setAtendiendo(false);
  }

  return (
    <Card className="flex h-fit flex-col gap-2 p-3 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)]">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <BellRing className="size-4 text-destructive" /> Alarmas
        </p>
        <Badge variant={porEstado("abierta").length ? "destructive" : "secondary"}>{porEstado("abierta").length} abiertas</Badge>
      </div>

      <div className="grid grid-cols-4 gap-1 rounded-md bg-muted p-1">
        {ESTADOS_PANEL.map((e) => (
          <button
            key={e.k}
            type="button"
            onClick={() => setEstado(e.k)}
            className={cn(
              "rounded px-1 py-1 text-[11px] font-medium text-muted-foreground transition-colors",
              estado === e.k && "bg-background text-foreground shadow-sm",
            )}
          >
            {e.t}
            <span className="ml-1 tabular-nums opacity-70">{porEstado(e.k).length}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setCat("todas")}
          className={cn("rounded-full border px-2 py-0.5 text-[11px]", cat === "todas" && "border-primary bg-primary/10 font-medium")}
        >
          Todas
        </button>
        {(Object.keys(CATEGORIAS) as Categoria[]).map((k) => {
          const C = CATEGORIAS[k];
          const n = porEstado(estado).filter((a) => categoria(a.tipo) === k).length;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setCat(k)}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                cat === k && "border-primary bg-primary/10 font-medium",
                !n && "opacity-50",
              )}
            >
              <C.icono className="size-3" /> {C.l} <span className="tabular-nums">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex gap-1">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-7 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Persona, cédula o texto" />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2 text-[11px]"
          title="Cambiar el orden"
          onClick={() => setOrden((o) => (o === "gravedad" ? "recientes" : "gravedad"))}
        >
          {orden === "gravedad" ? "Graves primero" : "Recientes primero"}
        </Button>
      </div>

      {puedeGestionar && abiertasVisibles.length > 1 ? (
        <Button size="sm" variant="ghost" className="h-7 justify-start text-xs" disabled={atendiendo} onClick={() => void atenderTodas()}>
          {atendiendo ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />} Marcar atendidas las{" "}
          {abiertasVisibles.length} abiertas visibles
        </Button>
      ) : null}

      {cargando ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          <Loader2 className="mr-1 inline size-3.5 animate-spin" />
          Cargando…
        </p>
      ) : !visibles.length ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {alarmas.length ? "Ninguna alarma con estos filtros." : "Sin alarmas en este periodo."}
        </p>
      ) : (
        <ol className="max-h-[32rem] min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-1 xl:max-h-none">
          {visibles.map((a) => {
            const C = CATEGORIAS[categoria(a.tipo)];
            const abierta = a.estado === "abierta";
            const quien = nombre(a);
            return (
              <li
                key={a.id}
                className={cn(
                  "rounded-md border border-l-4 bg-card p-2 text-xs",
                  C.color,
                  abierta && a.severidad === "alta" && "bg-destructive/5",
                  !abierta && "opacity-75",
                )}
              >
                <div className="flex items-start gap-2">
                  <C.icono className={cn("mt-0.5 size-3.5 shrink-0", abierta && a.severidad === "alta" ? "text-destructive" : "text-muted-foreground")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold">
                        {ALARMAS[a.tipo] ?? a.tipo}
                        {a.repeticiones > 1 ? <span className="ml-1 font-normal text-muted-foreground">×{a.repeticiones}</span> : null}
                      </p>
                      <span className="shrink-0 text-[11px] text-muted-foreground" title={fechaHora(a.ultima_at)}>
                        {haceCuanto(a.ultima_at)}
                      </span>
                    </div>
                    {quien ? (
                      <button
                        type="button"
                        className="max-w-full truncate text-left text-[11px] font-medium text-primary hover:underline"
                        title="Ver su turno en la tabla"
                        onClick={() => onPersona(quien)}
                      >
                        {quien}
                      </button>
                    ) : null}
                    <p className="line-clamp-3 text-muted-foreground" title={a.detalle}>
                      {a.detalle}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {abierta ? (a.severidad === "alta" ? "Abierta · alta" : "Abierta") : a.estado === "atendida" ? "Atendida" : "Registro"}
                      </span>
                      {abierta && puedeGestionar ? (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void onAtender([a.id])}>
                          <CheckCheck className="size-3" /> Atendida
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
