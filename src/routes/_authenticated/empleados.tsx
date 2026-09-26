import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, UserCheck, UserX } from "lucide-react";
import { CrudPage, type Registro } from "@/components/crud-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmpleadosMasivo } from "@/components/empleados-masivo";
import { dbAny } from "@/lib/db";

export const Route = createFileRoute("/_authenticated/empleados")({
  head: () => ({ meta: [{ title: "Empleados — Convert-IA" }] }),
  component: Empleados,
});

type Empleador = { id: string; name: string; include_in_reports: boolean };

const texto = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
const nombreRel = (v: unknown) => texto((v as { name?: string } | null)?.name);

function Empleados() {
  const empleadores = useQuery({
    queryKey: ["employers", "opciones"],
    queryFn: async () => {
      const { data, error } = await dbAny.from("employers").select("id, name, include_in_reports").order("name");
      if (error) throw error;
      return (data ?? []) as Empleador[];
    },
  });
  const lista = empleadores.data ?? [];

  return (
    <CrudPage
      titulo="Empleados"
      descripcion="Maestro de personal vinculado al documento del biométrico. El empleador define si la persona cuenta en el panel y los reportes."
      tabla="employees"
      modulo="empleados"
      select="*, campaigns(name), cost_centers(name), shifts(name), employers(name, include_in_reports)"
      orden="full_name"
      ordenAsc
      accionesExtra={<EmpleadosMasivo />}
      buscarEn={["document", "full_name", "position", "biometric_group"]}
      aviso={(filas) => {
        const sin = filas.filter((f) => !f.employer_id && f.status === "activo").length;
        return sin ? (
          <Card className="mb-4 flex flex-wrap items-center gap-2 border-accent/50 bg-accent/5 p-3 text-sm">
            <Building2 className="size-4 text-accent" />
            <span>
              <strong className="tabular-nums">{sin}</strong> empleados activos no tienen empleador. Filtra por «Empleador: Sin empleador», selecciónalos y usa «Asignar empleador».
            </span>
          </Card>
        ) : null;
      }}
      filtros={[
        {
          key: "empleador",
          label: "Empleador",
          // El personal de empleadores excluidos solo se ve si se elige explícitamente
          inicial: "_visibles",
          etiquetaTodos: "Todos (incluye excluidos)",
          opciones: [
            { value: "_visibles", label: "Sin excluidos" },
            { value: "_sin", label: "Sin empleador" },
            { value: "_reportes", label: "Cuentan en reportes" },
            { value: "_excluidos", label: "Excluidos de reportes" },
            ...lista.map((e) => ({ value: e.id, label: e.name })),
          ],
          aplicar: (f: Registro, v) =>
            v === "_visibles"
              ? !f.employers || f.employers.include_in_reports
              : v === "_sin"
              ? !f.employer_id
              : v === "_reportes"
                ? Boolean(f.employers?.include_in_reports)
                : v === "_excluidos"
                  ? f.employers && !f.employers.include_in_reports
                  : f.employer_id === v,
        },
        {
          key: "estado",
          label: "Estado",
          opciones: [
            { value: "activo", label: "Activo" },
            { value: "inactivo", label: "Inactivo" },
          ],
          aplicar: (f: Registro, v) => f.status === v,
        },
      ]}
      accionesMasivas={(sel, limpiar) => <AccionesMasivas seleccion={sel} limpiar={limpiar} empleadores={lista} />}
      columnas={[
        { key: "document", header: "Documento", cell: (f) => <span className="tabular-nums">{texto(f.document)}</span> },
        {
          key: "full_name",
          header: "Nombre",
          cell: (f) => (
            <div>
              <p className="font-medium">{texto(f.full_name)}</p>
              <p className="text-xs text-muted-foreground">{texto(f.position)}</p>
            </div>
          ),
        },
        {
          key: "employer",
          header: "Empleador",
          cell: (f) =>
            f.employers ? (
              <Badge variant={f.employers.include_in_reports ? "default" : "secondary"} className="max-w-56 truncate font-normal">
                {f.employers.name}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">Sin empleador</span>
            ),
        },
        { key: "grupo", header: "Grupo biométrico", cell: (f) => <span className="text-xs">{texto(f.biometric_group)}</span> },
        { key: "campaign", header: "Campaña", cell: (f) => nombreRel(f.campaigns) },
        { key: "shift", header: "Turno", cell: (f) => nombreRel(f.shifts) },
        {
          key: "status",
          header: "Estado",
          cell: (f) => <Badge variant={f.status === "activo" ? "outline" : "secondary"}>{texto(f.status)}</Badge>,
        },
      ]}
      campos={[
        { name: "document", label: "Documento", required: true },
        { name: "full_name", label: "Nombre completo", required: true },
        {
          name: "employer_id",
          label: "Empleador",
          fuente: { tabla: "employers" },
          ayuda: "Empresa a la que pertenece la persona. Seguridad, aseo o contratistas no cuentan en los reportes.",
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
        { name: "position", label: "Cargo" },
        { name: "email", label: "Correo", type: "email" },
        { name: "campaign_id", label: "Campaña", fuente: { tabla: "campaigns" } },
        { name: "cost_center_id", label: "Centro de costo", fuente: { tabla: "cost_centers" } },
        { name: "shift_id", label: "Turno", fuente: { tabla: "shifts" } },
        { name: "hire_date", label: "Fecha de ingreso", type: "date" },
        { name: "termination_date", label: "Fecha de retiro", type: "date" },
      ]}
    />
  );
}

function AccionesMasivas({
  seleccion,
  limpiar,
  empleadores,
}: {
  seleccion: Registro[];
  limpiar: () => void;
  empleadores: Empleador[];
}) {
  const qc = useQueryClient();
  const [empleador, setEmpleador] = useState("");
  const [trabajando, setTrabajando] = useState(false);

  async function actualizar(cambio: Record<string, unknown>, mensaje: string) {
    setTrabajando(true);
    try {
      const ids = seleccion.map((f) => f.id as string);
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await dbAny.from("employees").update(cambio).in("id", ids.slice(i, i + 200));
        if (error) throw error;
      }
      toast.success(mensaje);
      limpiar();
      setEmpleador("");
      await qc.invalidateQueries();
    } catch (e) {
      toast.error("No se pudo actualizar", { description: (e as Error).message });
    } finally {
      setTrabajando(false);
    }
  }

  const n = seleccion.length;
  return (
    <>
      <Select value={empleador} onValueChange={setEmpleador}>
        <SelectTrigger className="h-8 w-64">
          <SelectValue placeholder="Elegir empleador…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_ninguno">— Quitar empleador —</SelectItem>
          {empleadores.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={!empleador || trabajando}
        onClick={() =>
          actualizar(
            { employer_id: empleador === "_ninguno" ? null : empleador },
            `Empleador actualizado en ${n} empleados`,
          )
        }
      >
        <Building2 className="size-4" /> Asignar empleador
      </Button>
      <Button size="sm" variant="outline" disabled={trabajando} onClick={() => actualizar({ status: "activo" }, `${n} empleados activados`)}>
        <UserCheck className="size-4" /> Activar
      </Button>
      <Button size="sm" variant="outline" disabled={trabajando} onClick={() => actualizar({ status: "inactivo" }, `${n} empleados inactivados`)}>
        <UserX className="size-4" /> Inactivar
      </Button>
    </>
  );
}
