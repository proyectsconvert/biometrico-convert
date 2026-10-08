import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { HISTORIAL, VERSION } from "@/lib/version";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const CLAVE_VISTA = "convertia.version.vista";

/** Versión de la plataforma junto a «Contraer menú»; abre el historial de cambios. */
export function VersionApp({ compacto = false }: { compacto?: boolean }) {
  const [abierto, setAbierto] = useState(false);
  const [nueva, setNueva] = useState(false);

  useEffect(() => {
    try {
      setNueva(localStorage.getItem(CLAVE_VISTA) !== VERSION);
    } catch {
      /* sin almacenamiento: no se marca como nueva */
    }
  }, []);

  const abrir = () => {
    setAbierto(true);
    setNueva(false);
    try {
      localStorage.setItem(CLAVE_VISTA, VERSION);
    } catch {
      /* sin almacenamiento */
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={abrir}
        title="Ver novedades de la versión"
        className={cn(
          "relative flex items-center gap-1.5 rounded-md text-[11px] tabular-nums text-sidebar-foreground/60 hover:text-sidebar-foreground",
          compacto ? "mx-auto px-1 py-1" : "px-2 py-1",
        )}
      >
        {compacto ? null : <Sparkles className="size-3.5" />}v
        {compacto ? VERSION.split(".").slice(0, 2).join(".") : VERSION}
        {nueva ? (
          <span
            className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary"
            aria-label="Versión nueva"
          />
        ) : null}
      </button>
      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Convert-IA Biométrico v{VERSION}</DialogTitle>
            <DialogDescription>
              Historial de versiones y cambios de la plataforma.
            </DialogDescription>
          </DialogHeader>
          <ol className="space-y-5">
            {HISTORIAL.map((v, i) => (
              <li key={v.version} className="relative border-l pl-4">
                <span
                  className={cn(
                    "absolute -left-[5px] top-1.5 size-2.5 rounded-full",
                    i === 0 ? "bg-primary" : "bg-muted-foreground/40",
                  )}
                />
                <p className="text-sm font-medium">
                  v{v.version} · {v.titulo}
                  {i === 0 ? (
                    <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                      Actual
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(`${v.fecha}T12:00:00`).toLocaleDateString("es-CO", {
                    dateStyle: "long",
                  })}
                </p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                  {v.cambios.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </DialogContent>
      </Dialog>
    </>
  );
}
