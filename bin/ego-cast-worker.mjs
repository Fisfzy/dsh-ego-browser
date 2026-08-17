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
 *
 * == 文件内部结构（维护前先看 docs/ARCH.md）==
 *   顶部常量   : 状态路径 / 哨兵 / HUMAN_PROBE_JS(人机探针) / probeCache
 *   Cdp 类     : CDP 连接封装（call/on）
 *   createCastPool : screencast 池 + viewport + 实时帧广播
 *   sseBroadcast   : SSE 客户端扇出（frame / spaces 事件）
 *   probeHuman     : 每页 humanCheck 检测（节流5s, fire-and-forget）
 *   runConnectLoop : 浏览器连接/重连
 *   keepCastsAlive : 兜底截图 + humanCheck 刷新
 *   main           : loopback HTTP 路由（/api/spaces /api/stream /api/input /api/flush /api/close）
 * 注意：humanCheck 探针与 lib/index.js 各有一份，改特征要两处同步。
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SENTINEL = "@@DSH_RESULT@@";
// Paths must mirror ego-linux/src/paths.mjs so we attach to the SAME browser.
// Windows stores everything under %LOCALAPPDATA%\ego-lite-linux; POSIX uses
// $XDG_STATE_HOME (default ~/.local/state)/ego-lite-linux.
const HOME = homedir() || process.env.HOME || process.env.USERPROFILE || "/root";
const IS_WIN = platform() === "win32";
const STATE_HOME = IS_WIN
  ? process.env.LOCALAPPDATA || join(HOME, "AppData", "Local")
  : process.env.XDG_STATE_HOME || join(HOME, ".local", "state");
const EGO_LITE_STATE_DIR = process.env.EGO_LINUX_STATE_DIR || join(STATE_HOME, "ego-lite-linux");
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

// ---------------------------------------------------------------------------
// Real-time SSE fan-out. The watch panel runs on an EventSource; every new
// screencast frame is pushed immediately (browser repaint cadence), so the UI
// stops waiting on a per-request captureScreenshot (which measured ~700ms).
// ---------------------------------------------------------------------------
const sseClients = new Set();

// Lightweight DOM probe for human-verification (CAPTCHA) challenges. Runs via
// Runtime.evaluate on a page session during snapshotting, so the watch panel can
// flash a reminder when the agent is being asked to verify.
const HUMAN_PROBE_JS = `(() => {
  const sel = [
    'iframe[src*="recaptcha"]', '.g-recaptcha',
    '.h-captcha', 'iframe[src*="hcaptcha"]',
    '.cf-turnstile', 'iframe[src*="turnstile"]',
    'iframe[src*="cloudflare"]', '#challenge-form', '.challenge-form',
    '#captcha', '.captcha'
  ].join(',');
  const el = document.querySelector(sel);
  if (el) {
    const s = el.outerHTML || '';
    if (/recaptcha|g-recaptcha/i.test(s)) return { detected: true, kind: 'recaptcha' };
    if (/hcaptcha|h-captcha/i.test(s)) return { detected: true, kind: 'hcaptcha' };
    if (/turnstile/i.test(s)) return { detected: true, kind: 'turnstile' };
    if (/cloudflare/i.test(s)) return { detected: true, kind: 'cloudflare' };
    return { detected: true, kind: 'captcha' };
  }
  const t = ((document.body && document.body.innerText) || '').slice(0, 120000).toLowerCase();
  if (/verify you are human|your activity looks unusual|captcha|i.?m not a robot|人机验证|安全验证|我是人类|验证码|滑块验证/.test(t)) return { detected: true, kind: 'captcha' };
  return { detected: false, kind: null };
})()`;

/** Best-effort runtime of the human-check probe on a page session. */
async function probeHuman(cdp, sessionId) {
  if (!sessionId) return null;
  try {
    const r = await cdp.call(
      "Runtime.evaluate",
      { expression: HUMAN_PROBE_JS, returnByValue: true, awaitPromise: false },
      sessionId,
      3000
    );
    const v = r?.result?.result?.value;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function sseBracket(res, status = 200) {
  res.writeHead(status, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  res.write(":ok\n\n");
}
/** Write one SSE event to every connected client. `payload` must be JSON-safe. */
function sseBroadcast(event, payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  const frame = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}
/** Rebuild the current snapshot ({targetId,url,title,lastActive}) for a client. */
const probeCache = new Map(); // targetId -> { at, human }
const PROBE_INTERVAL_MS = 5000;
// ── Cast config (live-hot-swappable) ────────────────────────────────────────
// The host spawns this worker with the current cast settings as a JSON argv
// arg (process.argv[2]); subsequent settings edits are hot-pushed via
// POST /api/config. All three values are mutable so the watch panel's
// screencast parameters can be tuned at runtime without restarting the
// worker or the browser attachment.
//
//   castFpsCap        : 0 = uncapped (full repaint cadence); >0 = at most N
//                       frames/sec pushed to clients. The watched (active)
//                       tab is never throttled; only background repainting
//                       tabs are rate-limited.
//   screencastQuality : JPEG quality (1-100) for startScreencast + backstop
//                       captureScreenshot.
//   screencastMaxWidth: max CSS px width of each pushed frame.
let castConfig = { castFpsCap: 0, screencastQuality: 55, screencastMaxWidth: 960 };
try {
  const arg = process.argv[2];
  if (arg) {
    const parsed = JSON.parse(arg);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.castFpsCap === "number") castConfig.castFpsCap = parsed.castFpsCap;
      if (typeof parsed.screencastQuality === "number") castConfig.screencastQuality = parsed.screencastQuality;
      if (typeof parsed.screencastMaxWidth === "number") castConfig.screencastMaxWidth = parsed.screencastMaxWidth;
    }
  }
} catch { /* malformed argv — keep defaults */ }

// ── active-tab tracking ─────────────────────────────────────────────────────
// Which page the agent is CURRENTLY on is the single most important fact for the
// watch panel's auto-follow. It is NOT "the page that last repainted" — Chrome
// runs each page's screencast stream independently, so an animated/video tab in
// the background repaints (and bumps lastActive) as fast as the operated one and
// can steal the view. The authoritative signal is the DevTools HTTP endpoint
// `/json/list`, which returns targets in most-recently-used order — it reflects
// both the user's manual tab switches and the runtime's programmatic
// `Target.activateTarget` (switchTab / openOrReuseTab). The first page entry is
// the one the agent is looking at right now. (tabs.mjs in the runtime trusts the
// same source for exactly this reason.)
let activeTabCache = null; // { at, id } — id of the MRU-active page target
const ACTIVE_TAB_TTL_MS = 1500;
/** The id of the browser's most-recently-used (currently-active) page, or null. */
async function activeTabId() {
  const port = active?.port;
  if (!port) return null;
  if (activeTabCache && Date.now() - activeTabCache.at < ACTIVE_TAB_TTL_MS) {
    return activeTabCache.id;
  }
  let id = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const list = await res.json();
      const first = (Array.isArray(list) ? list : []).find((e) => e.type === "page");
      id = first?.id ?? null;
    }
  } catch {
    id = null;
  }
  activeTabCache = { at: Date.now(), id };
  return id;
}

/** Synchronous peek of the most-recently-known active tab (may be a moment stale).
 *  Used on the hot screencast path so a frame is never gated behind an await. */
function peekActiveTabId() {
  return (activeTabCache && Date.now() - activeTabCache.at < ACTIVE_TAB_TTL_MS)
    ? activeTabCache.id
    : null;
}

/** Clear the MRU cache when the browser (re)connects so we never follow a stale tab. */
function resetActiveTabCache() {
  activeTabCache = null;
}
async function snapshotSpaces() {
  if (!active) return [];
  try {
    const targets = await listPageTargets(active.cdp);
    // Authoritative active page: the browser's MRU-active tab. Never fall back
    // to "highest lastActive" here — background repaints must not win.
    const activeId = await activeTabId();
    // Read only already-cached frames — never call startScreencast here. That
    // keeps the initial "spaces" push instant and, crucially, does not steal
    // the one screencast stream Chrome allows per target away from the live
    // fan-out below. We also do NOT include the frame bytes in the snapshot
    // anymore — the live JPEGs stream over SSE `frame` events; the snapshot
    // is pure metadata so the panel can render its tab list without waiting
    // on a captureScreenshot per target.
    const frames = active.pool.cachedFrames ? active.pool.cachedFrames() : new Map();
    const spaces = [];
    for (const t of targets.slice(0, 30)) {
      const meta = frames.get(t.targetId);
      const isActive = activeId !== null && t.targetId === activeId;
      // Human-check probe: cached, throttled (5s), fire-and-forget so it never
      // blocks the snapshot. Each page's value is refreshed lazily; the panel
      // reads the last known one.
      const cached = probeCache.get(t.targetId);
      if (!cached || Date.now() - cached.at > PROBE_INTERVAL_MS) {
        const sess = active.pool.sessionFor ? active.pool.sessionFor(t.targetId) : null;
        probeHuman(active.cdp, sess).then((human) => {
          probeCache.set(t.targetId, { at: Date.now(), human });
        }).catch(() => {});
      }
      spaces.push({
        targetId: t.targetId,
        url: t.url,
        title: t.title,
        active: isActive,
        lastActive: meta?.lastActive ?? 0,
        viewportW: meta?.viewportW ?? undefined,
        viewportH: meta?.viewportH ?? undefined,
        humanCheck: (cached && cached.human) ?? null,
      });
    }
    // Active page always first; the rest by recency of activity.
    spaces.sort((a, b) => {
      const ad = a.active ? 1 : 0, bd = b.active ? 1 : 0;
      if (ad !== bd) return bd - ad;
      return (b.lastActive ?? 0) - (a.lastActive ?? 0);
    });
    return spaces;
  } catch {
    return [];
  }
}

/**
 * Script injected into every page target to force the compositor to keep
 * producing frames. Without this, pages that don't visibly repaint — video
 * players with hardware-accelerated <video>, canvas animations rendered in
 * a separate compositor layer, or simply static pages — never trigger
 * Page.screencastFrame events, so the watch panel freezes until the 5-second
 * captureScreenshot backstop fires.
 *
 * The element is a 1px fully-transparent div with an infinite opacity
 * animation. The animation forces the compositor to recomposite every frame
 * (opacity is a compositor-layer property), which in turn causes Chrome to
 * emit Page.screencastFrame events at the browser's native cadence. The
 * element is invisible (opacity:0 + pointer-events:none + z-index:-1) and
 * costs negligible CPU/GPU on modern hardware.
 *
 * Idempotent: the guard variable prevents double-injection on
 * addScriptToEvaluateOnNewDocument + Runtime.evaluate overlap.
 */
const FORCE_REPAINT_SCRIPT = `(function(){
  if(window.__egoForceRepaint__)return;
  window.__egoForceRepaint__=true;
  var s=document.createElement('style');
  s.textContent='@keyframes __ego_fr__{0%,100%{opacity:0}50%{opacity:0.001}}';
  (document.head||document.documentElement).appendChild(s);
  function add(){
    var el=document.createElement('div');
    el.setAttribute('data-ego-fr','');
    el.style.cssText='position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none;z-index:-1;opacity:0;animation:__ego_fr__ 0.5s infinite';
    (document.body||document.documentElement).appendChild(el);
  }
  if(document.body)add();
  else document.addEventListener('DOMContentLoaded',add);
})();`;

/** Screencast pool: one live stream per page target, newest JPEG cached. */
function createCastPool(cdp) {
  const casts = new Map();
  cdp.on("Page.screencastFrame", (params, sessionId) => {
    cdp.call("Page.screencastFrameAck", { sessionId }, sessionId).catch(() => {});
    for (const cast of casts.values()) {
      if (cast.sessionId !== sessionId) continue;
      cast.frame = params.data || null;
      cast.seq += 1;
      cast.lastActive = Date.now();
      // Capture the page's CSS viewport + page scale so the panel can map its
      // pointer coordinates back to real browser pixels. screencastFrame carries
      // these in metadata; frameFor's snapshot has no repaint event, so we only
      // learn them here (and refresh them from /api/input-able targets lazily).
      const md = params.metadata || {};
      if (Number.isFinite(md.visibleViewportWidth)) cast.viewportW = md.visibleViewportWidth;
      if (Number.isFinite(md.visibleViewportHeight)) cast.viewportH = md.visibleViewportHeight;
      // Real-time push: forward every fresh frame to the watch panel as soon as
      // it arrives, instead of waiting for the next /api/spaces poll. The panel
      // dataURL-caches per target so reconnecting clients catch up cheaply.
      if (cast.frame && sseClients.size > 0) {
        // Optional fan-out cap. Uncapped (0) → always send. Capped → the
        // watched (active) tab always passes; only background repainting tabs
        // are rate-limited to free bandwidth/CPU on dynamic pages.
        let pass = castConfig.castFpsCap <= 0;
        if (!pass) {
          // Sync path: use the cached active id so a frame is never gated
          // behind an await. The cap is opt-in; the default (0) short-circuits
          // above and stays fully synchronous.
          const activeId = peekActiveTabId();
          const isWatched = !activeId || cast.targetId === activeId;
          if (isWatched) {
            pass = true;
          } else {
            const minGapMs = 1000 / castConfig.castFpsCap;
            const now = Date.now();
            if (!cast.lastCastAt || now - cast.lastCastAt >= minGapMs) {
              cast.lastCastAt = now;
              pass = true;
            }
          }
        }
        if (pass) {
          sseBroadcast("frame", {
            targetId: cast.targetId,
            data: cast.frame,
            ts: Date.now(),
            vw: cast.viewportW || null,
            vh: cast.viewportH || null,
          });
        }
      }
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
      // Enable Page domain explicitly so screencastFrame events are delivered.
      // startScreencast implicitly enables it in most Chrome builds, but being
      // explicit avoids relying on undocumented behavior.
      await cdp.call("Page.enable", {}, sessionId).catch(() => {});
      await cdp.call("Page.startScreencast", { format: "jpeg", quality: castConfig.screencastQuality, maxWidth: castConfig.screencastMaxWidth, everyNthFrame: 1 }, sessionId);
      // Inject a force-repaint animation so the compositor keeps producing
      // frames even on pages that don't repaint on their own — video players,
      // canvas animations, and static pages with hardware-accelerated content
      // all freeze the screencast stream because Chrome's compositor only
      // emits a new frame when something visible changes. The injected element
      // is a 1px transparent div with an infinite opacity animation; this
      // forces the compositor to recomposite every frame, which triggers
      // Page.screencastFrame events at the browser's native cadence.
      // addScriptToEvaluateOnNewDocument survives navigation; Runtime.evaluate
      // covers the current page immediately.
      try {
        await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: FORCE_REPAINT_SCRIPT }, sessionId);
        await cdp.call("Runtime.evaluate", { expression: FORCE_REPAINT_SCRIPT, silent: true }, sessionId);
      } catch { /* best-effort — screencast still works, just may be slow on static pages */ }
    } catch (err) {
      return null; // attach/screencast failed — caller reports no thumbnail
    }
    const cast = { targetId, sessionId, frame: null, seq: 0, lastActive: Date.now(), viewportW: null, viewportH: null };
    casts.set(targetId, cast);
    // Pull the CSS viewport once so the panel can map coordinates even before
    // the first repaint (screencast metadata only arrives on a pushed frame).
    updateViewport(cast).catch(() => {});
    await refreshFrame(targetId);
    return cast;
  }
  /** Best-effort: fill cast.viewportW/H from the page's layout metrics. */
  async function updateViewport(cast) {
    try {
      if (!cast.sessionId) return;
      const shot = await cdp.call("Page.getLayoutMetrics", {}, cast.sessionId);
      const r = shot?.result || shot || {};
      const css = r.cssLayoutViewport || r.cssViewport || {};
      const w = css.clientWidth ?? css.width;
      const h = css.clientHeight ?? css.height;
      if (Number.isFinite(w) && w > 0) cast.viewportW = w;
      if (Number.isFinite(h) && h > 0) cast.viewportH = h;
    } catch {
      /* leave existing values */
    }
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
        const shot = await cdp.call("Page.captureScreenshot", { format: "jpeg", quality: castConfig.screencastQuality }, cast.sessionId);
        const data = shot?.result?.data || shot?.data || null;
        if (data && data.length > 0) {
          cast.frame = data;
          cast.lastActive = Date.now();
        }
        // The screenshot itself implies the page is rendered — line up the viewport
        // there too (cheap; only when we still don't know it).
        if (!cast.viewportW || !cast.viewportH) await updateViewport(cast);
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
  /** Map of targetId -> { frame } for targets that already have a cast. */
  function cachedFrames() {
    const out = new Map();
    for (const [targetId, cast] of casts) {
      if (cast.frame) out.set(targetId, { frame: cast.frame, lastActive: cast.lastActive, viewportW: cast.viewportW, viewportH: cast.viewportH });
    }
    return out;
  }
  /**
   * Dispatch a raw browser-input event to a live page via its screencast session.
   *
   * The watch panel sends pointer/wheel intentions with coordinates already
   * mapped to browser CSS pixels (it knows the page viewport from the frame
   * metadata we attach). Here we turn them into CDP `Input.dispatchMouseEvent`
   * calls on the same session that drives the screencast for that target, so a
   * click/drag/scroll lands on the real page the user is looking at.
   *
   * `payload.type` is one of:  mouseMoved | mousePressed | mouseReleased |
   * mouseWheel. Fields mirror CDP's params where sensible.
   */
  async function sendInput(targetId, payload) {
    const cast = casts.get(targetId);
    if (!cast || !cast.sessionId) return { ok: false, error: "no live session for target" };
    const { type, x, y, button = "left", buttons = 0, deltaX = 0, deltaY = 0, clickCount = 0, modifiers = 0 } = payload || {};
    const base = { button, buttons, clickCount, modifiers };
    if (type === "mouseMoved") {
      // during a drag Chrome expects buttons to stay held; aim for smoothness.
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons }, cast.sessionId);
    } else if (type === "mousePressed" || type === "mouseReleased") {
      await cdp.call("Input.dispatchMouseEvent", { type, x, y, ...base }, cast.sessionId);
    } else if (type === "mouseWheel") {
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY }, cast.sessionId);
    } else {
      return { ok: false, error: `unsupported input type: ${type}` };
    }
    return { ok: true };
  }

  /** The screencast session id for a target (used to run in-page probes). */
  function sessionFor(targetId) {
    return casts.get(targetId)?.sessionId ?? null;
  }

  /**
   * Restart every active screencast stream with the given parameters. Used
   * when the user changes screencastQuality / screencastMaxWidth in the
   * settings card — Chrome only honors new params on a fresh
   * startScreencast call (the running stream keeps its original params).
   * Best-effort: a target whose restart fails is left with its old stream.
   */
  async function restartScreencasts({ quality, maxWidth }) {
    const tasks = [];
    for (const [tid, cast] of casts) {
      tasks.push((async () => {
        try {
          await cdp.call("Page.stopScreencast", {}, cast.sessionId);
        } catch { /* may already be stopped */ }
        try {
          await cdp.call("Page.startScreencast", { format: "jpeg", quality, maxWidth, everyNthFrame: 1 }, cast.sessionId);
        } catch { /* target may have died — drop will follow on targetDestroyed */ }
      })());
    }
    await Promise.all(tasks);
  }

  return { frameFor, refreshFrame, removeCast, cachedFrames, sendInput, sessionFor, restartScreencasts };
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
// Single-instance guard: ensure only ONE ego-cast-worker is ever alive.
//
// Background: a worker can be launched both from the plugin install
// (C:\Users\...\.external-plugins\ego-browser) and from a dev clone
// (D:\AGENT LEARING\...), and `ensureWorker` respawns one whenever the last
// known pid in ego-cast.json looks dead. That can leave a stale file pointing
// at a dead pid while an older-but-alive worker keeps running on another port —
// exactly the "watch panel lost the stream" state. Fix: on startup this worker
// enumerates other node processes running the same ego-cast-worker.mjs and
// stops them, then REMOVES any stale ego-cast.json so the fresh process's own
// {port,pid} becomes authoritative.
// ---------------------------------------------------------------------------

// On Windows enumerate sibling node processes with a QUOTED commandline filter.
// We avoid cmd.exe / nested-quote mess by shipping the PowerShell script to
// powershell.exe -EncodedCommand as UTF-16LE base64 — immune to quote mangling.
function listSiblingWorkerPids() {
  const self = String(process.pid);
  const pids = [];
  if (IS_WIN) {
    // The script outputs one integer PID per line for every node.exe whose
    // command line contains our worker script, excluding our own pid.
    const ps = [
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
      "| Where-Object { $_.CommandLine -like '*ego-cast-worker.mjs*' -and $_.ProcessId -ne $PID }",
      "| Select-Object -ExpandProperty ProcessId",
    ].join(" ");
    try {
      const enc = Buffer.from(ps, "utf16le").toString("base64");
      const out = execFileSync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
        { encoding: "utf8", timeout: 8000 });
      for (const l of out.split(/\r?\n/)) {
        const t = l.trim();
        if (/^\d+$/.test(t) && t !== self) pids.push(Number(t));
      }
    } catch { /* enumeration failed → no-op */ }
    return pids;
  }
  // POSIX: ps -eo pid=,args= and filter lines by our script name.
  try {
    const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 8000 });
    for (const l of out.split(/\n/)) {
      const m = l.match(/^\s*(\d+)\s+(.+)$/);
      if (m && m[2].includes("ego-cast-worker.mjs") && m[1] !== self) pids.push(Number(m[1]));
    }
  } catch {}
  return pids;
}

/** Stop (graceful SIGTERM, then force) node processes running ego-cast-worker.mjs other than ourselves. */
function stopSiblingWorkers() {
  const others = listSiblingWorkerPids();
  for (const p of others) {
    // Graceful first (lets the old worker flush its cast state and exit),
    // then force if it lingers.
    try { process.kill(p, "SIGTERM"); } catch {}
    try { execFileSync("taskkill", ["/PID", String(p), "/T", "/F"], { timeout: 8000, stdio: "ignore" }); } catch {}
  }
}

/** Remove any stale ego-cast.json (dead pid, or a pid that will now be killed). */
async function cleanStaleCastState() {
  try {
    const { readFile } = await import("node:fs/promises");
    let pid = null;
    try {
      pid = JSON.parse(await readFile(CAST_STATE_FILE, "utf8"))?.pid ?? null;
    } catch {
      pid = null; // unparsable/absent → nothing to preserve
    }
    // If a live worker owns the file and it is NOT a stale duplicate we'd be
    // killing, leaving it would confuse ensureWorker. We always own the file in
    // the end, so just remove it; the fresh worker writes its own right after.
    rmSync(CAST_STATE_FILE, { force: true });
    console.error?.(`ego-cast-worker: stale cast state cleared (had pid=${pid ?? "-"})`);
  } catch {}
}

// ---------------------------------------------------------------------------
// main — resilient version: loopback HTTP stays up; the browser attachment is
// re-established automatically whenever the agent browser appears, restarts,
// or its CDP socket drops. This replaces the old "exit(2) if no browser" and
// "one-shot WS" behavior so the panel never silently goes dead.
// ---------------------------------------------------------------------------
const RETRY_NO_BROWSER_MS = 3000;  // no browser.json / unreachable
const RETRY_AFTER_DROP_MS = 2000;  // CDP socket closed or errored
// How long a page may go without a pushed screencast frame before the periodic
// backstop issues a forced screenshot for it. Longer than the keepalive interval
// so a live page (fed by screencast each repaint) is never needlessly captured,
// while a quiet/backgrounded page still gets rescued within a visible window.
const BACKSTOP_STALE_MS = 5000;
let active = null; // { cdp, pool } for the live browser attachment

async function openBrowserSession(wsUrl, browserPort = null) {
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
  return { ws, cdp, pool, dropped, port: browserPort };
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
      const session = await openBrowserSession(browser.wsUrl, browser.port || null);
      active = session;
      resetActiveTabCache();
      console.error(`ego-cast-worker: attached to browser (${browser.port ?? "override"})`);
      keepCastsAlive(session);
      await session.dropped;
    } catch {
      console.error("ego-cast-worker: browser connect failed, retrying");
    } finally {
      active = null;
      await sleep(RETRY_AFTER_DROP_MS);
    }
  }
}

/**
 * Keep a screencast stream on every live page target AND force a fresh frame
 * periodically as a backstop.
 *
 * Two complementary sources feed the watch panel:
 *   1. `Page.screencastFrame` — real time, but only fires while the page is
 *      actually repainting (a backgrounded or static page goes quiet), and only
 *      for targets with an open `Page.startScreencast` stream.
 *   2. a periodic `Page.captureScreenshot` — always renders, so a quiet page
 *      still gets a fresh frame. This is the backstop that keeps the panel from
 *      freezing on a page that stops repainting (e.g. a static layout while a
 *      <video> inside it keeps playing without a repaint would otherwise starve
 *      the screencast stream).
 *
 * Runs until `session` stops being current (its socket dropped). frameFor is
 * idempotent for existing casts, so calling it often is cheap; the screenshot
 * backstop is throttled per target by refreshFrame's own 500ms floor.
 *
 * This loop ALSO broadcasts a `spaces` event on every tick (URL/title/active
 * changes), so the watch panel no longer needs to poll /api/spaces. The tick
 * cadence is the panel's metadata freshness bound — every 500ms by default.
 */

// Metadata broadcast throttle. `spaces` events are cheap (no JPEG bytes), but
// we still don't want to flood the SSE pipe on a busy tab churn — coalesce
// back-to-back triggers into a single push within this window.
let spacesBroadcastPending = false;
let spacesBroadcastTimer = null;
const SPACES_BROADCAST_THROTTLE_MS = 250;
/**
 * Schedule a `spaces` event broadcast on the next microtask, coalesced so a
 * flurry of target changes / url updates collapses into a single push.
 * Safe to call from any path (CDP event handler, keepalive tick, etc).
 */
function scheduleSpacesBroadcast() {
  if (spacesBroadcastPending) return;
  spacesBroadcastPending = true;
  spacesBroadcastTimer = setTimeout(() => {
    spacesBroadcastPending = false;
    spacesBroadcastTimer = null;
    if (sseClients.size === 0) return;
    snapshotSpaces().then((snap) => {
      if (sseClients.size > 0) sseBroadcast("spaces", snap);
    }).catch(() => {});
  }, SPACES_BROADCAST_THROTTLE_MS);
}

async function keepCastsAlive(session, intervalMs = 500) {
  while (active === session) {
    try {
      const targets = await listPageTargets(session.cdp);
      const cached = session.pool.cachedFrames?.() ?? new Map();
      const now = Date.now();
      for (const t of targets.slice(0, 30)) {
        if (!session.pool.frameFor) continue;
        await session.pool.frameFor(t.targetId).catch(() => {});
        const meta = cached.get(t.targetId);
        const stale = !meta || (now - (meta.lastActive || 0)) > BACKSTOP_STALE_MS;
        if (!stale) continue;
        const cast = await session.pool.refreshFrame(t.targetId).catch(() => null);
        if (cast?.frame && sseClients.size > 0) {
          sseBroadcast("frame", { targetId: t.targetId, data: cast.frame, ts: Date.now() });
        }
      }
      // Push the current tab list (url/title/active/viewport/humanCheck) so
      // the panel can render its tab bar without polling /api/spaces.
      scheduleSpacesBroadcast();
    } catch {
      // browser call failed; keep trying on the next tick
    }
    await sleep(intervalMs);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


async function main() {
  // Single-instance: kill duplicate workers first, then own the state file, so
  // the port/pid we write below is the ONLY live worker's.
  try { stopSiblingWorkers(); } catch {}
  await cleanStaleCastState();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: !!active });
    if (req.method === "POST" && url.pathname === "/api/config") {
      // Hot-update cast parameters. castFpsCap takes effect immediately (the
      // screencastFrame handler reads castConfig on every frame);
      // screencastQuality / screencastMaxWidth require restarting the running
      // screencast streams (Chrome only honors new params on a fresh
      // startScreencast call).
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const prev = { ...castConfig };
        if (typeof body.castFpsCap === "number" && body.castFpsCap >= 0 && body.castFpsCap <= 60) {
          castConfig.castFpsCap = body.castFpsCap;
        }
        if (typeof body.screencastQuality === "number" && body.screencastQuality >= 1 && body.screencastQuality <= 100) {
          castConfig.screencastQuality = body.screencastQuality;
        }
        if (typeof body.screencastMaxWidth === "number" && body.screencastMaxWidth >= 320 && body.screencastMaxWidth <= 1920) {
          castConfig.screencastMaxWidth = body.screencastMaxWidth;
        }
        // If quality or width changed, restart the running screencast streams
        // so the new params take effect immediately. fpsCap needs no restart.
        const needsRestart = castConfig.screencastQuality !== prev.screencastQuality
          || castConfig.screencastMaxWidth !== prev.screencastMaxWidth;
        if (needsRestart && active?.pool?.restartScreencasts) {
          active.pool.restartScreencasts({
            quality: castConfig.screencastQuality,
            maxWidth: castConfig.screencastMaxWidth,
          }).catch(() => {});
        }
        return sendJson(res, 200, { ok: true, config: castConfig });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }
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
    if (req.method === "POST" && url.pathname === "/api/input") {
      // Forward a watch-panel pointer intention to the real agent page. Body:
      //   { targetId, type, x, y, button, buttons, deltaX, deltaY, clickCount, modifiers }
      // `x`/`y` are already in browser CSS pixels (the panel mapped them).
      const sess = active;
      if (!sess) return sendJson(res, 400, { ok: false, error: "no live browser" });
      let body;
      try { body = JSON.parse((await readBody(req)) || "{}"); }
      catch { return sendJson(res, 400, { ok: false, error: "bad body" }); }
      const { targetId, type, x, y } = body;
      if (!targetId || typeof type !== "string" || !Number.isFinite(x) || !Number.isFinite(y)) {
        return sendJson(res, 400, { ok: false, error: "targetId, type, x, y required" });
      }
      try {
        const result = await sess.pool.sendInput(targetId, body);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/stream") {
      // SSE: the live watch panel. On connect we send the current snapshot for
      // every live page, then push each new screencast frame in real time. The
      // browser-level 'spaces' event lets the panel keep its tab list in sync.
      sseBracket(res);
      sseClients.add(res);
      const onClose = () => { sseClients.delete(res); };
      req.on("close", onClose);
      res.on("close", onClose);
      // Non-blocking initial snapshot: never let the first event wait on a CDP
      // call. Push the current pages in the background; live screencast frames
      // follow on their own cadence in the screencastFrame handler.
      snapshotSpaces().then((snap) => {
        if (!sseClients.has(res)) return;
        sseBroadcast("spaces", snap);
      }).catch(() => {});
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/spaces") {
      // Lightweight metadata endpoint. Used as the initial snapshot when a
      // watch panel's SSE connection comes up, and as a reconnect fallback.
      // Returns ONLY metadata (url/title/active/viewport/humanCheck) — no
      // thumbnail bytes — because the live frames already stream over SSE.
      // This drops a 30-tab response from ~30 × 700ms captureScreenshot calls
      // down to a single Target.getTargets + cachedFrames() map lookup (<50ms).
      const sess = active;
      if (!sess) return sendJson(res, 200, { ok: true, spaces: [] });
      try {
        const snap = await snapshotSpaces();
        return sendJson(res, 200, { ok: true, spaces: snap });
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
    // Persist login state. Chrome flushes cookies to the on-disk profile on a
    // graceful Browser.close; SIGTERM/kill leaves the journal unmerged and the
    // newest logins are lost on restart. So before we detach, if we are attached
    // to a live browser, ask it to close itself gracefully over the browser-level
    // CDP channel — the exact graceful path the vendored runtime uses, matching
    // upstream ego-lite's "the browser persists, not the driver".
    if (active?.cdp) {
      try {
        await active.cdp.call("Browser.close", {}, undefined, 5000);
      } catch { /* best-effort: browser may already be gone */ }
    }
    // Wait a beat for the close to settle so Chrome merges its cookie journal
    // into the Cookies db before we tear down our own socket.
    await new Promise((r) => setTimeout(r, 400));
    // Only remove the state file if it still identifies THIS worker. During the
    // single-instance guard a newer worker kills us right after writing its own
    // ego-cast.json; blindly deleting here would erase the successor's truthful
    // state and leave ensureWorker with a stale/missing file again.
    try {
      const { readFile } = await import("node:fs/promises");
      const rec = JSON.parse(await readFile(CAST_STATE_FILE, "utf8"));
      if (rec.pid === process.pid) rmSync(CAST_STATE_FILE, { force: true });
    } catch { /* absent/unparsable — nothing to clean */ }
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
