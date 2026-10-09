import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

// Ensure WebSocket exists in Node runtime for @supabase/realtime-js
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = class DummyWebSocket {} as any;
}

// Load .env automatically in node-server runtime if present
try {
  if (typeof process !== "undefined" && typeof (process as any).loadEnvFile === "function") {
    (process as any).loadEnvFile();
  }
} catch {
  // .env file not present or already in environment
}

// Reprocesos del histórico: se retoman solos tras un reinicio o cuando toca su reintento automático
if (
  typeof process !== "undefined" &&
  (process.env["NODE_ENV"] === "production" || process.env["REPROCESO_VIGILANTE"] === "1")
) {
  void import("./lib/reproceso.server")
    .then((m: { vigilarReprocesos: () => void }) => m.vigilarReprocesos())
    .catch((e) => console.error("[reproceso] no se pudo iniciar el vigilante", e));
}

// Alarmas de turnos abiertos que pasan el tiempo configurado (cada minuto, sin depender del tablero)
if (
  typeof process !== "undefined" &&
  (process.env["NODE_ENV"] === "production" || process.env["REPROCESO_VIGILANTE"] === "1")
) {
  void import("./lib/alarmas-turno.server")
    .then((m: { vigilarAlarmasTurno: () => void }) => m.vigilarAlarmasTurno())
    .catch((e) => console.error("[alarmas-turno] no se pudo iniciar el vigilante", e));
}

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      if (env && typeof env === "object") {
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === "string" && !process.env[key]) {
            process.env[key] = value;
          }
        }
      }
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
