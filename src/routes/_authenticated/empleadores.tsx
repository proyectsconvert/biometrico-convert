import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CrudPage } from "@/components/crud-page";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { dbAny } from "@/lib/db";

export const Route = createFileRoute("/_authenticated/empleadores")({
  head: () => ({ meta: [{ title: "Empleadores — Convert-IA" }] }),
  component: Empleadores,
});

const texto = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

function Empleadores() {
  // Personas por empleador y grupos del biométrico sin empleador (para sugerir el mapeo)
  const resumen = useQuery({
    queryKey: ["employees", "resumen-empleadores"],
    queryFn: async () => {
      const out: { employer_id: string | null; biometric_group: string | null }[] = [];
      for (let i = 0; i < 50; i++) {
        const { data, error } = await dbAny
          .from("employees")
          .select("employer_id, biometric_group")
          .range(i * 1000, i * 1000 + 999);
        if (error) throw error;
        out.push(...((data ?? []) as typeof out));
        if (!data || data.length < 1000) break;
      }
      const porEmpleador = new Map<string, number>();
      const gruposSinEmpleador = new Map<string, number>();
      for (const e of out) {
        if (e.employer_id) porEmpleador.set(e.employer_id, (porEmpleador.get(e.employer_id) ?? 0) + 1);
        else {
          const g = e.biometric_group ?? "(sin grupo)";
          gruposSinEmpleador.set(g, (gruposSinEmpleador.get(g) ?? 0) + 1);
        }
      }
      return { porEmpleador, gruposSinEmpleador: [...gruposSinEmpleador.entries()].sort((a, b) => b[1] - a[1]) };
    },
  });

  return (
    <CrudPage
      titulo="Empleadores"
      descripcion="Empresas a las que pertenece el personal que pasa por el biométrico: ICA, seguridad, aseo, contratistas. Solo las marcadas «En reportes» cuentan en el panel, el control diario y las novedades."
      tabla="employers"
      modulo="empleadores"
      orden="name"
      ordenAsc
      buscarEn={["name", "nit"]}
      aviso={() =>
        resumen.data?.gruposSinEmpleador.length ? (
          <Card className="mb-4 p-4 text-sm">
            <p className="font-medium">Personal sin empleador, según su grupo en el biométrico</p>
            <p className="mb-2 text-xs text-muted-foreground">
              Si agregas un grupo en «Grupos del biométrico» de un empleador, las personas de ese grupo que aún no tengan empleador quedan asignadas automáticamente. «All Users» mezcla varias empresas: asígnalas desde Empleados.
            </p>
            <div className="flex flex-wrap gap-2">
              {resumen.data.gruposSinEmpleador.map(([g, n]) => (
                <Badge key={g} variant="outline" className="font-normal">
                  {g}: <span className="ml-1 font-semibold tabular-nums">{n}</span>
                </Badge>
              ))}
            </div>
          </Card>
        ) : null
      }
      columnas={[
        { key: "name", header: "Empleador", cell: (f) => <span className="font-medium">{texto(f.name)}</span> },
        { key: "nit", header: "NIT", cell: (f) => texto(f.nit) },
        {
          key: "reportes",
          header: "Cuenta en reportes",
          cell: (f) =>
            f.include_in_reports ? <Badge>En reportes</Badge> : <Badge variant="secondary">Excluido</Badge>,
        },
        {
          key: "grupos",
          header: "Grupos del biométrico",
          cell: (f) => ((f.biometric_groups as string[] | null)?.length ? (f.biometric_groups as string[]).join(", ") : "—"),
        },
        {
          key: "personas",
          header: "Personas",
          className: "text-right",
          cell: (f) => <span className="tabular-nums">{resumen.data?.porEmpleador.get(f.id as string) ?? 0}</span>,
        },
        {
          key: "status",
          header: "Estado",
          cell: (f) => <Badge variant={f.status === "activo" ? "default" : "secondary"}>{texto(f.status)}</Badge>,
        },
      ]}
      campos={[
        { name: "name", label: "Razón social", required: true },
        { name: "nit", label: "NIT" },
        {
          name: "include_in_reports",
          label: "Cuenta en panel y reportes",
          type: "switch",
          ayuda: "Desactívalo para seguridad, aseo, contratistas u otras empresas que usan el biométrico.",
        },
        {
          name: "biometric_groups",
          label: "Grupos del biométrico",
          type: "lista",
          placeholder: "CONVERTIA, CASA CONVERTIA",
          ayuda: "Valores de la columna «Grupo Usuario» del CSV, separados por coma. Asigna automáticamente a las personas sin empleador.",
        },
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
