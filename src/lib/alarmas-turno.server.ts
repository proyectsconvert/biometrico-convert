/**
 * Vigilante de alarmas de turno: cada minuto revisa los turnos abiertos que pasaron el tiempo
 * configurado (o las horas extra autorizadas) y genera las alarmas y notificaciones a los roles de
 * la regla. Corre en el servidor, así funciona aunque nadie tenga abierto el tablero «Inicio turno».
 * La regla de cuándo repetir una alarma vive en la base (revisar_alarmas_turno), por lo que correrlo
 * en varios procesos a la vez no duplica avisos.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cliente: SupabaseClient | undefined;
function servicio(): SupabaseClient | null {
  if (cliente) return cliente;
  const url = process.env["REPROCESO_SUPABASE_URL"] || process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SERVICE_ROLE_KEY"];
  if (!url || !key) return null;
  cliente = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cliente;
}

let vigilando = false;
export function vigilarAlarmasTurno() {
  if (vigilando) return;
  vigilando = true;
  const revisar = async () => {
    const db = servicio();
    if (!db) return;
    try {
      const { data, error } = await db.rpc("revisar_alarmas_turno");
      if (error) console.warn("[alarmas-turno]", error.message);
      else if (Number(data) > 0) console.log(`[alarmas-turno] ${String(data)} alarma(s) generadas`);
    } catch (e) {
      console.warn("[alarmas-turno]", (e as Error).message);
    }
  };
  setTimeout(() => void revisar(), 30_000);
  setInterval(() => void revisar(), 60_000);

  // Cruce con el biométrico de los últimos 30 días (los archivos se cargan días después): concilia lo
  // pendiente y genera las diferencias reales
  const conciliar = async () => {
    const db = servicio();
    if (!db) return;
    const dia = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
    try {
      const { data, error } = await db.rpc("conciliar_turnos_biometrico", { _desde: dia(Date.now() - 30 * 864e5), _hasta: dia(Date.now()) });
      if (error) console.warn("[alarmas-turno] conciliación:", error.message);
      else if (Number(data) > 0) console.log(`[alarmas-turno] ${String(data)} alarma(s) del cruce con el biométrico`);
    } catch (e) {
      console.warn("[alarmas-turno] conciliación:", (e as Error).message);
    }
  };
  setTimeout(() => void conciliar(), 60_000);
  setInterval(() => void conciliar(), 10 * 60_000);
}
