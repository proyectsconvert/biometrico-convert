import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Building2, UserCog, Users } from "lucide-react";
import { CrudPage } from "@/components/crud-page";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { dbAny } from "@/lib/db";

export const Route = createFileRoute("/_authenticated/empresas")({
  head: () => ({ meta: [{ title: "Empresas — Convert-IA" }] }),
  component: Empresas,
});

const texto = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
const PAISES: Record<string, string> = { CO: "Colombia", PE: "Perú", CL: "Chile", CR: "Costa Rica", MX: "México", EC: "Ecuador" };

/** Cuenta registros por tenant (el super administrador ve todos). */
async function contarPorTenant(tabla: string) {
  const m = new Map<string, number>();
  for (let i = 0; i < 50; i++) {
    const { data, error } = await dbAny.from(tabla).select("tenant_id").range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    for (const r of (data ?? []) as { tenant_id: string | null }[]) if (r.tenant_id) m.set(r.tenant_id, (m.get(r.tenant_id) ?? 0) + 1);
    if (!data || data.length < 1000) break;
  }
  return m;
}

function Empresas() {
  const conteos = useQuery({
    queryKey: ["tenants", "conteos"],
    queryFn: async () => {
      const [usuarios, empleados] = await Promise.all([contarPorTenant("profiles"), contarPorTenant("employees")]);
      return { usuarios, empleados };
    },
  });

  return (
    <CrudPage
      titulo="Empresas (tenants)"
      descripcion="Clientes de la plataforma. Cada empresa ve únicamente su propia información: personal, biometría, novedades y configuración."
      tabla="tenants"
      modulo="empresas"
      orden="name"
      ordenAsc
      sinTenant
      buscarEn={["name", "nit"]}
      aviso={(filas) => (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          {[
            { t: "Empresas activas", v: filas.filter((f) => f.is_active).length, icon: Building2 },
            { t: "Usuarios de la plataforma", v: [...(conteos.data?.usuarios.values() ?? [])].reduce((a, b) => a + b, 0), icon: UserCog },
            { t: "Empleados registrados", v: [...(conteos.data?.empleados.values() ?? [])].reduce((a, b) => a + b, 0), icon: Users },
          ].map((c) => (
            <Card key={c.t} className="flex items-center gap-3 p-4">
              <span className="rounded-lg bg-primary/10 p-2"><c.icon className="size-4" /></span>
              <div><p className="text-xs text-muted-foreground">{c.t}</p><p className="text-xl font-semibold tabular-nums">{conteos.isLoading ? "…" : c.v.toLocaleString("es-CO")}</p></div>
            </Card>
          ))}
        </div>
      )}
      columnas={[
        {
          key: "name",
          header: "Empresa",
          cell: (f) => (
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10"><Building2 className="size-4" /></span>
              <div><p className="font-medium">{texto(f.name)}</p><p className="text-xs text-muted-foreground">NIT {texto(f.nit)}</p></div>
            </div>
          ),
        },
        { key: "country", header: "País", cell: (f) => PAISES[f.country as string] ?? texto(f.country) },
        { key: "usuarios", header: "Usuarios", className: "text-right", cell: (f) => <span className="tabular-nums">{conteos.data?.usuarios.get(f.id) ?? 0}</span> },
        { key: "empleados", header: "Empleados", className: "text-right", cell: (f) => <span className="tabular-nums">{(conteos.data?.empleados.get(f.id) ?? 0).toLocaleString("es-CO")}</span> },
        { key: "created_at", header: "Creada", cell: (f) => <span className="text-xs">{new Date(f.created_at).toLocaleDateString("es-CO")}</span> },
        {
          key: "is_active",
          header: "Estado",
          cell: (f) => <Badge variant={f.is_active ? "default" : "secondary"}>{f.is_active ? "Activa" : "Inactiva"}</Badge>,
        },
      ]}
      campos={[
        { name: "name", label: "Razón social", required: true, placeholder: "CONVERTIA S.A.S." },
        { name: "nit", label: "NIT", placeholder: "012345-6" },
        {
          name: "country",
          label: "País",
          type: "select",
          options: Object.entries(PAISES).map(([value, label]) => ({ value, label })),
          ayuda: "Define el calendario de festivos por defecto.",
        },
        { name: "is_active", label: "Empresa activa", type: "switch", ayuda: "Una empresa inactiva conserva su información, pero no se usa en la operación." },
      ]}
    />
  );
}
