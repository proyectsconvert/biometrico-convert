import { Moon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DIAS, hora, type Turno } from "@/lib/turnos";
import { cn } from "@/lib/utils";

/** Horario como chip de color: código y horas; el detalle va en el tooltip. */
export function ChipTurno({
  turno,
  apagado,
  compacto,
}: {
  turno: Turno | undefined;
  apagado?: boolean;
  compacto?: boolean;
}) {
  if (!turno) return <span className="text-xs text-muted-foreground">—</span>;
  const horas = `${hora(turno.start_time)}–${hora(turno.end_time)}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium",
            apagado && "border-dashed opacity-60",
          )}
          style={{ borderColor: turno.color ?? undefined, color: turno.color ?? undefined }}
        >
          {turno.crosses_midnight ? <Moon className="size-3" /> : null}
          {compacto ||
          turno.code ===
            `${hora(turno.start_time).replace(":", "")}-${hora(turno.end_time).replace(":", "")}`
            ? horas
            : `${turno.code} · ${horas}`}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {turno.name} ·{" "}
        {DIAS.filter(([d]) => turno.workdays.includes(d))
          .map(([, l]) => l)
          .join(" ")}
      </TooltipContent>
    </Tooltip>
  );
}
