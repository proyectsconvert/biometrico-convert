import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarPlus, CalendarDays, Loader2 } from "lucide-react";
import { CrudPage } from "@/components/crud-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useServerFn } from "@tanstack/react-start";
import { recalcularAsistencia } from "@/lib/asistencia.functions";
import { dbAny } from "@/lib/db";
import { festivosColombia } from "@/lib/festivos-co";
import { useAccess } from "@/lib/session";

export const Route = createFileRoute("/_authenticated/festivos")({
  head: () => ({ meta: [{ title: "Festivos — Convert-IA" }] }),
  component: Festivos,
});

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const fechaLarga = (f: string) => {
  const d = new Date(`${f}T12:00:00`);
  return `${DIAS[d.getDay()]} ${d.toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" })}`;
};
const hoyIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function Festivos() {
  const acceso = useAccess();
  const anioActual = new Date().getFullYear();
  const anios = Array.from({ length: 5 }, (_, i) => String(anioActual - 2 + i));

  return (
    <CrudPage
      titulo="Festivos"
      descripcion="Calendario de festivos usado para el recargo dominical y festivo. Genera los de Colombia automáticamente o agrega festivos propios."
      tabla="holidays"
      modulo="festivos"
      orden="holiday_date"
      ordenAsc
      buscarEn={["description", "holiday_date"]}
      accionesExtra={acceso.can("festivos", "crear") ? <GenerarFestivos /> : null}
      aviso={(filas) => {
        const hoy = hoyIso();
        const proximo = filas.filter((f) => f.is_active && f.holiday_date >= hoy).sort((a, b) => a.holiday_date.localeCompare(b.holiday_date))[0];
        const porAnio = new Map<string, number>();
        for (const f of filas) porAnio.set(String(f.holiday_date).slice(0, 4), (porAnio.get(String(f.holiday_date).slice(0, 4)) ?? 0) + 1);
        return (
          <div className="mb-4 grid gap-3 md:grid-cols-[1.4fr_2fr]">
            <Card className="flex items-center gap-3 p-4">
              <span className="rounded-lg bg-primary/10 p-2.5"><CalendarDays className="size-5" /></span>
              <div>
                <p className="text-xs text-muted-foreground">Próximo festivo</p>
                <p className="font-semibold">{proximo ? proximo.description : "No hay festivos futuros cargados"}</p>
                {proximo ? <p className="text-xs capitalize text-muted-foreground">{fechaLarga(proximo.holiday_date)}</p> : null}
              </div>
            </Card>
            <Card className="p-4">
              <p className="mb-2 text-xs text-muted-foreground">Festivos cargados por año (el recargo solo se calcula en años cargados)</p>
              <div className="flex flex-wrap gap-2">
                {anios.map((a) => (
                  <Badge key={a} variant={porAnio.get(a) ? "default" : "outline"} className={porAnio.get(a) ? "" : "border-amber-400 text-amber-700 dark:text-amber-400"}>
                    {a}: {porAnio.get(a) ?? "sin cargar"}
                  </Badge>
                ))}
              </div>
            </Card>
          </div>
        );
      }}
      filtros={[
        {
          key: "anio",
          label: "Año",
          inicial: String(anioActual),
          opciones: anios.map((a) => ({ value: a, label: a })),
          aplicar: (f, v) => String(f.holiday_date).startsWith(v),
        },
      ]}
      columnas={[
        {
          key: "holiday_date",
          header: "Fecha",
          cell: (f) => (
            <div>
              <p className="font-medium tabular-nums">{f.holiday_date}</p>
              <p className="text-xs capitalize text-muted-foreground">{fechaLarga(f.holiday_date).split(" ")[0]}</p>
            </div>
          ),
        },
        { key: "description", header: "Festivo", cell: (f) => <span className="font-medium">{f.description}</span> },
        { key: "country", header: "País", cell: (f) => f.country },
        {
          key: "is_active",
          header: "Aplica",
          cell: (f) => <Badge variant={f.is_active ? "default" : "secondary"}>{f.is_active ? "Sí" : "No aplica"}</Badge>,
        },
      ]}
      campos={[
        { name: "holiday_date", label: "Fecha", type: "date", required: true },
        { name: "description", label: "Descripción", required: true },
        { name: "country", label: "País", placeholder: "CO" },
        { name: "is_active", label: "Aplica para el cálculo", type: "switch", ayuda: "Desactívalo si la empresa trabaja normalmente ese día." },
      ]}
    />
  );
}

function GenerarFestivos() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [anio, setAnio] = useState(new Date().getFullYear());
  const [trabajando, setTrabajando] = useState(false);
  const recalcular = useServerFn(recalcularAsistencia);
  const lista = festivosColombia(anio);

  async function generar() {
    setTrabajando(true);
    try {
      const { data, error } = await dbAny
        .from("holidays")
        .upsert(
          lista.map((f) => ({ tenant_id: acceso.tenantId, country: "CO", holiday_date: f.fecha, description: f.descripcion, is_active: true })),
          { onConflict: "tenant_id,holiday_date", ignoreDuplicates: true },
        )
        .select("id");
      if (error) throw error;
      // Recalcular la asistencia del año para aplicar el recargo festivo
      await recalcular({ data: { desde: `${anio}-01-01`, hasta: `${anio}-12-31` } });
      toast.success(`${data?.length ?? 0} festivos de ${anio} agregados`, { description: "La asistencia de ese año se recalculó con el recargo festivo." });
      setAbierto(false);
      void qc.invalidateQueries();
    } catch (e) {
      toast.error("No se pudieron generar", { description: (e as Error).message });
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setAbierto(true)}><CalendarPlus className="size-4" /> Festivos de Colombia</Button>
      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generar festivos de Colombia</DialogTitle>
            <DialogDescription>Según la Ley Emiliani (traslados al lunes) y la Semana Santa del año. Los que ya existan no se duplican.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAnio(anio - 1)}>‹</Button>
            <span className="w-16 text-center text-lg font-semibold tabular-nums">{anio}</span>
            <Button variant="outline" size="sm" onClick={() => setAnio(anio + 1)}>›</Button>
          </div>
          <ul className="max-h-64 space-y-1 overflow-auto rounded-md border p-2 text-sm">
            {lista.map((f) => (
              <li key={f.fecha} className="flex justify-between gap-2">
                <span>{f.descripcion}</span>
                <span className="capitalize text-muted-foreground tabular-nums">{fechaLarga(f.fecha).replace(` de ${anio}`, "")}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbierto(false)}>Cancelar</Button>
            <Button disabled={trabajando} onClick={() => void generar()}>{trabajando ? <Loader2 className="size-4 animate-spin" /> : null} Agregar {lista.length} festivos</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
