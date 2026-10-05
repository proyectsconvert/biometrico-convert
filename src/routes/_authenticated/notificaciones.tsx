import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCheck, Trash2 } from "lucide-react";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { PageHeader } from "@/components/app-shell";
import {
  SELECT_NOTIFICACION,
  TIPOS_NOTIFICACION,
  TarjetaNotificacion,
  marcarLeidas,
  type Notificacion,
} from "@/components/notificaciones";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/notificaciones")({
  head: () => ({ meta: [{ title: "Notificaciones — Convert-IA" }] }),
  component: Notificaciones,
});

function Notificaciones() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [vista, setVista] = useState<"sin-leer" | "todas">("sin-leer");
  const [tipo, setTipo] = useState("todos");

  const lista = useQuery({
    queryKey: ["notificaciones", "lista", acceso.userId],
    queryFn: async () => {
      const { data, error } = await dbAny
        .from("notifications")
        .select(SELECT_NOTIFICACION)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as Notificacion[];
    },
  });
  const refrescar = () => void qc.invalidateQueries({ queryKey: ["notificaciones"] });

  const filas = useMemo(
    () =>
      (lista.data ?? []).filter(
        (n) => (vista === "todas" || !n.leida_at) && (tipo === "todos" || n.tipo === tipo),
      ),
    [lista.data, vista, tipo],
  );
  const sinLeer = (lista.data ?? []).filter((n) => !n.leida_at).length;

  async function abrir(n: Notificacion) {
    if (!n.leida_at) await marcarLeidas([n.id]).catch(() => undefined);
    refrescar();
    if (n.enlace) void navigate({ href: n.enlace });
  }

  async function borrarLeidas() {
    if (!confirm("¿Borrar todas las notificaciones leídas?")) return;
    const { error } = await dbAny.from("notifications").delete().not("leida_at", "is", null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Notificaciones leídas borradas");
    refrescar();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        titulo="Notificaciones"
        descripcion="Avisos de tu rol: solicitudes de empleados, cambios de personal de tus campañas y revisión de novedades."
        acciones={
          <>
            <Button
              variant="outline"
              disabled={!sinLeer}
              onClick={() => void marcarLeidas(null).then(refrescar)}
            >
              <CheckCheck className="size-4" /> Marcar todas como leídas
            </Button>
            <Button variant="ghost" onClick={() => void borrarLeidas()}>
              <Trash2 className="size-4" /> Borrar leídas
            </Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs value={vista} onValueChange={(v) => setVista(v as typeof vista)}>
          <TabsList>
            <TabsTrigger value="sin-leer">Sin leer ({sinLeer})</TabsTrigger>
            <TabsTrigger value="todas">Todas</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={tipo} onValueChange={setTipo}>
          <SelectTrigger className="w-60" aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los tipos</SelectItem>
            {Object.entries(TIPOS_NOTIFICACION).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v.etiqueta}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card className="divide-y p-1">
        {lista.isLoading ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : filas.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {vista === "sin-leer"
              ? "No tienes notificaciones sin leer."
              : "No tienes notificaciones."}
          </p>
        ) : (
          filas.map((n) => <TarjetaNotificacion key={n.id} n={n} onAbrir={(x) => void abrir(x)} />)
        )}
      </Card>
    </div>
  );
}
