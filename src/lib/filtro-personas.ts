import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type EmpleadoFiltro = {
  id: string;
  document: string;
  full_name: string;
  position: string | null;
  campaign_id: string | null;
  campana: string | null;
  status: string;
  termination_date: string | null;
  jefe_id: string | null;
};

/** Cargo agrupable: sin «(PERIODO DE PRUEBA)» ni espacios de más. */
export const cargoBase = (cargo: string | null | undefined) =>
  (cargo ?? "").replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim().toUpperCase() || "SIN CARGO";
/** Usuario con rol Supervisor o Coordinador y las campañas que tiene asignadas. */
export type Supervisor = { user_id: string; nombre: string; rol: string; campaign_ids: string[]; todas: boolean };

/** Supervisores y coordinadores de la empresa con sus campañas (Usuarios → Roles). */
export function useSupervisores() {
  return useQuery({
    queryKey: ["supervisores-campanas"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("supervisores_campanas" as never);
      if (error) throw error;
      return ((data as unknown as Supervisor[]) ?? []).sort((a, b) => alfabetico(a.nombre, b.nombre));
    },
  });
}

/** ¿El supervisor tiene a cargo esa campaña? */
export const cubreCampana = (s: Supervisor, campaignId: string | null) =>
  s.todas || (campaignId != null && s.campaign_ids.includes(campaignId));
type Opcion = { value: string; label: string; sublabel?: string };

/** Orden alfabético en español (tildes y ñ en su lugar, sin distinguir mayúsculas). */
export const alfabetico = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "base" });

/** Todos los empleados visibles (el servidor entrega máximo 1.000 por consulta, así que se pagina). */
export function useEmpleadosFiltro() {
  return useQuery({
    queryKey: ["empleados-filtro"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const out: EmpleadoFiltro[] = [];
      for (let i = 0; i < 30; i++) {
        const { data, error } = await supabase
          .from("employees")
          .select("id, document, full_name, position, campaign_id, status, termination_date, jefe_id, campaigns(name)")
          .order("full_name")
          .range(i * 1000, i * 1000 + 999);
        if (error) throw error;
        for (const e of (data ?? []) as unknown as (Omit<EmpleadoFiltro, "campana"> & { campaigns: { name: string } | null })[]) {
          out.push({
            id: e.id,
            document: e.document,
            full_name: e.full_name,
            position: e.position,
            campaign_id: e.campaign_id,
            campana: e.campaigns?.name ?? null,
            status: e.status,
            termination_date: e.termination_date,
            jefe_id: e.jefe_id,
          });
        }
        if (!data || data.length < 1000) break;
      }
      return out.sort((a, b) => alfabetico(a.full_name, b.full_name));
    },
  });
}

/**
 * Filtros «Campañas» y «Personas» coherentes entre sí:
 * - con campañas elegidas, en Personas solo aparecen las de esas campañas (y se quitan de la
 *   selección las que ya no pertenecen);
 * - con personas elegidas, en Campañas solo aparecen las campañas de esas personas (más las ya
 *   elegidas, para poder quitarlas).
 * Ambas listas van en orden alfabético. `campanasPor` indica si el filtro de campañas usa ids o
 * nombres; `valor`, qué dato identifica a la persona (id o documento).
 *
 * Además: cargo, supervisor (el usuario con rol Supervisor o Coordinador que tiene asignada la
 * campaña de la persona) y personal activo. Por defecto solo se listan las
 * personas activas (y las retiradas desde `desde`, para no perder a nadie en un corte de nómina);
 * `incluirInactivos` muestra a todos. Cargo y supervisor también filtran los datos: `personasConsulta`
 * es la lista de personas que la pantalla debe pasar a su consulta.
 */
export function useFiltroCampanaPersonas({
  opcionesCampanas,
  campanas,
  campanasPor = "id",
  personas,
  alCambiarPersonas,
  valor = "document",
  cargos = [],
  jefes = [],
  incluirInactivos = false,
  desde,
}: {
  opcionesCampanas: Opcion[];
  campanas: string[];
  campanasPor?: "id" | "nombre";
  personas: string[];
  alCambiarPersonas: (personas: string[]) => void;
  valor?: "id" | "document";
  cargos?: string[];
  jefes?: string[];
  incluirInactivos?: boolean;
  desde?: string;
}) {
  const empleados = useEmpleadosFiltro();
  const supervisores = useSupervisores();
  const campanaDe = (e: EmpleadoFiltro) => (campanasPor === "id" ? e.campaign_id : e.campana) ?? "";
  const vigente = (e: EmpleadoFiltro) =>
    incluirInactivos || e.status === "activo" || Boolean(desde && e.termination_date && e.termination_date >= desde);

  // Base: campaña y personal activo (sobre ella se calculan las opciones de cargo y supervisor)
  const base = useMemo(() => {
    const set = new Set(campanas);
    return (empleados.data ?? []).filter((e) => vigente(e) && (!campanas.length || set.has(campanaDe(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empleados.data, campanas, campanasPor, incluirInactivos, desde]);

  const visibles = useMemo(() => {
    const setCargos = new Set(cargos);
    const elegidos = (supervisores.data ?? []).filter((s) => jefes.includes(s.user_id));
    return base.filter(
      (e) =>
        (!cargos.length || setCargos.has(cargoBase(e.position))) &&
        (!jefes.length || elegidos.some((s) => cubreCampana(s, e.campaign_id))),
    );
  }, [base, cargos, jefes, supervisores.data]);

  const opcionesCargos = useMemo(() => {
    const cuenta = new Map<string, number>();
    for (const e of base) cuenta.set(cargoBase(e.position), (cuenta.get(cargoBase(e.position)) ?? 0) + 1);
    return [...cuenta.entries()]
      .sort((a, b) => alfabetico(a[0], b[0]))
      .map(([c, n]) => ({ value: c, label: c, sublabel: `${n} persona${n === 1 ? "" : "s"}` }));
  }, [base]);

  // Supervisores: usuarios con rol Supervisor o Coordinador, con sus campañas y su personal
  const opcionesJefes = useMemo(() => {
    const nombreCampana = new Map((empleados.data ?? []).map((e) => [e.campaign_id, e.campana]));
    return (supervisores.data ?? []).map((s) => {
      const n = base.filter((e) => cubreCampana(s, e.campaign_id)).length;
      const campanas = s.todas ? "toda la empresa" : s.campaign_ids.map((c) => nombreCampana.get(c) ?? "campaña").join(", ") || "sin campañas";
      return { value: s.user_id, label: s.nombre, sublabel: `${s.rol} · ${campanas} · ${n} persona${n === 1 ? "" : "s"}` };
    });
  }, [supervisores.data, empleados.data, base]);

  const opcionesPersonas = useMemo(
    () => visibles.map((e) => ({
      value: e[valor],
      label: e.full_name,
      sublabel: [e.document, e.campana ?? "Sin campaña", e.position].filter(Boolean).join(" · "),
    })),
    [visibles, valor],
  );

  const campanasFiltradas = useMemo(() => {
    let lista = opcionesCampanas;
    if (personas.length && empleados.data) {
      const elegidas = new Set(personas);
      const deLasPersonas = new Set(empleados.data.filter((e) => elegidas.has(e[valor])).map(campanaDe));
      lista = lista.filter((c) => deLasPersonas.has(c.value) || campanas.includes(c.value));
    }
    return [...lista].sort((a, b) => alfabetico(a.label, b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opcionesCampanas, personas, empleados.data, campanas, valor, campanasPor]);

  // Quitar de la selección a quien ya no pertenece a las campañas elegidas
  useEffect(() => {
    if (!empleados.data || !personas.length) return;
    const validos = new Set(visibles.map((e) => e[valor]));
    const quedan = personas.filter((s) => validos.has(s));
    if (quedan.length !== personas.length) alCambiarPersonas(quedan);
  }, [visibles, personas, valor, empleados.data, alCambiarPersonas]);

  const filtraDatos = Boolean(cargos.length || jefes.length);
  const personasConsulta = useMemo(() => {
    if (personas.length) return personas;
    if (!filtraDatos) return [];
    const v = visibles.map((e) => e[valor]);
    // Ninguna persona cumple: un valor imposible para que la consulta no traiga a todos
    return v.length ? v : ["__ninguna__"];
  }, [personas, filtraDatos, visibles, valor]);

  return {
    /** Cédulas de las personas de las campañas, cargos o supervisores elegidos (null = sin esos filtros). */
    documentosCampanas: campanas.length || filtraDatos ? visibles.map((e) => e.document) : null,
    /** Personas para la consulta de datos: las elegidas o, con cargo/supervisor, las que cumplen. */
    personasConsulta,
    opcionesCargos,
    opcionesJefes,
    opcionesCampanas: campanasFiltradas,
    opcionesPersonas,
    placeholderPersonas: campanas.length ? "Todas las de la campaña" : "Todas las personas",
    placeholderCampanas: personas.length ? "Campañas de las personas" : "Todas las campañas",
    cargando: empleados.isLoading,
  };
}
