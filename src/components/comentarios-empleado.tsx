import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Camera, Loader2, MessageSquareText, Paperclip, Send, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { dbAny } from "@/lib/db";
import { useAccess } from "@/lib/session";
import { haceCuanto } from "@/components/notificaciones";
import {
  ACEPTA_ARCHIVOS,
  BUCKET_EVIDENCIAS_EMPLEADOS,
  ChipArchivo,
  VisorDocumento,
  subirArchivos,
  type Archivo,
} from "@/components/visor-documento";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Comentario = {
  id: string;
  fecha: string | null;
  contexto: string;
  comentario: string;
  archivos: Archivo[];
  created_at: string;
  profiles: { full_name: string | null } | null;
};
export type Contexto = "general" | "malla" | "novedad" | "asistencia" | "solicitud";

const CONTEXTOS: Record<string, string> = {
  general: "General",
  malla: "Turnos",
  novedad: "Novedades",
  asistencia: "Asistencia",
  solicitud: "Solicitud",
};
const corta = (f: string) =>
  new Date(`${f}T12:00:00`).toLocaleDateString("es-CO", { day: "2-digit", month: "short" });

/** Carpeta de evidencias de una persona en el bucket privado: <empresa>/empleado/<id>. */
export const carpetaEmpleado = (tenantId: string, empleadoId: string) =>
  `${tenantId}/empleado/${empleadoId}`;

/** Selector de archivos reutilizable (documentos, fotos; en el celular abre la cámara). */
export function AdjuntarArchivos({
  archivos,
  onChange,
}: {
  archivos: File[];
  onChange: (a: File[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:border-primary hover:text-primary">
          <Paperclip className="size-3.5" /> Adjuntar documentos o fotos
          <input
            type="file"
            multiple
            accept={ACEPTA_ARCHIVOS}
            className="hidden"
            onChange={(e) => {
              // leer los archivos antes de limpiar el campo (si no, la lista queda vacía)
              const nuevos = Array.from(e.target.files ?? []);
              onChange([...archivos, ...nuevos].slice(0, 10));
              e.target.value = "";
            }}
          />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:border-primary hover:text-primary sm:hidden">
          <Camera className="size-3.5" /> Tomar foto
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const nuevos = Array.from(e.target.files ?? []);
              onChange([...archivos, ...nuevos].slice(0, 10));
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {archivos.length ? (
        <div className="flex flex-wrap gap-1.5">
          {archivos.map((f, i) => (
            <Badge key={i} variant="secondary" className="gap-1 font-normal">
              {f.name}
              <button
                type="button"
                aria-label={`Quitar ${f.name}`}
                onClick={() => onChange(archivos.filter((_, j) => j !== i))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          PDF, imágenes, Word, Excel o texto · hasta 10 MB cada uno · máximo 10.
        </p>
      )}
    </div>
  );
}

/**
 * Hilo de comentarios y evidencias de una persona (opcionalmente de un día). Lo escrito queda
 * con autor y fecha y no se puede editar ni borrar: es la trazabilidad del caso.
 */
export function HiloComentarios({
  empleadoId,
  fecha,
  contexto = "general",
  compacto,
  soloDelDia,
}: {
  empleadoId: string;
  fecha?: string | null;
  contexto?: Contexto;
  compacto?: boolean;
  soloDelDia?: boolean;
}) {
  const acceso = useAccess();
  const qc = useQueryClient();
  const [texto, setTexto] = useState("");
  const [archivos, setArchivos] = useState<File[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [visor, setVisor] = useState<Archivo | null>(null);

  const lista = useQuery({
    queryKey: ["comentarios-empleado", empleadoId, soloDelDia ? fecha : "todo"],
    queryFn: async () => {
      let q = dbAny
        .from("employee_comments")
        .select(
          "id, fecha, contexto, comentario, archivos, created_at, profiles:user_id(full_name)",
        )
        .eq("employee_id", empleadoId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (soloDelDia && fecha) q = q.eq("fecha", fecha);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Comentario[];
    },
  });

  async function enviar() {
    if (!texto.trim() && !archivos.length) {
      toast.error("Escribe un comentario o adjunta un archivo");
      return;
    }
    if (!acceso.tenantId) return;
    setEnviando(true);
    try {
      const subidos = archivos.length
        ? await subirArchivos(
            archivos,
            BUCKET_EVIDENCIAS_EMPLEADOS,
            carpetaEmpleado(acceso.tenantId, empleadoId),
          )
        : [];
      const { error } = await supabase.rpc(
        "comentar_empleado" as never,
        {
          _employee_id: empleadoId,
          _comentario: texto.trim(),
          _archivos: subidos,
          _fecha: fecha ?? null,
          _contexto: contexto,
        } as never,
      );
      if (error) throw new Error(error.message);
      toast.success(
        subidos.length
          ? `Comentario guardado con ${subidos.length} ${subidos.length === 1 ? "adjunto" : "adjuntos"}`
          : "Comentario guardado",
      );
      setTexto("");
      setArchivos([]);
      void qc.invalidateQueries({ queryKey: ["comentarios-empleado", empleadoId] });
    } catch (e) {
      toast.error("No se pudo guardar el comentario", { description: (e as Error).message });
    } finally {
      setEnviando(false);
    }
  }

  const filas = lista.data ?? [];
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-lg border p-3">
        <Textarea
          rows={compacto ? 2 : 3}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder={
            fecha
              ? `Comentario sobre el ${corta(fecha)} (ej.: adjunto incapacidad)…`
              : "Comentario, observación o soporte…"
          }
        />
        <AdjuntarArchivos archivos={archivos} onChange={setArchivos} />
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void enviar()} disabled={enviando}>
            {enviando ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}{" "}
            Guardar comentario
          </Button>
        </div>
      </div>
      {lista.isLoading ? (
        <p className="text-xs text-muted-foreground">
          <Loader2 className="mr-1 inline size-3 animate-spin" />
          Cargando…
        </p>
      ) : !filas.length ? (
        <p className="text-xs text-muted-foreground">
          Sin comentarios {soloDelDia && fecha ? "de este día" : "todavía"}.
        </p>
      ) : (
        <ol className={compacto ? "max-h-56 space-y-2 overflow-y-auto pr-1" : "space-y-2"}>
          {filas.map((c) => (
            <li key={c.id} className="rounded-md border bg-muted/20 p-2.5 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{c.profiles?.full_name ?? "—"}</span>
                <span>· {haceCuanto(c.created_at)}</span>
                {c.fecha ? (
                  <Badge variant="outline" className="h-4 px-1 text-[10px]">
                    día {corta(c.fecha)}
                  </Badge>
                ) : null}
                {c.contexto !== "general" ? (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    {CONTEXTOS[c.contexto] ?? c.contexto}
                  </Badge>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap">{c.comentario}</p>
              {c.archivos?.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {c.archivos.map((a) => (
                    <ChipArchivo
                      key={a.path}
                      archivo={{ ...a, bucket: a.bucket ?? BUCKET_EVIDENCIAS_EMPLEADOS }}
                      onAbrir={setVisor}
                    />
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <VisorDocumento archivo={visor} onClose={() => setVisor(null)} />
    </div>
  );
}

/** Diálogo con todos los comentarios y evidencias de una persona. */
export function ComentariosEmpleadoDialog({
  empleado,
  onClose,
}: {
  empleado: { id: string; full_name: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(empleado)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="size-5" /> {empleado?.full_name}
          </DialogTitle>
          <DialogDescription>
            Comentarios y evidencias (documentos, fotos) con autor y fecha. No se pueden editar ni
            borrar.
          </DialogDescription>
        </DialogHeader>
        {empleado ? <HiloComentarios empleadoId={empleado.id} /> : null}
      </DialogContent>
    </Dialog>
  );
}
