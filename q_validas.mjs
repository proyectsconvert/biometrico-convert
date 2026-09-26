import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env = Object.fromEntries(fs.readFileSync(".env","utf8").split(/\r?\n/).filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")]}));
const sb = createClient(env.SUPABASE_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: imps } = await sb.from("biometric_imports").select("id, filename").order("filename");
let i = 0, err = 0;
const tarea = async () => { while (i < imps.length) { const im = imps[i++];
  for (let k = 1; k <= 3; k++) { const { error } = await sb.rpc("estadisticas_importacion", { _import: im.id }); if (!error) break; if (k === 3) { err++; console.log("ERROR", im.filename, error.message.slice(0, 80)); } } } };
await Promise.all([tarea(), tarea(), tarea()]);
console.log("listo", imps.length, "errores", err);
