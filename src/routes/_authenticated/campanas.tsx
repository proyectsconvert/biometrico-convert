import { createFileRoute } from "@tanstack/react-router";
import { CrudPage } from "@/components/crud-page";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/campanas")({
  component: Campanas,
});

const texto = (v: unknown) => (v === null || v === undefined ? "—" : String(v));
const nombreRel = (v: unknown) => texto((v as { name?: string } | null)?.name);

function Campanas() {
  return (
    <CrudPage
      titulo="Campañas"
      descripcion="Agrupación operativa del personal para reportes y permisos."
      tabla="campaigns"
      modulo="campanas"
      select="*, cost_centers(name), shifts!campaigns_shift_id_fkey(name)"
      orden="name"
      ordenAsc
      buscarEn={["code", "name"]}
      columnas={[
        { key: "code", header: "Código", cell: (f) => texto(f.code) },
        {
          key: "name",
          header: "Campaña",
          cell: (f) => <span className="font-medium">{texto(f.name)}</span>,
        },
        { key: "cc", header: "Centro de costo", cell: (f) => nombreRel(f.cost_centers) },
        { key: "shift", header: "Turno base", cell: (f) => nombreRel(f.shifts) },
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
        { name: "cost_center_id", label: "Centro de costo", fuente: { tabla: "cost_centers" } },
        { name: "shift_id", label: "Turno base", fuente: { tabla: "shifts" } },
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
