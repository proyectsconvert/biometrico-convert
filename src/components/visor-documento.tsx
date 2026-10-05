import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, Image as ImageIcon, Loader2, Paperclip } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const BUCKET_EVIDENCIAS = "documentos-novedades";
/** Bucket de comentarios y evidencias por empleado (también los adjuntos de solicitudes). */
export const BUCKET_EVIDENCIAS_EMPLEADOS = "evidencias";
/** Archivo adjunto; sin `bucket` es de documentos de novedades. */
export type Archivo = { path: string; nombre: string; tipo: string; tamano: number; bucket?: string };
/** Tipos que acepta el selector de archivos (en el celular permite tomar la foto). */
export const ACEPTA_ARCHIVOS = "image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.heic";

const TIPOS_PERMITIDOS = /\.(pdf|png|jpe?g|webp|gif|heic|heif|docx?|xlsx?|txt|csv)$/i;
const MAXIMO = 10 * 1024 * 1024;

/** Sube las evidencias de una novedad al bucket privado: <empresa>/<novedad>/<archivo>. */
export async function subirEvidencias(archivos: File[], tenantId: string, totalId: string): Promise<Archivo[]> {
  return subirArchivos(archivos, BUCKET_EVIDENCIAS, `${tenantId}/${totalId}`);
}

/** Sube archivos a una carpeta de un bucket privado, validando tipo y tamaño. */
export async function subirArchivos(archivos: File[], bucket: string, carpeta: string): Promise<Archivo[]> {
  const subidos: Archivo[] = [];
  for (const f of archivos) {
    if (!TIPOS_PERMITIDOS.test(f.name)) throw new Error(`«${f.name}»: solo PDF, imágenes, Word, Excel o texto.`);
    if (f.size > MAXIMO) throw new Error(`«${f.name}» pesa más de 10 MB.`);
    const limpio = f.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "_");
    const path = `${carpeta}/${Date.now()}-${limpio}`;
    const { error } = await supabase.storage.from(bucket).upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
    if (error) throw new Error(`No se pudo subir «${f.name}»: ${error.message}`);
    subidos.push({ path, nombre: f.name, tipo: f.type, tamano: f.size, ...(bucket === BUCKET_EVIDENCIAS ? {} : { bucket }) });
  }
  return subidos;
}

const tamano = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const esImagen = (a: Archivo) => (a.tipo.startsWith("image/") && !/hei[cf]/i.test(a.tipo)) || /\.(png|jpe?g|webp|gif)$/i.test(a.nombre);
const esPdf = (a: Archivo) => a.tipo === "application/pdf" || /\.pdf$/i.test(a.nombre);

/** Chip de un archivo adjunto que abre el visor. */
export function ChipArchivo({ archivo, onAbrir }: { archivo: Archivo; onAbrir: (a: Archivo) => void }) {
  const Icono = esImagen(archivo) ? ImageIcon : esPdf(archivo) ? FileText : Paperclip;
  return (
    <button type="button" onClick={() => onAbrir(archivo)} className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs hover:border-primary hover:text-primary">
      <Icono className="size-3.5 shrink-0" />
      <span className="truncate">{archivo.nombre}</span>
      <span className="shrink-0 text-muted-foreground">{tamano(archivo.tamano)}</span>
    </button>
  );
}

/** Abre un documento del bucket dentro de la plataforma: PDF e imágenes se ven aquí; lo demás se descarga. */
export function VisorDocumento({ archivo, onClose }: { archivo: Archivo | null; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!archivo) return;
    let vigente = true;
    void supabase.storage.from(archivo.bucket ?? BUCKET_EVIDENCIAS).createSignedUrl(archivo.path, 3600).then(({ data, error: e }) => {
      if (!vigente) return;
      if (e || !data) setError(e?.message ?? "No se pudo abrir el documento.");
      else setUrl(data.signedUrl);
    });
    return () => { vigente = false; };
  }, [archivo]);

  return (
    <Dialog open={Boolean(archivo)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex h-[90vh] max-w-5xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{archivo?.nombre}</DialogTitle>
          <DialogDescription>Evidencia adjunta · {archivo ? tamano(archivo.tamano) : ""}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/30">
          {error ? (
            <p className="p-6 text-sm text-destructive">{error}</p>
          ) : !url || !archivo ? (
            <p className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />Abriendo…</p>
          ) : esPdf(archivo) ? (
            <iframe src={url} title={archivo.nombre} className="size-full" />
          ) : esImagen(archivo) ? (
            <div className="flex size-full items-center justify-center overflow-auto p-4">
              <img src={url} alt={archivo.nombre} className="max-h-full max-w-full object-contain" />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <Paperclip className="size-8" />
              Este tipo de archivo no se puede previsualizar; descárgalo para abrirlo.
            </div>
          )}
        </div>
        {url ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" asChild><a href={url} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> Abrir en otra pestaña</a></Button>
            <Button size="sm" asChild><a href={url} download={archivo?.nombre}><Download className="size-4" /> Descargar</a></Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
