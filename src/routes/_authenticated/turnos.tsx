import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowRight,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Loader2,
  Moon,
  CalendarDays,
  Pencil,
  Plus,
  Repeat,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { alfabetico } from "@/lib/filtro-personas";
import { recalcularAsistencia } from "@/lib/asistencia.functions";
import { PageHeader } from "@/components/app-shell";
import { Paginador } from "@/components/simple-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ChipTurno } from "@/components/chip-turno";
import { MallaTab } from "@/components/malla-turnos";
import {
  COLORES,
  DIAS,
  corta,
  hora,
  hoy,
  lunesDe,
  sumarDias,
  todas,
  type Campana,
  type Empleado,
  type Programado,
  type Rotacion,
  type Turno,
} from "@/lib/turnos";

export const Route = createFileRoute("/_authenticated/turnos")({
  head: () => ({ meta: [{ title: "Turnos — Convert-IA" }] }),
  component: Turnos,
});

/* ---------------- Tipos y utilidades ---------------- */

type Asignacion = {
  id: string;
  employee_id: string;
  shift_id: string | null;
  rotation_id: string | null;
  semana_inicial: number;
  start_date: string;
  end_date: string | null;
  nota: string | null;
  created_at: string;
  profiles: { full_name: string | null } | null;
};

const GENERAL = "_general";
const TODAS = "_todas";
const nombreCampana = (id: string | null, mapa: Map<string, string>) =>
  id ? (mapa.get(id) ?? "Campaña") : "General";

/* ---------------- Página ---------------- */

function Turnos() {
  const acceso = useAccess();
  const veTodo = acceso.scope === "plataforma" || acceso.scope === "mi_empresa";
  const [campana, setCampana] = useState<string>(TODAS);

  const campanas = useQuery({
    queryKey: ["turnos", "campanas"],
    queryFn: async () => {
      const { data, error } = await supabase.from("campaigns").select("id, name").order("name");
      if (error) throw error;
      return ((data ?? []) as Campana[]).sort((a, b) => alfabetico(a.name, b.name));
    },
  });
  const turnos = useQuery({
    queryKey: ["turnos", "horarios"],
    queryFn: async () => {
      const { data, error } = await dbAny.from("shifts").select("*").order("code");
      if (error) throw error;
      return (data ?? []) as Turno[];
    },
  });
  const rotaciones = useQuery({
    queryKey: ["turnos", "rotaciones"],
    queryFn: async () => {
      const { data, error } = await dbAny.from("shift_rotations").select("*").order("code");
      if (error) throw error;
      return (data ?? []) as Rotacion[];
    },
  });

  const listaCampanas = useMemo(() => campanas.data ?? [], [campanas.data]);
  const mapaCampanas = useMemo(
    () => new Map(listaCampanas.map((c) => [c.id, c.name])),
    [listaCampanas],
  );
  const mapaTurnos = useMemo(
    () => new Map((turnos.data ?? []).map((t) => [t.id, t])),
    [turnos.data],
  );
  const misCampanas = useMemo(() => new Set(listaCampanas.map((c) => c.id)), [listaCampanas]);
  const gestionable = (campaignId: string | null) =>
    veTodo || (campaignId !== null && misCampanas.has(campaignId));
  const enFiltro = (campaignId: string | null) =>
    campana === TODAS ||
    (campana === GENERAL ? campaignId === null : campaignId === campana || campaignId === null);

  return (
    <div>
      <PageHeader
        titulo="Turnos"
        descripcion="Malla diaria, horarios y rotaciones de cada campaña para el personal activo. El turno del día define las tardanzas y la jornada nocturna."
        acciones={
          <Select value={campana} onValueChange={setCampana}>
            <SelectTrigger className="w-64" aria-label="Campaña">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODAS}>
                {veTodo ? "Todas las campañas" : "Todas mis campañas"}
              </SelectItem>
              <SelectItem value={GENERAL}>Solo horarios generales</SelectItem>
              {listaCampanas.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {!veTodo && listaCampanas.length === 0 && !campanas.isLoading ? (
        <Card className="mb-4 p-4 text-sm text-muted-foreground">
          No tienes campañas asignadas. Pide a un administrador que te asocie a tu campaña para
          gestionar sus turnos.
        </Card>
      ) : null}
      <Tabs defaultValue="malla">
        <TabsList className="mb-3 h-auto flex-wrap justify-start">
          <TabsTrigger value="malla">
            <CalendarDays className="mr-1 size-4" /> Malla semanal
          </TabsTrigger>
          <TabsTrigger value="asignacion">
            <UserPlus className="mr-1 size-4" /> Asignación del personal
          </TabsTrigger>
          <TabsTrigger value="horarios">
            <CalendarClock className="mr-1 size-4" /> Horarios
          </TabsTrigger>
          <TabsTrigger value="rotaciones">
            <Repeat className="mr-1 size-4" /> Rotaciones
          </TabsTrigger>
        </TabsList>
        <TabsContent value="malla">
          <MallaTab
            campana={campana === TODAS || campana === GENERAL ? null : campana}
            mapaCampanas={mapaCampanas}
            mapaTurnos={mapaTurnos}
            turnos={turnos.data ?? []}
            puedeAsignar={acceso.can("turnos", "asignar")}
          />
        </TabsContent>
        <TabsContent value="asignacion">
          <AsignacionTab
            campana={campana}
            campanas={listaCampanas}
            mapaCampanas={mapaCampanas}
            mapaTurnos={mapaTurnos}
            turnos={turnos.data ?? []}
            rotaciones={rotaciones.data ?? []}
            puedeAsignar={acceso.can("turnos", "asignar")}
          />
        </TabsContent>
        <TabsContent value="horarios">
          <HorariosTab
            turnos={(turnos.data ?? []).filter((t) => enFiltro(t.campaign_id))}
            cargando={turnos.isLoading}
            campanas={listaCampanas}
            mapaCampanas={mapaCampanas}
            veTodo={veTodo}
            gestionable={gestionable}
            campanaInicial={campana !== TODAS && campana !== GENERAL ? campana : null}
            puedeCrear={acceso.can("turnos", "crear")}
            puedeEditar={acceso.can("turnos", "editar")}
            tenantId={acceso.tenantId}
          />
        </TabsContent>
        <TabsContent value="rotaciones">
          <RotacionesTab
            rotaciones={(rotaciones.data ?? []).filter((r) => enFiltro(r.campaign_id))}
            cargando={rotaciones.isLoading}
            turnos={turnos.data ?? []}
            mapaTurnos={mapaTurnos}
            campanas={listaCampanas}
            mapaCampanas={mapaCampanas}
            veTodo={veTodo}
            gestionable={gestionable}
            campanaInicial={campana !== TODAS && campana !== GENERAL ? campana : null}
            puedeCrear={acceso.can("turnos", "crear")}
            puedeEditar={acceso.can("turnos", "editar")}
            tenantId={acceso.tenantId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------------- Horarios ---------------- */

function HorariosTab({
  turnos,
  cargando,
  campanas,
  mapaCampanas,
  veTodo,
  gestionable,
  campanaInicial,
  puedeCrear,
  puedeEditar,
  tenantId,
}: {
  turnos: Turno[];
  cargando: boolean;
  campanas: Campana[];
  mapaCampanas: Map<string, string>;
  veTodo: boolean;
  gestionable: (c: string | null) => boolean;
  campanaInicial: string | null;
  puedeCrear: boolean;
  puedeEditar: boolean;
  tenantId: string | null;
}) {
  const qc = useQueryClient();
  const [editando, setEditando] = useState<Partial<Turno> | null>(null);
  const ordenados = [...turnos].sort(
    (a, b) =>
      alfabetico(
        nombreCampana(a.campaign_id, mapaCampanas),
        nombreCampana(b.campaign_id, mapaCampanas),
      ) || a.start_time.localeCompare(b.start_time),
  );

  async function eliminar(t: Turno) {
    if (!confirm(`¿Eliminar el horario «${t.name}»?`)) return;
    const { error } = await dbAny.from("shifts").delete().eq("id", t.id);
    if (error) {
      toast.error("No se pudo eliminar", {
        description: /foreign key|violates/i.test(error.message)
          ? "El horario está asignado a personas; inactívalo en lugar de borrarlo."
          : error.message,
      });
      return;
    }
    toast.success("Horario eliminado");
    void qc.invalidateQueries({ queryKey: ["turnos"] });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Cada horario pertenece a una campaña: los de Claro Costa Rica no se mezclan con los de
          Tigo o Movistar Perú.
        </p>
        {puedeCrear ? (
          <Button
            onClick={() =>
              setEditando({
                campaign_id: campanaInicial ?? (veTodo ? null : (campanas[0]?.id ?? null)),
                workdays: [1, 2, 3, 4, 5],
                break_minutes: 60,
                tolerance_in_minutes: 10,
                tolerance_out_minutes: 10,
                status: "activo",
                crosses_midnight: false,
                color: COLORES[0]!,
              })
            }
          >
            <Plus className="size-4" /> Nuevo horario
          </Button>
        ) : null}
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Horario</th>
              <th className="px-3 py-2">Campaña</th>
              <th className="px-3 py-2">Entrada – salida</th>
              <th className="px-3 py-2">Días</th>
              <th className="px-3 py-2">Descanso</th>
              <th className="px-3 py-2">Tolerancia</th>
              <th className="px-3 py-2">Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cargando ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline size-4 animate-spin" />
                  Cargando…
                </td>
              </tr>
            ) : ordenados.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  No hay horarios para esta campaña.{" "}
                  {puedeCrear ? "Crea el primero con «Nuevo horario»." : ""}
                </td>
              </tr>
            ) : (
              ordenados.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="size-3 shrink-0 rounded-full"
                        style={{ background: t.color ?? "#94a3b8" }}
                      />
                      <div>
                        <p className="font-medium">{t.name}</p>
                        <p className="text-xs text-muted-foreground">{t.code}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {t.campaign_id ? (
                      (mapaCampanas.get(t.campaign_id) ?? "—")
                    ) : (
                      <Badge variant="outline">General</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {hora(t.start_time)} – {hora(t.end_time)}
                    {t.crosses_midnight ? (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                        <Moon className="size-3" />
                        nocturno
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-0.5">
                      {DIAS.map(([d, l, n]) => (
                        <span
                          key={d}
                          title={n}
                          className={cn(
                            "flex size-5 items-center justify-center rounded text-[10px] font-semibold",
                            t.workdays.includes(d)
                              ? "bg-primary/15 text-primary"
                              : "text-muted-foreground/40",
                          )}
                        >
                          {l}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{t.break_minutes} min</td>
                  <td className="px-3 py-2 tabular-nums">{t.tolerance_in_minutes} min</td>
                  <td className="px-3 py-2">
                    <Badge variant={t.status === "activo" ? "default" : "secondary"}>
                      {t.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {puedeEditar && gestionable(t.campaign_id) ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Editar"
                          onClick={() => setEditando(t)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Eliminar"
                          onClick={() => void eliminar(t)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
      <HorarioDialog
        valor={editando}
        onClose={() => setEditando(null)}
        campanas={campanas}
        veTodo={veTodo}
        tenantId={tenantId}
      />
    </div>
  );
}

function HorarioDialog({
  valor,
  onClose,
  campanas,
  veTodo,
  tenantId,
}: {
  valor: Partial<Turno> | null;
  onClose: () => void;
  campanas: Campana[];
  veTodo: boolean;
  tenantId: string | null;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Partial<Turno>>({});
  const [guardando, setGuardando] = useState(false);
  const [abiertoPara, setAbiertoPara] = useState<Partial<Turno> | null>(null);
  if (valor !== abiertoPara) {
    setAbiertoPara(valor);
    setForm(valor ?? {});
  }
  const set = (c: Partial<Turno>) => setForm((f) => ({ ...f, ...c }));
  const dias = form.workdays ?? [];

  async function guardar() {
    if (!form.code?.trim() || !form.name?.trim() || !form.start_time || !form.end_time) {
      toast.error("Completa código, nombre, entrada y salida");
      return;
    }
    if (!veTodo && !form.campaign_id) {
      toast.error("Elige la campaña del horario");
      return;
    }
    if (dias.length === 0) {
      toast.error("Marca al menos un día laborable");
      return;
    }
    setGuardando(true);
    const payload = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      start_time: form.start_time,
      end_time: form.end_time,
      crosses_midnight: Boolean(form.crosses_midnight),
      break_minutes: Number(form.break_minutes ?? 0),
      tolerance_in_minutes: Number(form.tolerance_in_minutes ?? 0),
      tolerance_out_minutes: Number(form.tolerance_out_minutes ?? 0),
      workdays: dias,
      status: form.status ?? "activo",
      campaign_id: form.campaign_id ?? null,
      color: form.color ?? null,
    };
    const { error } = form.id
      ? await dbAny.from("shifts").update(payload).eq("id", form.id)
      : await dbAny.from("shifts").insert({ ...payload, tenant_id: tenantId });
    setGuardando(false);
    if (error) {
      toast.error("No se pudo guardar", {
        description: /duplicate|unique/i.test(error.message)
          ? "Ya existe un horario con ese código en la campaña."
          : error.message,
      });
      return;
    }
    toast.success(form.id ? "Horario actualizado" : "Horario creado");
    void qc.invalidateQueries({ queryKey: ["turnos"] });
    onClose();
  }

  return (
    <Dialog open={Boolean(valor)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{form.id ? "Editar horario" : "Nuevo horario"}</DialogTitle>
          <DialogDescription>
            Un horario es una franja (p. ej. 06:00–14:00). Para turnos que cambian cada semana,
            combina varios en una rotación.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Campaña</Label>
            <Select
              value={form.campaign_id ?? GENERAL}
              onValueChange={(v) => set({ campaign_id: v === GENERAL ? null : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Elige la campaña" />
              </SelectTrigger>
              <SelectContent>
                {veTodo ? (
                  <SelectItem value={GENERAL}>General (todas las campañas)</SelectItem>
                ) : null}
                {campanas.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="h-code">Código</Label>
              <Input
                id="h-code"
                value={form.code ?? ""}
                placeholder="T1"
                onChange={(e) => set({ code: e.target.value })}
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="h-name">Nombre</Label>
              <Input
                id="h-name"
                value={form.name ?? ""}
                placeholder="Mañana 06:00–14:00"
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="h-ini">Entrada</Label>
              <Input
                id="h-ini"
                type="time"
                value={hora(form.start_time) === "—" ? "" : hora(form.start_time)}
                onChange={(e) =>
                  set({
                    start_time: e.target.value,
                    crosses_midnight: Boolean(
                      form.end_time && e.target.value && form.end_time.slice(0, 5) < e.target.value,
                    ),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-fin">Salida</Label>
              <Input
                id="h-fin"
                type="time"
                value={hora(form.end_time) === "—" ? "" : hora(form.end_time)}
                onChange={(e) =>
                  set({
                    end_time: e.target.value,
                    crosses_midnight: Boolean(
                      form.start_time &&
                      e.target.value &&
                      e.target.value < form.start_time.slice(0, 5),
                    ),
                  })
                }
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <Label htmlFor="h-noc">Cruza medianoche</Label>
              <p className="text-xs text-muted-foreground">
                Las marcas de madrugada cuentan para el día en que empezó el turno.
              </p>
            </div>
            <Switch
              id="h-noc"
              checked={Boolean(form.crosses_midnight)}
              onCheckedChange={(v) => set({ crosses_midnight: v })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Días laborables</Label>
            <div className="flex gap-1">
              {DIAS.map(([d, l, n]) => (
                <button
                  key={d}
                  type="button"
                  title={n}
                  aria-pressed={dias.includes(d)}
                  onClick={() =>
                    set({ workdays: dias.includes(d) ? dias.filter((x) => x !== d) : [...dias, d] })
                  }
                  className={cn(
                    "size-9 rounded-md border text-sm font-medium",
                    dias.includes(d)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["Lunes a viernes", [1, 2, 3, 4, 5]],
                  ["Lunes a sábado", [1, 2, 3, 4, 5, 6]],
                  ["Todos los días", [0, 1, 2, 3, 4, 5, 6]],
                  ["Fin de semana", [6, 0]],
                ] as [string, number[]][]
              ).map(([t, d]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => set({ workdays: d })}
                  className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary"
                >
                  {t}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Los días sin marcar son de descanso. Para fechas puntuales (p. ej. del 5 al 10 de
              octubre), usa «Programar días» en la pestaña Malla semanal.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="h-brk">Descanso (min)</Label>
              <Input
                id="h-brk"
                type="number"
                min={0}
                value={form.break_minutes ?? 0}
                onChange={(e) => set({ break_minutes: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-tin">Tolerancia entrada</Label>
              <Input
                id="h-tin"
                type="number"
                min={0}
                value={form.tolerance_in_minutes ?? 0}
                onChange={(e) => set({ tolerance_in_minutes: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-tout">Tolerancia salida</Label>
              <Input
                id="h-tout"
                type="number"
                min={0}
                value={form.tolerance_out_minutes ?? 0}
                onChange={(e) => set({ tolerance_out_minutes: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1.5">
              <Label>Color</Label>
              <div className="flex gap-1.5">
                {COLORES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${c}`}
                    onClick={() => set({ color: c })}
                    className={cn(
                      "size-6 rounded-full border-2",
                      form.color === c ? "border-foreground" : "border-transparent",
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="h-act">Activo</Label>
              <Switch
                id="h-act"
                checked={(form.status ?? "activo") === "activo"}
                onCheckedChange={(v) => set({ status: v ? "activo" : "inactivo" })}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void guardar()} disabled={guardando}>
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null} Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Rotaciones ---------------- */

function RotacionesTab({
  rotaciones,
  cargando,
  turnos,
  mapaTurnos,
  campanas,
  mapaCampanas,
  veTodo,
  gestionable,
  campanaInicial,
  puedeCrear,
  puedeEditar,
  tenantId,
}: {
  rotaciones: Rotacion[];
  cargando: boolean;
  turnos: Turno[];
  mapaTurnos: Map<string, Turno>;
  campanas: Campana[];
  mapaCampanas: Map<string, string>;
  veTodo: boolean;
  gestionable: (c: string | null) => boolean;
  campanaInicial: string | null;
  puedeCrear: boolean;
  puedeEditar: boolean;
  tenantId: string | null;
}) {
  const qc = useQueryClient();
  const [editando, setEditando] = useState<Partial<Rotacion> | null>(null);

  async function eliminar(r: Rotacion) {
    if (!confirm(`¿Eliminar la rotación «${r.name}»?`)) return;
    const { error } = await dbAny.from("shift_rotations").delete().eq("id", r.id);
    if (error) {
      toast.error("No se pudo eliminar", {
        description: /foreign key|violates/i.test(error.message)
          ? "La rotación está asignada a personas; inactívala en lugar de borrarla."
          : error.message,
      });
      return;
    }
    toast.success("Rotación eliminada");
    void qc.invalidateQueries({ queryKey: ["turnos"] });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Una rotación repite sus semanas en ciclo: por ejemplo, semana 1 de 06:00 a 14:00, semana 2
          de 14:00 a 22:00 y vuelve a empezar. Sirve para el personal 100 % rotativo y los
          administrativos sin horario fijo.
        </p>
        {puedeCrear ? (
          <Button
            onClick={() =>
              setEditando({
                campaign_id: campanaInicial ?? (veTodo ? null : (campanas[0]?.id ?? null)),
                semanas: ["", ""],
                status: "activo",
              })
            }
          >
            <Plus className="size-4" /> Nueva rotación
          </Button>
        ) : null}
      </div>
      {cargando ? (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline size-4 animate-spin" />
          Cargando…
        </p>
      ) : null}
      {!cargando && rotaciones.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No hay rotaciones para esta campaña.
        </Card>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {rotaciones.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">
                  {r.name} <span className="text-xs text-muted-foreground">· {r.code}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {nombreCampana(r.campaign_id, mapaCampanas)} · ciclo de {r.semanas.length}{" "}
                  {r.semanas.length === 1 ? "semana" : "semanas"}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {r.status !== "activo" ? <Badge variant="secondary">inactiva</Badge> : null}
                {puedeEditar && gestionable(r.campaign_id) ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Editar"
                      onClick={() => setEditando(r)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Eliminar"
                      onClick={() => void eliminar(r)}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {r.semanas.map((s, i) => (
                <Fragment key={i}>
                  {i > 0 ? <ArrowRight className="size-3 text-muted-foreground" /> : null}
                  <span className="flex items-center gap-1 text-xs">
                    <span className="text-muted-foreground">S{i + 1}</span>
                    <ChipTurno turno={mapaTurnos.get(s)} />
                  </span>
                </Fragment>
              ))}
              <Repeat className="ml-1 size-3 text-muted-foreground" />
            </div>
          </Card>
        ))}
      </div>
      <RotacionDialog
        valor={editando}
        onClose={() => setEditando(null)}
        turnos={turnos}
        campanas={campanas}
        veTodo={veTodo}
        tenantId={tenantId}
      />
    </div>
  );
}

function RotacionDialog({
  valor,
  onClose,
  turnos,
  campanas,
  veTodo,
  tenantId,
}: {
  valor: Partial<Rotacion> | null;
  onClose: () => void;
  turnos: Turno[];
  campanas: Campana[];
  veTodo: boolean;
  tenantId: string | null;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Partial<Rotacion>>({});
  const [guardando, setGuardando] = useState(false);
  const [abiertoPara, setAbiertoPara] = useState<Partial<Rotacion> | null>(null);
  if (valor !== abiertoPara) {
    setAbiertoPara(valor);
    setForm(valor ?? {});
  }
  const set = (c: Partial<Rotacion>) => setForm((f) => ({ ...f, ...c }));
  const semanas = form.semanas ?? [];
  // Horarios de la campaña de la rotación y los generales
  const disponibles = turnos.filter(
    (t) =>
      t.status === "activo" &&
      (t.campaign_id === null || t.campaign_id === (form.campaign_id ?? null)) &&
      (form.campaign_id ? true : t.campaign_id === null),
  );

  async function guardar() {
    if (!form.code?.trim() || !form.name?.trim()) {
      toast.error("Completa código y nombre");
      return;
    }
    if (!veTodo && !form.campaign_id) {
      toast.error("Elige la campaña");
      return;
    }
    if (semanas.length === 0 || semanas.some((s) => !s)) {
      toast.error("Elige el horario de cada semana");
      return;
    }
    setGuardando(true);
    const payload = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      campaign_id: form.campaign_id ?? null,
      semanas,
      status: form.status ?? "activo",
    };
    const { error } = form.id
      ? await dbAny.from("shift_rotations").update(payload).eq("id", form.id)
      : await dbAny.from("shift_rotations").insert({ ...payload, tenant_id: tenantId });
    setGuardando(false);
    if (error) {
      toast.error("No se pudo guardar", {
        description: /duplicate|unique/i.test(error.message)
          ? "Ya existe una rotación con ese código en la campaña."
          : error.message,
      });
      return;
    }
    toast.success(form.id ? "Rotación actualizada" : "Rotación creada");
    void qc.invalidateQueries({ queryKey: ["turnos"] });
    onClose();
  }

  return (
    <Dialog open={Boolean(valor)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{form.id ? "Editar rotación" : "Nueva rotación"}</DialogTitle>
          <DialogDescription>
            Elige el horario de cada semana del ciclo. Al terminar la última semana vuelve a la
            primera.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Campaña</Label>
            <Select
              value={form.campaign_id ?? GENERAL}
              onValueChange={(v) =>
                set({ campaign_id: v === GENERAL ? null : v, semanas: semanas.map(() => "") })
              }
              disabled={Boolean(form.id)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Elige la campaña" />
              </SelectTrigger>
              <SelectContent>
                {veTodo ? (
                  <SelectItem value={GENERAL}>General (todas las campañas)</SelectItem>
                ) : null}
                {campanas.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="r-code">Código</Label>
              <Input
                id="r-code"
                value={form.code ?? ""}
                placeholder="ROT-AB"
                onChange={(e) => set({ code: e.target.value })}
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="r-name">Nombre</Label>
              <Input
                id="r-name"
                value={form.name ?? ""}
                placeholder="Mañana / tarde semanal"
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Semanas del ciclo</Label>
            {disponibles.length === 0 ? (
              <p className="text-xs text-destructive">
                Esta campaña aún no tiene horarios activos: créalos primero en la pestaña
                «Horarios».
              </p>
            ) : null}
            {semanas.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-sm text-muted-foreground">Semana {i + 1}</span>
                <Select
                  value={s}
                  onValueChange={(v) => set({ semanas: semanas.map((x, j) => (j === i ? v : x)) })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Elige el horario" />
                  </SelectTrigger>
                  <SelectContent>
                    {disponibles.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.code} · {t.name} ({hora(t.start_time)}–{hora(t.end_time)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Quitar semana"
                  disabled={semanas.length <= 1}
                  onClick={() => set({ semanas: semanas.filter((_, j) => j !== i) })}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={semanas.length >= 12}
              onClick={() => set({ semanas: [...semanas, ""] })}
            >
              <Plus className="size-4" /> Agregar semana
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="r-act">Activa</Label>
            <Switch
              id="r-act"
              checked={(form.status ?? "activo") === "activo"}
              onCheckedChange={(v) => set({ status: v ? "activo" : "inactivo" })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void guardar()} disabled={guardando}>
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null} Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Asignación ---------------- */

function AsignacionTab({
  campana,
  campanas,
  mapaCampanas,
  mapaTurnos,
  turnos,
  rotaciones,
  puedeAsignar,
}: {
  campana: string;
  campanas: Campana[];
  mapaCampanas: Map<string, string>;
  mapaTurnos: Map<string, Turno>;
  turnos: Turno[];
  rotaciones: Rotacion[];
  puedeAsignar: boolean;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(0);
  const [tamano, setTamano] = useState(20);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [abierta, setAbierta] = useState(false);
  const [expandida, setExpandida] = useState<string | null>(null);
  const [semanaBase, setSemanaBase] = useState(() => lunesDe(hoy()));

  // Solo personal activo: el inactivo no se puede programar
  const empleados = useQuery({
    queryKey: ["turnos", "personal-activo"],
    queryFn: () =>
      todas<Empleado>((a, b) =>
        supabase
          .from("employees")
          .select("id, document, full_name, position, campaign_id")
          .eq("status", "activo")
          .order("full_name")
          .range(a, b),
      ),
  });

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return (empleados.data ?? [])
      .filter((e) => campana === TODAS || campana === GENERAL || e.campaign_id === campana)
      .filter(
        (e) =>
          !q ||
          e.full_name.toLowerCase().includes(q) ||
          e.document.includes(q) ||
          (e.position ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => alfabetico(a.full_name, b.full_name));
  }, [empleados.data, campana, busqueda]);
  const visibles = filtrados.slice(pagina * tamano, (pagina + 1) * tamano);
  if (pagina > 0 && pagina * tamano >= filtrados.length) setPagina(0);

  const semanas = [0, 1, 2, 3].map((w) => sumarDias(semanaBase, w * 7));
  const fechas = semanas.flatMap((s) => [0, 1, 2, 3, 4, 5, 6].map((d) => sumarDias(s, d)));
  const programacion = useQuery({
    queryKey: ["turnos", "programacion", semanaBase, visibles.map((e) => e.id).join(",")],
    enabled: visibles.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "turnos_programados" as never,
        { _fechas: fechas, _empleados: visibles.map((e) => e.id) } as never,
      );
      if (error) throw error;
      const mapa = new Map<string, Programado>();
      for (const p of (data ?? []) as Programado[]) mapa.set(`${p.employee_id}|${p.fecha}`, p);
      return mapa;
    },
  });

  // Horarios distintos de cada semana (una asignación temporal puede empezar a mitad de semana)
  const turnosSemana = (empId: string, lunes: string) => {
    const ids: string[] = [];
    for (let d = 0; d < 7; d++) {
      const p = programacion.data?.get(`${empId}|${sumarDias(lunes, d)}`);
      if (p?.shift_id && !ids.includes(p.shift_id)) ids.push(p.shift_id);
    }
    return ids;
  };

  const seleccionados = (empleados.data ?? []).filter((e) => seleccion.has(e.id));
  const todosFiltrados = filtrados.length > 0 && filtrados.every((e) => seleccion.has(e.id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-sm"
          placeholder="Buscar por nombre, cédula o cargo…"
          value={busqueda}
          onChange={(e) => {
            setBusqueda(e.target.value);
            setPagina(0);
          }}
        />
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSemanaBase(sumarDias(semanaBase, -7))}
          >
            ‹ Semana anterior
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSemanaBase(lunesDe(hoy()))}>
            Esta semana
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSemanaBase(sumarDias(semanaBase, 7))}
          >
            Siguiente ›
          </Button>
        </div>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {filtrados.length.toLocaleString("es-CO")} personas activas
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Solo aparece el personal <strong>activo</strong>. Si alguien debe estar activo y no aparece,
        ve a{" "}
        <Link to="/empleados" className="text-primary underline">
          Empleados
        </Link>{" "}
        y usa «Solicitar ajuste» para que Nómina o Administración lo activen.
      </p>

      {puedeAsignar && seleccionados.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">{seleccionados.length} seleccionados</span>
          <Button size="sm" onClick={() => setAbierta(true)}>
            <CalendarClock className="size-4" /> Asignar turno
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setSeleccion(new Set())}
          >
            <X className="size-4" /> Quitar selección
          </Button>
        </div>
      ) : null}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              {puedeAsignar ? (
                <th className="w-10 px-3 py-2">
                  <Checkbox
                    aria-label="Seleccionar todos los filtrados"
                    checked={todosFiltrados}
                    onCheckedChange={(v) =>
                      setSeleccion(v ? new Set(filtrados.map((e) => e.id)) : new Set())
                    }
                  />
                </th>
              ) : null}
              <th className="px-3 py-2">Persona</th>
              <th className="px-3 py-2">Campaña</th>
              {semanas.map((s, i) => (
                <th key={s} className="px-3 py-2 whitespace-nowrap">
                  {i === 0 && s === lunesDe(hoy()) ? "Esta semana" : "Semana"} · {corta(s)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {empleados.isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline size-4 animate-spin" />
                  Cargando personal…
                </td>
              </tr>
            ) : visibles.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                  No hay personal activo con estos filtros.
                </td>
              </tr>
            ) : (
              visibles.map((e) => (
                <Fragment key={e.id}>
                  <tr
                    className="cursor-pointer border-t hover:bg-muted/30"
                    onClick={() => setExpandida(expandida === e.id ? null : e.id)}
                  >
                    {puedeAsignar ? (
                      <td className="px-3 py-2" onClick={(ev) => ev.stopPropagation()}>
                        <Checkbox
                          aria-label={`Seleccionar a ${e.full_name}`}
                          checked={seleccion.has(e.id)}
                          onCheckedChange={(v) =>
                            setSeleccion((prev) => {
                              const n = new Set(prev);
                              if (v) n.add(e.id);
                              else n.delete(e.id);
                              return n;
                            })
                          }
                        />
                      </td>
                    ) : null}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        {expandida === e.id ? (
                          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <div>
                          <p className="font-medium">{e.full_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {e.document}
                            {e.position ? ` · ${e.position}` : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {e.campaign_id ? (mapaCampanas.get(e.campaign_id) ?? "—") : "Sin campaña"}
                    </td>
                    {semanas.map((s) => {
                      const ids = turnosSemana(e.id, s);
                      return (
                        <td key={s} className="px-3 py-2">
                          {programacion.isLoading ? (
                            <span className="text-xs text-muted-foreground">…</span>
                          ) : ids.length ? (
                            <div className="flex flex-col gap-1">
                              {ids.map((id) => (
                                <ChipTurno key={id} turno={mapaTurnos.get(id)} />
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Sin turno</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {expandida === e.id ? (
                    <tr className="bg-muted/20">
                      <td colSpan={7} className="px-4 py-3">
                        <HistorialAsignaciones
                          empleado={e}
                          mapaTurnos={mapaTurnos}
                          rotaciones={rotaciones}
                          puedeAsignar={puedeAsignar}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </Card>
      <Paginador
        pagina={pagina}
        tamano={tamano}
        total={filtrados.length}
        onCambio={setPagina}
        onTamano={setTamano}
      />

      <AsignarDialog
        abierta={abierta}
        onClose={() => setAbierta(false)}
        personas={seleccionados}
        turnos={turnos}
        rotaciones={rotaciones}
        mapaTurnos={mapaTurnos}
        mapaCampanas={mapaCampanas}
        onListo={() => {
          setSeleccion(new Set());
          setAbierta(false);
        }}
      />
    </div>
  );
}

function HistorialAsignaciones({
  empleado,
  mapaTurnos,
  rotaciones,
  puedeAsignar,
}: {
  empleado: Empleado;
  mapaTurnos: Map<string, Turno>;
  rotaciones: Rotacion[];
  puedeAsignar: boolean;
}) {
  const qc = useQueryClient();
  const lista = useQuery({
    queryKey: ["turnos", "asignaciones", empleado.id],
    queryFn: async () => {
      const { data, error } = await dbAny
        .from("shift_assignments")
        .select("*, profiles:created_by(full_name)")
        .eq("employee_id", empleado.id)
        .order("start_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Asignacion[];
    },
  });
  const mapaRot = new Map(rotaciones.map((r) => [r.id, r]));

  async function quitar(a: Asignacion) {
    if (!confirm("¿Quitar esta asignación?")) return;
    const { error } = await supabase.rpc(
      "quitar_asignacion_turno" as never,
      { _id: a.id } as never,
    );
    if (error) {
      toast.error("No se pudo quitar", { description: error.message });
      return;
    }
    toast.success("Asignación quitada");
    void qc.invalidateQueries({ queryKey: ["turnos"] });
  }

  if (lista.isLoading)
    return (
      <p className="text-xs text-muted-foreground">
        <Loader2 className="mr-1 inline size-3 animate-spin" />
        Cargando historial…
      </p>
    );
  if (!lista.data?.length)
    return (
      <p className="text-xs text-muted-foreground">
        {empleado.full_name} no tiene turnos asignados todavía.
      </p>
    );
  const h = hoy();
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        Historial de turnos (la asignación vigente con inicio más reciente es la que aplica)
      </p>
      {lista.data.map((a) => {
        const rot = a.rotation_id ? mapaRot.get(a.rotation_id) : undefined;
        const vigente = a.start_date <= h && (!a.end_date || a.end_date >= h);
        return (
          <div
            key={a.id}
            className={cn(
              "flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-xs",
              !vigente && "opacity-70",
            )}
          >
            {vigente ? (
              <Badge className="h-5">Vigente</Badge>
            ) : a.start_date > h ? (
              <Badge variant="outline" className="h-5">
                Programada
              </Badge>
            ) : (
              <Badge variant="secondary" className="h-5">
                Terminada
              </Badge>
            )}
            <span className="tabular-nums">
              {corta(a.start_date)} → {a.end_date ? corta(a.end_date) : "indefinido"}
            </span>
            {a.shift_id ? (
              <ChipTurno turno={mapaTurnos.get(a.shift_id)} />
            ) : (
              <span className="flex flex-wrap items-center gap-1">
                <Repeat className="size-3" /> {rot?.name ?? "Rotación"} (arranca en semana{" "}
                {a.semana_inicial}):
                {rot?.semanas.map((s, i) => (
                  <ChipTurno key={i} turno={mapaTurnos.get(s)} />
                ))}
              </span>
            )}
            {a.nota ? <span className="text-muted-foreground">· {a.nota}</span> : null}
            <span className="ml-auto text-muted-foreground">{a.profiles?.full_name ?? ""}</span>
            {puedeAsignar ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Quitar asignación"
                onClick={() => void quitar(a)}
              >
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AsignarDialog({
  abierta,
  onClose,
  personas,
  turnos,
  rotaciones,
  mapaTurnos,
  mapaCampanas,
  onListo,
}: {
  abierta: boolean;
  onClose: () => void;
  personas: Empleado[];
  turnos: Turno[];
  rotaciones: Rotacion[];
  mapaTurnos: Map<string, Turno>;
  mapaCampanas: Map<string, string>;
  onListo: () => void;
}) {
  const qc = useQueryClient();
  const recalcular = useServerFn(recalcularAsistencia);
  const [modo, setModo] = useState<"rotacion" | "fijo">("rotacion");
  const [objetivo, setObjetivo] = useState("");
  const [desde, setDesde] = useState(() => lunesDe(sumarDias(hoy(), 7)));
  const [hasta, setHasta] = useState("");
  const [semanaInicial, setSemanaInicial] = useState(1);
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);

  // Los horarios son por campaña: con personas de varias campañas solo sirven los generales
  const campanasSel = [...new Set(personas.map((p) => p.campaign_id ?? ""))];
  const unica = campanasSel.length === 1 && campanasSel[0] ? campanasSel[0] : null;
  const aplica = (c: string | null) => c === null || (unica !== null && c === unica);
  const turnosOk = turnos.filter((t) => t.status === "activo" && aplica(t.campaign_id));
  const rotacionesOk = rotaciones.filter((r) => r.status === "activo" && aplica(r.campaign_id));
  const rot = modo === "rotacion" ? rotacionesOk.find((r) => r.id === objetivo) : undefined;

  // Vista previa de las próximas semanas con la rotación elegida
  const vista = rot
    ? [0, 1, 2, 3, 4, 5].map((w) => {
        const lunes = sumarDias(lunesDe(desde), w * 7);
        const idx = (w + semanaInicial - 1) % rot.semanas.length;
        return { lunes, turno: mapaTurnos.get(rot.semanas[idx]!) };
      })
    : [];

  async function guardar() {
    if (!objetivo) {
      toast.error(modo === "rotacion" ? "Elige la rotación" : "Elige el horario");
      return;
    }
    if (hasta && hasta < desde) {
      toast.error("La fecha final es anterior a la inicial");
      return;
    }
    setGuardando(true);
    const { data, error } = await supabase.rpc(
      "asignar_turnos" as never,
      {
        _empleados: personas.map((p) => p.id),
        _shift: modo === "fijo" ? objetivo : null,
        _rotation: modo === "rotacion" ? objetivo : null,
        _desde: desde,
        _hasta: hasta || null,
        _semana_inicial: semanaInicial,
        _nota: nota || null,
      } as never,
    );
    if (error) {
      setGuardando(false);
      toast.error("No se pudo asignar", { description: error.message });
      return;
    }
    toast.success(
      `Turno asignado a ${data as number} ${(data as number) === 1 ? "persona" : "personas"}`,
    );
    // Si la asignación toca días pasados, se recalcula ese tramo para que las tardanzas usen el turno nuevo
    const h = hoy();
    if (desde <= h) {
      const fin = hasta && hasta < h ? hasta : h;
      const ini = desde < sumarDias(fin, -62) ? sumarDias(fin, -62) : desde;
      try {
        await recalcular({ data: { desde: ini, hasta: fin } });
        toast.success("Asistencia recalculada con el turno nuevo", {
          description: `${corta(ini)} a ${corta(fin)}`,
        });
      } catch (e) {
        toast.warning("El turno quedó asignado, pero no se pudo recalcular la asistencia", {
          description: (e as Error).message,
        });
      }
    }
    setGuardando(false);
    void qc.invalidateQueries({ queryKey: ["turnos"] });
    setObjetivo("");
    setHasta("");
    setNota("");
    setSemanaInicial(1);
    onListo();
  }

  return (
    <Dialog open={abierta} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Asignar turno a {personas.length} {personas.length === 1 ? "persona" : "personas"}
          </DialogTitle>
          <DialogDescription>
            {unica
              ? `Campaña ${mapaCampanas.get(unica) ?? ""}: puedes usar sus horarios y rotaciones, o los generales.`
              : "Las personas elegidas son de varias campañas: solo puedes usar horarios y rotaciones generales."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex max-h-20 flex-wrap gap-1 overflow-auto">
            {personas.map((p) => (
              <Badge key={p.id} variant="secondary" className="font-normal">
                {p.full_name}
              </Badge>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["rotacion", "fijo"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setModo(m);
                  setObjetivo("");
                  setSemanaInicial(1);
                }}
                className={cn(
                  "rounded-lg border p-3 text-left text-sm",
                  modo === m ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                )}
              >
                <p className="flex items-center gap-1.5 font-medium">
                  {m === "rotacion" ? (
                    <Repeat className="size-4" />
                  ) : (
                    <CalendarClock className="size-4" />
                  )}
                  {m === "rotacion" ? "Rotación semanal" : "Horario fijo"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {m === "rotacion"
                    ? "Cambia de horario cada semana según el ciclo."
                    : "El mismo horario todas las semanas."}
                </p>
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>{modo === "rotacion" ? "Rotación" : "Horario"}</Label>
            <Select
              value={objetivo}
              onValueChange={(v) => {
                setObjetivo(v);
                setSemanaInicial(1);
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={modo === "rotacion" ? "Elige la rotación" : "Elige el horario"}
                />
              </SelectTrigger>
              <SelectContent>
                {modo === "rotacion"
                  ? rotacionesOk.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name} · {r.semanas.length} semanas{r.campaign_id ? "" : " (general)"}
                      </SelectItem>
                    ))
                  : turnosOk.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.code} · {t.name} ({hora(t.start_time)}–{hora(t.end_time)})
                        {t.campaign_id ? "" : " (general)"}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
            {(modo === "rotacion" ? rotacionesOk : turnosOk).length === 0 ? (
              <p className="text-xs text-destructive">
                No hay {modo === "rotacion" ? "rotaciones" : "horarios"} activos para{" "}
                {unica ? "esta campaña" : "varias campañas"}. Créalos en las pestañas «Horarios» o
                «Rotaciones».
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="a-desde">Desde</Label>
              <Input
                id="a-desde"
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-hasta">Hasta (opcional)</Label>
              <Input
                id="a-hasta"
                type="date"
                value={hasta}
                min={desde}
                onChange={(e) => setHasta(e.target.value)}
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Sin fecha final, reemplaza el turno que tenían desde ese día. Con fecha final es
            temporal: al terminar vuelve su turno anterior.
          </p>
          {rot ? (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Label className="shrink-0">Arranca en</Label>
                <Select
                  value={String(semanaInicial)}
                  onValueChange={(v) => setSemanaInicial(Number(v))}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {rot.semanas.map((s, i) => (
                      <SelectItem key={i} value={String(i + 1)}>
                        Semana {i + 1} · {mapaTurnos.get(s)?.code ?? ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                Útil para escalonar equipos: un grupo arranca en la semana 1 y otro en la 2.
              </p>
              <div className="flex flex-wrap gap-2">
                {vista.map((v) => (
                  <div key={v.lunes} className="rounded-md bg-muted/40 px-2 py-1 text-xs">
                    <p className="text-muted-foreground">Semana {corta(v.lunes)}</p>
                    <ChipTurno turno={v.turno} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="a-nota">Nota (opcional)</Label>
            <Textarea
              id="a-nota"
              rows={2}
              value={nota}
              placeholder="Ej.: rotación del equipo B por cambio de operación"
              onChange={(e) => setNota(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void guardar()} disabled={guardando || !objetivo}>
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null} Asignar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
