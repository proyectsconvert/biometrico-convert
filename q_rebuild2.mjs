import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env = Object.fromEntries(fs.readFileSync(".env","utf8").split(/\r?\n/).filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")]}));
const sb = createClient(env.SUPABASE_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "11111111-1111-1111-1111-111111111111";
const DESDE_TS = process.argv[2] ?? "0000-00-00"; const DESDE = DESDE_TS.slice(0, 10);
const LIMITE = Number(process.argv[3] ?? 200000); // filas crudas máximas por tramo de días
const { data: dias } = await sb.rpc("filas_crudas_por_dia", { _tenant: T });
const sig = (d) => new Date(Date.parse(d + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
// tramos: días juntos hasta 200k filas (máx. 10 días); los días pesados se parten por horas
const tramos = []; let cur = null;
const cerrar = () => { if (cur) tramos.push({ ini: `${cur.desde}T00:00:00`, fin: `${sig(cur.hasta)}T00:00:00`, recalcular: true, etiqueta: `${cur.desde}..${cur.hasta}` }); cur = null; };
for (const { dia, filas } of dias.filter((x) => x.dia >= DESDE)) {
  if (filas > 200000) {
    cerrar();
    const { data: horas } = await sb.rpc("filas_crudas_por_hora", { _tenant: T, _dia: dia });
    let ini = `${dia}T00:00:00`, n = 0; const partes = [];
    for (const h of horas) {
      const hi = h.hora.replace(" ", "T").slice(0, 19);
      if (h.filas > 100000) {
        // hora de sincronización masiva: se parte en pedazos de 10 minutos
        if (n) { partes.push({ ini, fin: hi }); n = 0; }
        const b = Date.parse(hi + "Z");
        for (let k = 0; k < 6; k++) partes.push({ ini: new Date(b + k * 6e5).toISOString().slice(0, 19), fin: new Date(b + (k + 1) * 6e5).toISOString().slice(0, 19) });
        ini = new Date(b + 36e5).toISOString().slice(0, 19);
        continue;
      }
      if (n && n + h.filas > 100000) { partes.push({ ini, fin: hi }); ini = hi; n = 0; }
      n += h.filas;
    }
    partes.push({ ini, fin: `${sig(dia)}T00:00:00` });
    partes.forEach((p, i) => tramos.push({ ...p, recalcular: i === partes.length - 1, etiqueta: `${dia} ${p.ini.slice(11, 16)}-${p.fin.slice(11, 16)}` }));
    continue;
  }
  if (cur && cur.n + filas <= LIMITE && (Date.parse(dia) - Date.parse(cur.desde)) / 864e5 < 10) { cur.hasta = dia; cur.n += filas; }
  else { cerrar(); cur = { desde: dia, hasta: dia, n: filas }; }
}
cerrar();
const pend = tramos.filter((t) => t.fin > DESDE_TS); tramos.length = 0; tramos.push(...pend);
console.log(`tramos: ${tramos.length}`);
const t0 = Date.now();
for (const [i, t] of tramos.entries()) {
  let ok = false;
  for (let intento = 1; intento <= 3 && !ok; intento++) {
    const { data, error } = await sb.rpc("reconstruir_tramo", { _tenant: T, _ini: t.ini, _fin: t.fin, _recalcular: t.recalcular });
    if (!error) { ok = true; console.log(`[${i + 1}/${tramos.length}] ${t.etiqueta} crudas=${data.filas_crudas} limpias=${data.eventos_limpios} jornadas=${data.jornadas} (${Math.round((Date.now() - t0) / 1000)}s)`); }
    else console.log(`[${i + 1}/${tramos.length}] ${t.etiqueta} ERROR intento ${intento}: ${error.message.replace(/\s+/g, " ").slice(0, 90)}`);
  }
  if (!ok) { console.log("DETENIDO"); process.exit(1); }
}
const { data: fin, error: ef } = await sb.rpc("finalizar_reconstruccion", { _tenant: T });
console.log("FINALIZADO", ef?.message ?? JSON.stringify(fin), `${Math.round((Date.now() - t0) / 1000)}s`);
