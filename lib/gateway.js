// lib/gateway.js — host-side HTTP gateway exposing the `ego-browser` config
// to the browser through a self-hosted `/ego/api` route.
//
// The DSH typertGateway `/api` RPC dispatch was the original channel
// (TypertRemoteService + @Remote), but the host's SRC discovery
// (ctx.reflect.props enumeration) is not claiming plugin-owned service
// endpoints on the current dsh snapshot. The self-hosted HTTP route
// mirrors the better-sidebar / dsh-plugin-interpreters pattern:
// `ctx.webServer.register` claims a prefix route, the handler reads/writes
// the settings seam in-process (no wire-layer allowlist gate), and the
// browser reaches it through `fetch('/ego/api/<method>')`.
//
// Route shape:
//   POST /ego/api/get  → { ok: true, value: { config: ResolvedConfig } }
//   POST /ego/api/set  body: { patch: Partial<Config> }
//                        → { ok: true, value: { config: ResolvedConfig } }
// Errors carry { ok: false, error: { code, message } }.
import { resolveConfig } from "./config.js";
import { SETTINGS_NAMESPACE } from "./settings.js";

/** HTTP route prefix owning every ego-browser API request. */
const API_PREFIX = "/ego/api";

/** Config keys the `set` endpoint accepts (allow-list; unknown keys are dropped). */
const ALLOWED_KEYS = new Set([
  "chromePath", "captureBackend", "streamProfile", "cdpFps", "cdpQuality",
  "cdpMaxWidth", "cdpBackstopIntervalMs", "ffmpegFps", "ffmpegMaxWidth",
  "ffmpegEncoder", "ffmpegPath",
]);

/**
 * Register the `/ego/api` HTTP route on the host's web server.
 *
 * The route reads/writes the `ego-browser` settings namespace in-process
 * through the bridge + `ctx.settings`. The settings service is optional:
 * when absent, `get` degrades to the entry source and `set` returns a
 * clear error.
 * @param {import("@deepseek-ai/cordis").Context} ctx - host context carrying `webServer`.
 * @param {{ source: () => { chromePath: string, castFpsCap: number, screencastQuality: number, screencastMaxWidth: number }, onChange: (cb: () => void) => void }} bridge
 *   the settings bridge the route reads through.
 */
export function registerEgoBrowserGateway(ctx, bridge) {
  let settings;
  ctx.inject(["settings"], (sctx) => {
    settings = sctx.settings;
    return () => {
      settings = undefined;
    };
  });
  ctx.effect(() => {
    if (!ctx.webServer || typeof ctx.webServer.register !== "function") return;
    return ctx.webServer.register({
      kind: "prefix",
      path: API_PREFIX,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, envelopeError("method-not-allowed", "POST only"));
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
        const method = pathname.startsWith(`${API_PREFIX}/`)
          ? pathname.slice(`${API_PREFIX}/`.length)
          : undefined;
        if (method === undefined || method.includes("/")) {
          writeJson(res, 404, envelopeError("not-found", "unknown ego-browser API method"));
          return;
        }
        try {
          const body = await readJsonBody(req);
          if (method === "get") {
            const config = resolveConfig(bridge.source());
            writeJson(res, 200, envelopeOk({ config }));
          } else if (method === "set") {
            const result = await handleSet(body, settings, bridge);
            writeJson(res, 200, envelopeOk(result));
          } else {
            writeJson(res, 404, envelopeError("not-found", `unknown ego-browser API method "${method}"`));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJson(res, 500, envelopeError("internal", message));
        }
      },
    });
  }, "ego-browser: /ego/api routes");
}

/**
 * Handle the `set` method: validate the patch, write the user layer, return
 * the new resolved config.
 */
async function handleSet(body, settings, bridge) {
  const patch = extractPatch(body);
  if (Object.keys(patch).length === 0) {
    return { config: resolveConfig(bridge.source()) };
  }
  if (settings === undefined) {
    throw new Error(
      "ego-browser: settings service is unavailable — configuration cannot be written",
    );
  }
  await settings.update(SETTINGS_NAMESPACE, patch);
  return { config: resolveConfig(bridge.source()) };
}

/**
 * Extract and validate the patch from the request body.
 *
 * JSON wire boundary: null = "delete" (filtered), undefined never crosses
 * JSON. Unknown keys are dropped (the settings service is non-strict and
 * would otherwise store them). String keys (chromePath) are accepted.
 */
function extractPatch(body) {
  if (!isObject(body)) return {};
  const raw = Reflect.get(body, "patch");
  if (!isObject(raw)) return {};
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

/** Read and parse a JSON body from a node:http request. */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  return JSON.parse(text);
}

/** Write a JSON response envelope. */
function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

/** Build a success envelope. */
function envelopeOk(value) {
  return { ok: true, value };
}

/** Build an error envelope. */
function envelopeError(code, message) {
  return { ok: false, error: { code, message } };
}

/** Narrow unknown to a non-null object. */
function isObject(value) {
  return typeof value === "object" && value !== null;
}
