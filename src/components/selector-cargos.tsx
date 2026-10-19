import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";

/**
 * Cargos que supervisa un supervisor de área (calidad, formación, BO…): ve a todas las personas con esos
 * cargos, en cualquier campaña o centro de costo, sin acceso a las campañas.
 */
export function SelectorCargos({ sel, onChange }: { sel: string[]; onChange: (v: string[]) => void }) {
  const [filtro, setFiltro] = useState("");
  const cargos = useQuery({
    queryKey: ["cargos-empleados"],
    queryFn: async () => {
      const { data, error } = await supabase.from("employees").select("position").eq("status", "activo").limit(20000);
      if (error) throw error;
      const cuenta = new Map<string, number>();
      for (const e of (data ?? []) as { position: string | null }[]) {
        const c = (e.position ?? "").trim().toUpperCase();
        if (c) cuenta.set(c, (cuenta.get(c) ?? 0) + 1);
      }
      return [...cuenta.entries()].map(([cargo, n]) => ({ cargo, n })).sort((a, b) => a.cargo.localeCompare(b.cargo));
    },
  });
  const sinTildes = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const lista = [
    ...(cargos.data ?? []),
    ...sel.filter((c) => !(cargos.data ?? []).some((x) => x.cargo === c)).map((cargo) => ({ cargo, n: 0 })),
  ];
  const visibles = lista.filter((x) => sinTildes(x.cargo).includes(sinTildes(filtro.trim())));
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Verá a todas las personas con estos cargos, en cualquier campaña o centro de costo, y su propia información. No ve
        las campañas. Marca también las variantes (p. ej. «(PERIODO DE PRUEBA)»).
      </p>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{sel.length} cargo(s) seleccionado(s)</span>
        {filtro.trim() && visibles.length ? (
          <button type="button" className="text-primary hover:underline" onClick={() => onChange([...new Set([...sel, ...visibles.map((x) => x.cargo)])])}>
            Marcar los {visibles.length} que coinciden
          </button>
        ) : null}
      </div>
      <Input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Buscar cargo (p. ej. calidad, formador)" className="h-8" />
      <div className="max-h-52 space-y-1 overflow-auto rounded-md border bg-background p-2">
        {cargos.isLoading ? (
          <p className="text-xs text-muted-foreground">Cargando cargos…</p>
        ) : (
          visibles.map((x) => (
            <label key={x.cargo} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sel.includes(x.cargo)}
                onChange={(e) => onChange(e.target.checked ? [...sel, x.cargo] : sel.filter((c) => c !== x.cargo))}
              />
              <span className="flex-1">{x.cargo}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{x.n}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
