import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Cpu, CheckCircle2, CircleDashed, Power } from "lucide-react";
import { CrudPage, type Registro } from "@/components/crud-page";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";

export const Route = createFileRoute("/_authenticated/dispositivos")({
  head: () => ({ meta: [{ title: "Dispositivos — Convert-IA" }] }),
  component: Dispositivos,
});

const CLASES = [
  { value: "entrada", label: "Entrada" },
  { value: "salida", label: "Salida" },
  { value: "entrada_salida", label: "Entrada y salida" },
  { value: "interno", label: "Interno" },
  { value: "ignorar", label: "Ignorar" },
];
const texto = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

function Dispositivos() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const puede = acceso.can("dispositivos", "editar");

  // Edición directa en la tabla (sin abrir el formulario)
  async function cambiar(fila: Registro, cambio: Record<string, unknown>) {
    const { error } = await dbAny.from("devices").update(cambio).eq("id", fila.id);
    if (error) {
      toast.error("No se pudo actualizar", { description: error.message });
      return;
    }
    toast.success(`${fila.name} actualizado`);
    void qc.invalidateQueries({ queryKey: ["devices"] });
  }

  return (
    <CrudPage
      titulo="Dispositivos"
      descripcion="Lectores biométricos detectados en las importaciones. La asistencia toma la primera y la última autenticación exitosa del día en cualquier lector; la clasificación y la ubicación son informativas."
      tabla="devices"
      modulo="dispositivos"
      orden="name"
      ordenAsc
      buscarEn={["device_code", "name", "door_name", "site", "building"]}
      permitirCrear={false}
      aviso={(filas) => {
        const porConfirmar = filas.filter((f) => !f.confirmed).length;
        const tarjetas = [
          { t: "Lectores", v: filas.length, icon: Cpu },
          { t: "Confirmados", v: filas.length - porConfirmar, icon: CheckCircle2 },
          { t: "Por revisar", v: porConfirmar, icon: CircleDashed },
          { t: "Inactivos", v: filas.filter((f) => !f.is_active).length, icon: Power },
        ];
        return (
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            {tarjetas.map((c) => (
              <Card key={c.t} className="flex items-center gap-3 p-4">
                <span className="rounded-lg bg-primary/10 p-2"><c.icon className="size-4" /></span>
                <div><p className="text-xs text-muted-foreground">{c.t}</p><p className="text-xl font-semibold tabular-nums">{c.v}</p></div>
              </Card>
            ))}
          </div>
        );
      }}
      filtros={[
        { key: "clase", label: "Clasificación", opciones: CLASES, aplicar: (f, v) => f.classification === v },
        {
          key: "confirmado",
          label: "Revisión",
          opciones: [{ value: "si", label: "Confirmados" }, { value: "no", label: "Por revisar" }],
          aplicar: (f, v) => (v === "si") === Boolean(f.confirmed),
        },
      ]}
      columnas={[
        {
          key: "name",
          header: "Lector",
          cell: (f) => (
            <div>
              <p className="font-medium">{texto(f.name)}</p>
              <p className="text-xs text-muted-foreground">ID {texto(f.device_code)}{f.door_name ? ` · ${f.door_name}` : ""}</p>
            </div>
          ),
        },
        {
          key: "classification",
          header: "Clasificación",
          cell: (f) => (
            <div onClick={(e) => e.stopPropagation()}>
              <Select value={f.classification} disabled={!puede} onValueChange={(v) => void cambiar(f, { classification: v, confirmed: true })}>
                <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{CLASES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ),
        },
        {
          key: "site",
          header: "Ubicación",
          cell: (f) => <span className="text-xs">{[f.site, f.building, f.floor && `Piso ${f.floor}`].filter(Boolean).join(" · ") || "—"}</span>,
        },
        {
          key: "confirmed",
          header: "Confirmado",
          cell: (f) => <Switch checked={Boolean(f.confirmed)} disabled={!puede} onCheckedChange={(v) => void cambiar(f, { confirmed: v })} aria-label="Confirmado" />,
        },
        {
          key: "is_active",
          header: "Activo",
          cell: (f) => <Switch checked={Boolean(f.is_active)} disabled={!puede} onCheckedChange={(v) => void cambiar(f, { is_active: v })} aria-label="Activo" />,
        },
      ]}
      campos={[
        { name: "device_code", label: "ID dispositivo", readOnlyOnEdit: true },
        { name: "name", label: "Nombre" },
        { name: "door_name", label: "Puerta" },
        { name: "classification", label: "Clasificación", type: "select", options: CLASES },
        { name: "site", label: "Sede" },
        { name: "building", label: "Edificio" },
        { name: "floor", label: "Piso" },
        { name: "confirmed", label: "Clasificación confirmada", type: "switch" },
        { name: "is_active", label: "Activo", type: "switch" },
      ]}
    />
  );
}
