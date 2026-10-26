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
import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { EgoContext, RegisterRouteOptions, ResolvedConfig, WebServerLike } from './types.ts'
import type { SettingsBridge } from './settings.ts'
import type { FfmpegInstallationManager } from './ffmpeg-installation.ts'
import type { LoginImportOptions, LoginImportReport } from './login-import.ts'
import {
  createLoginExtensionPairingCode,
  getLoginExtensionHealth,
  getLoginExtensionJob,
  startLoginExtensionJob,
  stopLoginExtensionBridge,
} from './login-extension.ts'

import { captureConfig, isProcessAlive, knownWorkerState, makeEnsureWorker, proxyFrom, proxyPost, type EnsureWorker } from './worker-client.ts'
export { proxyPost } from './worker-client.ts'

type PushConfig = (cfg: ResolvedConfig) => Promise<void>

export const EGO_SPACES_ROUTE = '/api/ego/spaces'
export const EGO_STREAM_ROUTE = '/api/ego/stream'
export const EGO_HEALTH_ROUTE = '/api/ego/health'
export const EGO_CLOSE_ROUTE = '/api/ego/close'
export const EGO_FLUSH_ROUTE = '/api/ego/flush'
export const EGO_RAISE_ROUTE = '/api/ego/raise'
export const EGO_LOGIN_IMPORT_ROUTE = '/api/ego/login-import'
export const EGO_INPUT_ROUTE = '/api/ego/input'
export const EGO_WINDOW_SIZE_ROUTE = '/api/ego/window-size'
export const EGO_WATCH_START_ROUTE = '/api/ego/watch/start'
export const EGO_WATCH_SWITCH_ROUTE = '/api/ego/watch/switch'
export const EGO_WATCH_STOP_ROUTE = '/api/ego/watch/stop'
export const EGO_WATCH_STATUS_ROUTE = '/api/ego/watch/status'
export const EGO_VIDEO_ROUTE = '/api/ego/video'
export const EGO_VIDEO_STATUS_ROUTE = '/api/ego/video/status'

// ── tool-call signal (auto-open sidebar Tab) ─────────────────────────────
// Module-level counter bumped by markEgoToolCall() from the tool execute
// path (src/index.ts: defineEgoTool). When a new tool call lands, we
// broadcast a `tool-call` SSE event to every connected watch-panel client
// so the sidebar auto-opens instantly — NO client-side polling needed.
// (Previously the client polled /api/ego/spaces every 2s to detect this;
//  that loop is now gone.) Process-local; resets to 0 on host restart,
// which is fine — the auto-open is a one-shot per session anyway.
let toolCallCount = 0
const sseClients = new Set<ServerResponse>()

/** Timestamp of the last ego_* tool call — the idle reaper's activity signal. */
let lastEgoActivity = 0
export function getLastEgoActivity(): number {
  return lastEgoActivity
}

export function markEgoToolCall(sessionId?: string): void {
  toolCallCount += 1
  lastEgoActivity = Date.now()
  // Push the new count to every connected SSE client immediately. The event
  // payload carries the counter AND the calling session id (when the caller
  // supplied one): the client scopes its sidebar auto-open to that session, so
  // a background conversation's tool call lands in ITS OWN sidebar instead of
  // the one the user happens to be reading.
  const payload = sessionId === undefined || sessionId === ''
    ? { count: toolCallCount }
    : { count: toolCallCount, sessionId }
  const frame = `event: tool-call\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(frame)
    } catch {
      sseClients.delete(res)
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
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
export function proxyWorkerStream(
  port: number,
  res: ServerResponse,
  path: string,
  retry?: () => Promise<number | null>,
  retryDelayMs = 1500,
): () => void {
  let cancelled = false
  let ended = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let upstream: ClientRequest | null = null
  const endOnce = (): void => {
    if (ended) return
    ended = true
    sseClients.delete(res)
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(':ok\n\n')
  sseClients.add(res)
  // Declared before the retry branch: the late-attach path returns from this
  // function, so anything defined after it would be in the temporal dead zone
  // when the retry callback fires.
  const onClose = (): void => {
    cancelled = true
    sseClients.delete(res)
    try {
      upstream?.destroy()
    } catch {
      /* ignore */
    }
  }
  // No worker to bridge (ensureWorker() returned null): keep the SSE open and
  // quiet so markEgoToolCall() can still push events, but when a `retry`
  // provider is supplied also re-check periodically. The browser may be
  // started AFTER the panel: without this the panel's stream stayed a dead
  // `:ok` forever, so it never received a single frame/spaces event and the
  // sidebar showed "未接管 / 暂无截图" even though the worker was streaming.
  if (!Number.isInteger(port) || port <= 0) {
    res.on('close', () => {
      cancelled = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      sseClients.delete(res)
    })
    if (retry) {
      const attempt = (): void => {
        if (cancelled || ended) return
        retry().then((next) => {
          if (cancelled || ended) return
          if (typeof next === 'number' && next > 0) {
            res.on('close', onClose)
            attach(next)
          } else {
            timer = setTimeout(attempt, Math.max(20, retryDelayMs))
          }
        }).catch(() => {
          if (!cancelled && !ended) timer = setTimeout(attempt, Math.max(20, retryDelayMs))
        })
      }
      timer = setTimeout(attempt, Math.max(20, retryDelayMs))
      return () => {
        cancelled = true
        if (timer !== null) { clearTimeout(timer); timer = null }
        sseClients.delete(res)
      }
    }
    return () => {
      sseClients.delete(res)
    }
  }
  // Use node:http (not fetch) to consume the worker's SSE stream. fetch buffers
  // chunked responses in a way that delays/interleaves the first data chunks
  // under Node's undici, which the real-time frame pipeline cannot tolerate —
  // http.request streams them as they arrive and frames forward immediately.
  function attach(workerPort: number): void {
    upstream = request(
      { host: '127.0.0.1', port: workerPort, path, method: 'GET', headers: { accept: 'text/event-stream' } },
      (upRes: IncomingMessage) => {
        upRes.on('data', (chunk: Buffer) => {
          if (cancelled || ended) return
          try {
            if (!res.write(chunk)) {
              upRes.pause()
              res.once('drain', () => {
                if (!cancelled && !ended) upRes.resume()
              })
            }
          } catch {
            cancelled = true
            endOnce()
          }
        })
        upRes.on('end', endOnce)
        upRes.on('error', endOnce)
      },
    )
    upstream.on('error', endOnce)
    upstream.setTimeout(5000, () => {
      try {
        upstream?.destroy()
      } catch {
        /* ignore */
      }
      endOnce()
    })
    upstream.end()
  }
  // don't end res here; let worker stream close it
  res.on('close', onClose)
  attach(port)
  return () => {
    cancelled = true
    sseClients.delete(res)
    try {
      upstream?.destroy()
    } catch {
      /* ignore */
    }
  }
}

function proxyWorkerVideo(port: number, req: IncomingMessage, res: ServerResponse): void {
  const sourceUrl = new URL(req.url || EGO_VIDEO_ROUTE, 'http://dsh.internal')
  const generation = sourceUrl.searchParams.get('generation')
  const path = `/api/video/stream${generation ? `?generation=${encodeURIComponent(generation)}` : ''}`
  let upstream: ClientRequest
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }
  upstream = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { accept: 'video/mp4' } }, (upRes: IncomingMessage) => {
    res.writeHead(upRes.statusCode || 502, {
      'content-type': upRes.headers['content-type'] || 'application/octet-stream',
      'cache-control': 'no-store',
      ...(upRes.headers['x-ego-generation'] ? { 'x-ego-generation': upRes.headers['x-ego-generation'] } : {}),
      ...(upRes.headers['x-ego-backend'] ? { 'x-ego-backend': upRes.headers['x-ego-backend'] } : {}),
    })
    upRes.on('data', (chunk: Buffer) => {
      if (ended) return
      try {
        if (!res.write(chunk)) {
          upRes.pause()
          res.once('drain', () => {
            if (!ended) upRes.resume()
          })
        }
      } catch {
        upstream.destroy()
        end()
      }
    })
    upRes.on('end', end)
    upRes.on('error', end)
  })
  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'video worker unavailable' })
    else end()
  })
  upstream.setTimeout(5000, () => {
    try {
      upstream.destroy()
    } catch {
      /* ignore */
    }
    if (!res.headersSent) sendJson(res, 504, { ok: false, error: 'video worker timeout' })
    else end()
  })
  upstream.end()
  res.on('close', () => {
    ended = true
    try {
      upstream.destroy()
    } catch {
      /* ignore */
    }
  })
}

async function readJsonBody(req: IncomingMessage, maxBytes = 8192): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error('body too large')
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

/** Reason string every frame-relay route answers with while the relay is off. */
export const FRAME_RELAY_DISABLED = 'frame relay disabled'

/**
 * Stop a running ego-cast worker (SIGTERM). The worker owns the CDP
 * screencast / WGC capture and the ffmpeg pull, so killing it is what actually
 * turns the frame relay off when the setting is flipped while it is running —
 * no HTTP shutdown route exists in bin/ego-cast-worker.mjs (it exits on
 * SIGTERM/SIGINT). A stale ego-cast.json is harmless: ensureWorker() proves the
 * pid is alive before trusting the recorded port.
 */
export async function stopCastWorker(): Promise<boolean> {
  const state = await knownWorkerState()
  if (state.pid === null || !isProcessAlive(state.pid)) return false
  try {
    process.kill(state.pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/**
 * Push the current cast config to a running worker via POST /api/config.
 * Best-effort: if the worker is unreachable or the POST fails, the config
 * will take effect on the next worker spawn (argv seed). Called whenever the
 * settings layer reports a change.
 */
function makePushConfig(ensureWorker: EnsureWorker, ffmpegManager: FfmpegInstallationManager | null): PushConfig {
  let lastPush = ''
  return async function pushConfig(cfg: ResolvedConfig): Promise<void> {
    await ffmpegManager?.check({ configuredPath: cfg.ffmpegPath, requestedEncoder: cfg.ffmpegEncoder }).catch(() => null)
    const port = await ensureWorker()
    if (port === null) return
    const payload = JSON.stringify(captureConfig(cfg, ffmpegManager))
    // Dedupe: don't re-push identical config (settings onChange can fire
    // multiple times for a single logical edit).
    if (payload === lastPush) return
    lastPush = payload
    try {
      const result = await proxyPost(port, '/api/config', JSON.parse(payload))
      if (!result || result.status >= 400) throw new Error('worker config update failed')
    } catch {
      // worker may be mid-restart; the next ensureWorker will re-seed via argv
    }
  }
}

/**
 * Register the watch-panel routes. Call inside plugin apply() with the real
 * ctx; dispose is returned for ctx.effect cleanup.
 *
 * `bridge` is the settings bridge — its `onChange` is used to react to
 * live settings saves and push the new config to a running worker.
 */
export function initCastServer(
  ctx: EgoContext,
  cfg: ResolvedConfig,
  bridge: SettingsBridge,
  ffmpegManager: FfmpegInstallationManager | null,
  openAgentWindow: () => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: false, error: 'raise not supported by this host build' }),
  loginImport: (opts: LoginImportOptions) => Promise<LoginImportReport> = async () => ({ ok: false, error: 'login import not supported by this host build' }),
  getExecutorStatus: () => Record<string, unknown> = () => ({}),
): void {
  const ensureWorker = makeEnsureWorker(ctx, cfg, ffmpegManager)
  const pushConfig = makePushConfig(ensureWorker, ffmpegManager)
  // The web shell exposes `webServer` — the only HTTP host surface the plugin
  // uses. It is NOT a required inject (TUI / headless hosts have none), so we
  // resolve it opportunistically via ctx.get('webServer'); if absent here there
  // is nothing to register, so exit cleanly.
  const rawServer = (ctx as EgoContext).get?.('webServer') as WebServerLike | undefined
  if (!rawServer || typeof rawServer.register !== 'function') {
    return
  }

  // ── trust fence for /api/ego/* ────────────────────────────────────────────
  // Exact-path routes match BEFORE the host's `/api` prefix trust-fence route,
  // so every handler below would otherwise answer unauthenticated requests.
  // The host issues a `dsh-auth-<processKey>` cookie that is HttpOnly AND
  // SameSite=Strict: a cross-site page (CSRF driver-by) never carries it, so
  // requiring its mere presence closes the remote surface. A local process can
  // still forge the header, but that is the same threat tier as the host's own
  // token fence (a local process can read the process token too).
  const isTrustedRequest = (req: IncomingMessage): boolean =>
    /(?:^|;\s*)dsh-auth-[^=]+=/.test(String(req.headers.cookie ?? ''))
  const guardHandler = (handler: NonNullable<RegisterRouteOptions['handler']>) =>
    async (req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      if (!isTrustedRequest(req as IncomingMessage)) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"unauthorized"}')
        return
      }
      return handler(req, res)
    }
  // Scope the guard to THIS plugin's registrations only: never patch the host
  // webServer singleton in place — other plugins' routes registered through the
  // same service instance must keep their own (unguarded) semantics.
  const rawRegister = rawServer.register.bind(rawServer) as (opts: RegisterRouteOptions) => () => void
  const server = Object.assign(Object.create(Object.getPrototypeOf(rawServer)), rawServer, {
    register: (opts: RegisterRouteOptions) => rawRegister({
      ...opts,
      handler: opts.handler ? guardHandler(opts.handler) : opts.handler,
    }),
  })

  // ── frame-relay switch (settings: disableFrameRelay) ──────────────────────
  // When the relay is off the plugin must not spawn the ego-cast worker, must
  // not capture (CDP screencast / WGC) and must not pull ffmpeg, so every
  // worker-backed route answers a plain JSON refusal instead of bridging a
  // stream. The switch is read LIVE on each request (cfg is the plugin's
  // settings-bridge object), so a saved settings change applies immediately.
  // Routes that do NOT use the worker (raise / login-import) stay functional:
  // disabling the frame relay is about the picture, not about the tools.
  const relayDisabled = (): boolean => cfg.disableFrameRelay === true
  const refuseFrameRelay = (res: ServerResponse, extra: Record<string, unknown> = {}): void => {
    sendJson(res, 200, { ok: false, reason: FRAME_RELAY_DISABLED, frameRelay: false, ...extra })
  }
  // NOTE: mounting with the relay already off does NOT hunt down a worker to
  // kill. This host has not started one yet (the worker is only ever spawned by
  // ensureWorker on a request), and an unconditional kill would race with a
  // freshly written ego-cast.json — it could SIGTERM a worker that a newer
  // state file (another DSH instance, or a worker started a moment later)
  // points at. Turning the switch OFF while a worker runs is handled by the
  // onChange path below, which is the case that actually needs stopping.

  // Hot-push config changes to a running worker. The settings bridge fires
  // onChange whenever the user saves a new castFpsCap / screencastQuality /
  // screencastMaxWidth in the settings card.
  if (typeof bridge?.onChange === 'function') {
    const off = bridge.onChange(() => {
      // Relay off: pushing the config would spawn/keep a worker, so stop it
      // instead (idempotent — a dead/absent worker is a no-op). Relay back on:
      // the next request lazily restarts the worker with the current config.
      if (relayDisabled()) {
        void stopCastWorker()
        return
      }
      pushConfig(cfg)
    })
    if (typeof off === 'function') {
      ctx.effect?.(() => () => {
        try {
          off()
        } catch {
          /* ignore */
        }
      })
    }
  }

  const disposeSpaces = server.register({
    kind: 'exact',
    path: EGO_SPACES_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      // Keep the tab-list shape (and the auto-open counter) in the refusal so
      // the client's baseline probe still works while the relay is off.
      if (relayDisabled()) return refuseFrameRelay(res, { spaces: [], toolCallCount })
      const port = await ensureWorker()
      if (port === null) {
        return sendJson(res, 200, { ok: false, spaces: [], toolCallCount, reason: 'no live agent browser', frameRelay: true })
      }
      const data = await proxyFrom(port, '/api/spaces')
      if (!data) return sendJson(res, 200, { ok: false, spaces: [], toolCallCount, reason: 'worker not ready', frameRelay: true })
      // Attach the host-side tool-call counter (the worker doesn't know about
      // tool invocations; only the host's defineEgoTool path does).
      return sendJson(res, 200, { ...(data as Record<string, unknown>), toolCallCount, frameRelay: true })
    },
  })

  // GET /api/ego/stream — Server-Sent Events: real-time screencast frames and
  // the live tab/spaces list. The web shell supports exact HTTP routes and this
  // handler keeps the connection open for the worker->panel fan-out.
  const disposeStream = server.register({
    kind: 'exact',
    path: EGO_STREAM_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      // Relay off: never open an event stream. A plain JSON body with an
      // explicit reason is the answer (no dangling connection, no
      // reconnect-loop ambiguity once the client honors it).
      if (relayDisabled()) return refuseFrameRelay(res)
      const port = await ensureWorker()
      // Pass ensureWorker as the retry provider: if the panel opens before the
      // browser/worker exists (typical right after a DSH restart), the stream
      // must attach once they appear instead of staying a dead `:ok`.
      proxyWorkerStream(port ?? -1, res, '/api/stream', ensureWorker)
    },
  })

  // POST /api/ego/input — forward a watch-panel pointer/wheel intention to the
  // real agent page. Coordinates are already in browser CSS pixels (the panel
  // maps them). The web shell passes the raw body through to the worker.
  const disposeInput = server.register({
    kind: 'exact',
    path: EGO_INPUT_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED })
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      const result = await proxyPost(port, '/api/input', body)
      if (!result) return sendJson(res, 502, { ok: false, error: 'input worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // POST /api/ego/window-size — the watch panel's size-sync toggle drives the
  // REAL agent browser window. The body carries the desired PAGE viewport in
  // CSS px; the worker adds Chrome's frame and calls Browser.setWindowBounds.
  const disposeWindowSize = server.register({
    kind: 'exact',
    path: EGO_WINDOW_SIZE_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED })
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      const width = Number(body.width)
      const delta = Number(body.delta)
      const height = Number(body.height)
      const dy = Number(body.dy)
      const aspect = Number(body.aspect)
      if (!Number.isFinite(width) && !Number.isFinite(delta) && !Number.isFinite(height) && !Number.isFinite(dy) && !Number.isFinite(aspect)) {
        return sendJson(res, 400, { ok: false, error: 'width, delta, height, dy or aspect is required' })
      }
      const result = await proxyPost(port, '/api/window-size', {
        ...(Number.isFinite(width) ? { width } : {}),
        // The panel's toggle sends drag deltas; the worker applies them to the
        // page's current viewport.
        ...(Number.isFinite(delta) ? { delta } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height } : {}),
        ...(Number.isFinite(dy) ? { dy } : {}),
        // Aspect presets keep the current width and derive the height.
        ...(Number.isFinite(aspect) && aspect > 0 ? { aspect } : {}),
        ...(typeof body.targetId === 'string' && body.targetId ? { targetId: body.targetId } : {}),
      })
      if (!result) return sendJson(res, 502, { ok: false, error: 'window-size worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // POST /api/ego/close — close a browser tab by targetId.
  const disposeClose = server.register({
    kind: 'exact',
    path: EGO_CLOSE_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED })
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      // Collect the request body (small JSON: { targetId }).
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      const targetId = typeof body.targetId === 'string' ? body.targetId : ''
      if (!targetId) return sendJson(res, 400, { ok: false, error: 'targetId required' })
      const result = await proxyPost(port, '/api/close', { targetId })
      if (!result) return sendJson(res, 502, { ok: false, error: 'close worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // POST /api/ego/flush — force login cookies down to the disk profile.
  const disposeFlush = server.register({
    kind: 'exact',
    path: EGO_FLUSH_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED })
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 400, { ok: false, error: 'no live agent browser' })
      const result = await proxyPost(port, '/api/flush', {})
      if (!result) return sendJson(res, 502, { ok: false, error: 'flush worker unavailable' })
      return sendJson(res, result.status, result.body)
    },
  })

  // POST /api/ego/raise — pop the agent browser out as a REAL visible window
  // (issue #51): when the backing browser runs headless, the runtime's
  // `ego-browser --open` replaces it with a headed instance on the SAME
  // profile (tabs restore); when it is already visible, --open just raises
  // the window. The actual spawn is injected by the host plugin (it owns
  // egoBin + the env resolution).
  const disposeRaise = server.register({
    kind: 'exact',
    path: EGO_RAISE_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      try {
        const result = await openAgentWindow()
        return sendJson(res, result.ok ? 200 : 500, result)
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) })
      }
    },
  })

  // POST /api/ego/login-import — the settings card's entry point for the
  // login-cookie importer (issue #46). The heavy lifting (system browser
  // probe, ABE-safe CDP read, write into the agent browser) is injected by
  // the host plugin; the body mirrors ego_login_import's arguments.
  const disposeLoginImport = server.register({
    kind: 'exact',
    path: EGO_LOGIN_IMPORT_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      try {
        const result = await loginImport({
          source: (['chrome', 'edge', 'brave', 'auto'].includes(String(body.source)) ? String(body.source) : 'auto') as LoginImportOptions['source'],
          domains: Array.isArray(body.domains) ? (body.domains as unknown[]).map(String) : undefined,
          profile: typeof body.profile === 'string' && body.profile !== '' ? body.profile : undefined,
          closeSource: body.closeSource === true,
          dryRun: body.dryRun === true,
        })
        return sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) })
      }
    },
  })

  const disposeHealth = server.register({
    kind: 'exact',
    path: EGO_HEALTH_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED })
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 200, { ok: false })
      const h = await proxyFrom(port, '/api/health')
      return sendJson(res, 200, h || { ok: false })
    },
  })

  const watchRoutes: (() => void)[] = [
    [EGO_WATCH_START_ROUTE, '/api/watch/start'],
    [EGO_WATCH_SWITCH_ROUTE, '/api/watch/switch'],
    [EGO_WATCH_STOP_ROUTE, '/api/watch/stop'],
  ].map(([path, workerPath]) => server.register!({
    kind: 'exact', path,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED, state: 'disabled' })
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 409, { ok: false, error: 'worker not ready' })
      const timeoutMs = workerPath === '/api/watch/start' || workerPath === '/api/watch/switch' ? 30000 : 4000
      const result = await proxyPost(port, workerPath, await readJsonBody(req).catch(() => ({})), timeoutMs)
      return result
        ? sendJson(res, result.status, result.body)
        : sendJson(res, 502, { ok: false, error: 'worker request failed' })
    },
  }))
  const disposeWatchStatus = server.register({
    kind: 'exact', path: EGO_WATCH_STATUS_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      // The client calls this right before opening the SSE stream; the
      // `frameRelay: false` flag is what makes it skip the connection entirely.
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED, state: 'disabled' })
      const port = await ensureWorker()
      const result = port === null ? null : await proxyFrom(port, '/api/watch/status')
      return sendJson(res, 200, { ...(result || { ok: false, state: 'idle', reason: 'worker not ready' }), frameRelay: true })
    },
  })
  const disposeVideoStatus = server.register({
    kind: 'exact', path: EGO_VIDEO_STATUS_ROUTE,
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      if (relayDisabled()) return refuseFrameRelay(res, { error: FRAME_RELAY_DISABLED, state: 'disabled' })
      const port = await ensureWorker()
      const result = port === null ? null : await proxyFrom(port, '/api/video/status')
      return sendJson(res, 200, result || { ok: false, state: 'idle', reason: 'worker not ready' })
    },
  })
  const disposeVideo = server.register({
    kind: 'exact', path: EGO_VIDEO_ROUTE,
    handler: async (reqRaw: unknown, resRaw: unknown) => {
      const req = reqRaw as IncomingMessage
      const res = resRaw as ServerResponse
      // Never start the ffmpeg pull / fMP4 bridge while the relay is off.
      if (relayDisabled()) return refuseFrameRelay(res)
      const port = await ensureWorker()
      if (port === null) return sendJson(res, 502, { ok: false, error: 'worker not ready' })
      proxyWorkerVideo(port, req, res)
    },
  })

  // GET /api/ego/executor — resident // one-shot executor diagnostics (#73).
  // Host-level state only (no worker), so it works even before the browser is up.
  const disposeExecutor = server.register({
    kind: 'exact', path: '/api/ego/executor',
    handler: async (_req: unknown, resRaw: unknown) => {
      const res = resRaw as ServerResponse
      let status: Record<string, unknown> = {}
      try { status = getExecutorStatus() } catch { /* ignore */ }
      return sendJson(res, 200, { ok: true, ...status })
    },
  })

  // #69 v2 — one-click login-state bridge for the panel: pairing code, health
  // and job status. The extension itself talks to the loopback server in
  // login-extension.ts; these routes are for the in-panel UI.
  const disposeLoginBridge = [
    server.register({
      kind: 'exact', path: '/api/ego/login-extension/health',
      handler: async (_req: unknown, resRaw: unknown) => {
        const res = resRaw as ServerResponse
        try { return sendJson(res, 200, await getLoginExtensionHealth()) }
        catch (err) { return sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) }) }
      },
    }),
    server.register({
      kind: 'exact', path: '/api/ego/login-extension/pair-code',
      handler: async (_req: unknown, resRaw: unknown) => {
        const res = resRaw as ServerResponse
        try { return sendJson(res, 200, await createLoginExtensionPairingCode()) }
        catch (err) { return sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) }) }
      },
    }),
    server.register({
      kind: 'exact', path: '/api/ego/login-extension/import',
      handler: async (reqRaw: unknown, resRaw: unknown) => {
        const req = reqRaw as IncomingMessage
        const res = resRaw as ServerResponse
        try {
          const body = (await readJsonBody(req).catch(() => ({}))) as { domains?: unknown }
          const domains = Array.isArray(body.domains) ? body.domains.map(String).filter(Boolean) : []
          if (domains.length === 0) return sendJson(res, 400, { ok: false, error: 'domains is required' })
          const job = await startLoginExtensionJob({ domains })
          return sendJson(res, 200, { ok: true, jobId: job.jobId })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) })
        }
      },
    }),
    server.register({
      kind: 'exact', path: '/api/ego/login-extension/status',
      handler: async (reqRaw: unknown, resRaw: unknown) => {
        const req = reqRaw as IncomingMessage
        const res = resRaw as ServerResponse
        try {
          const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? ''
          if (!id) return sendJson(res, 400, { ok: false, error: 'id is required' })
          return sendJson(res, 200, await getLoginExtensionJob(id))
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) })
        }
      },
    }),
  ]

  ctx.effect?.(() => () => {
    try { disposeSpaces() } catch { /* ignore */ }
    try { disposeStream() } catch { /* ignore */ }
    try { disposeInput() } catch { /* ignore */ }
    try { disposeWindowSize() } catch { /* ignore */ }
    try { disposeExecutor() } catch { /* ignore */ }
    try { disposeLoginBridge.forEach((dispose) => dispose()) } catch { /* ignore */ }
    try { stopLoginExtensionBridge() } catch { /* ignore */ }
    try { disposeClose() } catch { /* ignore */ }
    try { disposeFlush() } catch { /* ignore */ }
    try { disposeRaise() } catch { /* ignore */ }
    try { disposeLoginImport() } catch { /* ignore */ }
    try { disposeHealth() } catch { /* ignore */ }
    for (const dispose of watchRoutes) try { dispose() } catch { /* ignore */ }
    try { disposeWatchStatus() } catch { /* ignore */ }
    try { disposeVideoStatus() } catch { /* ignore */ }
    try { disposeVideo() } catch { /* ignore */ }
  })
}
