import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, LogOut, MapPin, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
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

type TurnoAbierto = { id: string; started_at: string };
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
        .select("id, started_at")
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

  useEffect(() => {
    if (!turno) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [turno]);

  if (!visible || abierto.isLoading) return null;

  async function registrar(fn: "iniciar_turno" | "finalizar_turno") {
    setTrabajando(true);
    try {
      const datos = await datosRegistro();
      const { data, error } = await rpc(fn, { _datos: datos });
      if (error) throw new Error(error.message);
      const r = data as { started_at: string; ended_at: string | null };
      const sinUbicacion = (datos.ubicacion as { estado?: string }).estado !== "ok";
      if (fn === "iniciar_turno")
        toast.success(`Turno iniciado a las ${hora(r.started_at)}`, {
          description: sinUbicacion
            ? "Quedó registrado sin ubicación: permite la ubicación del navegador para el próximo registro."
            : "Recuerda: el inicio debe ser después de marcar la huella de entrada.",
        });
      else
        toast.success(`Turno finalizado a las ${hora(r.ended_at ?? new Date().toISOString())}`, {
          description: `Duración: ${duracion(Date.parse(r.ended_at ?? "") - Date.parse(r.started_at))}. Marca la huella de salida después.`,
        });
      setConfirmar(false);
      await qc.invalidateQueries({ queryKey: ["mi-turno"] });
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

      <Dialog open={confirmar} onOpenChange={(v) => !trabajando && setConfirmar(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>¿Finalizar tu turno?</DialogTitle>
            <DialogDescription>
              {turno
                ? `Iniciaste a las ${hora(turno.started_at)} · llevas ${duracion(ahora - Date.parse(turno.started_at))}.`
                : ""}{" "}
              Se registra la hora del servidor, este equipo y tu ubicación. Después marca la huella
              de salida.
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
