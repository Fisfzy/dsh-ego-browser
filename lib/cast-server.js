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

const WORKER_BIN = fileURLToPath(new URL('../bin/ego-cast-worker.mjs', import.meta.url));

export const EGO_SPACES_ROUTE = '/api/ego/spaces';
export const EGO_HEALTH_ROUTE = '/api/ego/health';
export const EGO_CLOSE_ROUTE = '/api/ego/close';
export const EGO_FLUSH_ROUTE = '/api/ego/flush';

function castStatePath() {
  const home = process.env.HOME || '/root';
  const stateDir = process.env.XDG_STATE_HOME || `${home}/.local/state`;
  return `${stateDir}/ego-lite-linux/ego-cast.json`;
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

/** Proxy a POST with a JSON body to the worker. Returns null on failure. */
async function proxyPost(port, path, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
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
 */
function makeEnsureWorker(ctx) {
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
        const handle = ctx.subprocess.spawn({
          argv: [process.execPath, WORKER_BIN],
          stdio: {
            stdin: { data: '' },
            stdout: { maxBytes: 8192 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: 12_000,
        });
        const done = handle.done.then(() => launchedWorkerPort()).catch(() => null);
        return await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 8000))]);
      } catch {
        return null;
      }
    }
    return null;
  };
}

/**
 * Register the watch-panel routes. Call inside plugin apply() with the real
 * ctx; dispose is returned for ctx.effect cleanup.
 */
export function initCastServer(ctx) {
  const ensureWorker = makeEnsureWorker(ctx);

  const disposeSpaces = ctx.httpServer.register({
    kind: 'exact',
    path: EGO_SPACES_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      if (port === null) {
        return sendJson(res, 200, { ok: false, spaces: [], reason: 'no live agent browser' });
      }
      const data = await proxyFrom(port, '/api/spaces');
      if (!data) return sendJson(res, 200, { ok: false, spaces: [], reason: 'worker not ready' });
      return sendJson(res, 200, data);
    },
  });

  // POST /api/ego/close — close a browser tab by targetId.
  const disposeClose = ctx.httpServer.register({
    kind: 'exact',
    path: EGO_CLOSE_ROUTE,
    handler: async (req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' });
      // Collect the request body (small JSON: { targetId }).
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } });
        req.on('error', () => resolve({}));
      });
      const targetId = typeof body.targetId === 'string' ? body.targetId : '';
      if (!targetId) return sendJson(res, 400, { ok: false, error: 'targetId required' });
      const result = await proxyPost(port, '/api/close', { targetId });
      if (!result) return sendJson(res, 500, { ok: false, error: 'worker close failed' });
      return sendJson(res, 200, result);
    },
  });

  // POST /api/ego/flush — force login cookies down to the disk profile.
  const disposeFlush = ctx.httpServer.register({
    kind: 'exact',
    path: EGO_FLUSH_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' });
      const result = await proxyPost(port, '/api/flush', {});
      if (!result) return sendJson(res, 500, { ok: false, error: 'worker flush failed' });
      return sendJson(res, 200, result);
    },
  });

  const disposeHealth = ctx.httpServer.register({
    kind: 'exact',
    path: EGO_HEALTH_ROUTE,
    handler: async (_req, res) => {
      const port = await ensureWorker();
      if (port === null) return sendJson(res, 200, { ok: false });
      const h = await proxyFrom(port, '/api/health');
      return sendJson(res, 200, h || { ok: false });
    },
  });

  ctx.effect(() => () => {
    try { disposeSpaces() } catch {}
    try { disposeClose() } catch {}
    try { disposeFlush() } catch {}
    try { disposeHealth() } catch {}
  });
}
