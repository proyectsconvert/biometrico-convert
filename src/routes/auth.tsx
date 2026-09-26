import logoAsset from "@/assets/convertia-logo.png.asset.json";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Fingerprint, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Ingresar — Convert-IA Control Biométrico" },
      { name: "description", content: "Accede a Convert-IA, la plataforma de control de asistencia y nómina." },
      { property: "og:title", content: "Ingresar — Convert-IA Control Biométrico" },
      { property: "og:description", content: "Accede a Convert-IA, la plataforma de control de asistencia." },
    ],
  }),
  component: Auth,
});

function Auth() {
  const navigate = useNavigate();
  const [cargando, setCargando] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/panel", replace: true });
    });
  }, [navigate]);

  async function ingresar(e: React.FormEvent) {
    e.preventDefault();
    setCargando(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setCargando(false);
    if (error) {
      toast.error("No se pudo ingresar", { description: error.message });
      return;
    }
    navigate({ to: "/panel", replace: true });
  }


  return (
    <div className="relative min-h-screen overflow-hidden bg-secondary">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-60" />
      <div className="pointer-events-none absolute -right-40 -top-40 size-[36rem] rounded-full bg-primary/20 blur-[140px]" />
      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl content-center grid-cols-1 gap-4 p-4 md:grid-cols-12 md:gap-6 md:p-8">
        <div className="md:col-span-12">
          <Button asChild variant="ghost" size="sm">
            <Link to="/"><ArrowLeft className="size-4" /> Volver al inicio</Link>
          </Button>
        </div>

        <aside className="relative hidden overflow-hidden rounded-[2rem] bg-sidebar p-10 text-sidebar-foreground shadow-2xl md:col-span-6 md:flex md:flex-col md:justify-between">
          <div className="flex items-center gap-3">
            <img src={logoAsset.url} alt="Convert-IA" className="size-10 rounded-lg" />
            <div>
              <p className="font-display text-lg font-bold">Convert-IA</p>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">Control Biométrico</p>
            </div>
          </div>
          <div className="relative mx-auto my-10 flex size-40 items-center justify-center overflow-hidden rounded-3xl border border-sidebar-border bg-sidebar-accent">
            <Fingerprint className="size-20 text-primary" strokeWidth={1.2} />
            <span className="animate-scan absolute inset-x-4 top-2 h-0.5 rounded-full bg-primary shadow-[0_0_12px_var(--primary)]" />
          </div>
          <div>
            <h2 className="mb-2 font-display text-2xl font-bold">Asistencia confiable, sin hojas de cálculo.</h2>
            <p className="text-sm opacity-70">Marcaciones, novedades y nómina en un solo lugar, con acceso según tu rol.</p>
          </div>
        </aside>

        <div className="flex flex-col justify-center rounded-[2rem] border bg-card p-6 shadow-xl sm:p-10 md:col-span-6">
          <div className="mb-8 flex items-center gap-3 md:hidden">
            <img src={logoAsset.url} alt="Convert-IA" className="size-9 rounded-md" />
            <div>
              <p className="font-display font-bold">Convert-IA</p>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Control Biométrico</p>
            </div>
          </div>
          <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border bg-secondary px-3 py-1 text-[10px] font-extrabold tracking-widest text-muted-foreground">
            <span className="size-2 rounded-full bg-primary" /> ACCESO SEGURO
          </div>
          <h1 className="mb-1 font-display text-2xl font-bold">Ingresar</h1>
          <p className="mb-6 text-sm text-muted-foreground">Usa las credenciales que te entregó el administrador.</p>
          <form onSubmit={ingresar} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Correo</Label>
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-11" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Contraseña</Label>
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-11" />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={cargando}>
              {cargando ? "Ingresando…" : "Ingresar"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
