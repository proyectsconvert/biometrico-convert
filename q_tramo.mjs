import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env = Object.fromEntries(fs.readFileSync(".env","utf8").split(/\r?\n/).filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")]}));
const sb = createClient(env.SUPABASE_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const t0 = Date.now();
const { data, error } = await sb.rpc("reconstruir_mes", { _tenant: "11111111-1111-1111-1111-111111111111", _desde: process.argv[2], _hasta: process.argv[3] });
console.log(process.argv[2], process.argv[3], ((Date.now() - t0) / 1000).toFixed(1) + "s", error?.message?.slice(0, 120) ?? JSON.stringify(data));
