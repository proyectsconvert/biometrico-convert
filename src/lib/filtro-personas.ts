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
};
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
          .select("id, document, full_name, position, campaign_id, campaigns(name)")
          .order("full_name")
          .range(i * 1000, i * 1000 + 999);
        if (error) throw error;
        for (const e of (data ?? []) as unknown as (Omit<EmpleadoFiltro, "campana"> & { campaigns: { name: string } | null })[]) {
          out.push({ id: e.id, document: e.document, full_name: e.full_name, position: e.position, campaign_id: e.campaign_id, campana: e.campaigns?.name ?? null });
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
 */
export function useFiltroCampanaPersonas({
  opcionesCampanas,
  campanas,
  campanasPor = "id",
  personas,
  alCambiarPersonas,
  valor = "document",
}: {
  opcionesCampanas: Opcion[];
  campanas: string[];
  campanasPor?: "id" | "nombre";
  personas: string[];
  alCambiarPersonas: (personas: string[]) => void;
  valor?: "id" | "document";
}) {
  const empleados = useEmpleadosFiltro();
  const campanaDe = (e: EmpleadoFiltro) => (campanasPor === "id" ? e.campaign_id : e.campana) ?? "";

  const visibles = useMemo(() => {
    const lista = empleados.data ?? [];
    if (!campanas.length) return lista;
    const set = new Set(campanas);
    return lista.filter((e) => set.has(campanaDe(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empleados.data, campanas, campanasPor]);

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

  return {
    /** Cédulas de las personas de las campañas elegidas (null = sin filtro de campaña). */
    documentosCampanas: campanas.length ? visibles.map((e) => e.document) : null,
    opcionesCampanas: campanasFiltradas,
    opcionesPersonas,
    placeholderPersonas: campanas.length ? "Todas las de la campaña" : "Todas las personas",
    placeholderCampanas: personas.length ? "Campañas de las personas" : "Todas las campañas",
    cargando: empleados.isLoading,
  };
}
