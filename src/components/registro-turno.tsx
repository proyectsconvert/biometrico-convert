import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlarmClock, BellRing, Loader2, LogOut, MapPin, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Roles que no registran turno (administran la plataforma). */
const ROLES_SIN_TURNO = ["super_admin", "admin", "nomina"];

type TurnoAbierto = { id: string; started_at: string; extra_autorizada_hasta: string | null };
/** Aviso emergente: «tiempo excedido» (automático) o «finalizar turno» enviado por supervisión o Nómina. */
type Emergente = {
  id: string;
  titulo: string;
  items: string[];
  contador: number;
  ref: string | null;
  created_at: string;
  actor: { full_name: string | null } | null;
};
type Respuesta = { ok: boolean; motivo?: string; started_at?: string; ended_at?: string; advertencias?: string[] | null };

/**
 * Llave del dispositivo: se crea al iniciar el turno y queda solo en este navegador. La base guarda
 * su hash, así el turno únicamente se puede finalizar desde el mismo equipo y navegador.
 */
const CLAVE_LLAVE = "convertia.turno.llave";
function nuevaLlave() {
  const llave = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  try {
    localStorage.setItem(CLAVE_LLAVE, llave);
  } catch {
    /* sin almacenamiento: el cierre deberá autorizarlo el supervisor */
  }
  return llave;
}
function llaveGuardada() {
  try {
    return localStorage.getItem(CLAVE_LLAVE) ?? "";
  } catch {
    return "";
  }
}
type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;

type NavegadorExtendido = Navigator & {
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
    brands?: { brand: string; version: string }[];
    getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>>;
  };
  deviceMemory?: number;
  connection?: { effectiveType?: string; downlink?: number; type?: string };
};

/** Identificador del equipo: se crea una vez y queda en este navegador. */
function idEquipo() {
  try {
    let id = localStorage.getItem("convertia.equipo.id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("convertia.equipo.id", id);
    }
    return id;
  } catch {
    return "sin_almacenamiento";
  }
}

/** Todo lo que el navegador deja saber del equipo (la IP y el país los pone el servidor). */
async function datosEquipo() {
  const n = navigator as NavegadorExtendido;
  let alta: Record<string, unknown> = {};
  try {
    alta =
      (await n.userAgentData?.getHighEntropyValues?.([
        "platform",
        "platformVersion",
        "model",
        "architecture",
        "bitness",
      ])) ?? {};
  } catch {
    /* navegador sin client hints */
  }
  return {
    id: idEquipo(),
    navegador: n.userAgent,
    marcas: n.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(", "),
    plataforma: (alta["platform"] as string | undefined) ?? n.userAgentData?.platform ?? n.platform,
    version_so: alta["platformVersion"],
    modelo: alta["model"] || undefined,
    arquitectura: alta["architecture"]
      ? `${String(alta["architecture"])} ${String(alta["bitness"] ?? "")}`.trim()
      : undefined,
    movil: n.userAgentData?.mobile ?? /Mobi|Android/i.test(n.userAgent),
    idioma: n.language,
    zona_horaria: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pantalla: `${screen.width}x${screen.height}`,
    escala: window.devicePixelRatio,
    nucleos: n.hardwareConcurrency,
    memoria_gb: n.deviceMemory,
    tactil: n.maxTouchPoints,
    conexion: n.connection?.effectiveType,
  };
}

/** Ubicación del navegador (la persona debe permitirla); si no, queda el motivo. */
function ubicacion(): Promise<Record<string, unknown>> {
  if (!("geolocation" in navigator)) return Promise.resolve({ estado: "no_disponible" });
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          estado: "ok",
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          precision_m: Math.round(p.coords.accuracy),
          tomada: new Date(p.timestamp).toISOString(),
        }),
      (e) =>
        resolve({
          estado: e.code === 1 ? "denegada" : e.code === 3 ? "tiempo_agotado" : "no_disponible",
          detalle: e.message,
        }),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    ),
  );
}

async function datosRegistro() {
  const [equipo, ub] = await Promise.all([datosEquipo(), ubicacion()]);
  return {
    equipo,
    ubicacion: ub,
    hora_equipo: new Date().toISOString(),
    pagina: location.pathname,
  };
}

/** Pitido corto con Web Audio (el navegador puede bloquearlo si no ha habido ningún clic en la página). */
function sonarAlarma() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.3);
    });
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    /* sin audio */
  }
}

/** Notificación del sistema operativo (si la persona la permitió); sirve con la página en segundo plano. */
function notificarSistema(a: Emergente) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(a.titulo, { body: a.items[0] ?? "", tag: `turno-${a.id}`, requireInteraction: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* navegador sin notificaciones */
  }
}
function pedirPermisoNotificaciones() {
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    /* sin soporte */
  }
}

const duracion = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });

/**
 * Botón flotante para iniciar y finalizar el turno. Lo ven todos los roles, excepto Super
 * Administrador, Administrador y Nómina. La hora la pone el servidor.
 */
export function RegistroTurno() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [trabajando, setTrabajando] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const [ahora, setAhora] = useState(() => Date.now());

  const visible =
    !acceso.loading &&
    Boolean(acceso.tenantId) &&
    !acceso.isSuperAdmin &&
    !acceso.roleCodes.some((r) => ROLES_SIN_TURNO.includes(r));

  const abierto = useQuery({
    queryKey: ["mi-turno", acceso.userId],
    enabled: visible,
    queryFn: async () => {
      const consulta: PromiseLike<{ data: unknown; error: { message: string } | null }> = supabase
        .from("work_sessions" as never)
        .select("id, started_at, extra_autorizada_hasta")
        .eq("user_id", acceso.userId)
        .is("ended_at", null)
        .maybeSingle();
      const { data, error } = await consulta;
      if (error) throw new Error(error.message);
      return (data as TurnoAbierto | null) ?? null;
    },
    refetchOnWindowFocus: true,
  });
  const turno = abierto.data ?? null;

  // Avisos emergentes pendientes: el servidor los crea al pasar el tiempo (y los repite) o cuando
  // supervisión / Nómina piden finalizar. Se consultan cada 8 s con turno abierto (60 s sin turno), también
  // con la pestaña en segundo plano.
  const avisos = useQuery({
    queryKey: ["avisos-emergentes", acceso.userId],
    enabled: visible,
    refetchInterval: turno ? 8_000 : 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const consulta: PromiseLike<{ data: unknown; error: { message: string } | null }> = supabase
        .from("notifications" as never)
        .select("id, titulo, items, contador, ref, created_at, actor:actor_id(full_name)")
        .eq("emergente", true)
        .is("confirmada_at", null)
        .order("created_at", { ascending: false })
        .limit(5);
      const { data, error } = await consulta;
      if (error) throw new Error(error.message);
      return (data as Emergente[] | null) ?? [];
    },
  });
  const pendientes = avisos.data ?? [];
  const vistos = useRef(new Set<string>());
  // Zumbido (como Messenger): sonido + sacudida de la ventana + vibración en equipos que la soportan
  const [sacudir, setSacudir] = useState(0);
  const zumbar = () => {
    sonarAlarma();
    setSacudir((n) => n + 1);
    try {
      navigator.vibrate?.([200, 100, 200, 100, 200]);
    } catch {
      /* sin vibración */
    }
  };
  const clavesPendientes = pendientes.map((a) => `${a.id}:${a.created_at}`).join("|");
  useEffect(() => {
    const nuevos = pendientes.filter((a) => !vistos.current.has(`${a.id}:${a.created_at}`));
    if (!nuevos.length) return;
    nuevos.forEach((a) => vistos.current.add(`${a.id}:${a.created_at}`));
    zumbar();
    if (document.hidden) nuevos.forEach(notificarSistema);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clavesPendientes]);
  // Título de la pestaña parpadeando mientras haya un aviso sin atender
  const hayPendientes = pendientes.length > 0;
  useEffect(() => {
    if (!hayPendientes) return;
    const t = setInterval(zumbar, 60_000);
    return () => clearInterval(t);
  }, [hayPendientes]);
  useEffect(() => {
    if (!hayPendientes) return;
    const original = document.title;
    let alterna = false;
    const t = setInterval(() => {
      alterna = !alterna;
      document.title = alterna ? "⚠ Finaliza tu turno" : original;
    }, 1000);
    return () => {
      clearInterval(t);
      document.title = original;
    };
  }, [hayPendientes]);
  const [confirmando, setConfirmando] = useState(false);
  async function entendido(abrirFinalizar: boolean) {
    setConfirmando(true);
    const { error } = await rpc("confirmar_avisos_emergentes", { _ids: pendientes.map((a) => a.id) });
    setConfirmando(false);
    if (error) toast.error("No se pudo confirmar el aviso", { description: error.message });
    await qc.invalidateQueries({ queryKey: ["avisos-emergentes"] });
    void qc.invalidateQueries({ queryKey: ["notificaciones"] });
    if (abrirFinalizar) setConfirmar(true);
  }

  useEffect(() => {
    if (!turno) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [turno]);

  // La ubicación solo se toma al iniciar y al finalizar. Si está apagada o bloqueada, no se registra:
  // se explica cómo activarla y se vuelve a pedir (y se reintenta solo si el navegador da el permiso).
  const [pedirUbicacion, setPedirUbicacion] = useState<{ fn: "iniciar_turno" | "finalizar_turno"; estado: string } | null>(null);
  const reintentar = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!pedirUbicacion || !navigator.permissions) return;
    let estado: PermissionStatus | undefined;
    let vivo = true;
    void navigator.permissions
      .query({ name: "geolocation" })
      .then((p) => {
        if (!vivo) return;
        estado = p;
        p.onchange = () => {
          if (p.state === "granted") reintentar.current();
        };
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
      if (estado) estado.onchange = null;
    };
  }, [pedirUbicacion]);

  if (!visible || abierto.isLoading) return null;

  async function registrar(fn: "iniciar_turno" | "finalizar_turno") {
    // Permiso para avisarle con notificaciones del sistema si pasa su tiempo (aprovecha el clic)
    if (fn === "iniciar_turno") pedirPermisoNotificaciones();
    setTrabajando(true);
    try {
      const datos = await datosRegistro();
      const estadoUbicacion = (datos.ubicacion as { estado?: string }).estado ?? "no_disponible";
      if (estadoUbicacion !== "ok") {
        setConfirmar(false);
        reintentar.current = () => void registrar(fn);
        setPedirUbicacion({ fn, estado: estadoUbicacion });
        return;
      }
      setPedirUbicacion(null);
      const llave = fn === "iniciar_turno" ? nuevaLlave() : llaveGuardada();
      const { data, error } = await rpc(fn, { _datos: datos, _token: llave });
      if (error) throw new Error(error.message);
      const r = data as Respuesta;
      // La base valida la regla (IP, ubicación, dispositivo, mismo equipo) y explica el bloqueo
      if (!r.ok) {
        toast.error(fn === "iniciar_turno" ? "No se pudo iniciar el turno" : "No se pudo finalizar el turno", {
          description: r.motivo ?? "Intenta de nuevo.",
          duration: 10_000,
        });
        void qc.invalidateQueries({ queryKey: ["mi-turno"] });
        return;
      }
      const avisos = (r.advertencias ?? []).filter(Boolean);
      if (fn === "iniciar_turno")
        toast.success(`Turno iniciado a las ${hora(r.started_at ?? new Date().toISOString())}`, {
          description: avisos.length
            ? `Quedó registrado con observaciones: ${avisos.join("; ")}.`
            : "Recuerda: el inicio debe ser después de marcar la huella de entrada. Finaliza desde este mismo equipo.",
        });
      else
        toast.success(`Turno finalizado a las ${hora(r.ended_at ?? new Date().toISOString())}`, {
          description: `Duración: ${duracion(Date.parse(r.ended_at ?? "") - Date.parse(r.started_at ?? ""))}. Marca la huella de salida después.`,
        });
      setConfirmar(false);
      await qc.invalidateQueries({ queryKey: ["mi-turno"] });
      void qc.invalidateQueries({ queryKey: ["avisos-emergentes"] });
      void qc.invalidateQueries({ queryKey: ["registro-turnos"] });
    } catch (e) {
      toast.error("No se pudo registrar el turno", { description: (e as Error).message });
      void qc.invalidateQueries({ queryKey: ["mi-turno"] });
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <>
      <div className="fixed bottom-4 right-4 z-40 sm:bottom-5 sm:right-5">
        {turno ? (
          <div className="flex items-center gap-2 rounded-full border bg-card/95 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
            </span>
            <div className="leading-tight">
              <p className="text-[11px] text-muted-foreground">
                En turno desde {hora(turno.started_at)}
                {turno.extra_autorizada_hasta ? ` · extra hasta ${hora(turno.extra_autorizada_hasta)}` : ""}
              </p>
              <p className="font-mono text-sm font-medium tabular-nums">
                {duracion(ahora - Date.parse(turno.started_at))}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={trabajando}
              onClick={() => setConfirmar(true)}
            >
              <LogOut className="size-4" /> Finalizar
            </Button>
          </div>
        ) : (
          <Button
            className="h-11 rounded-full px-5 shadow-lg"
            disabled={trabajando}
            onClick={() => void registrar("iniciar_turno")}
            title="Registra la hora de inicio, el equipo y la ubicación"
          >
            {trabajando ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {trabajando ? "Registrando…" : "Iniciar turno"}
          </Button>
        )}
      </div>

      <Dialog open={pendientes.length > 0 && !confirmar && !pedirUbicacion} onOpenChange={(v) => !v && !confirmando && void entendido(false)}>
        <DialogContent
          key={sacudir}
          className={cn("border-2 border-destructive/60 shadow-2xl sm:max-w-md", sacudir > 0 && "animate-zumbido")}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex justify-center pt-2">
            <span className="relative flex size-20 items-center justify-center">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/25" />
              <span className="relative flex size-20 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-lg">
                <BellRing className="size-10 animate-campana" />
              </span>
            </span>
          </div>
          <DialogHeader className="items-center text-center sm:text-center">
            <DialogTitle className="flex items-center gap-2 text-xl text-destructive">
              <AlarmClock className="size-5" />
              {pendientes[0]?.titulo ?? "Aviso de turno"}
            </DialogTitle>
            <DialogDescription>
              <span className="mr-1 inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                <BellRing className="size-3" /> ¡Zumbido!
              </span>
              {turno ? `Iniciaste a las ${hora(turno.started_at)} · llevas ${duracion(ahora - Date.parse(turno.started_at))}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {pendientes.map((a) => (
              <div key={a.id} className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                {pendientes.length > 1 ? <p className="font-medium">{a.titulo}</p> : null}
                {a.items.map((l, i) => (
                  <p key={i}>{l}</p>
                ))}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {hora(a.created_at)}
                  {a.actor?.full_name ? ` · enviado por ${a.actor.full_name}` : " · aviso automático"}
                  {a.contador > 1 ? ` · aviso n.º ${a.contador}` : ""}
                </p>
              </div>
            ))}
          </div>
          {typeof Notification !== "undefined" && Notification.permission === "default" ? (
            <button type="button" className="flex items-center gap-1 text-left text-xs text-primary hover:underline" onClick={pedirPermisoNotificaciones}>
              <BellRing className="size-3.5" /> Activar notificaciones del sistema para recibir estos avisos aunque estés en otra pestaña
            </button>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={confirmando} onClick={() => void entendido(false)}>
              Entendido
            </Button>
            {turno ? (
              <Button variant="destructive" disabled={confirmando} onClick={() => void entendido(true)}>
                <LogOut className="size-4" /> Finalizar turno ahora
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pedirUbicacion)} onOpenChange={(v) => !v && !trabajando && setPedirUbicacion(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="size-5 text-destructive" />
              Activa tu ubicación para {pedirUbicacion?.fn === "finalizar_turno" ? "finalizar" : "iniciar"} el turno
            </DialogTitle>
            <DialogDescription>
              La ubicación se toma solo en este momento (al iniciar y al finalizar), no durante el turno.
            </DialogDescription>
          </DialogHeader>
          {pedirUbicacion?.estado === "denegada" ? (
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>
                Haz clic en el ícono que está a la izquierda de la dirección de la página (candado o <b>ⓘ</b>).
              </li>
              <li>
                En <b>Ubicación</b> elige <b>Permitir</b>.
              </li>
              <li>
                Pulsa <b>Reintentar</b> (si el navegador lo pide, recarga la página).
              </li>
            </ol>
          ) : (
            <p className="text-sm">
              No se pudo obtener tu ubicación. Verifica que la ubicación del equipo esté activada (en Windows: Configuración → Privacidad y
              seguridad → Ubicación) y pulsa <b>Reintentar</b>.
            </p>
          )}
          {pedirUbicacion?.fn === "finalizar_turno" ? (
            <p className="text-xs text-muted-foreground">Si no logras activarla, pide a tu supervisor un cierre autorizado.</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={trabajando} onClick={() => setPedirUbicacion(null)}>
              Cancelar
            </Button>
            <Button disabled={trabajando} onClick={() => pedirUbicacion && void registrar(pedirUbicacion.fn)}>
              {trabajando ? <Loader2 className="size-4 animate-spin" /> : <MapPin className="size-4" />} Reintentar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmar} onOpenChange={(v) => !trabajando && setConfirmar(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>¿Finalizar tu turno?</DialogTitle>
            <DialogDescription>
              {turno
                ? `Iniciaste a las ${hora(turno.started_at)} · llevas ${duracion(ahora - Date.parse(turno.started_at))}.`
                : ""}{" "}
              Se registra la hora del servidor, este equipo y tu ubicación. Solo puedes finalizar desde el
              mismo equipo y navegador donde iniciaste. Después marca la huella de salida.
            </DialogDescription>
          </DialogHeader>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <MapPin className="size-3.5" /> Si el navegador lo pide, permite la ubicación.
          </p>
          <DialogFooter>
            <Button variant="outline" disabled={trabajando} onClick={() => setConfirmar(false)}>
              Seguir en turno
            </Button>
            <Button
              variant="destructive"
              disabled={trabajando}
              onClick={() => void registrar("finalizar_turno")}
            >
              {trabajando ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
              Finalizar turno
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
