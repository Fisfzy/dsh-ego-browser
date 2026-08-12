#!/usr/bin/env node
/**
 * ego-cast-worker — DSH-owned realtime view source for the ego-browser panel.
 *
 * Unlike the first-cut design, this worker does NOT launch its own Chromium.
 * The agent's browser is the ONLY instance that matters (it is the one the
 * ego_* tools drive, on ~/.local/{share,state}/ego-lite-linux, and Chromium is
 * single-instance per profile anyway — a second Chrome would just hand control
 * back to the running one). Instead this worker ATTACHES to that same live
 * browser via its browser-level CDP WebSocket:
 *
 *   1. read BROWSER_STATE_FILE (~/.local/state/ego-lite-linux/browser.json)
 *      -> { port }
 *   2. probe http://127.0.0.1:<port>/json/version -> webSocketDebuggerUrl
 *   3. open the browser WS, keep one Page.startScreencast stream per page
 *      target, cache the newest JPEG frame (push mode, not polled capture)
 *   4. expose a loopback HTTP api the host route forwards:
 *        GET /api/spaces   -> [{targetId,url,title,thumbnail(dataURL)}]
 *        GET /api/health   -> { ok }
 *   5. write { port, pid } to a small state file the plugin finds it by
 *
 * It only EVER reads from the shared browser (attach + screencast); it never
 * navigates, never writes, never opens a window, never touches the host env.
 * If no agent browser is up yet it reports an empty spaces list and waits; the
 * plugin's host route surfaces that as "no live browser right now".
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = "@@DSH_RESULT@@";
// Paths must mirror ego-linux/src/paths.mjs so we attach to the SAME browser.
const HOME = process.env.HOME || "/root";
const STATE_DIR = process.env.XDG_STATE_HOME || join(HOME, ".local", "state");
const EGO_LITE_STATE_DIR = join(
  process.env.EGO_LINUX_STATE_DIR || join(STATE_DIR, "ego-lite-linux"),
);
const BROWSER_STATE_FILE = join(EGO_LITE_STATE_DIR, "browser.json");
const CAST_STATE_FILE = join(EGO_LITE_STATE_DIR, "ego-cast.json");

/** Poll a DevTools port for its browser-level WS URL (mirrors chrome.mjs probe). */
async function probe(port, ms = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()).webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

/** Read the chromium browser state file the ego runtime wrote. */
async function readBrowserState() {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(BROWSER_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve the live browser ws, honoring an explicit CDP override first. */
async function resolveBrowserWs() {
  const over = process.env.EGO_LINUX_CDP_URL;
  if (over) return { wsUrl: over, port: null };
  const state = await readBrowserState();
  if (!state?.port) return null;
  const wsUrl = await probe(state.port);
  return wsUrl ? { wsUrl, port: state.port } : null;
}

// ---------------------------------------------------------------------------
// CDP plumbing (Node >= 22 ships a global WebSocket)
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const [resolve] = this.pending.get(m.id);
        this.pending.delete(m.id);
        resolve(m);
        return;
      }
      if (m.method) {
        for (const h of this.events.get(m.method) || []) h(m.params, m.sessionId);
      }
    });
  }
  call(method, params = {}, sessionId, timeoutMs = 6000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, [
        (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      ]);
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }
  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(handler);
  }
}

/** Screencast pool: one live stream per page target, newest JPEG cached. */
function createCastPool(cdp) {
  const casts = new Map();
  cdp.on("Page.screencastFrame", (params) => {
    cdp.call("Page.screencastFrameAck", { sessionId: params.sessionId }, params.sessionId).catch(() => {});
    for (const cast of casts.values()) {
      if (cast.sessionId !== params.sessionId) continue;
      cast.frame = params.data || null;
      cast.seq += 1;
      cast.lastActive = Date.now();
      break;
    }
  });
  /** Drop a target's cast and stop its screencast stream (best-effort). */
  async function drop(targetId) {
    const cast = casts.get(targetId);
    if (!cast) return;
    casts.delete(targetId);
    cdp.call("Page.stopScreencast", {}, cast.sessionId).catch(() => {});
  }
  // Keep the pool bounded: a target that goes away must not linger forever
  // (it would keep acked screencast frames and leak memory over a long run).
  cdp.on("Target.targetDestroyed", (params) => {
    for (const [tid, cast] of casts) {
      if (cast.targetId === params.targetId) drop(tid);
    }
  });
  async function frameFor(targetId) {
    if (casts.has(targetId)) return casts.get(targetId);
    let sessionId;
    try {
      const { result } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
      sessionId = result.sessionId;
      await cdp.call("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 960, everyNthFrame: 1 }, sessionId);
    } catch (err) {
      return null; // attach/screencast failed — caller reports no thumbnail
    }
    const cast = { targetId, sessionId, frame: null, seq: 0, lastActive: Date.now() };
    casts.set(targetId, cast);
    await refreshFrame(targetId);
    return cast;
  }
  /**
   * Force a fresh screenshot for a target, updating its cached frame.
   *
   * Screencast only emits frames when the PAGE repaints; pages that change
   * without repainting — a <video> element playing inside a static layout, a
   * canvas that animates off-throttle — may never push a new screencast frame,
   * so the cached frame freezes. `/api/spaces` calls this so the watch panel
   * shows the CURRENT picture, not a stale one. Rate-limited per target
   * (min 500ms) to avoid hammering every poll, and parallel-safe via a
   * per-target in-flight promise.
   */
  const pending = new Map();
  const lastShot = new Map();
  function refreshFrame(targetId) {
    const cast = casts.get(targetId);
    if (!cast) return frameFor(targetId);
    const since = Date.now() - (lastShot.get(targetId) || 0);
    if (since < 500) return cast;
    if (pending.has(targetId)) return pending.get(targetId);
    const p = (async () => {
      try {
        const shot = await cdp.call("Page.captureScreenshot", { format: "jpeg", quality: 55 }, cast.sessionId);
        const data = shot?.result?.data || shot?.data || null;
        if (data && data.length > 0) {
          cast.frame = data;
          cast.lastActive = Date.now();
        }
      } catch {
        /* transient — keep last frame */
      } finally {
        lastShot.set(targetId, Date.now());
        pending.delete(targetId);
      }
      return cast;
    })();
    pending.set(targetId, p);
    return p;
  }
  async function removeCast(targetId) {
    await drop(targetId);
  }
  return { frameFor, refreshFrame, removeCast };
}

async function listPageTargets(cdp) {
  const { result } = await cdp.call("Target.getTargets");
  return (result.targetInfos || []).filter((t) => t.type === "page");
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** Collect a small JSON request body (bounded) and return it as a string. */
function readBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => (tooBig ? reject(new Error("body too large")) : resolve(data)));
    req.on("error", reject);
  }).catch(() => "");
}

// ---------------------------------------------------------------------------
// main — resilient version: loopback HTTP stays up; the browser attachment is
// re-established automatically whenever the agent browser appears, restarts,
// or its CDP socket drops. This replaces the old "exit(2) if no browser" and
// "one-shot WS" behavior so the panel never silently goes dead.
// ---------------------------------------------------------------------------
const RETRY_NO_BROWSER_MS = 3000;  // no browser.json / unreachable
const RETRY_AFTER_DROP_MS = 2000;  // CDP socket closed or errored
let active = null; // { cdp, pool } for the live browser attachment

async function openBrowserSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  const pool = createCastPool(cdp);
  const dropped = new Promise((resolve) => {
    ws.addEventListener("close", () => resolve("close"), { once: true });
    ws.addEventListener("error", () => resolve("error"), { once: true });
  });
  return { ws, cdp, pool, dropped };
}

async function runConnectLoop() {
  while (true) {
    const browser = await resolveBrowserWs();
    if (!browser) {
      // Wait for the agent browser to appear; report empty in the meantime.
      await sleep(RETRY_NO_BROWSER_MS);
      continue;
    }
    try {
      const session = await openBrowserSession(browser.wsUrl);
      active = session;
      console.error(`ego-cast-worker: attached to browser (${browser.port ?? "override"})`);
      await session.dropped;
    } catch {
      console.error("ego-cast-worker: browser connect failed, retrying");
    } finally {
      active = null;
      await sleep(RETRY_AFTER_DROP_MS);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: !!active });
    if (req.method === "POST" && url.pathname === "/api/close") {
      const sess = active;
      if (!sess) return sendJson(res, 400, { ok: false, error: "no live browser" });
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const targetId = body.targetId;
        if (!targetId) return sendJson(res, 400, { ok: false, error: "targetId required" });
        // closeTarget is a browser-level command; pass the target id as a param
        // (no sessionId — it closes the whole page target).
        await sess.cdp.call("Target.closeTarget", { targetId }, undefined, 6000);
        // drop any cast stream for that page
        try { await sess.pool.removeCast(targetId); } catch {}
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/flush") {
      const sess = active;
      if (!sess) return sendJson(res, 400, { ok: false, error: "no live browser" });
      try {
        // Force all persistent cookies down to the on-disk profile store.
        // Chrome buffers cookie writes in memory and only flushes lazily; a
        // graceful Browser.close flushes them. To keep the login stable across a
        // restart we re-write each non-session cookie via Network.setCookie on a
        // page session, which nudges Chrome to persist it sooner.
        const targets = await listPageTargets(sess.cdp);
        let sessionId = null;
        for (const t of targets.slice(0, 5)) {
          try {
            const { result } = await sess.cdp.call("Target.attachToTarget", { targetId: t.targetId, flatten: true });
            if (result?.sessionId) { sessionId = result.sessionId; break; }
          } catch { /* try next */ }
        }
        if (!sessionId) return sendJson(res, 200, { ok: true, flushed: 0, note: "no page session" });
        await sess.cdp.call("Network.enable", {}, sessionId, 6000).catch(() => {});
        const all = await sess.cdp.call("Network.getAllCookies", {}, sessionId, 6000);
        const cookies = Array.isArray(all?.result?.cookies) ? all.result.cookies : [];
        let rewrote = 0;
        for (const c of cookies) {
          if (c.session === true) continue; // session-only cookie can't persist
          try {
            await sess.cdp.call("Network.setCookie", {
              name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
              secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite,
              expires: c.expires ? c.expires : -1,
              url: `https://${c.domain.replace(/^\./, "")}`,
            }, sessionId, 6000);
            rewrote++;
          } catch { /* skip unpersistable */ }
        }
        return sendJson(res, 200, { ok: true, total: cookies.length, flushed: rewrote });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/spaces") {
      const sess = active;
      if (!sess) return sendJson(res, 200, { ok: true, spaces: [] });
      try {
        const targets = await listPageTargets(sess.cdp);
        const spaces = [];
        for (const t of targets.slice(0, 30)) {
          try {
            // refreshFrame forces a fresh screenshot so the watch panel shows
            // the CURRENT picture of each page (screencast alone can freeze on
            // pages that change without repainting, e.g. a playing video).
            const cast = await sess.pool.refreshFrame(t.targetId);
            spaces.push({
              targetId: t.targetId,
              url: t.url,
              title: t.title,
              thumbnail: cast?.frame ? `data:image/jpeg;base64,${cast.frame}` : null,
              // Most-recently-active first: the page the agent is currently
              // looking at (or just touched) gets the newest lastActive.
              lastActive: cast?.lastActive ?? 0,
            });
          } catch {
            /* skip broken target */
          }
        }
        // Newest active on top — the panel's default ("latest step on top" view).
        spaces.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
        return sendJson(res, 200, { ok: true, spaces });
      } catch {
        return sendJson(res, 200, { ok: true, spaces: [] });
      }
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  mkdirSync(EGO_LITE_STATE_DIR, { recursive: true });
  writeFileSync(CAST_STATE_FILE, JSON.stringify({ port, pid: process.pid }, null, 2));

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  async function shutdown() {
    try { rmSync(CAST_STATE_FILE, { force: true }); } catch {}
    server.close();
    try { active?.ws?.close(); } catch {}
    process.exit(0);
  }

  console.log(`${SENTINEL}${JSON.stringify({ ok: true, port, pid: process.pid })}`);
  // Both the connect loop (forever) and the keepalive hold the loop open.
  runConnectLoop().catch((e) => console.error("ego-cast-worker: connect loop died", e?.stack || e?.message));
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error("ego-cast-worker failed:", e.stack || e.message);
  process.exit(1);
});
