import { createFileRoute, redirect } from "@tanstack/react-router";

// «Resultados biométricos» se unificó con el Control diario (entrada/salida + marcaciones del día).
export const Route = createFileRoute("/_authenticated/resultados")({
  beforeLoad: () => {
    throw redirect({ to: "/asistencia" });
  },
});
