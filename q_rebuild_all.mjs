import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env = Object.fromEntries(fs.readFileSync(".env","utf8").split(/\r?\n/).filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")]}));
const sb = createClient(env.SUPABASE_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "11111111-1111-1111-1111-111111111111";
const q = async (query) => (await (await fetch(env.SUPABASE_URL + "/pg/query", {method:"POST", headers:{apikey:env.SERVICE_ROLE_KEY, Authorization:`Bearer ${env.SERVICE_ROLE_KEY}`,"content-type":"application/json"}, body: JSON.stringify({query})})).json());
const dias = await q("select event_at::date::text d, count(*)::int n from biometric_raw group by 1 order by 1");
// tramos consecutivos de hasta ~200k filas crudas y máximo 10 días
const tramos = []; let cur = null;
for (const { d, n } of dias) {
  if (cur && cur.n + n <= 200000 && (new Date(d) - new Date(cur.desde)) / 864e5 < 10) { cur.hasta = d; cur.n += n; }
  else { if (cur) tramos.push(cur); cur = { desde: d, hasta: d, n }; }
}
if (cur) tramos.push(cur);
console.log(`${dias.length} días con datos → ${tramos.length} tramos`);
const t0 = Date.now(); let limpias = 0;
for (const [i, t] of tramos.entries()) {
  for (let intento = 1; intento <= 3; intento++) {
    const { data, error } = await sb.rpc("reconstruir_mes", { _tenant: T, _desde: t.desde, _hasta: t.hasta });
    if (!error) { limpias += data.eventos_limpios; console.log(`[${i + 1}/${tramos.length}] ${t.desde}..${t.hasta} crudas=${data.filas_crudas} limpias=${data.eventos_limpios} jornadas=${data.jornadas} (${Math.round((Date.now() - t0) / 1000)}s)`); break; }
    console.log(`[${i + 1}/${tramos.length}] ${t.desde}..${t.hasta} ERROR intento ${intento}: ${error.message.slice(0, 100)}`);
    if (intento === 3) { console.log("DETENIDO"); process.exit(1); }
  }
}
const { data: fin, error: ef } = await sb.rpc("finalizar_reconstruccion", { _tenant: T });
console.log("FINALIZADO", ef?.message ?? JSON.stringify(fin), `${Math.round((Date.now() - t0) / 1000)}s`);
