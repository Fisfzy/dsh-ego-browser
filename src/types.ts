/**
 * ego-browser — shared host-side types.
 *
 * Self-contained structural types for the DSH host services the plugin uses
 * (tools / subprocess / settings / webServer). We deliberately do NOT import
 * from `@deepseek-ai/cordis` here: the ctx shape is matched structurally so
 * the package typechecks without a cordis install, mirroring the original
 * hand-written `lib/index.d.ts`.
 */

/** Result payload emitted by every ego_* tool (parsed from the sentinel line). */
export interface EgoResult {
  ok: boolean
  /** Free-form payload; tools put their structured data here. */
  [key: string]: unknown
}

/** Reader over a subprocess' collected stdout/stderr buffer. */
export interface CollectReader {
  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
}

/** Handle returned by `ctx.subprocess.spawn`. */
export interface SubprocessHandle {
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  readonly collected: { stdout?: CollectReader; stderr?: CollectReader }
}

/** Structural subset of the dsh-subprocess `SubprocessSpawnSpec`. */
export interface SpawnSpec {
  argv: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio: {
    stdin: { data: string }
    stdout: { maxBytes: number; spill?: { maxBytes: number } }
    stderr: { maxBytes: number; spill?: { maxBytes: number } }
  }
  graceMs: number
  signal?: AbortSignal
}

export interface SubprocessService {
  spawn(spec: SpawnSpec): SubprocessHandle
}

export interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly agent?: unknown
  readonly token?: unknown
}

export type ToolExecute = (args: Record<string, unknown>, exec: ToolExec) => Promise<unknown> | unknown

export interface ToolRegistrar {
  register(tool: unknown): unknown
}

export interface LoggerLike {
  /** cordis loggers are also callable with a scope name to get a child logger. */
  (id: string): LoggerLike | undefined
  info(message: unknown, ...args: unknown[]): void
  warn(message: unknown, ...args: unknown[]): void
  error(message: unknown, ...args: unknown[]): void
}

export interface RouteHandler {
  (req: unknown, res: unknown): void
}

export interface RegisterRouteOptions {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

export interface WebServerLike {
  get?(path: string, handler: RouteHandler): unknown
  post?(path: string, handler: RouteHandler): unknown
  route?(path: string, handler: RouteHandler): unknown
  use?(path: string, handler: RouteHandler): unknown
  register?(opts: RegisterRouteOptions): () => void
}

export interface HttpServerLike {
  get?(path: string, handler: RouteHandler): unknown
  post?(path: string, handler: RouteHandler): unknown
  route?(path: string, handler: RouteHandler): unknown
  use?(path: string, handler: RouteHandler): unknown
  register?(opts: RegisterRouteOptions): () => void
}

export interface SettingsScope {
  get(): Record<string, unknown>
  watch(cb: () => void): () => void
}

export interface SettingsService {
  register(namespace: string, schema: unknown, opts?: { base?: Record<string, unknown> }): SettingsScope
  update?(namespace: string, patch: Record<string, unknown>): Promise<void>
}

/** Host context shape the plugin consumes (structural; not imported from cordis). */
export interface EgoContext {
  tools: ToolRegistrar
  subprocess: SubprocessService
  logger?: LoggerLike
  webServer?: WebServerLike
  httpServer?: HttpServerLike
  get?(name: string): unknown
  effect?(fn: () => unknown, label?: string): unknown
  inject?(services: readonly string[], fn: (sctx: EgoContext) => void): void
  on?(event: string, fn: (...args: unknown[]) => unknown): () => void
  settings?: SettingsService
  fiber?: { state?: number }
}

/** Resolved (post-defaults) runtime config — the canonical key set. */
export interface ResolvedConfig {
  chromePath: string
  captureBackend: 'auto' | 'cdp' | 'ffmpeg'
  streamProfile: 'low' | 'balanced' | 'high'
  cdpFps: number
  cdpQuality: number
  cdpMaxWidth: number
  cdpBackstopIntervalMs: number
  ffmpegFps: number
  ffmpegMaxWidth: number
  ffmpegBitrateKbps: number
  ffmpegEncoder: 'auto' | 'software' | 'h264_mf' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox' | 'h264_vaapi'
  ffmpegPath: string
  githubMirror: string
  egoCliArgs: string
  chromeArgs: string
}

/** Raw composition-layer config (may contain legacy / extra keys). */
export interface RawConfig extends Partial<ResolvedConfig> {
  castFpsCap?: number
  screencastQuality?: number
  screencastMaxWidth?: number
  backstopIntervalMs?: number
  [key: string]: unknown
}
