/**
 * ego-browser cast-server — host half of the realtime watch panel.
 *
 * Bridges the client UI (/api/ego/*) to the ego-cast worker
 * (bin/ego-cast-worker.mjs) that attaches to the agent's live browser and
 * streams screencast JPEGs. Everything the agent's own browser does is pushed;
 * this host route only *reads* the worker's loopback JSON. No navigation, no
 * writes, no host env changes — consistent with the plugin's read-only stance.
 *
 * Lifecycle: the worker is launched lazily (only once), on the first request,
 * when a live agent browser is expected. If no browser.json exists yet it
 * exits cleanly; we surface an empty spaces list so the panel says
 * "no live browser right now" instead of erroring.
 */
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const WORKER_BIN = fileURLToPath(new URL('../bin/ego-cast-worker.mjs', import.meta.url));

export const EGO_SPACES_ROUTE = '/api/ego/spaces';
export const EGO_STREAM_ROUTE = '/api/ego/stream';
export const EGO_HEALTH_ROUTE = '/api/ego/health';
export const EGO_CLOSE_ROUTE = '/api/ego/close';
export const EGO_FLUSH_ROUTE = '/api/ego/flush';
export const EGO_INPUT_ROUTE = '/api/ego/input';
export const EGO_WATCH_START_ROUTE = '/api/ego/watch/start';
export const EGO_WATCH_SWITCH_ROUTE = '/api/ego/watch/switch';
export const EGO_WATCH_STOP_ROUTE = '/api/ego/watch/stop';
export const EGO_WATCH_STATUS_ROUTE = '/api/ego/watch/status';
export const EGO_VIDEO_ROUTE = '/api/ego/video';
export const EGO_VIDEO_STATUS_ROUTE = '/api/ego/video/status';

// ── tool-call signal (auto-open sidebar Tab) ─────────────────────────────
// Module-level counter bumped by markEgoToolCall() from the tool execute
// path (lib/index.js: defineEgoTool). When a new tool call lands, we
// broadcast a `tool-call` SSE event to every connected watch-panel client
// so the sidebar auto-opens instantly — NO client-side polling needed.
// (Previously the client polled /api/ego/spaces every 2s to detect this;
//  that loop is now gone.) Process-local; resets to 0 on host restart,
// which is fine — the auto-open is a one-shot per session anyway.
let toolCallCount = 0;
const sseClients = new Set();
export function markEgoToolCall() {
  toolCallCount += 1;
  // Push the new count to every connected SSE client immediately. The event
  // payload is tiny (just the counter); frames and spaces events continue
  // to flow from the worker as before.
  const frame = `event: tool-call\ndata: ${JSON.stringify({ count: toolCallCount })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

function castStatePath() {
  // Mirror the ego-lite runtime state dir across platforms so we find the
  // worker's ego-cast.json wherever it ran: Windows uses
  // %LOCALAPPDATA%\ego-lite-linux; POSIX uses $XDG_STATE_HOME (default
  // ~/.local/state)/ego-lite-linux. Honors EGO_LINUX_STATE_DIR overrides.
  const e = process.env;
  const isWin = process.platform === 'win32';
  const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || '' : '/root');
  const stateHome = e.EGO_LINUX_STATE_DIR || (isWin
    ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`)
    : (e.XDG_STATE_HOME || `${home}/.local/state`));
  return stateHome.endsWith('ego-lite-linux')
    ? `${stateHome}/ego-cast.json`
    : `${stateHome}/ego-lite-linux/ego-cast.json`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Proxy a worker loopback endpoint. Returns null when the worker is unreachable. */
async function proxyFrom(port, path) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Proxy a POST with a JSON body to the worker. Returns status and body, or null when unreachable. */
export async function proxyPost(port, path, body, timeoutMs = 4000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, body: await r.json().catch(() => ({ ok: false, error: `worker returned ${r.status}` })) };
  } catch {
    return null;
  }
}

/**
 * Bridge the worker's SSE stream to the DSH watch panel.
 *
 * The host's webServer calls this as a plain HTTP handler and then returns, so
 * we write the `text/event-stream` headers, start consuming the worker's
 * /api/stream body, and forward every SSE line verbatim onto `res` from a
 * background loop. The connection stays open until the worker stream ends or
 * the client disconnects. If the worker is unreachable we still emit a valid
 * empty SSE stream (the panel stays quiet instead of erroring).
 *
 * Each `res` is also registered in the module-level `sseClients` set so
 * markEgoToolCall() can inject `tool-call` events directly into the live
 * stream (the sidebar auto-open signal), without the client polling.
 */
function proxyWorkerStream(port, res, path) {
  let cancelled = false;
  let ended = false;
  const endOnce = () => { if (ended) return; ended = true; sseClients.delete(res); try { res.end(); } catch {} };
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(':ok\n\n');
  sseClients.add(res);
  // Use node:http (not fetch) to consume the worker's SSE stream. fetch buffers
  // chunked responses in a way that delays/interleaves the first data chunks
  // under Node's undici, which the real-time frame pipeline cannot tolerate —
  // http.request streams them as they arrive and frames forward immediately.
  const up = request(
    { host: '127.0.0.1', port, path, method: 'GET', headers: { accept: 'text/event-stream' } },
    (upRes) => {
      upRes.on('data', (chunk) => {
        if (cancelled || ended) return;
        try {
          if (!res.write(chunk)) {
            upRes.pause();
            res.once('drain', () => { if (!cancelled && !ended) upRes.resume(); });
          }
        } catch { cancelled = true; endOnce(); }
      });
      upRes.on('end', endOnce);
      upRes.on('error', endOnce);
    }
  );
  up.on('error', endOnce);
  up.setTimeout(5000, () => { try { up.destroy(); } catch {} endOnce(); });
  up.end();
  const onClose = () => { cancelled = true; sseClients.delete(res); try { up.destroy(); } catch {} }; // don't end res here; let worker stream close it
  res.on('close', onClose);
  return () => { cancelled = true; sseClients.delete(res); try { up.destroy(); } catch {} };
}

function proxyWorkerVideo(port, req, res) {
  const sourceUrl = new URL(req.url || EGO_VIDEO_ROUTE, 'http://dsh.internal');
  const generation = sourceUrl.searchParams.get('generation');
  const path = `/api/video/stream${generation ? `?generation=${encodeURIComponent(generation)}` : ''}`;
  let upstream;
  let ended = false;
  const end = () => { if (ended) return; ended = true; try { res.end(); } catch {} };
  upstream = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { accept: 'video/mp4' } }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, {
      'content-type': upRes.headers['content-type'] || 'application/octet-stream',
      'cache-control': 'no-store',
      ...(upRes.headers['x-ego-generation'] ? { 'x-ego-generation': upRes.headers['x-ego-generation'] } : {}),
      ...(upRes.headers['x-ego-backend'] ? { 'x-ego-backend': upRes.headers['x-ego-backend'] } : {}),
    });
    upRes.on('data', (chunk) => {
      if (ended) return;
      try {
        if (!res.write(chunk)) {
          upRes.pause();
          res.once('drain', () => { if (!ended) upRes.resume(); });
        }
      } catch { upstream.destroy(); end(); }
    });
    upRes.on('end', end);
    upRes.on('error', end);
  });
  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'video worker unavailable' });
    else end();
  });
  upstream.setTimeout(5000, () => {
    try { upstream.destroy(); } catch {}
    if (!res.headersSent) sendJson(res, 504, { ok: false, error: 'video worker timeout' });
    else end();
  });
  upstream.end();
  res.on('close', () => { ended = true; try { upstream.destroy(); } catch {} });
}

async function readJsonBody(req, maxBytes = 8192) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('body too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Read the worker's { port, pid } from ego-cast.json, if any. */
async function knownWorkerState() {
  try {
    const { readFile } = await import('node:fs/promises');
    const state = JSON.parse(await readFile(castStatePath(), 'utf8'));
    return {
      port: typeof state.port === 'number' ? state.port : null,
      pid: typeof state.pid === 'number' ? state.pid : null,
    };
  } catch {
    return { port: null, pid: null };
  }
}

/** Is a process with this pid alive? (false for our own / empty / signals fail) */
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence probe, no side effect
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // exists but not ours to signal
  }
}

/**
 * Ensure a single ego-cast worker is running (idempotent). Launches it via
 * ctx.subprocess. Re-spawns whenever the previous worker is found dead (its
 * pid no longer alive or its /api/health does not answer), so a crashed
 * worker is brought back without a host restart. Spawn is rate-limited to
 * avoid hot-looping while a headless container has no browser yet.
 *
 * `cfg` is the live config source (getters for castFpsCap /
 * screencastQuality / screencastMaxWidth). On spawn, the current values are
 * passed to the worker via argv as a JSON string; the worker reads them as
 * initial screencast parameters. Subsequent config edits are pushed to a
 * running worker via POST /api/config (see pushConfig below).
 */
function makeEnsureWorker(ctx, cfg) {
  let lastAttempt = 0;
  async function launchedWorkerPort() {
    const state = await knownWorkerState();
    if (state.pid === null || !isProcessAlive(state.pid)) return null;
    const alive = await proxyFrom(state.port, '/api/health');
    return alive ? state.port : null;
  }
  return async function ensureWorker() {
    const running = await launchedWorkerPort();
    if (running !== null) return running;
    // Worker is dead or not yet up; spawn one, rate-limited.
    const now = Date.now();
    if (now - lastAttempt > 8000) {
      lastAttempt = now;
      try {
        // Pass the current cast config to the worker as a JSON argv arg so it
        // starts with the right screencast parameters without needing an
        // extra round-trip POST. The worker reads process.argv[2].
        const initCfg = JSON.stringify(captureConfig(cfg));
        const handle = ctx.subprocess.spawn({
          argv: [process.execPath, WORKER_BIN, initCfg],
          stdio: {
            stdin: { data: '' },
            stdout: { maxBytes: 8192 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: 12_000,
        });
        handle.done.catch(() => null);
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const ready = await launchedWorkerPort();
          if (ready !== null) return ready;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      } catch {
        return null;
      }
    }
    return null;
  };
}

/**
 * Push the current cast config to a running worker via POST /api/config.
 * Best-effort: if the worker is unreachable or the POST fails, the config
 * will take effect on the next worker spawn (argv seed). Called whenever the
 * settings layer reports a change.
 */
function makePushConfig(ensureWorker) {
  let lastPush = '';
  return async function pushConfig(cfg) {
    const port = await ensureWorker();
    if (port === null) return;
    const payload = JSON.stringify(captureConfig(cfg));
    // Dedupe: don't re-push identical config (settings onChange can fire
    // multiple times for a single logical edit).
    if (payload === lastPush) return;
    lastPush = payload;
    try {
      const result = await proxyPost(port, '/api/config', JSON.parse(payload));
      if (!result || result.status >= 400) throw new Error('worker config update failed');
    } catch {
      // worker may be mid-restart; the next ensureWorker will re-seed via argv
    }
  };
}

function captureConfig(cfg) {
  return {
    captureBackend: cfg.captureBackend,
    streamProfile: cfg.streamProfile,
    cdpFps: cfg.cdpFps,
    cdpQuality: cfg.cdpQuality,
    cdpMaxWidth: cfg.cdpMaxWidth,
    cdpBackstopIntervalMs: cfg.cdpBackstopIntervalMs,
    ffmpegFps: cfg.ffmpegFps,
    ffmpegMaxWidth: cfg.ffmpegMaxWidth,
    ffmpegBitrateKbps: cfg.ffmpegBitrateKbps,
    ffmpegEncoder: cfg.ffmpegEncoder,
    ffmpegPath: cfg.ffmpegPath,
  };
}

/**
 * Register the watch-panel routes. Call inside plugin apply() with the real
 * ctx; dispose is returned for ctx.effect cleanup.
 *
 * `cfg` is the live config source (getters for castFpsCap /
 * screencastQuality / screencastMaxWidth). The worker is spawned with the
 * current values as an argv seed; subsequent edits are hot-pushed via
 * POST /api/config (see makePushConfig).
 *
 * `bridge` is the settings bridge — its `onChange` is used to react to
 * live settings saves and push the new config to a running worker.
 */
export function initCastServer(ctx, cfg, bridge) {
  const ensureWorker = makeEnsureWorker(ctx, cfg);
  const pushConfig = makePushConfig(ensureWorker);
  // The web shell exposes `webServer` (the only HTTP host surface the plugin
  // declares in inject). We deliberately reach for `webServer` alone: touching
  // an undeclared `httpServer` on a strict-inject host would trip the
  // `cannot get property without inject` guard. If webServer is absent here
  // (headless / non-Web runner) there is nothing to register, so exit cleanly.
  const server = ctx.webServer;
  if (!server || typeof server.register !== 'function') {
    return;
  }

  // Hot-push config changes to a running worker. The settings bridge fires
  // onChange whenever the user saves a new castFpsCap / screencastQuality /
  // screencastMaxWidth in the settings card.
  if (typeof bridge?.onChange === 'function') {
    const off = bridge.onChange(() => { pushConfig(cfg); });
    if (typeof off === 'function') {
      ctx.effect?.(() => () => { try { off() } catch {} });
    }
  }

  const disposeSpaces = server.register({
    kind: 'exact',
    path: EGO_SPACES_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      if (port === null) {
        return sendJson(res, 200, { ok: false, spaces: [], toolCallCount, reason: 'no live agent browser' });
      }
      const data = await proxyFrom(port, '/api/spaces');
      if (!data) return sendJson(res, 200, { ok: false, spaces: [], toolCallCount, reason: 'worker not ready' });
      // Attach the host-side tool-call counter (the worker doesn't know about
      // tool invocations; only the host's defineEgoTool path does).
      return sendJson(res, 200, { ...data, toolCallCount });
    },
  });

  // GET /api/ego/stream — Server-Sent Events: real-time screencast frames and
  // the live tab/spaces list. The web shell supports exact HTTP routes and this
  // handler keeps the connection open for the worker->panel fan-out.
  const disposeStream = server.register({
    kind: 'exact',
    path: EGO_STREAM_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      if (port === null) {
        return proxyWorkerStream(-1, res, '/api/stream');
      }
      proxyWorkerStream(port, res, '/api/stream');
    },
  });

  // POST /api/ego/input — forward a watch-panel pointer/wheel intention to the
  // real agent page. Coordinates are already in browser CSS pixels (the panel
  // maps them). The web shell passes the raw body through to the worker.
  const disposeInput = server.register({
    kind: 'exact',
    path: EGO_INPUT_ROUTE,
    handler: async (req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' });
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await proxyPost(port, '/api/input', body);
      if (!result) return sendJson(res, 502, { ok: false, error: 'input worker unavailable' });
      return sendJson(res, result.status, result.body);
    },
  });

  // POST /api/ego/close — close a browser tab by targetId.
  const disposeClose = server.register({
    kind: 'exact',
    path: EGO_CLOSE_ROUTE,
    handler: async (req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' });
      // Collect the request body (small JSON: { targetId }).
      const body = await readJsonBody(req).catch(() => ({}));
      const targetId = typeof body.targetId === 'string' ? body.targetId : '';
      if (!targetId) return sendJson(res, 400, { ok: false, error: 'targetId required' });
      const result = await proxyPost(port, '/api/close', { targetId });
      if (!result) return sendJson(res, 502, { ok: false, error: 'close worker unavailable' });
      return sendJson(res, result.status, result.body);
    },
  });

  // POST /api/ego/flush — force login cookies down to the disk profile.
  const disposeFlush = server.register({
    kind: 'exact',
    path: EGO_FLUSH_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' });
      const result = await proxyPost(port, '/api/flush', {});
      if (!result) return sendJson(res, 502, { ok: false, error: 'flush worker unavailable' });
      return sendJson(res, result.status, result.body);
    },
  });

  const disposeHealth = server.register({
    kind: 'exact',
    path: EGO_HEALTH_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 200, { ok: false });
      const h = await proxyFrom(port, '/api/health');
      return sendJson(res, 200, h || { ok: false });
    },
  });

  const watchRoutes = [
    [EGO_WATCH_START_ROUTE, '/api/watch/start'],
    [EGO_WATCH_SWITCH_ROUTE, '/api/watch/switch'],
    [EGO_WATCH_STOP_ROUTE, '/api/watch/stop'],
  ].map(([path, workerPath]) => server.register({
    kind: 'exact', path,
    handler: async (req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 409, { ok: false, error: 'worker not ready' });
       const timeoutMs = workerPath === '/api/watch/start' || workerPath === '/api/watch/switch' ? 30000 : 4000;
       const result = await proxyPost(port, workerPath, await readJsonBody(req).catch(() => ({})), timeoutMs);
       return result
         ? sendJson(res, result.status, result.body)
         : sendJson(res, 502, { ok: false, error: 'worker request failed' });
    },
  }));
  const disposeWatchStatus = server.register({
    kind: 'exact', path: EGO_WATCH_STATUS_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      const result = port === null ? null : await proxyFrom(port, '/api/watch/status');
      return sendJson(res, 200, result || { ok: false, state: 'idle', reason: 'worker not ready' });
    },
  });
  const disposeVideoStatus = server.register({
    kind: 'exact', path: EGO_VIDEO_STATUS_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      const result = port === null ? null : await proxyFrom(port, '/api/video/status');
      return sendJson(res, 200, result || { ok: false, state: 'idle', reason: 'worker not ready' });
    },
  });
  const disposeVideo = server.register({
    kind: 'exact', path: EGO_VIDEO_ROUTE,
    handler: async (req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 502, { ok: false, error: 'worker not ready' });
      proxyWorkerVideo(port, req, res);
    },
  });

  ctx.effect(() => () => {
    try { disposeSpaces() } catch {}
    try { disposeStream() } catch {}
    try { disposeInput() } catch {}
    try { disposeClose() } catch {}
    try { disposeFlush() } catch {}
    try { disposeHealth() } catch {}
    for (const dispose of watchRoutes) try { dispose() } catch {}
    try { disposeWatchStatus() } catch {}
    try { disposeVideoStatus() } catch {}
    try { disposeVideo() } catch {}
  });
}
