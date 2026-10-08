import { MultiSelectFilter, type MultiSelectOption } from "@/components/multi-select-filter";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAccess } from "@/lib/session";

/** Roles sin personas a cargo: no ven estos filtros. */
const SIN_EQUIPO = ["asesor", "bo"];

/** Estado de los filtros de personal que comparten Panel, Control diario, Novedades, Turnos… */
export type FiltroPersonal = { cargos: string[]; jefes: string[]; incluirInactivos: boolean };
export const FILTRO_PERSONAL_INICIAL: FiltroPersonal = {
  cargos: [],
  jefes: [],
  incluirInactivos: false,
};

/** ¿El usuario tiene personas a cargo? (asesor y back office no). */
export function useTieneEquipo() {
  const acceso = useAccess();
  return (
    !acceso.roleCodes.length ||
    acceso.isSuperAdmin ||
    acceso.roleCodes.some((r) => !SIN_EQUIPO.includes(r))
  );
}

/**
 * Filtros «Cargo», «Supervisor» e «Incluir inactivos». Las opciones vienen de useFiltroCampanaPersonas
 * (opcionesCargos, opcionesJefes) para que sean coherentes con la campaña elegida.
 */
export function FiltrosPersonal({
  valor,
  onChange,
  opcionesCargos,
  opcionesJefes,
  conInactivos = true,
  compacto = false,
  triggerClassName,
  claseInactivos,
}: {
  valor: FiltroPersonal;
  onChange: (v: FiltroPersonal) => void;
  opcionesCargos: MultiSelectOption[];
  opcionesJefes: MultiSelectOption[];
  /** false en pantallas donde «inactivos» no aplica. */
  conInactivos?: boolean;
  /** Sin etiquetas, para barras de filtros en una sola línea (p. ej. el Panel). */
  compacto?: boolean;
  triggerClassName?: string;
  claseInactivos?: string;
}) {
  const tieneEquipo = useTieneEquipo();
  if (!tieneEquipo) return null;
  if (compacto) {
    return (
      <>
        <MultiSelectFilter
          title="Cargos"
          placeholder="Todos los cargos"
          searchPlaceholder="Buscar cargo…"
          options={opcionesCargos}
          selected={valor.cargos}
          onChange={(cargos) => onChange({ ...valor, cargos })}
          triggerClassName={triggerClassName ?? ""}
        />
        <MultiSelectFilter
          title="Supervisores"
          placeholder="Todos los supervisores"
          searchPlaceholder="Buscar supervisor…"
          options={opcionesJefes}
          selected={valor.jefes}
          onChange={(jefes) => onChange({ ...valor, jefes })}
          popoverWidth="w-[340px]"
          triggerClassName={triggerClassName ?? ""}
        />
        {conInactivos ? (
          <label className={claseInactivos ?? "flex cursor-pointer items-center gap-2 text-xs"}>
            <Switch
              checked={valor.incluirInactivos}
              onCheckedChange={(incluirInactivos) => onChange({ ...valor, incluirInactivos })}
            />
            Incluir inactivos
          </label>
        ) : null}
      </>
    );
  }
  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-xs">Cargo</Label>
        <MultiSelectFilter
          title="Cargos"
          placeholder="Todos los cargos"
          searchPlaceholder="Buscar cargo…"
          options={opcionesCargos}
          selected={valor.cargos}
          onChange={(cargos) => onChange({ ...valor, cargos })}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Supervisor</Label>
        <MultiSelectFilter
          title="Supervisores"
          placeholder="Todos los supervisores"
          searchPlaceholder="Buscar supervisor…"
          options={opcionesJefes}
          selected={valor.jefes}
          onChange={(jefes) => onChange({ ...valor, jefes })}
          popoverWidth="w-[340px]"
        />
      </div>
      {conInactivos ? (
        <label
          className="flex h-9 cursor-pointer items-center gap-2 self-end text-sm"
          title="Por defecto solo se muestra el personal activo (y quien se retiró dentro del periodo)"
        >
          <Switch
            checked={valor.incluirInactivos}
            onCheckedChange={(incluirInactivos) => onChange({ ...valor, incluirInactivos })}
          />
          Incluir inactivos
        </label>
      ) : null}
    </>
  );
}
