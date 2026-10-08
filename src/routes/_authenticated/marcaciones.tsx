import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Loader2, Search, X } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { useFiltroCampanaPersonas } from "@/lib/filtro-personas";
import { FILTRO_PERSONAL_INICIAL, FiltrosPersonal, type FiltroPersonal } from "@/components/filtros-personal";

export const Route = createFileRoute("/_authenticated/marcaciones")({
  head: () => ({ meta: [{ title: "Marcaciones — Convert-IA" }] }),
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
  campaign_id: string | null;
  campaign_name: string | null;
  cost_center_name: string | null;
  en_reportes: boolean;
};

const hoy = () => new Date().toISOString().slice(0, 10);

const COLS =
  "id, event_at, device_name, door, document, biometric_name, event_type, is_attendance, is_duplicate, employer_name, campaign_id, campaign_name, cost_center_name, en_reportes";

function Marcaciones() {
  const acceso = useAccess();
  const [desde, setDesde] = useState(hoy());
  const [hasta, setHasta] = useState(hoy());
  const [campanasSel, setCampanasSel] = useState<string[]>([]);
  const [personasSel, setPersonasSel] = useState<string[]>([]);
  const [fp, setFp] = useState<FiltroPersonal>(FILTRO_PERSONAL_INICIAL);
  const [texto, setTexto] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [soloValidas, setSoloValidas] = useState(true);
  const [conExcluidos, setConExcluidos] = useState(false);
  const [anclado, setAnclado] = useState(false);
  const [exportando, setExportando] = useState(false);

  // Cargar campañas para selector
  const campanas = useQuery({
    queryKey: ["campaigns", "opciones"],
    queryFn: async () => {
      const { data } = await dbAny.from("campaigns").select("id, name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });


  const todasCampanas = (campanas.data ?? []).map((c) => ({ value: c.id, label: c.name }));
  // Campañas y personas coherentes entre sí y en orden alfabético
  const { opcionesCampanas, opcionesPersonas, placeholderCampanas, placeholderPersonas, opcionesCargos, opcionesJefes, personasConsulta } = useFiltroCampanaPersonas({
    opcionesCampanas: todasCampanas,
    campanas: campanasSel,
    personas: personasSel,
    alCambiarPersonas: setPersonasSel,
    cargos: fp.cargos,
    jefes: fp.jefes,
    incluirInactivos: fp.incluirInactivos,
    desde,
  });
  // La búsqueda libre filtra mientras se escribe
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(texto), 400);
    return () => clearTimeout(t);
  }, [texto]);

  // Abrir en el último día con eventos
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
    if (ultimo.data) {
      setDesde(ultimo.data);
      setHasta(ultimo.data);
    }
  }, [anclado, ultimo.isSuccess, ultimo.data]);

  const [pagina, setPagina] = useState(0);
  const [tamano, setTamano] = useState(50);

  useEffect(() => {
    setPagina(0);
  }, [desde, hasta, campanasSel, personasConsulta, busqueda, soloValidas, conExcluidos]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtrar = (q: any) => {
    q = q.gte("event_at", `${desde}T00:00:00`).lte("event_at", `${hasta}T23:59:59`);
    if (soloValidas) q = q.eq("is_attendance", true);
    if (!conExcluidos) q = q.eq("en_reportes", true);
    if (campanasSel.length > 0) q = q.in("campaign_id", campanasSel);
    if (personasConsulta.length > 0) q = q.in("document", personasConsulta);

    const t = busqueda.trim();
    if (t) {
      if (/^\d+$/.test(t)) {
        q = q.eq("document", t);
      } else {
        const clean = t.replace(/[%,()]/g, " ").trim();
        q = q.or(`biometric_name.ilike.%${clean}%,campaign_name.ilike.%${clean}%,device_name.ilike.%${clean}%,door.ilike.%${clean}%`);
      }
    }
    return q;
  };

  const lista = useQuery({
    queryKey: ["marcaciones", desde, hasta, campanasSel, personasConsulta, busqueda, soloValidas, conExcluidos, pagina, tamano],
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

  const hayFiltrosActivos =
    campanasSel.length > 0 ||
    personasSel.length > 0 ||
    fp.cargos.length > 0 ||
    fp.jefes.length > 0 ||
    Boolean(busqueda) ||
    !soloValidas ||
    conExcluidos;

  // Exporta el rango filtrado
  async function exportar() {
    setExportando(true);
    try {
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
        `marcaciones_${desde}_${hasta}`,
        todas.map((e) => ({
          fecha_hora: e.event_at.replace("T", " "),
          documento: e.document ?? "",
          nombre: e.biometric_name ?? "",
          campana: e.campaign_name ?? "",
          centro_costo: e.cost_center_name ?? "",
          empleador: e.employer_name ?? "",
          dispositivo: e.device_name ?? "",
          puerta: e.door ?? "",
          evento: e.event_type,
          cuenta_asistencia: e.is_attendance ? "Sí" : "No",
          duplicada: e.is_duplicate ? "Sí" : "No",
        })),
      );
    } finally {
      setExportando(false);
    }
  }

  return (
    <div>
      <PageHeader
        titulo="Marcaciones"
        descripcion="Historial completo de eventos del biométrico, filtrable por campaña, fechas, persona, centro de costo y dispositivo."
        acciones={
          acceso.can("marcaciones", "exportar") ? (
            <Button variant="outline" onClick={() => void exportar()} disabled={exportando || !lista.data?.total}>
              {exportando ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Exportar
            </Button>
          ) : null
        }
      />

      <Card className="mb-4 p-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setBusqueda(texto);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="desde">Desde</Label>
            <Input id="desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hasta">Hasta</Label>
            <Input id="hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Campañas</Label>
            <MultiSelectFilter
              title="Campañas"
              placeholder={placeholderCampanas}
              searchPlaceholder="Buscar campaña…"
              options={opcionesCampanas}
              selected={campanasSel}
              onChange={setCampanasSel}
              triggerClassName="w-48"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Personas</Label>
            <MultiSelectFilter
              title="Personas"
              placeholder={placeholderPersonas}
              searchPlaceholder="Buscar por cédula o nombre…"
              options={opcionesPersonas}
              selected={personasSel}
              onChange={setPersonasSel}
              triggerClassName="w-52"
              popoverWidth="w-[340px]"
            />
          </div>
          <FiltrosPersonal valor={fp} onChange={setFp} opcionesCargos={opcionesCargos} opcionesJefes={opcionesJefes} />
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="q">Búsqueda libre</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="q"
                className="pl-9"
                placeholder="Cédula, nombre, dispositivo, puerta…"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit"><Search className="size-4" /> Filtrar</Button>
            {hayFiltrosActivos && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setTexto("");
                  setBusqueda("");
                  setCampanasSel([]);
                  setPersonasSel([]);
                  setFp(FILTRO_PERSONAL_INICIAL);
                  setSoloValidas(true);
                  setConExcluidos(false);
                }}
              >
                <X className="size-4 mr-1" /> Limpiar
              </Button>
            )}
          </div>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-6 border-t pt-3">
          <div className="flex items-center gap-2">
            <Switch id="validas" checked={soloValidas} onCheckedChange={setSoloValidas} />
            <Label htmlFor="validas" className="cursor-pointer text-xs">Solo marcaciones válidas (asistencia)</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="excluidos" checked={conExcluidos} onCheckedChange={setConExcluidos} />
            <Label htmlFor="excluidos" className="cursor-pointer text-xs">Incluir personal excluido (seguridad, aseo…)</Label>
          </div>
        </div>
      </Card>

      <SimpleTable<Evento>
        cargando={lista.isLoading}
        filas={lista.data?.filas ?? []}
        getKey={(f) => String(f.id)}
        vacio="No hay eventos para los filtros seleccionados."
        columnas={[
          { key: "hora", header: "Fecha y hora", cell: (f) => f.event_at.replace("T", " ").slice(0, 19) },
          {
            key: "persona",
            header: "Persona",
            cell: (f) => (
              <div>
                <p className="font-medium">{f.biometric_name ?? "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {f.document ?? "sin documento"}
                  {f.campaign_name ? ` · ${f.campaign_name}` : ""}
                  {f.cost_center_name ? ` · ${f.cost_center_name}` : ""}
                </p>
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
          {
            key: "disp",
            header: "Dispositivo y puerta",
            cell: (f) => (
              <div className="text-xs">
                <p className="font-medium">{f.device_name ?? "—"}</p>
                {f.door && <p className="text-muted-foreground">{f.door}</p>}
              </div>
            ),
          },
          { key: "evento", header: "Evento", cell: (f) => f.event_type },
          {
            key: "estado",
            header: "Cuenta",
            cell: (f) =>
              f.is_duplicate ? (
                <Badge variant="secondary">duplicada</Badge>
              ) : f.is_attendance ? (
                <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">válida</Badge>
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
