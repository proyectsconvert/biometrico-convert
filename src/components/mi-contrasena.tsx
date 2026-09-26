import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Cualquier usuario puede cambiar su propia contraseña. */
export function MiContrasena() {
  const [abierto, setAbierto] = useState(false);
  const [clave, setClave] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [guardando, setGuardando] = useState(false);
  const valida = clave.length >= 8 && clave === confirmar;

  async function guardar() {
    setGuardando(true);
    const { error } = await supabase.auth.updateUser({ password: clave });
    setGuardando(false);
    if (error) {
      toast.error("No se pudo cambiar la contraseña", { description: error.message });
      return;
    }
    toast.success("Tu contraseña fue actualizada");
    setClave("");
    setConfirmar("");
    setAbierto(false);
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAbierto(true)} title="Cambiar mi contraseña">
        <KeyRound className="size-4" /> <span className="hidden sm:inline">Mi contraseña</span>
      </Button>
      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Cambiar mi contraseña</DialogTitle>
            <DialogDescription>Mínimo 8 caracteres. Se aplica de inmediato.</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valida) void guardar(); }}>
            <div className="space-y-1.5"><Label htmlFor="mc-1">Nueva contraseña</Label><Input id="mc-1" type="password" autoComplete="new-password" value={clave} onChange={(e) => setClave(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="mc-2">Confirmar</Label>
              <Input id="mc-2" type="password" autoComplete="new-password" value={confirmar} onChange={(e) => setConfirmar(e.target.value)} />
              {confirmar && clave !== confirmar ? <p className="text-xs text-destructive">Las contraseñas no coinciden.</p> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAbierto(false)}>Cancelar</Button>
              <Button type="submit" disabled={!valida || guardando}>{guardando ? <Loader2 className="size-4 animate-spin" /> : null} Guardar</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
