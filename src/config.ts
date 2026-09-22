// [DSH 0.1.7] Schemastery MUST come from DSH's own fork rather than the public
// package: only that build WRAPS a `meta.volatile` field in a cosmokit
// `Volatile` reference when it parses the config, and the Loader's live-commit
// path (`volatileEntries` / `updateVolatile`) walks those references. With the
// public build the write reports success but has nothing to commit — and with
// NO volatile field at all the host refuses the edit outright with
// `Plugin entry "ego-browser" has no volatile fields`.
import z from '@deepseek-ai/schemastery'
import type { RawConfig, ResolvedConfig } from './types.ts'

const backend = z.union(['auto', 'cdp', 'ffmpeg'])
const profile = z.union(['low', 'balanced', 'high'])
const encoder = z.union([
  'auto', 'software', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf',
  'h264_videotoolbox', 'h264_vaapi',
])

// User preferences. Every field here is marked `.volatile()` below: the Loader
// ignores volatile fields when deciding whether an edit needs a remount, takes
// the live-commit path instead, and the settings form can then write them
// without restarting the plugin.
const prefs = {
  isolateSpaces: z.boolean().description('Space isolation: false = persistent profile (keep logins across restarts); true = isolated sandbox.'),
  idleTimeoutMin: z.number().min(0).max(1440).step(1).description('Auto-stop the backing browser after N minutes without an ego_* call (0 = off). Relaunches on demand at the next call.'),
  disableFrameRelay: z.boolean().description('Disable the live frame relay (watch panel): no ego-cast worker, no screencast capture and no /api/ego stream routes. ego_* tools keep working.'),
  chromePath: z.string().description('Path to Chrome/Chromium. Empty = auto-detect.'),
  captureBackend: backend.description('Capture backend: auto, cdp, or ffmpeg.'),
  streamProfile: profile.description('Capture quality profile.'),
  cdpFps: z.number().min(5).max(30).step(1).description('CDP preview FPS.'),
  cdpQuality: z.number().min(1).max(100).step(1).description('CDP JPEG quality.'),
  cdpMaxWidth: z.number().min(320).max(1920).step(40).description('CDP frame max width.'),
  cdpBackstopIntervalMs: z.number().min(1000).max(10000).step(100).description('CDP recovery screenshot interval.'),
  ffmpegFps: z.number().min(5).max(30).step(1).description('FFmpeg video FPS.'),
  ffmpegMaxWidth: z.number().min(320).max(1920).step(40).description('FFmpeg video max width.'),
  ffmpegBitrateKbps: z.number().min(500).max(20000).step(250).description('FFmpeg target video bitrate in kbps.'),
  ffmpegEncoder: encoder.description('FFmpeg H.264 encoder.'),
  ffmpegPath: z.string().description('Custom FFmpeg path. Empty = detect PATH or managed install.'),
  githubMirror: z.string().description('HTTPS base replacing https://github.com for managed downloads.'),
  // User-defined extra CLI args. Shell-like tokenize; mutually-exclusive
  // control flags are stripped (see EGO_CLI_BLOCKED / CHROME_BLOCKED below).
  egoCliArgs: z.string().description('Extra args appended to `ego-browser nodejs` argv. Takes effect on the next ego_* call.'),
  chromeArgs: z.string().description('Extra args appended to the Chrome launch argv. Takes effect on the next browser cold start (the browser is a singleton).'),
}

// `.volatile()` RETURNS A COPY (like `extra()`), so the marked schemas must be
// collected — calling it for its side effect leaves every field non-volatile
// and the settings service then reports "no volatile fields" for the entry.
const volatilePrefs = Object.fromEntries(
  // The fork's public typings do not declare `volatile()`, but the runtime has
  // it (DSH's own plugins rely on it) — hence the unknown-cast.
  Object.entries(prefs).map(([key, field]) => [key, (field as unknown as { volatile(): unknown }).volatile()]),
)

// Defaults live in resolveConfig so a persisted legacy value is not hidden by
// a schema default before the one-release migration runs.
export const Config = z.object({
  ...volatilePrefs,
  // Deprecated read-compatible keys. The settings UI only writes canonical keys.
  castFpsCap: z.number().min(0).max(60).step(1),
  screencastQuality: z.number().min(1).max(100).step(1),
  screencastMaxWidth: z.number().min(320).max(1920).step(40),
  backstopIntervalMs: z.number().min(200).max(10000).step(100),
}) as unknown as z<Record<string, unknown>>

// ── user-defined extra CLI args ─────────────────────────────────────────────
/**
 * Flags the user must NOT put in `egoCliArgs`: these ego-browser subcommands
 * exit before the heredoc runs (--status/--stop/--help/...) or steal the
 * browser window (--open), so appending them would break every ego_* tool.
 * `--headless` is managed by EGO_LINUX_HEADLESS; `--sdk-path` is allowed.
 */
export const EGO_CLI_BLOCKED = new Set<string>([
  '--status',
  '--stop',
  '--open',
  '--spaces',
  '--spaces-daemon',
  '--prune-spaces',
  '--import-chrome-profile',
  '--install-desktop-entry',
  '--help',
  '-h',
])

/**
 * Flags the user must NOT put in `chromeArgs`: these are managed by the
 * launcher / EGO_LINUX_PROXY and overriding them would break CDP control,
 * profile isolation, or the proxy bypass list. `--proxy-server` should go
 * through EGO_LINUX_PROXY (which also sets the bypass list).
 */
export const CHROME_BLOCKED = new Set<string>([
  '--user-data-dir',
  '--remote-debugging-port',
  '--remote-allow-origins',
  '--headless',
  '--no-startup-window',
  '--proxy-server',
  '--proxy-bypass-list',
])

/**
 * Shell-like tokenizer for user-supplied arg strings. Handles single/double
 * quotes and backslash escapes; bare whitespace separates tokens. Returns []
 * for empty/whitespace-only input. Used for both `egoCliArgs` and `chromeArgs`
 * (mirrored in runtime/ego-linux/src/chrome.mjs for the Chrome side, since the
 * runtime must not import from src/).
 */
export function tokenizeArgs(input: unknown): string[] {
  if (typeof input !== 'string') return []
  const out: string[] = []
  let cur = ''
  let i = 0
  let quote: string | null = null
  while (i < input.length) {
    const c = input[i]!
    if (quote) {
      if (c === '\\') {
        const next = input[i + 1]
        if (next !== undefined) {
          cur += next
          i += 2
          continue
        }
      } else if (c === quote) {
        quote = null
        i += 1
        continue
      }
      cur += c
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      i += 1
      continue
    }
    if (c === '\\') {
      const next = input[i + 1]
      if (next !== undefined) {
        cur += next
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (cur !== '') {
        out.push(cur)
        cur = ''
      }
      i += 1
      continue
    }
    cur += c
    i += 1
  }
  if (cur !== '') out.push(cur)
  return out
}

/**
 * Split a raw arg string into tokens, dropping any token (and, for `--flag
 * value` pairs, its value) that appears in `blocked`. A "blocked" token with a
 * `=` attached (e.g. `--headless=new`) is also dropped. Returns the surviving
 * tokens. Exposed for tests and for the runtime to mirror.
 */
export function filterArgs(raw: string, blocked: Set<string>): string[] {
  const tokens = tokenizeArgs(raw)
  const kept: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    const key = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok
    if (blocked.has(key)) {
      // Drop a bare `--flag value` pair when the flag is blocklisted and the
      // next token does not itself look like a flag (i.e. it is the value).
      if (!tok.includes('=') && i + 1 < tokens.length && !tokens[i + 1]!.startsWith('-')) {
        i += 1
      }
      continue
    }
    kept.push(tok)
  }
  return kept
}

const finiteIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * DSH 0.1.7 wraps a `.volatile()` field in a cosmokit `Volatile` reference: a
 * plain object exposing `get()` plus a `Symbol(cosmokit.volatile.write)` slot.
 * `typeof`/`JSON.stringify` see an opaque `{}`, so a raw read would silently
 * fall back to the default instead of the value the user saved. Reading through
 * `get()` also picks up later live commits, because the reference stays put and
 * only its value moves.
 */
export function unwrapVolatile<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const candidate = value as unknown as { get?: unknown }
  if (typeof candidate.get !== 'function') return value
  const isVolatile = Object.getOwnPropertySymbols(value).some((symbol) => String(symbol).includes('cosmokit.volatile'))
  if (!isVolatile) return value
  try {
    return (candidate.get as () => T)()
  } catch {
    return value
  }
}

/** Unwrap every volatile reference so `resolveConfig` sees plain values. */
function normalizeVolatile(config: RawConfig): RawConfig {
  const source = config as unknown as Record<string, unknown>
  const plain: Record<string, unknown> = {}
  for (const key of Object.keys(source)) plain[key] = unwrapVolatile(source[key])
  return plain as RawConfig
}

export function resolveConfig(config: RawConfig = {}): ResolvedConfig {
  config = normalizeVolatile(config)
  const legacyFps = finiteIn(config.castFpsCap, 0, 60)
    ? (config.castFpsCap === 0 ? 20 : Math.max(5, Math.min(30, config.castFpsCap)))
    : 20
  const selectedProfile = oneOf(config.streamProfile, ['low', 'balanced', 'high'], 'balanced')
  const profileDefaults = selectedProfile === 'low'
    ? { fps: 15, width: 960, bitrateKbps: 2000 }
    : selectedProfile === 'high'
      ? { fps: 30, width: 1600, bitrateKbps: 8000 }
      : { fps: 20, width: 1280, bitrateKbps: 4000 }
  return {
    chromePath: typeof config.chromePath === 'string' ? config.chromePath : '',
    captureBackend: oneOf(config.captureBackend, ['auto', 'cdp', 'ffmpeg'], 'auto'),
    streamProfile: selectedProfile,
    cdpFps: finiteIn(config.cdpFps, 5, 30) ? config.cdpFps : legacyFps,
    cdpQuality: finiteIn(config.cdpQuality, 1, 100) ? config.cdpQuality : (finiteIn(config.screencastQuality, 1, 100) ? config.screencastQuality : 55),
    cdpMaxWidth: finiteIn(config.cdpMaxWidth, 320, 1920) ? config.cdpMaxWidth : (finiteIn(config.screencastMaxWidth, 320, 1920) ? config.screencastMaxWidth : 960),
    cdpBackstopIntervalMs: finiteIn(config.cdpBackstopIntervalMs, 1000, 10000) ? config.cdpBackstopIntervalMs : (finiteIn(config.backstopIntervalMs, 200, 10000) ? Math.max(1000, config.backstopIntervalMs) : 3000),
    ffmpegFps: finiteIn(config.ffmpegFps, 5, 30) ? config.ffmpegFps : profileDefaults.fps,
    ffmpegMaxWidth: finiteIn(config.ffmpegMaxWidth, 320, 1920) ? config.ffmpegMaxWidth : profileDefaults.width,
    ffmpegBitrateKbps: finiteIn(config.ffmpegBitrateKbps, 500, 20000) ? config.ffmpegBitrateKbps : profileDefaults.bitrateKbps,
    ffmpegEncoder: oneOf(config.ffmpegEncoder, ['auto', 'software', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'h264_vaapi'], 'auto'),
    ffmpegPath: typeof config.ffmpegPath === 'string' ? config.ffmpegPath : '',
    githubMirror: typeof config.githubMirror === 'string' ? config.githubMirror : '',
    // User-defined extra args: stored raw (string), filtered at the call site
    // so a saved value is not silently mutated by a later blocklist change.
    egoCliArgs: typeof config.egoCliArgs === 'string' ? config.egoCliArgs : '',
    chromeArgs: typeof config.chromeArgs === 'string' ? config.chromeArgs : '',
    isolateSpaces: typeof config.isolateSpaces === 'boolean' ? config.isolateSpaces : config.isolateSpaces === 'true' || config.isolateSpaces === '1' || config.isolateSpaces === 1,
    idleTimeoutMin: finiteIn(config.idleTimeoutMin, 0, 1440) ? config.idleTimeoutMin : 0,
    // Default false (= frame relay ON, unchanged behavior); the switch is opt-in.
    disableFrameRelay: typeof config.disableFrameRelay === 'boolean' ? config.disableFrameRelay : config.disableFrameRelay === 'true' || config.disableFrameRelay === '1' || config.disableFrameRelay === 1,
  }
}
