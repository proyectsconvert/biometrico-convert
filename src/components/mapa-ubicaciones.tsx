import { useEffect, useRef } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";

export type PuntoMapa = { nombre: string; lat: number; lon: number; radio_m: number };

/** Centro por defecto (Bogotá) cuando aún no hay sedes. */
const CENTRO: [number, number] = [4.6486, -74.0628];

/**
 * Mapa (OpenStreetMap + Leaflet) con las sedes autorizadas y su radio. Un clic en el mapa mueve la
 * sede seleccionada (o crea la primera). Leaflet se carga solo en el navegador (no en el servidor).
 */
export function MapaUbicaciones({
  puntos,
  seleccion,
  onClicMapa,
  alto = 280,
}: {
  puntos: PuntoMapa[];
  seleccion: number;
  onClicMapa: (lat: number, lon: number) => void;
  alto?: number;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<Leaflet.Map | null>(null);
  const capa = useRef<Leaflet.LayerGroup | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const alClic = useRef(onClicMapa);
  alClic.current = onClicMapa;
  const cantidad = useRef(-1);

  const dibujar = () => {
    const l = L.current;
    const m = mapa.current;
    const g = capa.current;
    if (!l || !m || !g) return;
    g.clearLayers();
    puntos.forEach((p, i) => {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
      const activo = i === seleccion;
      const color = activo ? "#16a34a" : "#64748b";
      l.circle([p.lat, p.lon], { radius: Math.max(5, p.radio_m || 0), color, weight: 2, fillColor: color, fillOpacity: activo ? 0.18 : 0.08 }).addTo(g);
      l.circleMarker([p.lat, p.lon], { radius: 5, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(`${p.nombre} · ${p.radio_m} m`, { permanent: activo, direction: "top", offset: [0, -6] })
        .addTo(g);
    });
    // Encuadre: al cambiar la cantidad de sedes o al abrir
    if (cantidad.current !== puntos.length) {
      cantidad.current = puntos.length;
      const validos = puntos.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (validos.length === 1) m.setView([validos[0]!.lat, validos[0]!.lon], 18);
      else if (validos.length > 1) m.fitBounds(l.latLngBounds(validos.map((p) => [p.lat, p.lon] as [number, number])).pad(0.3));
    }
  };

  useEffect(() => {
    let vivo = true;
    void import("leaflet").then((mod) => {
      if (!vivo || !contenedor.current || mapa.current) return;
      const l = ((mod as unknown as { default?: typeof Leaflet }).default ?? mod) as typeof Leaflet;
      L.current = l;
      const m = l.map(contenedor.current, { zoomControl: true }).setView(CENTRO, 16);
      l.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      }).addTo(m);
      capa.current = l.layerGroup().addTo(m);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => alClic.current(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))));
      mapa.current = m;
      dibujar();
      // Dentro de un diálogo el tamaño final llega después de la animación
      setTimeout(() => m.invalidateSize(), 300);
    });
    return () => {
      vivo = false;
      mapa.current?.remove();
      mapa.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => dibujar(), [puntos, seleccion]);

  /** Centra el mapa en un punto (p. ej. tras «Usar mi ubicación»). */
  useEffect(() => {
    const p = puntos[seleccion];
    if (p && mapa.current && Number.isFinite(p.lat)) mapa.current.panTo([p.lat, p.lon]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seleccion]);

  return <div ref={contenedor} style={{ height: alto }} className="z-0 w-full overflow-hidden rounded-md border" />;
}
