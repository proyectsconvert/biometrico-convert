import { useEffect, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useAccess } from "@/lib/session";
import { RUTAS_MODULO } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Impide abrir por enlace un módulo sin permiso «ver» (o exclusivo de super administrador).
 * La base de datos ya bloquea los datos con RLS; esto evita además mostrar la pantalla.
 */
export function GuardiaModulo({ children }: { children: ReactNode }) {
  const acceso = useAccess();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const ruta = RUTAS_MODULO.filter(
    (r) => pathname === r.to || pathname.startsWith(`${r.to}/`),
  ).sort((a, b) => b.to.length - a.to.length)[0];
  const permitido = (r: (typeof RUTAS_MODULO)[number]) =>
    (!r.superOnly || acceso.isSuperAdmin) && acceso.can(r.module, "ver");
  const denegado = !acceso.loading && ruta !== undefined && !permitido(ruta);
  const disponibles = RUTAS_MODULO.filter(
    (r) => r.to !== "/reglas" && r.to !== "/resultados" && permitido(r),
  );
  const destino = disponibles[0]?.to;

  // Al entrar (inicio en /panel) sin acceso al panel, se envía al primer módulo permitido
  useEffect(() => {
    if (denegado && pathname === "/panel" && destino) void navigate({ to: destino, replace: true });
  }, [denegado, pathname, destino, navigate]);

  if (acceso.loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!denegado) return <>{children}</>;
  return (
    <Card className="mx-auto mt-10 max-w-lg p-8 text-center">
      <ShieldAlert className="mx-auto mb-3 size-10 text-destructive" />
      <h1 className="font-display text-xl font-semibold">No tienes acceso a «{ruta?.label}»</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Tu rol no tiene permiso para ver este módulo. Si lo necesitas, pide a un administrador que
        lo habilite en Roles y permisos.
      </p>
      {disponibles.length ? (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {disponibles.slice(0, 6).map((r) => (
            <Button key={r.to} variant="outline" size="sm" asChild>
              <Link to={r.to}>{r.label}</Link>
            </Button>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Tu usuario no tiene módulos habilitados.
        </p>
      )}
    </Card>
  );
}
