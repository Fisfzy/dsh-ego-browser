/** Shared lazy worker client. Importing this module performs no I/O. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { EgoContext, ResolvedConfig } from './types.ts'
import type { FfmpegInstallationManager, FfmpegStatus } from './ffmpeg-installation.ts'
import { resolveEgoStateDir } from './login-import.ts'

const WORKER_BIN = fileURLToPath(new URL('../bin/ego-cast-worker.mjs', import.meta.url))

function castStatePath(): string {
  // Mirror the ego-lite runtime state dir across platforms so we find the
  // worker's ego-cast.json wherever it ran: Windows uses
  // %LOCALAPPDATA%\ego-lite-linux; POSIX uses $XDG_STATE_HOME (default
  // ~/.local/state)/ego-lite-linux. Honors EGO_LINUX_STATE_DIR overrides.
  const e = process.env
  const isWin = process.platform === 'win32'
  const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || '' : '/root')
  const stateHome = e.EGO_LINUX_STATE_DIR || (isWin
    ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`)
    : (e.XDG_STATE_HOME || `${home}/.local/state`))
  return stateHome.endsWith('ego-lite-linux')
    ? `${stateHome}/ego-cast.json`
    : `${stateHome}/ego-lite-linux/ego-cast.json`
}

/** Proxy a worker loopback endpoint. Returns null when the worker is unreachable. */
export async function proxyFrom(port: number, path: string): Promise<unknown> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export interface ProxyPostResult {
  status: number
  body: unknown
}

/** Proxy a POST with a JSON body to the worker. Returns status and body, or null when unreachable. */
export async function proxyPost(port: number, path: string, body: unknown, timeoutMs = 4000): Promise<ProxyPostResult | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: r.status, body: await r.json().catch(() => ({ ok: false, error: `worker returned ${r.status}` })) }
  } catch {
    return null
  }
}

export interface WorkerState {
  port: number | null
  pid: number | null
}

/** Read the worker's { port, pid } from ego-cast.json, if any. */
export async function knownWorkerState(): Promise<WorkerState> {
  try {
    const { readFile } = await import('node:fs/promises')
    const state = JSON.parse(await readFile(castStatePath(), 'utf8')) as { port?: unknown; pid?: unknown }
    return {
      port: typeof state.port === 'number' ? state.port : null,
      pid: typeof state.pid === 'number' ? state.pid : null,
    }
  } catch {
    return { port: null, pid: null }
  }
}

/** Is a process with this pid alive? (false for our own / empty / signals fail) */
export function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0) // signal 0 = existence probe, no side effect
    return true
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return e && e.code === 'EPERM' // exists but not ours to signal
  }
}

interface CaptureConfigPayload {
  captureBackend: ResolvedConfig['captureBackend']
  ffmpegFallbackReason: string
  streamProfile: ResolvedConfig['streamProfile']
  cdpFps: number
  cdpQuality: number
  cdpMaxWidth: number
  cdpBackstopIntervalMs: number
  ffmpegFps: number
  ffmpegMaxWidth: number
  ffmpegBitrateKbps: number
  ffmpegEncoder: ResolvedConfig['ffmpegEncoder']
  ffmpegPath: string
  ffmpegResolvedPath: string
}

export function captureConfig(cfg: ResolvedConfig, ffmpegManager: FfmpegInstallationManager | null): CaptureConfigPayload {
  const ffmpegStatus: FfmpegStatus | undefined = ffmpegManager?.status()
  const unavailable = cfg.captureBackend === 'ffmpeg' && !ffmpegStatus?.canSelectFfmpeg
  return {
    captureBackend: unavailable ? 'cdp' : cfg.captureBackend,
    ffmpegFallbackReason: unavailable ? (ffmpegStatus?.reason || 'FFmpeg is unavailable') : '',
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
    ffmpegResolvedPath: ffmpegStatus?.canSelectFfmpeg ? (ffmpegStatus.path || '') : '',
  }
}

export type EnsureWorker = () => Promise<number | null>

/**
 * Ensure a single ego-cast worker is running (idempotent). Launches it via
 * ctx.subprocess. Re-spawns whenever the previous worker is found dead (its
 * pid no longer alive or its /api/health does not answer), so a crashed
 * worker is brought back without a host restart. Spawn is rate-limited to
 * avoid hot-looping while a headless container has no browser yet.
 */
export function makeEnsureWorker(ctx: EgoContext, cfg: ResolvedConfig, ffmpegManager: FfmpegInstallationManager | null): EnsureWorker {
  let lastAttempt = 0
  async function launchedWorkerPort(): Promise<number | null> {
    const state = await knownWorkerState()
    if (state.pid === null || !isProcessAlive(state.pid)) return null
    const alive = await proxyFrom(state.port!, '/api/health')
    return alive ? state.port : null
  }
  return async function ensureWorker(): Promise<number | null> {
    const running = await launchedWorkerPort()
    if (running !== null) return running
    // Worker is dead or not yet up; spawn one, rate-limited.
    const now = Date.now()
    if (now - lastAttempt > 8000) {
      lastAttempt = now
      try {
        // Pass the current cast config to the worker as a JSON argv arg so it
        // starts with the right screencast parameters without needing an
        // extra round-trip POST. The worker reads process.argv[2].
        await ffmpegManager?.check({ configuredPath: cfg.ffmpegPath, requestedEncoder: cfg.ffmpegEncoder }).catch(() => null)
        const initCfg = JSON.stringify(captureConfig(cfg, ffmpegManager))
        const handle = ctx.subprocess.spawn({
          argv: [process.execPath, WORKER_BIN, initCfg],
          // cwd is required by the dsh-subprocess provider on DSH >= 0.1.5 —
          // omitting it throws inside spawn() and the catch below swallowed it
          // silently, making the watch panel never start (issue #34 defect 1).
          cwd: process.cwd(),
          // Electron hosts (DSH Desktop): process.execPath is the Electron
          // binary; children need ELECTRON_RUN_AS_NODE=1 or they boot as a
          // second Electron app (issue #42). Mirror of resolveEgoEnv's guard —
          // inlined here because cast-server cannot import from index.ts
          // (circular import).
          env: (process.versions as { electron?: string }).electron
            ? { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? '1' }
            : undefined,
          stdio: {
            stdin: { data: '' },
            stdout: { maxBytes: 8192 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: 12_000,
        })
        handle.done.catch(() => null)
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const ready = await launchedWorkerPort()
          if (ready !== null) return ready
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return null
      } catch {
        return null
      }
    }
    return null
  }
}

export interface TaskSpaceGroup { readonly name: string; readonly targetIds: readonly string[] }

/** Read-only membership metadata; never reconcile, prune, or mutate task spaces. */
export async function readTaskSpaceGroups(): Promise<readonly TaskSpaceGroup[]> {
  try {
    const { readFile } = await import('node:fs/promises')
    const state = JSON.parse(await readFile(join(resolveEgoStateDir(), 'task-spaces.json'), 'utf8')) as { spaces?: unknown }
    if (!Array.isArray(state.spaces)) return []
    return state.spaces.flatMap(value => {
      if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !Array.isArray(value.targetIds)) return []
      return [{ name: value.name, targetIds: value.targetIds.filter((id: unknown): id is string => typeof id === 'string') }]
    })
  } catch {
    return []
  }
}

export interface BrowserProcessState {
  running: boolean
  headless?: boolean
}

/** Read browser metadata without launching the browser or the cast worker. */
export async function readBrowserState(): Promise<BrowserProcessState> {
  try {
    const { readFile } = await import('node:fs/promises')
    const state = JSON.parse(await readFile(join(resolveEgoStateDir(), 'browser.json'), 'utf8')) as { pid?: unknown; headless?: unknown }
    const running = typeof state.pid === 'number' && isProcessAlive(state.pid)
    return { running, ...(typeof state.headless === 'boolean' ? { headless: state.headless } : {}) }
  } catch {
    return { running: false }
  }
}

/** Fetch one PNG without starting a worker or subscribing to its live stream. */
export async function requestSnapshot(port: number, targetId: string, maxWidth: number): Promise<Uint8Array | null> {
  try {
    const query = new URLSearchParams({ targetId, maxWidth: String(maxWidth) })
    const response = await fetch(`http://127.0.0.1:${port}/api/snapshot?${query}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return null
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return null
  }
}
