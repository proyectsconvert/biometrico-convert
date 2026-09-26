import { createFileRoute, redirect } from "@tanstack/react-router";

// Las reglas de cálculo se editan con formulario en «Reglas de cálculo» (/jornada).
export const Route = createFileRoute("/_authenticated/reglas")({
  beforeLoad: () => {
    throw redirect({ to: "/jornada" });
  },
});
