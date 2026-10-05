import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, History, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { haceCuanto } from "@/components/notificaciones";

type Cambio = {
  created_at: string;
  usuario: string;
  accion: string;
  antes: Record<string, unknown> | null;
  despues: Record<string, unknown> | null;
};

const CAMPOS: Record<string, string> = {
  novelty_type: "novedad",
  status: "estado",
  notes: "notas",
  source: "origen",
  novedad: "novedad",
  shift_id: "horario",
  nota: "nota",
  origen: "origen",
};
const VERBO: Record<string, string> = { crear: "Creó", editar: "Cambió", eliminar: "Eliminó" };
const valor = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "(vacío)"
    : typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)
      ? "otro"
      : String(v).slice(0, 60);

function detalle(c: Cambio) {
  const op = c.accion.split("_")[0] ?? "";
  if (op === "editar" && c.antes && c.despues) {
    return Object.keys(c.despues)
      .filter((k) => CAMPOS[k])
      .map((k) => `${CAMPOS[k]}: ${valor(c.antes?.[k])} → ${valor(c.despues?.[k])}`)
      .join(" · ");
  }
  const reg = (op === "eliminar" ? c.antes : c.despues) ?? {};
  return Object.entries(reg)
    .filter(([k, v]) => CAMPOS[k] && v !== null && v !== "" && k !== "shift_id")
    .map(([k, v]) => `${CAMPOS[k]}: ${valor(v)}`)
    .join(" · ");
}

/** Quién creó o cambió el dato de un día, cuándo y qué tenía antes (desde la auditoría). */
export function HistorialCambios({
  tabla,
  clave,
}: {
  tabla: "novelty_entries" | "shift_schedule";
  clave: Record<string, string>;
}) {
  const [abierto, setAbierto] = useState(false);
  const lista = useQuery({
    queryKey: ["historial-cambios", tabla, clave],
    enabled: abierto,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "historial_cambios" as never,
        { _tabla: tabla, _clave: clave } as never,
      );
      if (error) throw error;
      return (data ?? []) as Cambio[];
    },
  });
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setAbierto(!abierto)}
        className="flex items-center gap-1 font-medium hover:text-primary"
      >
        {abierto ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <History className="size-4" /> Historial de cambios
      </button>
      {abierto ? (
        lista.isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">
            <Loader2 className="mr-1 inline size-3 animate-spin" />
            Cargando…
          </p>
        ) : lista.error ? (
          <p className="mt-2 text-xs text-destructive">{(lista.error as Error).message}</p>
        ) : !lista.data?.length ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Sin cambios registrados para este día.
          </p>
        ) : (
          <ol className="mt-2 max-h-48 space-y-1.5 overflow-y-auto border-l pl-3">
            {lista.data.map((c, i) => (
              <li key={i} className="text-xs">
                <span className="font-medium">{c.usuario}</span> ·{" "}
                {VERBO[c.accion.split("_")[0] ?? ""] ?? c.accion}
                {c.accion.endsWith("_masivo") ? " (carga masiva)" : ""} ·{" "}
                <span className="text-muted-foreground">{haceCuanto(c.created_at)}</span>
                {detalle(c) ? <p className="text-muted-foreground">{detalle(c)}</p> : null}
              </li>
            ))}
          </ol>
        )
      ) : null}
    </div>
  );
}
