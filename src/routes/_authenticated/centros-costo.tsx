import { createFileRoute } from "@tanstack/react-router";
import { CrudPage } from "@/components/crud-page";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/centros-costo")({
  component: CentrosCosto,
});

const texto = (v: unknown) => (v === null || v === undefined ? "—" : String(v));

function CentrosCosto() {
  return (
    <CrudPage
      titulo="Centros de costo"
      descripcion="Estructura contable a la que se imputan las horas del personal."
      tabla="cost_centers"
      modulo="centros_costo"
      orden="name"
      ordenAsc
      buscarEn={["code", "name"]}
      columnas={[
        { key: "code", header: "Código", cell: (f) => texto(f.code) },
        {
          key: "name",
          header: "Nombre",
          cell: (f) => <span className="font-medium">{texto(f.name)}</span>,
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
