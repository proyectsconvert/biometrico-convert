import { createFileRoute } from "@tanstack/react-router";
import { CrudPage } from "@/components/crud-page";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/turnos")({
  component: Turnos,
});

const texto = (v: unknown) => (v === null || v === undefined ? "—" : String(v));

function Turnos() {
  return (
    <CrudPage
      titulo="Turnos"
      descripcion="Horarios base usados para calcular jornada, tolerancias y turnos nocturnos."
      tabla="shifts"
      modulo="turnos"
      orden="code"
      ordenAsc
      buscarEn={["code", "name"]}
      columnas={[
        { key: "code", header: "Código", cell: (f) => texto(f.code) },
        {
          key: "name",
          header: "Turno",
          cell: (f) => <span className="font-medium">{texto(f.name)}</span>,
        },
        {
          key: "horario",
          header: "Horario",
          cell: (f) => `${texto(f.start_time)} – ${texto(f.end_time)}`,
        },
        {
          key: "noche",
          header: "Cruza medianoche",
          cell: (f) => (f.crosses_midnight ? "Sí" : "No"),
        },
        { key: "break", header: "Descanso (min)", cell: (f) => texto(f.break_minutes) },
        {
          key: "tol",
          header: "Tolerancia entrada",
          cell: (f) => `${texto(f.tolerance_in_minutes)} min`,
        },
        {
          key: "status",
          header: "Estado",
          cell: (f) => (
            <Badge variant={f.status === "activo" ? "default" : "secondary"}>
              {texto(f.status)}
            </Badge>
          ),
        },
      ]}
      campos={[
        { name: "code", label: "Código", required: true },
        { name: "name", label: "Nombre", required: true },
        { name: "start_time", label: "Hora de entrada", type: "time", required: true },
        { name: "end_time", label: "Hora de salida", type: "time", required: true },
        { name: "crosses_midnight", label: "Cruza medianoche", type: "switch" },
        { name: "break_minutes", label: "Descanso (minutos)", type: "number" },
        { name: "tolerance_in_minutes", label: "Tolerancia entrada (min)", type: "number" },
        { name: "tolerance_out_minutes", label: "Tolerancia salida (min)", type: "number" },
        {
          name: "status",
          label: "Estado",
          type: "select",
          options: [
            { value: "activo", label: "Activo" },
            { value: "inactivo", label: "Inactivo" },
          ],
        },
      ]}
    />
  );
}
