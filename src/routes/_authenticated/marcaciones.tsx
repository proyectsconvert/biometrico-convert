import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { descargarCsv } from "@/lib/biometria";
import { PageHeader } from "@/components/app-shell";
import { Paginador, SimpleTable } from "@/components/simple-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/_authenticated/marcaciones")({
  component: Marcaciones,
});

type Evento = {
  id: number;
  event_at: string;
  device_name: string | null;
  door: string | null;
  document: string | null;
  biometric_name: string | null;
  event_type: string;
  is_attendance: boolean;
  is_duplicate: boolean;
  employer_name: string | null;
  en_reportes: boolean;
};

const hoy = () => new Date().toISOString().slice(0, 10);

function Marcaciones() {
  const acceso = useAccess();
  const [fecha, setFecha] = useState(hoy());
  const [documento, setDocumento] = useState("");
  const [soloValidas, setSoloValidas] = useState(true);
  const [conExcluidos, setConExcluidos] = useState(false);
  const [anclado, setAnclado] = useState(false);

  // Abrir en el último día con eventos, no en «hoy»
  const ultimo = useQuery({
    queryKey: ["marcaciones", "ultimo-dia"],
    queryFn: async () => {
      const { data } = await dbAny.from("biometric_events").select("event_at").order("event_at", { ascending: false }).limit(1);
      return ((data?.[0] as { event_at?: string } | undefined)?.event_at ?? "").slice(0, 10) || null;
    },
  });
  useEffect(() => {
    if (anclado || !ultimo.isSuccess) return;
    setAnclado(true);
    if (ultimo.data) setFecha(ultimo.data);
  }, [anclado, ultimo.isSuccess, ultimo.data]);

  const [pagina, setPagina] = useState(0);
  const [tamano, setTamano] = useState(50);
  useEffect(() => setPagina(0), [fecha, documento, soloValidas, conExcluidos]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtrar = (q: any) => {
    q = q.gte("event_at", `${fecha}T00:00:00`).lte("event_at", `${fecha}T23:59:59`);
    if (soloValidas) q = q.eq("is_attendance", true);
    // El personal de empleadores excluidos (seguridad, aseo…) solo se ve si se pide
    if (!conExcluidos) q = q.eq("en_reportes", true);
    const t = documento.trim();
    if (t) q = /^\d+$/.test(t) ? q.eq("document", t) : q.ilike("biometric_name", `%${t.replace(/[%,()]/g, " ")}%`);
    return q;
  };
  const COLS =
    "id, event_at, device_name, door, document, biometric_name, event_type, is_attendance, is_duplicate, employer_name, en_reportes";

  const lista = useQuery({
    queryKey: ["marcaciones", fecha, documento, soloValidas, conExcluidos, pagina, tamano],
    enabled: anclado,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error, count } = await filtrar(dbAny.from("marcaciones_reporte").select(COLS, { count: "exact" }))
        .order("event_at", { ascending: false })
        .range(pagina * tamano, pagina * tamano + tamano - 1);
      if (error) throw error;
      return { filas: (data ?? []) as Evento[], total: count ?? 0 };
    },
  });

  // Exporta todo el día filtrado, no solo la página visible
  async function exportar() {
    const todas: Evento[] = [];
    for (let i = 0; i < 100; i++) {
      const { data, error } = await filtrar(dbAny.from("marcaciones_reporte").select(COLS))
        .order("event_at", { ascending: false })
        .range(i * 1000, i * 1000 + 999);
      if (error) throw error;
      todas.push(...((data ?? []) as Evento[]));
      if (!data || data.length < 1000) break;
    }
    descargarCsv(
      `marcaciones_${fecha}`,
      todas.map((e) => ({
        fecha_hora: e.event_at.replace("T", " "),
        documento: e.document ?? "",
        nombre: e.biometric_name ?? "",
        empleador: e.employer_name ?? "",
        dispositivo: e.device_name ?? "",
        puerta: e.door ?? "",
        evento: e.event_type,
        cuenta_asistencia: e.is_attendance ? "Sí" : "No",
        duplicada: e.is_duplicate ? "Sí" : "No",
      })),
    );
  }

  return (
    <div>
      <PageHeader
        titulo="Marcaciones"
        descripcion="Historial completo de eventos del biométrico, incluidos los que no cuentan como asistencia."
        acciones={
          acceso.can("marcaciones", "exportar") ? (
            <Button variant="outline" onClick={() => void exportar()} disabled={!lista.data?.total}>
              <Download className="size-4" /> Exportar
            </Button>
          ) : null
        }
      />

      <Card className="mb-4 flex flex-wrap items-end gap-4 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="fecha">Fecha</Label>
          <Input id="fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc">Documento o nombre</Label>
          <Input
            id="doc"
            placeholder="Todos"
            value={documento}
            onChange={(e) => setDocumento(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="validas" checked={soloValidas} onCheckedChange={setSoloValidas} />
          <Label htmlFor="validas">Solo marcaciones válidas</Label>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="excluidos" checked={conExcluidos} onCheckedChange={setConExcluidos} />
          <Label htmlFor="excluidos">Incluir personal excluido (seguridad, aseo…)</Label>
        </div>
      </Card>

      <SimpleTable<Evento>
        cargando={lista.isLoading}
        filas={lista.data?.filas ?? []}
        getKey={(f) => String(f.id)}
        vacio="No hay eventos para los filtros seleccionados."
        columnas={[
          { key: "hora", header: "Fecha y hora", cell: (f) => f.event_at.replace("T", " ") },
          {
            key: "persona",
            header: "Persona",
            cell: (f) => (
              <div>
                <p className="font-medium">{f.biometric_name ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{f.document ?? "sin documento"}</p>
              </div>
            ),
          },
          {
            key: "empleador",
            header: "Empleador",
            cell: (f) => (
              <span className={f.en_reportes ? "text-xs" : "text-xs text-muted-foreground line-through"}>
                {f.employer_name ?? (f.document ? "Sin empleador" : "—")}
              </span>
            ),
          },
          { key: "disp", header: "Dispositivo", cell: (f) => f.device_name ?? "—" },
          { key: "evento", header: "Evento", cell: (f) => f.event_type },
          {
            key: "estado",
            header: "Cuenta",
            cell: (f) =>
              f.is_duplicate ? (
                <Badge variant="secondary">duplicada</Badge>
              ) : f.is_attendance ? (
                <Badge>válida</Badge>
              ) : (
                <Badge variant="outline">historial</Badge>
              ),
          },
        ]}
      />
      <Paginador pagina={pagina} tamano={tamano} total={lista.data?.total ?? 0} onCambio={setPagina} onTamano={setTamano} opciones={[10, 20, 30, 40, 50, 100]} />
    </div>
  );
}
