import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, ClipboardList, Clock, Paperclip, UserCog, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type Notificacion = {
  id: string;
  tipo: string;
  titulo: string;
  items: string[];
  contador: number;
  enlace: string | null;
  leida_at: string | null;
  created_at: string;
  actor: { full_name: string | null } | null;
};

export const TIPOS_NOTIFICACION: Record<
  string,
  { etiqueta: string; icono: typeof Bell; color: string }
> = {
  solicitud: {
    etiqueta: "Solicitudes de empleados",
    icono: UserCog,
    color: "text-amber-600 bg-amber-500/10",
  },
  personal: { etiqueta: "Cambios de personal", icono: Users, color: "text-sky-600 bg-sky-500/10" },
  novedades: {
    etiqueta: "Novedades",
    icono: ClipboardList,
    color: "text-violet-600 bg-violet-500/10",
  },
  turnos: { etiqueta: "Turnos", icono: Clock, color: "text-emerald-600 bg-emerald-500/10" },
  evidencias: { etiqueta: "Comentarios y evidencias", icono: Paperclip, color: "text-rose-600 bg-rose-500/10" },
};

export const SELECT_NOTIFICACION =
  "id, tipo, titulo, items, contador, enlace, leida_at, created_at, actor:actor_id(full_name)";

export function haceCuanto(fecha: string) {
  const min = Math.round((Date.now() - new Date(fecha).getTime()) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return `hace ${d} ${d === 1 ? "día" : "días"}`;
  return new Date(fecha).toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export async function marcarLeidas(ids: string[] | null) {
  const { error } = await supabase.rpc(
    "marcar_notificaciones_leidas" as never,
    { _ids: ids } as never,
  );
  if (error) throw error;
}

/** Una notificación: título, primeras líneas del detalle y quién la generó. */
export function TarjetaNotificacion({
  n,
  onAbrir,
  compacta,
}: {
  n: Notificacion;
  onAbrir: (n: Notificacion) => void;
  compacta?: boolean;
}) {
  const tipo = TIPOS_NOTIFICACION[n.tipo] ?? {
    etiqueta: n.tipo,
    icono: Bell,
    color: "text-muted-foreground bg-muted",
  };
  const Icono = tipo.icono;
  const max = compacta ? 2 : 6;
  return (
    <button
      type="button"
      onClick={() => onAbrir(n)}
      className={cn(
        "flex w-full gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/60",
        !n.leida_at && "bg-primary/5",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
          tipo.color,
        )}
      >
        <Icono className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className={cn("text-sm", !n.leida_at && "font-semibold")}>{n.titulo}</span>
          {!n.leida_at ? (
            <span
              className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
              aria-label="Sin leer"
            />
          ) : null}
        </span>
        <span className="mt-0.5 block space-y-0.5">
          {n.items.slice(0, max).map((l, i) => (
            <span key={i} className="block truncate text-xs text-muted-foreground">
              {l}
            </span>
          ))}
          {n.contador > max ? (
            <span className="block text-xs text-muted-foreground">y {n.contador - max} más…</span>
          ) : null}
        </span>
        <span className="mt-1 block text-[11px] text-muted-foreground/80">
          {haceCuanto(n.created_at)}
          {n.actor?.full_name ? ` · ${n.actor.full_name}` : ""}
        </span>
      </span>
    </button>
  );
}

/** Campana del encabezado: cuenta lo no leído y muestra lo más reciente. */
export function CampanaNotificaciones() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [abierta, setAbierta] = useState(false);

  const sinLeer = useQuery({
    queryKey: ["notificaciones", "sin-leer", acceso.userId],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { count, error } = await dbAny
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .is("leida_at", null);
      if (error) throw error;
      return count ?? 0;
    },
  });
  const recientes = useQuery({
    queryKey: ["notificaciones", "recientes", acceso.userId],
    enabled: abierta,
    queryFn: async () => {
      const { data, error } = await dbAny
        .from("notifications")
        .select(SELECT_NOTIFICACION)
        .order("created_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      return (data ?? []) as unknown as Notificacion[];
    },
  });

  const refrescar = () => void qc.invalidateQueries({ queryKey: ["notificaciones"] });
  async function abrir(n: Notificacion) {
    if (!n.leida_at) await marcarLeidas([n.id]).catch(() => undefined);
    refrescar();
    setAbierta(false);
    if (n.enlace) void navigate({ href: n.enlace });
  }

  const total = sinLeer.data ?? 0;
  return (
    <Popover open={abierta} onOpenChange={setAbierta}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={total ? `Notificaciones: ${total} sin leer` : "Notificaciones"}
        >
          <Bell className="size-5" />
          {total > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground tabular-nums">
              {total > 99 ? "99+" : total}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-semibold">Notificaciones</p>
          {total > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void marcarLeidas(null).then(refrescar)}
            >
              <CheckCheck className="size-3.5" /> Marcar todas como leídas
            </Button>
          ) : null}
        </div>
        <div className="max-h-[420px] overflow-y-auto p-1">
          {recientes.isLoading ? (
            <p className="p-4 text-center text-xs text-muted-foreground">Cargando…</p>
          ) : !recientes.data?.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No tienes notificaciones.
            </p>
          ) : (
            recientes.data.map((n) => (
              <TarjetaNotificacion key={n.id} n={n} compacta onAbrir={(x) => void abrir(x)} />
            ))
          )}
        </div>
        <div className="border-t p-1">
          <Button variant="ghost" size="sm" className="w-full" asChild>
            <Link to="/notificaciones" onClick={() => setAbierta(false)}>
              Ver todas
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
