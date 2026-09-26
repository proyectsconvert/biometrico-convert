import logoAsset from "@/assets/convertia-logo.png.asset.json";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Fingerprint,
  Zap,
  FileSpreadsheet,
  ShieldCheck,
  Upload,
  ArrowRight,
  Moon,
  CalendarDays,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Convert-IA — Control Biométrico, Asistencia y Nómina" },
      {
        name: "description",
        content:
          "Convert-IA centraliza marcaciones biométricas, control de asistencia, novedades y conciliación de nómina en una sola plataforma.",
      },
      { property: "og:title", content: "Convert-IA — Control Biométrico, Asistencia y Nómina" },
      {
        property: "og:description",
        content:
          "Convert-IA centraliza marcaciones biométricas, control de asistencia, novedades y conciliación de nómina.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Inicio,
});

const MARCAS = [
  { hora: "07:58", tipo: "Entrada", ok: true },
  { hora: "12:02", tipo: "Interno", ok: false },
  { hora: "17:04", tipo: "Salida", ok: true },
];

function Inicio() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-secondary">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-60" />
      <div className="pointer-events-none absolute -right-40 -top-40 size-[36rem] rounded-full bg-primary/20 blur-[140px]" />

      <div className="relative mx-auto grid w-full max-w-[1800px] grid-cols-1 gap-4 p-4 md:grid-cols-12 md:gap-6 md:p-6 lg:p-10 xl:px-16 xl:py-12">
        {/* Encabezado */}
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-2xl border bg-card p-4 shadow-sm md:col-span-12 md:p-5">
          <div className="flex min-w-0 items-center gap-4">
            <img src={logoAsset.url} alt="Convert-IA" className="size-10 shrink-0 rounded-lg" />
            <div className="min-w-0">
              <p className="truncate font-display text-lg font-bold tracking-tight">Convert-IA</p>
              <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                Control Biométrico
              </p>
            </div>
            <div className="mx-2 hidden h-8 w-px bg-border md:block" />
            <div className="hidden md:block">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Gestión biométrica y nómina</p>
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                Plataforma operativa
              </p>
            </div>
          </div>
          <Button asChild>
            <Link to="/auth">Ingresar</Link>
          </Button>
        </header>

        {/* Héroe */}
        <section className="relative overflow-hidden rounded-[2rem] border bg-card p-6 shadow-xl sm:p-10 md:col-span-8 md:row-span-2 lg:p-14">
          <div className="absolute -right-20 -top-20 size-80 rounded-full bg-primary/10" />
          <div className="relative">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border bg-secondary px-4 py-1.5 text-[10px] font-extrabold tracking-widest text-muted-foreground">
              <span className="size-2 rounded-full bg-primary" />
              SISTEMA CENTRALIZADO DE ASISTENCIA
            </div>
            <h1 className="mb-6 font-display text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl lg:text-5xl">
              Control de asistencia, biometría y <span className="text-primary">conciliación de nómina</span>
            </h1>
            <p className="mb-8 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Reemplaza el proceso manual en hojas de cálculo: importa el reporte del biométrico, valida la asistencia
              por campaña y entrega a nómina una base confiable.
            </p>
            <Button asChild size="lg" className="group">
              <Link to="/auth">
                Entrar a la plataforma <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </Link>
            </Button>

            <div className="mt-10 grid grid-cols-2 gap-6 border-t pt-8 sm:grid-cols-3">
              {[
                ["CSV masivo", "Carga por lotes"],
                ["Por campaña", "Acceso por rol"],
                ["Auditado", "Cada cambio registrado"],
              ].map(([v, l]) => (
                <div key={v}>
                  <p className="font-display text-xl font-bold sm:text-2xl">{v}</p>
                  <p className="text-xs font-semibold uppercase tracking-tight text-muted-foreground">{l}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Marcaciones */}
        <div className="flex flex-col justify-between rounded-3xl border bg-card p-6 shadow-md transition-shadow hover:shadow-lg md:col-span-4 md:p-8">
          <div>
            <div className="relative mb-5 flex size-12 items-center justify-center overflow-hidden rounded-xl bg-primary/10">
              <Fingerprint className="size-6 text-primary" />
              <span className="animate-scan absolute inset-x-1 top-0 h-px bg-primary" />
            </div>
            <h3 className="mb-2 font-display text-xl font-bold">Marcaciones biométricas</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Procesa miles de registros del biométrico, limpia repetidos y separa entradas y salidas.
            </p>
          </div>
          <ul className="mt-6 space-y-2">
            {MARCAS.map((m) => (
              <li key={m.hora} className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-xs">
                <span className="font-mono font-semibold">{m.hora}</span>
                <span className={m.ok ? "font-bold text-primary" : "text-muted-foreground"}>{m.tipo}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Oscuro */}
        <div className="relative overflow-hidden rounded-3xl bg-sidebar p-6 text-sidebar-foreground shadow-2xl md:col-span-4 md:p-8">
          <div className="relative">
            <div className="mb-5 flex size-12 items-center justify-center rounded-xl bg-sidebar-accent">
              <Zap className="size-6 text-primary" />
            </div>
            <h3 className="mb-2 font-display text-xl font-bold">Horas y recargos</h3>
            <p className="mb-5 text-sm leading-relaxed opacity-70">
              Calculados según tu jornada: extras, nocturnas y dominicales o festivas.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {[
                [Timer, "Extra"],
                [Moon, "Nocturna"],
                [CalendarDays, "Festivo"],
              ].map(([Icon, l]) => {
                const I = Icon as typeof Timer;
                return (
                  <div key={l as string} className="rounded-lg border border-sidebar-border px-2 py-2 text-center">
                    <I className="mx-auto mb-1 size-4 text-primary" />
                    <span className="text-[11px] font-semibold">{l as string}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Mosaicos inferiores */}
        <div className="flex items-center gap-5 rounded-[2rem] border bg-card p-6 shadow-sm md:col-span-4 md:p-8">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
            <FileSpreadsheet className="size-7" />
          </div>
          <div className="min-w-0">
            <h4 className="mb-1 font-display text-lg font-bold">Listo para nómina</h4>
            <p className="text-xs leading-relaxed text-muted-foreground">Consolidados por campaña y periodo, exportables para conciliar.</p>
          </div>
        </div>
        <div className="flex items-center gap-5 rounded-[2rem] border bg-card p-6 shadow-sm md:col-span-4 md:p-8">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
            <Upload className="size-7" />
          </div>
          <div className="min-w-0">
            <h4 className="mb-1 font-display text-lg font-bold">Novedades y plantillas</h4>
            <p className="text-xs leading-relaxed text-muted-foreground">Sube tus plantillas de novedades y apruébalas en un solo lugar.</p>
          </div>
        </div>
        <div className="relative flex items-center gap-5 overflow-hidden rounded-[2rem] bg-primary p-6 text-primary-foreground shadow-xl md:col-span-4 md:p-8">
          <div className="absolute -bottom-4 -right-4 size-32 rounded-full bg-background/20 blur-xl" />
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-background/25">
            <ShieldCheck className="size-7" />
          </div>
          <div className="relative min-w-0">
            <h4 className="mb-1 font-display text-lg font-bold">Accesos por rol</h4>
            <p className="text-xs leading-relaxed opacity-90">Cada persona ve solo su campaña o su empresa, con auditoría permanente.</p>
          </div>
        </div>

        <footer className="px-2 pt-2 text-center text-xs text-muted-foreground md:col-span-12">
          © {new Date().getFullYear()} Convert-IA · Intelligent Customer Acquisition
        </footer>
      </div>
    </div>
  );
}
