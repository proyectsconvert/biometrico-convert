import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { AlertTriangle, Download, MapPin, MonitorSmartphone, Timer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccess } from "@/lib/session";
import { escribirLibro } from "@/lib/exportar";
import { PageHeader } from "@/components/app-shell";
import {
  Paginador,
  SimpleTable,
  ordenarFilas,
  usePaginado,
  type Orden,
} from "@/components/simple-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/registro-turnos")({
  head: () => ({ meta: [{ title: "Registro de turnos — Convert-IA" }] }),
  component: RegistroTurnos,
});

type Datos = {
  equipo?: Record<string, string | number | boolean | null | undefined>;
  ubicacion?: {
    estado?: string;
    lat?: number;
    lon?: number;
    precision_m?: number;
    detalle?: string;
  };
  red?: { ip?: string; pais?: string; ciudad?: string; region?: string };
  hora_equipo?: string;
  hora_servidor?: string;
};
type Fila = {
  id: string;
  fecha: string;
  usuario: string | null;
  email: string | null;
  documento: string | null;
  empleado: string | null;
  campana: string | null;
  inicio: string;
  fin: string | null;
  cierre: string | null;
  minutos_conectado: number | null;
  entrada_biometrico: string | null;
  salida_biometrico: string | null;
  minutos_en_empresa: number | null;
  minutos_inicio_vs_entrada: number | null;
  minutos_fin_vs_salida: number | null;
  alarmas: string[];
  avisos: string[];
  inicio_datos: Datos | null;
  fin_datos: Datos | null;
};

const ALARMAS: Record<string, string> = {
  inicio_antes_de_huella: "Inició antes de marcar la huella",
  fin_despues_de_salida: "Finalizó después de la salida",
  sin_huella: "Sin huella ese día",
  sin_cierre: "No finalizó el turno",
};
const AVISOS: Record<string, string> = {
  sin_empleado_vinculado: "Usuario sin empleado vinculado",
  biometrico_pendiente: "Biométrico del día aún no cargado",
  sin_ubicacion: "Sin ubicación",
  en_curso: "En curso",
};

const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
const restarDias = (f: string, d: number) =>
  new Date(Date.parse(`${f}T12:00:00Z`) - d * 864e5).toISOString().slice(0, 10);
const hm = (ts: string | null) => (ts ? ts.slice(11, 16) : "—");
const dur = (m: number | null) =>
  m == null ? "—" : `${Math.floor(Math.abs(m) / 60)}:${String(Math.abs(m) % 60).padStart(2, "0")}`;
/** «3 min antes» / «5 min después» de la huella. */
const relativo = (m: number | null) =>
  m == null
    ? ""
    : m === 0
      ? "a la misma hora"
      : `${Math.abs(m)} min ${m < 0 ? "antes" : "después"}`;
const equipoCorto = (d: Datos | null) => {
  const e = d?.equipo ?? {};
  const nav = /Edg\//.test(String(e["navegador"]))
    ? "Edge"
    : /Chrome\//.test(String(e["navegador"]))
      ? "Chrome"
      : /Firefox\//.test(String(e["navegador"]))
        ? "Firefox"
        : /Safari\//.test(String(e["navegador"]))
          ? "Safari"
          : "Navegador";
  return [e["plataforma"], e["modelo"], nav, e["movil"] ? "móvil" : null]
    .filter(Boolean)
    .join(" · ");
};
const mapa = (u: Datos["ubicacion"]) =>
  u?.estado === "ok" && u.lat != null && u.lon != null
    ? `https://www.google.com/maps?q=${u.lat},${u.lon}`
    : null;

function RegistroTurnos() {
  const acceso = useAccess();
  const [hasta, setHasta] = useState(hoy);
  const [desde, setDesde] = useState(() => restarDias(hoy(), 7));
  const [soloAlarmas, setSoloAlarmas] = useState(false);
  const [buscar, setBuscar] = useState("");
  const [abierta, setAbierta] = useState<string | null>(null);
  const [orden, setOrden] = useState<Orden | null>(null);

  const datos = useQuery({
    queryKey: ["registro-turnos", desde, hasta],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "reporte_registro_turnos" as never,
        { _desde: desde, _hasta: hasta } as never,
      );
      if (error) throw error;
      return (data as unknown as Fila[]) ?? [];
    },
  });

  const filas = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    return (datos.data ?? []).filter(
      (f) =>
        (!soloAlarmas || f.alarmas.length > 0) &&
        (!q ||
          `${f.empleado} ${f.usuario} ${f.documento} ${f.email} ${f.campana}`
            .toLowerCase()
            .includes(q)),
    );
  }, [datos.data, soloAlarmas, buscar]);
  const pag = usePaginado(ordenarFilas(filas, orden), 20);

  const todas = datos.data ?? [];
  const cuenta = (a: string) => todas.filter((f) => f.alarmas.includes(a)).length;
  const cruzados = todas.filter((f) => f.minutos_conectado != null && f.minutos_en_empresa != null);
  const promedio = (k: "minutos_conectado" | "minutos_en_empresa") =>
    cruzados.length
      ? Math.round(cruzados.reduce((s, f) => s + (f[k] ?? 0), 0) / cruzados.length)
      : null;

  function exportar() {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(
      filas.map((f) => ({
        Fecha: f.fecha,
        Documento: f.documento ?? "",
        Empleado: f.empleado ?? f.usuario ?? "",
        Usuario: f.email ?? "",
        Campaña: f.campana ?? "",
        "Inicio de turno": hm(f.inicio),
        "Fin de turno": hm(f.fin),
        Cierre:
          f.cierre === "automatico"
            ? "Automático (no lo finalizó)"
            : f.cierre
              ? "Usuario"
              : "En curso",
        "Tiempo conectado": dur(f.minutos_conectado),
        "Entrada biométrico": hm(f.entrada_biometrico),
        "Salida biométrico": hm(f.salida_biometrico),
        "Tiempo en la empresa": dur(f.minutos_en_empresa),
        "Inicio vs huella": relativo(f.minutos_inicio_vs_entrada),
        "Fin vs salida": relativo(f.minutos_fin_vs_salida),
        Alarmas: f.alarmas.map((a) => ALARMAS[a] ?? a).join("; "),
        Avisos: f.avisos.map((a) => AVISOS[a] ?? a).join("; "),
        "Equipo inicio": equipoCorto(f.inicio_datos),
        "Id equipo inicio": String(f.inicio_datos?.equipo?.["id"] ?? ""),
        "IP inicio": f.inicio_datos?.red?.ip ?? "",
        "País inicio": f.inicio_datos?.red?.pais ?? "",
        "Ubicación inicio":
          mapa(f.inicio_datos?.ubicacion) ?? f.inicio_datos?.ubicacion?.estado ?? "",
        "Precisión inicio (m)": f.inicio_datos?.ubicacion?.precision_m ?? "",
        "Equipo fin": equipoCorto(f.fin_datos),
        "IP fin": f.fin_datos?.red?.ip ?? "",
        "Ubicación fin": mapa(f.fin_datos?.ubicacion) ?? f.fin_datos?.ubicacion?.estado ?? "",
      })),
    );
    XLSX.utils.book_append_sheet(wb, ws, "Registro de turnos");
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Registro de turnos frente al biométrico"],
        [`Periodo: ${desde} a ${hasta}`],
        [
          "Las horas de inicio y fin son las del servidor. La entrada y salida son la primera y la última marca del biométrico ese día.",
        ],
      ]),
      "Información",
    );
    escribirLibro(wb, `registro_turnos_${desde}_${hasta}.xlsx`);
  }

  return (
    <div>
      <PageHeader
        titulo="Registro de turnos"
        descripcion="Inicios y fines de turno registrados en la plataforma frente al biométrico: tiempo conectado, tiempo en la empresa y alarmas."
        acciones={
          acceso.can("registro_turnos", "exportar") ? (
            <Button variant="outline" onClick={exportar} disabled={!filas.length}>
              <Download className="size-4" /> Exportar
            </Button>
          ) : null
        }
      />

      <Card className="mb-4 flex flex-wrap items-end gap-4 p-4">
        <div className="space-y-1">
          <Label>Desde</Label>
          <Input
            type="date"
            value={desde}
            max={hasta}
            onChange={(e) => e.target.value && setDesde(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label>Hasta</Label>
          <Input
            type="date"
            value={hasta}
            min={desde}
            onChange={(e) => e.target.value && setHasta(e.target.value)}
          />
        </div>
        <div className="min-w-56 flex-1 space-y-1">
          <Label>Buscar</Label>
          <Input
            value={buscar}
            onChange={(e) => setBuscar(e.target.value)}
            placeholder="Nombre, cédula, usuario o campaña"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={soloAlarmas} onCheckedChange={setSoloAlarmas} /> Solo con alarmas
        </label>
      </Card>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Indicador titulo="Turnos registrados" valor={todas.length} />
        <Indicador
          titulo="Inició antes de la huella"
          valor={cuenta("inicio_antes_de_huella")}
          alerta
        />
        <Indicador
          titulo="Finalizó después de la salida"
          valor={cuenta("fin_despues_de_salida")}
          alerta
        />
        <Indicador
          titulo="Sin huella / sin cierre"
          valor={`${cuenta("sin_huella")} / ${cuenta("sin_cierre")}`}
          alerta={cuenta("sin_huella") + cuenta("sin_cierre") > 0}
        />
        <Indicador
          titulo="Promedio conectado vs en empresa"
          valor={`${dur(promedio("minutos_conectado"))} / ${dur(promedio("minutos_en_empresa"))}`}
          detalle={`${cruzados.length} turnos con ambos datos`}
        />
      </div>

      {datos.error ? (
        <Card className="p-6 text-sm text-destructive">{(datos.error as Error).message}</Card>
      ) : (
        <>
          <SimpleTable<Fila>
            cargando={datos.isLoading}
            filas={pag.visibles}
            getKey={(f) => f.id}
            vacio="No hay turnos registrados en este periodo."
            orden={orden}
            onOrden={setOrden}
            onFilaClick={(f) => setAbierta((a) => (a === f.id ? null : f.id))}
            expandida={abierta}
            detalle={(f) => <Detalle fila={f} />}
            columnas={[
              {
                key: "fecha",
                header: "Fecha",
                orden: "fecha",
                cell: (f) => <span className="tabular-nums">{f.fecha}</span>,
              },
              {
                key: "persona",
                header: "Persona",
                orden: "empleado",
                cell: (f) => (
                  <div className="min-w-40">
                    <p className="font-medium">{f.empleado ?? f.usuario ?? f.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {[f.documento, f.campana].filter(Boolean).join(" · ") || f.email}
                    </p>
                  </div>
                ),
              },
              {
                key: "turno",
                header: "Turno",
                orden: "inicio",
                cell: (f) => (
                  <div className="tabular-nums">
                    <p>
                      {hm(f.inicio)} –{" "}
                      {f.fin ? hm(f.fin) : <span className="text-emerald-600">en curso</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      conectado {dur(f.minutos_conectado)}
                    </p>
                  </div>
                ),
              },
              {
                key: "bio",
                header: "Biométrico",
                cell: (f) => (
                  <div className="tabular-nums">
                    <p>
                      {hm(f.entrada_biometrico)} – {hm(f.salida_biometrico)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      en empresa {dur(f.minutos_en_empresa)}
                    </p>
                  </div>
                ),
              },
              {
                key: "dif",
                header: "Inicio vs huella",
                cell: (f) => (
                  <span
                    className={cn(
                      "text-xs",
                      f.alarmas.includes("inicio_antes_de_huella")
                        ? "font-medium text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {relativo(f.minutos_inicio_vs_entrada) || "—"}
                  </span>
                ),
              },
              {
                key: "alarmas",
                header: "Alarmas",
                cell: (f) => (
                  <div className="flex max-w-64 flex-wrap gap-1">
                    {f.alarmas.map((a) => (
                      <Badge key={a} variant="destructive" className="font-normal">
                        {ALARMAS[a] ?? a}
                      </Badge>
                    ))}
                    {f.avisos.map((a) => (
                      <Badge
                        key={a}
                        variant="secondary"
                        className={cn(
                          "font-normal",
                          a === "en_curso" &&
                            "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
                        )}
                      >
                        {AVISOS[a] ?? a}
                      </Badge>
                    ))}
                    {!f.alarmas.length && !f.avisos.length ? (
                      <span className="text-xs text-muted-foreground">✓ Sin alarmas</span>
                    ) : null}
                  </div>
                ),
              },
              {
                key: "equipo",
                header: "Equipo y red",
                cell: (f) => (
                  <div className="text-xs">
                    <p>{equipoCorto(f.inicio_datos) || "—"}</p>
                    <p className="text-muted-foreground">
                      {[f.inicio_datos?.red?.ip, f.inicio_datos?.red?.pais]
                        .filter(Boolean)
                        .join(" · ")}
                      {mapa(f.inicio_datos?.ubicacion) ? (
                        <a
                          href={mapa(f.inicio_datos?.ubicacion)!}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="ml-2 inline-flex items-center gap-0.5 text-primary hover:underline"
                        >
                          <MapPin className="size-3" /> mapa
                        </a>
                      ) : null}
                    </p>
                  </div>
                ),
              },
            ]}
          />
          {filas.length > 20 ? <Paginador {...pag.paginador} /> : null}
        </>
      )}

      <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        Las alarmas aparecen cuando el biométrico de ese día está cargado. El inicio de turno debe
        ser después de la huella de entrada y el fin antes de la huella de salida (tolerancia en
        Reglas de cálculo: «tolerancia_registro_turno_min»).
      </p>
    </div>
  );
}

function Indicador({
  titulo,
  valor,
  detalle,
  alerta,
}: {
  titulo: string;
  valor: ReactNode;
  detalle?: string;
  alerta?: boolean;
}) {
  const activo = alerta && valor !== 0 && valor !== "0 / 0";
  return (
    <Card className={cn("p-4", activo && "border-destructive/40")}>
      <p className="text-xs text-muted-foreground">{titulo}</p>
      <p
        className={cn(
          "mt-1 font-display text-2xl font-semibold tabular-nums",
          activo && "text-destructive",
        )}
      >
        {valor}
      </p>
      {detalle ? <p className="text-[11px] text-muted-foreground">{detalle}</p> : null}
    </Card>
  );
}

function BloqueDatos({
  titulo,
  d,
  hora,
}: {
  titulo: string;
  d: Datos | null;
  hora: string | null;
}) {
  if (!d) return null;
  const e = d.equipo ?? {};
  const u = d.ubicacion;
  const desfase =
    d.hora_equipo && d.hora_servidor
      ? Math.round((Date.parse(d.hora_equipo) - Date.parse(d.hora_servidor)) / 1000)
      : null;
  const filas: [string, ReactNode][] = [
    ["Hora del servidor", hm(hora)],
    [
      "Reloj del equipo",
      desfase == null
        ? "—"
        : Math.abs(desfase) <= 60
          ? "Sincronizado"
          : `${desfase > 0 ? "Adelantado" : "Atrasado"} ${Math.abs(desfase)} s`,
    ],
    ["Equipo", equipoCorto(d) || "—"],
    ["Id del equipo", String(e["id"] ?? "—")],
    [
      "Sistema",
      [e["plataforma"], e["version_so"], e["arquitectura"]].filter(Boolean).join(" ") || "—",
    ],
    ["Pantalla", e["pantalla"] ? `${String(e["pantalla"])} (x${String(e["escala"] ?? 1)})` : "—"],
    [
      "Núcleos / memoria",
      `${String(e["nucleos"] ?? "—")} / ${e["memoria_gb"] ? `${String(e["memoria_gb"])} GB` : "—"}`,
    ],
    ["Idioma / zona", `${String(e["idioma"] ?? "—")} / ${String(e["zona_horaria"] ?? "—")}`],
    ["Conexión", String(e["conexion"] ?? "—")],
    ["IP / país", [d.red?.ip, d.red?.pais, d.red?.ciudad].filter(Boolean).join(" · ") || "—"],
    [
      "Ubicación",
      mapa(u) ? (
        <a
          href={mapa(u)!}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          {u!.lat!.toFixed(5)}, {u!.lon!.toFixed(5)} (±{u!.precision_m} m)
        </a>
      ) : (
        ({
          denegada: "La persona no permitió la ubicación",
          tiempo_agotado: "No respondió a tiempo",
          no_disponible: "No disponible",
        }[u?.estado ?? ""] ?? "—")
      ),
    ],
    [
      "Navegador",
      <span className="break-all text-muted-foreground">{String(e["navegador"] ?? "—")}</span>,
    ],
  ];
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
        <MonitorSmartphone className="size-3.5" /> {titulo}
      </p>
      <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-0.5 text-xs">
        {filas.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Detalle({ fila }: { fila: Fila }) {
  return (
    <div className="space-y-3 bg-muted/20 p-4">
      <p className="flex items-center gap-2 text-sm">
        <Timer className="size-4 text-primary" />
        Conectado {dur(fila.minutos_conectado)} · en la empresa {dur(fila.minutos_en_empresa)}
        {fila.minutos_inicio_vs_entrada != null
          ? ` · inició ${relativo(fila.minutos_inicio_vs_entrada)} de la huella de entrada`
          : ""}
        {fila.minutos_fin_vs_salida != null
          ? ` · finalizó ${relativo(fila.minutos_fin_vs_salida)} de la salida`
          : ""}
      </p>
      <div className="flex flex-col gap-4 md:flex-row">
        <BloqueDatos titulo="Inicio de turno" d={fila.inicio_datos} hora={fila.inicio} />
        <BloqueDatos titulo="Fin de turno" d={fila.fin_datos} hora={fila.fin} />
      </div>
    </div>
  );
}
