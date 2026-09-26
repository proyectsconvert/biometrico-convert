import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { recalcularAsistencia } from "@/lib/asistencia.functions";
import { useAccess } from "@/lib/session";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calculator, Clock, Fingerprint, Moon, Scale } from "lucide-react";

export const Route = createFileRoute("/_authenticated/jornada")({
  head: () => ({ meta: [{ title: "Reglas de cálculo — Convert-IA" }] }),
  component: Jornada,
});

const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// Solo las reglas que el motor de cálculo usa realmente.
type Config = {
  dias_laborales: number[];
  jornada_minutos: number;
  horas_extra_despues: number;
  nocturna_inicio: string;
  nocturna_fin: string;
  aplica_dominical_festivo: boolean;
  ventana_nocturna_horas: number;
  dedupe_seconds: number;
  reportes_incluir_sin_empresa: boolean;
  descanso_minutos: number;
  descanso_desde_horas: number;
  tolerancia_conciliacion_horas: number;
  descontar_descanso: boolean;
  eventos_asistencia: string;
};

const DEFECTO: Config = {
  dias_laborales: [1, 2, 3, 4, 5],
  jornada_minutos: 480,
  horas_extra_despues: 8,
  nocturna_inicio: "21:00",
  nocturna_fin: "06:00",
  aplica_dominical_festivo: true,
  ventana_nocturna_horas: 4,
  dedupe_seconds: 60,
  reportes_incluir_sin_empresa: true,
  descanso_minutos: 60,
  descanso_desde_horas: 5,
  tolerancia_conciliacion_horas: 0.5,
  descontar_descanso: false,
  eventos_asistencia: "sin_administrativos",
};

const DESCRIPCIONES: Record<keyof Config, string> = {
  dias_laborales: "Días laborales ordinarios (0=domingo … 6=sábado)",
  jornada_minutos: "Jornada esperada en minutos",
  horas_extra_despues: "Horas trabajadas a partir de las cuales se cuenta hora extra",
  nocturna_inicio: "Desde qué hora se considera hora nocturna",
  nocturna_fin: "Hasta qué hora se considera hora nocturna",
  aplica_dominical_festivo: "Calcular recargo dominical y festivo",
  ventana_nocturna_horas: "Horas después del fin de turno nocturno que siguen perteneciendo a la jornada",
  dedupe_seconds: "Segundos para considerar una marcación repetida",
  reportes_incluir_sin_empresa: "Incluir en panel y reportes al personal que aún no tiene empleador asignado",
  descanso_minutos: "Minutos de descanso/almuerzo que se descuentan cuando el empleado no tiene turno",
  descanso_desde_horas: "Permanencia mínima (horas) para descontar el descanso por defecto",
  tolerancia_conciliacion_horas: "Diferencia máxima (horas) entre lo reportado y el biométrico para considerarlo coherente",
  descontar_descanso: "Descontar el descanso/almuerzo de las horas trabajadas (si no, horas = tiempo total en la empresa)",
  eventos_asistencia: "Qué eventos cuentan como marcación: sin_administrativos (todo registro con usuario salvo actualizar, enrolar o borrar usuario de BioStar), todos_con_usuario (cualquier registro con usuario) o exitosas (solo autenticaciones exitosas)",
};

function Jornada() {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [c, setC] = useState<Config>(DEFECTO);
  const [inicial, setInicial] = useState<Config>(DEFECTO);
  const puede = acceso.can("reglas", "editar");
  const recalcular = useServerFn(recalcularAsistencia);

  const q = useQuery({
    queryKey: ["jornada", acceso.tenantId],
    enabled: Boolean(acceso.tenantId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rules")
        .select("key, value")
        .eq("tenant_id", acceso.tenantId!)
        .in("key", Object.keys(DEFECTO));
      if (error) throw error;
      const out: Record<string, unknown> = { ...DEFECTO };
      for (const r of data ?? []) out[r.key] = r.value;
      return out as Config;
    },
  });
  useEffect(() => {
    if (q.data) {
      setC(q.data);
      setInicial(q.data);
    }
  }, [q.data]);

  const guardar = useMutation({
    mutationFn: async () => {
      const cambiadas = (Object.keys(c) as (keyof Config)[]).filter(
        (k) => JSON.stringify(c[k]) !== JSON.stringify(inicial[k]),
      );
      if (!cambiadas.length) return { cambiadas, recalculado: false };
      const { error } = await supabase.from("rules").upsert(
        cambiadas.map((key) => ({
          tenant_id: acceso.tenantId!,
          key,
          value: c[key],
          description: DESCRIPCIONES[key],
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "tenant_id,key" },
      );
      if (error) throw error;
      await supabase.from("audit_logs").insert({
        tenant_id: acceso.tenantId,
        user_id: acceso.userId,
        module: "reglas",
        action: "editar",
        old_value: Object.fromEntries(cambiadas.map((k) => [k, inicial[k]])),
        new_value: Object.fromEntries(cambiadas.map((k) => [k, c[k]])),
      });
      // Recalcular todo el rango con datos (no solo los últimos días)
      const soloReportes = cambiadas.every((k) =>
        ["reportes_incluir_sin_empresa", "dedupe_seconds", "tolerancia_conciliacion_horas"].includes(k),
      );
      if (soloReportes) return { cambiadas, recalculado: false };
      // Todo el periodo con marcaciones, desde el servidor (puede abarcar varios años)
      await recalcular({ data: {} });
      return { cambiadas, recalculado: true };
    },
    onSuccess: (r) => {
      if (!r.cambiadas.length) toast.info("No hay cambios por guardar");
      else if (r.recalculado) toast.success("Reglas guardadas y asistencia recalculada");
      else toast.success("Reglas guardadas");
      if (r.cambiadas.includes("dedupe_seconds"))
        toast.info("La tolerancia de duplicados se aplica al reprocesar los archivos en Importaciones.");
      void qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error("No se pudo guardar", { description: e.message }),
  });

  const toggleDia = (d: number) =>
    setC({ ...c, dias_laborales: c.dias_laborales.includes(d) ? c.dias_laborales.filter((x) => x !== d) : [...c.dias_laborales, d].sort() });

  const pendientes = (Object.keys(c) as (keyof Config)[]).filter((k) => JSON.stringify(c[k]) !== JSON.stringify(inicial[k])).length;

  return (
    <div className="max-w-5xl pb-20">
      <PageHeader
        titulo="Reglas de cálculo"
        descripcion="Parámetros del motor de asistencia. Al guardar, la asistencia se recalcula con las nuevas reglas."
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <Tabs defaultValue="jornada">
          <TabsList className="mb-4 flex h-auto flex-wrap">
            <TabsTrigger value="jornada"><Clock className="mr-1.5 size-4" />Jornada</TabsTrigger>
            <TabsTrigger value="recargos"><Moon className="mr-1.5 size-4" />Nocturnas y recargos</TabsTrigger>
            <TabsTrigger value="marcaciones"><Fingerprint className="mr-1.5 size-4" />Marcaciones</TabsTrigger>
            <TabsTrigger value="reportes"><Scale className="mr-1.5 size-4" />Conciliación y reportes</TabsTrigger>
          </TabsList>

          <TabsContent value="jornada" className="space-y-4">
            <Seccion titulo="Días laborales ordinarios" nota="Los días no marcados se tratan como descanso.">
              <div className="flex flex-wrap gap-2">
                {DIAS.map((n, i) => (
                  <Button key={n} type="button" size="sm" disabled={!puede} variant={c.dias_laborales.includes(i) ? "default" : "outline"} onClick={() => toggleDia(i)}>
                    {n}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" disabled={!puede} onClick={() => setC({ ...c, dias_laborales: [1, 2, 3, 4, 5] })}>Lunes a viernes</Button>
                <Button size="sm" variant="ghost" disabled={!puede} onClick={() => setC({ ...c, dias_laborales: [1, 2, 3, 4, 5, 6] })}>Lunes a sábado</Button>
                <Button size="sm" variant="ghost" disabled={!puede} onClick={() => setC({ ...c, dias_laborales: [0, 1, 2, 3, 4, 5, 6] })}>Todos los días</Button>
              </div>
            </Seccion>
            <Card className="grid gap-4 p-5 sm:grid-cols-2">
              <h2 className="font-semibold sm:col-span-2">Jornada, descanso y horas extra</h2>
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3 sm:col-span-2">
                <div>
                  <p className="text-sm font-medium">Descontar descanso/almuerzo</p>
                  <p className="text-xs text-muted-foreground">Apagado: horas trabajadas = tiempo total en la empresa (primera a última marcación). Encendido: se resta el descanso de abajo o el del turno.</p>
                </div>
                <Switch disabled={!puede} checked={c.descontar_descanso} onCheckedChange={(v) => setC({ ...c, descontar_descanso: v })} />
              </div>
              <Campo label="Jornada esperada por día (horas)">
                <Input type="number" min={1} max={16} step={0.5} disabled={!puede} value={c.jornada_minutos / 60}
                  onChange={(e) => setC({ ...c, jornada_minutos: Math.round(Number(e.target.value) * 60) })} />
              </Campo>
              <Campo label="Hora extra después de (horas trabajadas)">
                <Input type="number" min={1} max={16} step={0.5} disabled={!puede} value={c.horas_extra_despues}
                  onChange={(e) => setC({ ...c, horas_extra_despues: Number(e.target.value) })} />
              </Campo>
              <Campo label="Descanso/almuerzo sin turno (minutos)">
                <Input type="number" min={0} max={180} step={5} disabled={!puede} value={c.descanso_minutos}
                  onChange={(e) => setC({ ...c, descanso_minutos: Number(e.target.value) })} />
              </Campo>
              <Campo label="Descontar el descanso si permanece al menos (horas)">
                <Input type="number" min={0} max={12} step={0.5} disabled={!puede} value={c.descanso_desde_horas}
                  onChange={(e) => setC({ ...c, descanso_desde_horas: Number(e.target.value) })} />
              </Campo>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Con turno asignado se usa el descanso del turno. La llegada tarde y el cruce de medianoche se calculan con el turno (módulo Turnos).
              </p>
            </Card>
          </TabsContent>

          <TabsContent value="recargos" className="space-y-4">
            <Card className="grid gap-4 p-5 sm:grid-cols-2">
              <h2 className="font-semibold sm:col-span-2">Horas nocturnas</h2>
              <Campo label="Inicia a las">
                <Input type="time" disabled={!puede} value={c.nocturna_inicio} onChange={(e) => setC({ ...c, nocturna_inicio: e.target.value })} />
              </Campo>
              <Campo label="Termina a las">
                <Input type="time" disabled={!puede} value={c.nocturna_fin} onChange={(e) => setC({ ...c, nocturna_fin: e.target.value })} />
              </Campo>
              <Campo label="Turnos nocturnos: horas después del fin que siguen en la misma jornada">
                <Input type="number" min={0} max={12} disabled={!puede} value={c.ventana_nocturna_horas}
                  onChange={(e) => setC({ ...c, ventana_nocturna_horas: Number(e.target.value) })} />
              </Campo>
            </Card>
            <Interruptor
              titulo="Recargo dominical y festivo"
              nota="Las horas trabajadas en domingo o en un festivo del calendario (módulo Festivos) se separan para su recargo."
              valor={c.aplica_dominical_festivo}
              disabled={!puede}
              onChange={(v) => setC({ ...c, aplica_dominical_festivo: v })}
            />
          </TabsContent>

          <TabsContent value="marcaciones" className="space-y-4">
            <Card className="grid gap-4 p-5 sm:grid-cols-2">
              <h2 className="font-semibold sm:col-span-2">Marcaciones repetidas</h2>
              <Campo label="Tolerancia de duplicados (segundos)">
                <Input type="number" min={0} max={3600} disabled={!puede} value={c.dedupe_seconds}
                  onChange={(e) => setC({ ...c, dedupe_seconds: Number(e.target.value) })} />
              </Campo>
              <p className="self-end text-xs text-muted-foreground">
                Marcaciones de la misma persona en el mismo lector dentro de este tiempo se conservan, pero no cuentan. Se aplica al reprocesar los archivos en Importaciones.
              </p>
            </Card>
            <Card className="space-y-3 p-5 text-sm">
              <h2 className="font-semibold">Qué eventos cuentan como marcación</h2>
              {[
                ["sin_administrativos", "Registros con usuario, sin eventos administrativos de BioStar (recomendado)", "Cuentan huella, tarjeta, accesos denegados y autenticaciones fallidas: la persona estuvo en el lector. No cuentan actualizar, enrolar o borrar usuario, que BioStar registra en todos los lectores a la vez al sincronizar."],
                ["todos_con_usuario", "Todos los registros con usuario", "Incluye también las actualizaciones, enrolamientos y borrados de usuario de BioStar, que pueden correr la salida a la hora de una sincronización."],
                ["exitosas", "Solo autenticaciones exitosas (huella o tarjeta)", "Ignora eventos administrativos de BioStar (actualizar, enrolar o borrar usuario), que suelen aparecer en todos los lectores a la vez cuando se sincroniza."],
              ].map(([v, t, d]) => (
                <label key={v} className={"flex cursor-pointer items-start gap-3 rounded-lg border p-3 " + (c.eventos_asistencia === v ? "border-primary bg-primary/5" : "")}>
                  <input type="radio" name="eventos_asistencia" className="mt-1" disabled={!puede} checked={c.eventos_asistencia === v} onChange={() => setC({ ...c, eventos_asistencia: v! })} />
                  <span><span className="font-medium">{t}</span><span className="block text-xs text-muted-foreground">{d}</span></span>
                </label>
              ))}
              <p className="text-xs text-muted-foreground">Al cambiarla, usa «Reprocesar todo» en Importaciones para aplicarla a todo el histórico.</p>
            </Card>
            <Card className="p-5 text-sm">
              <h2 className="mb-1 font-semibold">¿Qué cuenta como marcación?</h2>
              <p className="text-muted-foreground">
                Según la regla de arriba. Los eventos sin usuario (puerta bloqueada o desbloqueada, botón de salida, tamper) nunca cuentan. Entrada = primera marcación del día; salida = la última, siempre que haya más de un registro. Todo se conserva en la capa cruda.
              </p>
            </Card>
          </TabsContent>

          <TabsContent value="reportes" className="space-y-4">
            <Card className="grid gap-4 p-5 sm:grid-cols-2">
              <h2 className="font-semibold sm:col-span-2">Conciliación de novedades</h2>
              <Campo label="Tolerancia (horas)">
                <Input type="number" min={0} max={8} step={0.25} disabled={!puede} value={c.tolerancia_conciliacion_horas}
                  onChange={(e) => setC({ ...c, tolerancia_conciliacion_horas: Number(e.target.value) })} />
              </Campo>
              <p className="self-end text-xs text-muted-foreground">
                Si la plantilla reporta más horas que las que respalda el biométrico por encima de esta tolerancia, la persona queda «Inconsistente».
              </p>
            </Card>
            <Interruptor
              titulo="Incluir en reportes al personal sin empleador"
              nota="Mientras clasificas al personal en Empleados, decide si cuenta o no en el panel y el control diario. Seguridad, aseo y contratistas se excluyen siempre desde Empleadores."
              valor={c.reportes_incluir_sin_empresa}
              disabled={!puede}
              onChange={(v) => setC({ ...c, reportes_incluir_sin_empresa: v })}
            />
          </TabsContent>
        </Tabs>

        <Simulador c={c} />
      </div>

      {puede && pendientes ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-6 py-3">
            <p className="text-sm"><strong>{pendientes}</strong> cambio(s) sin guardar. Al guardar se recalcula la asistencia.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setC(inicial)} disabled={guardar.isPending}>Descartar</Button>
              <Button onClick={() => guardar.mutate()} disabled={guardar.isPending}>
                {guardar.isPending ? "Guardando y recalculando…" : "Guardar cambios"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const aMin = (h: string) => {
  const [a, b] = h.split(":").map(Number);
  return (a ?? 0) * 60 + (b ?? 0);
};
const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}`;

/** Minutos de [ini, fin] (minutos del día; fin puede pasar de 1440) dentro de la franja nocturna. */
function nocturnos(ini: number, fin: number, ni: number, nf: number) {
  let total = 0;
  for (let d = -1; d <= 1; d++) {
    const a = d * 1440 + ni;
    const b = nf <= ni ? (d + 1) * 1440 + nf : d * 1440 + nf;
    total += Math.max(0, Math.min(b, fin) - Math.max(a, ini));
  }
  return total;
}

/** Ejemplo en vivo: cómo quedaría una jornada con las reglas en pantalla (aún sin guardar). */
function Simulador({ c }: { c: Config }) {
  const [entrada, setEntrada] = useState("08:00");
  const [salida, setSalida] = useState("17:30");
  const ini = aMin(entrada);
  let fin = aMin(salida);
  if (fin <= ini) fin += 1440;
  const permanencia = fin - ini;
  const descanso = c.descontar_descanso && permanencia >= c.descanso_desde_horas * 60 ? c.descanso_minutos : 0;
  const trabajadas = Math.max(0, permanencia - descanso);
  const extra = Math.max(0, trabajadas - c.horas_extra_despues * 60);
  const ni = aMin(c.nocturna_inicio);
  const nf = aMin(c.nocturna_fin);
  const noct = Math.min(nocturnos(ini, fin, ni, nf), trabajadas);
  const extraNoct = extra ? Math.min(extra, nocturnos(fin - extra, fin, ni, nf)) : 0;
  const filas: [string, string, boolean?][] = [
    ["Permanencia", hm(permanencia)],
    ["− Descanso", descanso ? hm(descanso) : c.descontar_descanso ? "no aplica" : "no se descuenta"],
    ["= Horas trabajadas", hm(trabajadas), true],
    ["Extra diurna", hm(extra - extraNoct)],
    ["Extra nocturna", hm(extraNoct)],
    ["Recargo nocturno ordinario", hm(Math.max(0, noct - extraNoct))],
  ];
  return (
    <Card className="h-fit p-5 lg:sticky lg:top-20">
      <h2 className="flex items-center gap-2 font-semibold"><Calculator className="size-4" />Simulador</h2>
      <p className="mb-3 text-xs text-muted-foreground">Así se calcularía una jornada con las reglas en pantalla (empleado sin turno).</p>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Campo label="Entrada"><Input type="time" value={entrada} onChange={(e) => setEntrada(e.target.value)} /></Campo>
        <Campo label="Salida"><Input type="time" value={salida} onChange={(e) => setSalida(e.target.value)} /></Campo>
      </div>
      <dl className="space-y-1 text-sm">
        {filas.map(([k, v, destacado]) => (
          <div key={k} className={destacado ? "flex justify-between border-y py-1 font-semibold" : "flex justify-between"}>
            <dt className={destacado ? "" : "text-muted-foreground"}>{k}</dt>
            <dd className="tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Seccion({ titulo, nota, children }: { titulo: string; nota?: string; children: ReactNode }) {
  return (
    <Card className="space-y-3 p-5">
      <h2 className="font-semibold">{titulo}</h2>
      {children}
      {nota ? <p className="text-xs text-muted-foreground">{nota}</p> : null}
    </Card>
  );
}

function Campo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Interruptor({ titulo, nota, valor, disabled, onChange }: { titulo: string; nota: string; valor: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <Card className="flex items-center justify-between gap-4 p-5">
      <div>
        <h2 className="font-semibold">{titulo}</h2>
        <p className="text-sm text-muted-foreground">{nota}</p>
      </div>
      <Switch disabled={disabled} checked={valor} onCheckedChange={onChange} />
    </Card>
  );
}
