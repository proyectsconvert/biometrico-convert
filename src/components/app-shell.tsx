import logoAsset from "@/assets/convertia-logo.png.asset.json";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutDashboard,
  Users,
  Building2,
  Briefcase,
  CalendarCheck,
  Fingerprint,
  Upload,
  Clock,
  Cpu,
  CalendarDays,
  ShieldCheck,
  SlidersHorizontal,
  ScrollText,
  LogOut,
  UserCog,
  Landmark,
  ClipboardList,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  Factory,
  FileBarChart,
  DatabaseZap,
} from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useAccess, useSignOut } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { MiContrasena } from "@/components/mi-contrasena";
import { CampanaNotificaciones } from "@/components/notificaciones";
import { cn } from "@/lib/utils";

type Item = {
  to: string;
  label: string;
  icon: typeof Users;
  module: string;
  superOnly?: boolean;
};

const GRUPOS: { titulo: string; items: Item[] }[] = [
  {
    titulo: "Inicio",
    items: [
      { to: "/panel", label: "Panel", icon: LayoutDashboard, module: "dashboard" },
      { to: "/reportes", label: "Reportes", icon: FileBarChart, module: "reportes" },
    ],
  },
  {
    titulo: "Personal",
    items: [
      { to: "/empleados", label: "Empleados", icon: Users, module: "empleados" },
      { to: "/empleadores", label: "Empleadores", icon: Factory, module: "empleadores" },
      { to: "/campanas", label: "Campañas", icon: Briefcase, module: "campanas" },
      { to: "/centros-costo", label: "Centros de costo", icon: Landmark, module: "centros_costo" },
    ],
  },
  {
    titulo: "Asistencia",
    items: [
      { to: "/importaciones", label: "Importaciones", icon: Upload, module: "importaciones" },
      { to: "/asistencia", label: "Control diario", icon: CalendarCheck, module: "asistencia" },
      { to: "/marcaciones", label: "Marcaciones", icon: Fingerprint, module: "marcaciones" },
      { to: "/turnos", label: "Turnos", icon: Clock, module: "turnos" },
    ],
  },
  {
    titulo: "Novedades",
    items: [{ to: "/novedades", label: "Novedades", icon: ClipboardList, module: "novedades" }],
  },
  {
    titulo: "Administración",
    items: [
      { to: "/usuarios", label: "Usuarios", icon: UserCog, module: "usuarios" },
      { to: "/roles", label: "Roles y permisos", icon: ShieldCheck, module: "roles" },
      { to: "/dispositivos", label: "Dispositivos", icon: Cpu, module: "dispositivos" },
      { to: "/jornada", label: "Reglas de cálculo", icon: SlidersHorizontal, module: "reglas" },
      { to: "/festivos", label: "Festivos", icon: CalendarDays, module: "festivos" },
      { to: "/datos", label: "Calidad de datos", icon: DatabaseZap, module: "datos" },
      { to: "/auditoria", label: "Auditoría", icon: ScrollText, module: "auditoria" },
      { to: "/empresas", label: "Empresas (tenants)", icon: Building2, module: "empresas", superOnly: true },
    ],
  },
];

/** Ruta → módulo que exige (permiso «ver»). Lo usa el guardián de rutas del layout. */
export const RUTAS_MODULO: { to: string; label: string; module: string; superOnly?: boolean }[] = [
  ...GRUPOS.flatMap((g) => g.items.map(({ to, label, module, superOnly }) => ({ to, label, module, ...(superOnly ? { superOnly } : {}) }))),
  { to: "/reglas", label: "Reglas de cálculo", module: "reglas" },
  { to: "/resultados", label: "Control diario", module: "asistencia" },
];

function Navegacion({ compacto, onNavegar }: { compacto: boolean; onNavegar?: () => void }) {
  const acceso = useAccess();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [cerrados, setCerrados] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const v = localStorage.getItem("convertia.sidebar.grupos");
      if (v) setCerrados(JSON.parse(v) as Record<string, boolean>);
    } catch {
      /* sin preferencias guardadas */
    }
  }, []);

  const alternar = (t: string) =>
    setCerrados((prev) => {
      const n = { ...prev, [t]: !prev[t] };
      localStorage.setItem("convertia.sidebar.grupos", JSON.stringify(n));
      return n;
    });

  return (
    <nav className={cn("flex-1 overflow-y-auto pb-6", compacto ? "space-y-2 px-2" : "space-y-3 px-3")}>
      {GRUPOS.map((grupo) => {
        const items = grupo.items.filter(
          (i) => (!i.superOnly || acceso.isSuperAdmin) && acceso.can(i.module, "ver"),
        );
        if (items.length === 0) return null;
        const tieneActivo = items.some((i) => pathname.startsWith(i.to));
        const abierto = compacto || !cerrados[grupo.titulo] || tieneActivo;
        return (
          <div key={grupo.titulo}>
            {compacto ? (
              <div className="mx-2 my-1 border-t border-sidebar-border" />
            ) : (
              <button
                type="button"
                onClick={() => alternar(grupo.titulo)}
                className="flex w-full items-center justify-between rounded px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/45 hover:text-sidebar-foreground/80"
              >
                {grupo.titulo}
                <ChevronDown className={cn("size-3.5 transition-transform", !abierto && "-rotate-90")} />
              </button>
            )}
            {abierto ? (
              <ul className="mt-0.5 space-y-0.5">
                {items.map((item) => {
                  const activo = pathname.startsWith(item.to);
                  const enlace = (
                    <Link
                      to={item.to}
                      onClick={onNavegar}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md py-2 text-sm transition-colors",
                        compacto ? "justify-center px-2" : "px-3",
                        activo
                          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                      )}
                    >
                      <item.icon className="size-4 shrink-0" />
                      {compacto ? <span className="sr-only">{item.label}</span> : item.label}
                    </Link>
                  );
                  return (
                    <li key={item.to}>
                      {compacto ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{enlace}</TooltipTrigger>
                          <TooltipContent side="right">{item.label}</TooltipContent>
                        </Tooltip>
                      ) : (
                        enlace
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

function Marca({ compacto }: { compacto: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 py-5", compacto ? "justify-center px-2" : "px-5")}>
      <img src={logoAsset.url} alt="Convert-IA" className="size-9 shrink-0 rounded-md" />
      {compacto ? null : (
        <div className="leading-tight">
          <p className="font-display text-sm font-semibold">Convert-IA</p>
          <p className="text-[11px] text-sidebar-foreground/60">Control Biométrico</p>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const acceso = useAccess();
  const cerrarSesion = useSignOut();
  const [compacto, setCompacto] = useState(false);
  const [movil, setMovil] = useState(false);

  useEffect(() => {
    setCompacto(localStorage.getItem("convertia.sidebar.compacto") === "1");
  }, []);
  const alternarCompacto = () =>
    setCompacto((v) => {
      localStorage.setItem("convertia.sidebar.compacto", v ? "0" : "1");
      return !v;
    });

  return (
    <TooltipProvider delayDuration={100}>
      <div className="flex min-h-screen bg-background">
        <aside
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex",
            compacto ? "w-16" : "w-64",
          )}
        >
          <Marca compacto={compacto} />
          <Navegacion compacto={compacto} />
          <button
            type="button"
            onClick={alternarCompacto}
            className="flex items-center gap-2 border-t border-sidebar-border px-5 py-3 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground"
            title={compacto ? "Expandir menú" : "Contraer menú"}
          >
            {compacto ? <PanelLeftOpen className="mx-auto size-4" /> : <><PanelLeftClose className="size-4" /> Contraer menú</>}
          </button>
        </aside>

        <Sheet open={movil} onOpenChange={setMovil}>
          <SheetContent side="left" className="flex w-72 flex-col border-sidebar-border bg-sidebar p-0 text-sidebar-foreground">
            <SheetTitle className="sr-only">Menú</SheetTitle>
            <Marca compacto={false} />
            <Navegacion compacto={false} onNavegar={() => setMovil(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b bg-card/80 px-5 backdrop-blur">
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMovil(true)} aria-label="Abrir menú">
                <Menu className="size-5" />
              </Button>
              <Button variant="ghost" size="icon" className="hidden md:inline-flex" onClick={alternarCompacto} aria-label="Contraer o expandir menú">
                {compacto ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
              </Button>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{acceso.tenantName ?? "Plataforma"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {acceso.fullName} · {acceso.roleCodes.join(", ") || "sin rol"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <CampanaNotificaciones />
              <MiContrasena />
              <Button variant="ghost" size="sm" onClick={cerrarSesion}>
                <LogOut className="size-4" /> Salir
              </Button>
            </div>
          </header>
          <main className="min-w-0 flex-1 p-5 md:p-7">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export function PageHeader({
  titulo,
  descripcion,
  acciones,
}: {
  titulo: string;
  descripcion?: string | undefined;
  acciones?: ReactNode | undefined;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-semibold">{titulo}</h1>
        {descripcion ? <p className="text-sm text-muted-foreground">{descripcion}</p> : null}
      </div>
      {acciones ? <div className="flex flex-wrap gap-2">{acciones}</div> : null}
    </div>
  );
}
