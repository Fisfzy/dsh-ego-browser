/**
 * ego-browser — DSH integration plugin for the ego-lite browser
 * (https://github.com/CitroLabs/ego-lite, MIT).
 *
 * ego lite is a Chromium browser built for AI agents: agents work in isolated
 * "task spaces" that inherit your real login state without stealing your tabs.
 * The official connection layer is the `ego-browser` CLI: `ego-browser nodejs`
 * reads a JS heredoc on stdin and runs it in a Node runtime with page-driving
 * facades preloaded (page/browser/taskSpaces/site/fetch, raw cdp).
 *
 * This plugin turns that CLI into structured HARNESS tools. Every action tool
 * builds a small script from its arguments, pipes it to `ego-browser nodejs`
 * through ctx.subprocess, and parses the result payload. Scripts target the
 * shared harness facade surface (preloaded by the ego-browser runtime itself):
 * taskSpaces.useOrCreate / .complete, browser.openOrReuseTab, page.info(),
 * page.snapshot(), page.evaluate(), page.waitForTimeout(), page.screenshot(),
 * page.locator(...).click()/.fill(), page.mouse.click(x, y), and the raw cdp().
 * Output is reported through console.log with a sentinel payload.
 *
 * Runtime requirements:
 *   - the `ego-browser` command on PATH (ego lite app, or the
 *     `ego-browser-v2` npm package; Node >= 22), and
 *   - a reachable ego lite browser (the app is macOS-only today; Linux is on
 *     the ego-lite roadmap, PR #202).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools'
import { fileURLToPath } from 'node:url'

export const name = 'ego-browser'
export const inject = ['tools', 'subprocess'] as const

// ── local structural contracts (services are injected in-process) ──────────

interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

interface ToolsLike {
  register(tool: unknown): unknown
}

interface CollectReader {
  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
}

interface SubprocessHandleLike {
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  readonly collected: { stdout?: CollectReader; stderr?: CollectReader }
}

/** Structural subset of the dsh-subprocess `SubprocessSpawnSpec`. */
interface SpawnSpecLike {
  argv: readonly string[]
  cwd: string
  stdio: {
    stdin: { data: string }
    stdout: { maxBytes: number; spill?: { maxBytes: number } }
    stderr: { maxBytes: number; spill?: { maxBytes: number } }
  }
  graceMs: number
  signal?: AbortSignal
}

interface SubprocessLike {
  spawn(spec: SpawnSpecLike): SubprocessHandleLike
}

interface ExecLike {
  signal?: AbortSignal
}

interface CtxLike {
  tools: ToolsLike
  subprocess: SubprocessLike
  logger?: LoggerLike
  /** Cordis lifecycle: register a dispose callback (e.g. cleanup on unmount). */
  effect?: (fn: () => unknown) => unknown
}

// ── config ──────────────────────────────────────────────────────────────────

export interface Config {
  /**
   * Path or command name of the ego-browser CLI.
   * Default: the vendored CLI bundled inside this plugin
   * (`runtime/ego-linux/bin/ego-browser.mjs`), so the plugin works with just
   * an installed Chrome. Set to `ego-browser` (or a path) to use an
   * official App / other host instead.
   */
  egoBin?: string
  /** Task-space name action tools use when no `space` argument is given. */
  defaultSpace?: string
  /** In-memory cap for collected stdout (snapshots / JS results) in bytes. */
  maxOutputBytes?: number
  /** Process-tree termination grace in ms. */
  graceMs?: number
}

// Plain object (no schemastery validation); fields documented above.
export const Config = {}

interface ResolvedConfig {
  egoBin: string
  defaultSpace: string
  maxOutputBytes: number
  graceMs: number
}

// ── constants ───────────────────────────────────────────────────────────────

const SENTINEL = '@@DSH_RESULT@@'
/** Vendored ego-linux CLI shipped inside this plugin (runtime/ego-linux/bin/). */
const VENDORED_EGO_BIN = fileURLToPath(new URL('../runtime/ego-linux/bin/ego-browser.mjs', import.meta.url))
const DEFAULT_EGO_BIN = VENDORED_EGO_BIN
const DEFAULT_SPACE = 'dsh-agent'
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_GRACE_MS = 15_000
const TOOL_TIMEOUT_MS = 120_000

// ── serialization ───────────────────────────────────────────────────────────

/**
 * The ego-lite host is a single persistent browser shared by every tool call;
 * concurrent tool executions would race on the same task space / tabs. All
 * ego_* executions are therefore serialized through one in-process lock. This
 * guards against concurrent tool calls within this plugin instance; separate
 * harness sessions sharing the same browser remain unsupported (host-level).
 */
let egoLockChain: Promise<unknown> = Promise.resolve()
async function withEgoLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = egoLockChain.then(() => fn(), () => fn())
  egoLockChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ── runner ──────────────────────────────────────────────────────────────────

type RunResult =
  | { ok: true; value: unknown; stdout: string; stderr: string }
  | { ok: false; error: string; stdout: string; stderr: string }

function readAll(reader: CollectReader | undefined): string {
  if (!reader) return ''
  return reader.readFrom(0).text
}

function describeStderr(stderr: string): string {
  const tail = stderr.trim()
  return tail === '' ? '' : `\n--- ego-browser stderr (tail) ---\n${tail.slice(-2000)}`
}

function describeSpawnFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ENOENT|spawn .* ENOENT|not found|could not load|cannot find module/i.test(msg)) {
    return 'ego-browser CLI could not be started. For the vendored runtime, make sure a Chrome/Chromium is reachable (PATH, or set EGO_LINUX_CHROME; root users need a --no-sandbox wrapper, see AGENTS.md). To use an official host instead, set egoBin to your `ego-browser` command. ' + msg
  }
  return `failed to start ego-browser: ${msg}`
}

/** Find the last line carrying the sentinel and JSON-parse its payload. */
function parseSentinel(stdout: string): unknown | undefined {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(SENTINEL)
    if (idx === -1) continue
    const payload = lines[i].slice(idx + SENTINEL.length).trim()
    try {
      return JSON.parse(payload)
    } catch {
      return undefined
    }
  }
  return undefined
}

async function runEgoScript(
  subprocess: SubprocessLike,
  script: string,
  exec: ExecLike,
  cfg: ResolvedConfig,
): Promise<RunResult> {
  let handle: SubprocessHandleLike
  try {
    handle = subprocess.spawn({
      // Run through the node interpreter so the vendored CLI needs no +x bit.
      argv: [process.execPath, cfg.egoBin, 'nodejs'],
      cwd: process.cwd(),
      stdio: {
        stdin: { data: script },
        stdout: { maxBytes: cfg.maxOutputBytes, spill: { maxBytes: cfg.maxOutputBytes } },
        stderr: { maxBytes: 512_000, spill: { maxBytes: 2_000_000 } },
      },
      graceMs: cfg.graceMs,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    })
  } catch (err) {
    return { ok: false, error: describeSpawnFailure(err), stdout: '', stderr: '' }
  }

  let outcome: { exitCode: number | null; signal: NodeJS.Signals | null }
  try {
    outcome = await handle.done
  } catch (err) {
    return { ok: false, error: describeSpawnFailure(err), stdout: '', stderr: '' }
  }

  const stdout = readAll(handle.collected.stdout)
  const stderr = readAll(handle.collected.stderr)

  if (exec.signal !== undefined && exec.signal.aborted) {
    return { ok: false, error: 'ego-browser tool aborted (harness timeout or cancellation)', stdout, stderr }
  }
  if (outcome.exitCode !== 0) {
    // When run through the node interpreter, a missing CLI surfaces as a
    // module-load failure with exit 1 instead of a spawn error — normalize it
    // to the same clear "CLI not available" message.
    const missingModule = /Cannot find module|MODULE_NOT_FOUND/i.test(stderr)
    return {
      ok: false,
      error: missingModule
        ? describeSpawnFailure(new Error(`node could not load ${cfg.egoBin}`))
        : `ego-browser exited with ${outcome.exitCode !== null ? `code ${outcome.exitCode}` : `signal ${String(outcome.signal)}`}${describeStderr(stderr)}`,
      stdout,
      stderr,
    }
  }
  const value = parseSentinel(stdout)
  if (value === undefined) {
    return {
      ok: false,
      error: `ego-browser finished but no ${SENTINEL} JSON payload was found on stdout${describeStderr(stderr)}`,
      stdout,
      stderr,
    }
  }
  return { ok: true, value, stdout, stderr }
}

// ── tool plumbing ───────────────────────────────────────────────────────────

const j = (v: unknown): string => JSON.stringify(v)

/** JS snippet that pins an action tool to one task space. */
const useSpace = (name: string): string => `const task = await taskSpaces.useOrCreate(${j(name)})\n`

/**
 * JS snippet that makes the harness act on a real page tab.
 *
 * The Linux host (PR #234 ego-linux) does not reliably persist "current tab"
 * across CLI invocations: a fresh process sometimes resolves page actions
 * against a blank/stale tab. Selecting the first non-blank tab in the space
 * before acting makes cross-process tool calls deterministic.
 */
const ensureRealTab = (): string =>
  `const __tabs = await browser.listTabs()\n` +
  `const __real = __tabs.find(t => !t.url.startsWith('about:') && !t.url.startsWith('chrome://')) ?? __tabs[0]\n` +
  `if (__real) await browser.switchTab(__real.targetId)\n`

/** Inline helper making arbitrary helper results JSON-safe for the payload. */
const SAFE_FN = 'function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n'

type ParamSpec = Record<string, ParameterPropertySpec>

function renderText(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const v = value as Record<string, unknown>
  if (v !== null && typeof v === 'object' && v.ok === true && typeof v.text === 'string') {
    return [{ type: 'text', text: v.text }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const commonOutputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
  },
} as const

function defineEgoTool(
  ctx: CtxLike,
  cfg: ResolvedConfig,
  opts: {
    name: string
    description: string
    parameters: ParamSpec
    buildScript: (args: Record<string, unknown>) => string
  },
): ReturnType<typeof defineTool> {
  return defineTool({
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    output: {
      schema: commonOutputSchema,
      render: renderText,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args, exec) => withEgoLock(async () => {
      const script = opts.buildScript(args as Record<string, unknown>)
      const result = await runEgoScript(ctx.subprocess, script, exec, cfg)
      if (!result.ok) throw new Error(result.error)
      // Value is JSON.parse output of our own payload — fits the tool JSON contract.
      return result.value as never
    }),
    presentCall: () => ({ card: 'generic', title: opts.name, kind: 'other', rawInput: null }),
  })
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v !== '' ? v : fallback)
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

// ── plugin entry ────────────────────────────────────────────────────────────

export function apply(ctx: CtxLike, config: Partial<Config> = {}): void {
  const cfg: ResolvedConfig = {
    egoBin: config.egoBin !== undefined && config.egoBin !== '' ? config.egoBin : DEFAULT_EGO_BIN,
    defaultSpace: config.defaultSpace ?? DEFAULT_SPACE,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
  }

  const reg = (tool: unknown): void => {
    const dispose = ctx.tools.register(tool)
    // Cordis lifecycle: unregister the tool when the plugin unmounts.
    ctx.effect?.(() => dispose)
  }

  registerEgoStatus(ctx, cfg, reg)
  registerActionTools(ctx, cfg, reg)

  // Best-effort teardown: stop the persistent browser when the plugin unmounts.
  ctx.effect?.(() => {
    try {
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, cfg.egoBin, '--stop'],
        cwd: process.cwd(),
        stdio: {
          stdin: { data: '' },
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        graceMs: 5_000,
      })
      void handle.done.catch(() => {})
    } catch {
      // never let teardown throw
    }
  })

  ctx.logger?.info(`ego-browser: mounted (egoBin=${cfg.egoBin}, defaultSpace=${cfg.defaultSpace})`)
}

/** `ego_status` probes CLI availability by running the real `--status` path. */
function registerEgoStatus(ctx: CtxLike, cfg: ResolvedConfig, reg: (tool: unknown) => void): void {
  reg(defineTool({
    name: 'ego_status',
    description: 'Check whether the ego-browser CLI is usable (runs `ego-browser --status`). Use this first when other ego_* tools report "CLI not found".',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          available: { type: 'boolean', required: true },
          path: { type: 'string' },
          exitCode: { type: 'integer' },
        },
      },
      render: renderText,
    },
    timeoutMs: 15_000,
    execute: async () => withEgoLock(async () => {
      try {
        const handle = ctx.subprocess.spawn({
          argv: [process.execPath, cfg.egoBin, '--status'],
          cwd: process.cwd(),
          stdio: {
            stdin: { data: '' },
            stdout: { maxBytes: 4096 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: cfg.graceMs,
        })
        const outcome = await handle.done
        const out = readAll(handle.collected.stdout).trim()
        return { ok: true, available: outcome.exitCode === 0 && out !== '', path: cfg.egoBin, exitCode: outcome.exitCode } as never
      } catch (err) {
        return { ok: true, available: false, path: '', exitCode: null, error: describeSpawnFailure(err) } as never
      }
    }),
    presentCall: () => ({ card: 'generic', title: 'ego_status', kind: 'other', rawInput: null }),
  }))
}

/** The 11 structured action tools that drive `ego-browser nodejs`. */
function registerActionTools(ctx: CtxLike, cfg: ResolvedConfig, reg: (tool: unknown) => void): void {
  const t = (opts: {
    name: string
    description: string
    parameters: ParamSpec
    buildScript: (args: Record<string, unknown>) => string
  }): ReturnType<typeof defineTool> => defineEgoTool(ctx, cfg, opts)

  const spaceParam: ParamSpec['x'] = { type: 'string', description: 'Task-space name or numeric id; defaults to the configured defaultSpace.' }

  reg(t({
    name: 'ego_space_open',
    description: 'Open (or reuse) an ego-lite task space — an isolated browsing context that inherits your login state. Returns the space id; pass it as `space` to other ego_* tools, or rely on the default space.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short name for the active user goal, e.g. "search github issues". Reuse the same name for follow-ups on the same goal.' },
    },
    buildScript: (args) =>
      `${useSpace(str(args.name, cfg.defaultSpace))}` +
      `console.log('${SENTINEL}' + JSON.stringify({ ok: true, id: task.id ?? null, name: task.name ?? ${j(str(args.name, cfg.defaultSpace))} }))\n`,
  }))

  reg(t({
    name: 'ego_space_close',
    description: 'Complete (close) an ego-lite task space. Must be the final ego_* call for a task — never leave a space hanging. `keep: true` keeps the page open for the user.',
    parameters: {
      name: { type: 'string', required: true, description: 'Task-space name or numeric id to close.' },
      keep: { type: 'boolean', description: 'Keep the live page open (default false: close it).' },
    },
    buildScript: (args) =>
      `const res = await taskSpaces.complete(${j(str(args.name, cfg.defaultSpace))}, { keep: ${bool(args.keep, false)} })\n` +
      `console.log('${SENTINEL}' + JSON.stringify({ ok: true, done: !!res.done, skipped: !!res.skipped, reason: res.skipped ? ${j('target space was not agent-owned')} : null }))\n`,
  }))

  reg(t({
    name: 'ego_snapshot',
    description: 'Read the current page as text: the full-page semantic tree annotated with [ref=N, loc=...] selectors that ego_click / ego_fill can target. This is the main observation tool for any browser task.',
    parameters: {
      space: spaceParam,
      scope: { type: 'string', description: "snapshot scope: 'full_page' (default) or 'only_within_viewport'." },
    },
    buildScript: (args) => {
      const scope = str(args.scope, '')
      const call = scope === '' ? 'await page.snapshotRaw()' : `await page.snapshotRaw({ scope: ${j(scope)} })`
      // The host can return an empty DOM capture right after a navigation;
      // retry briefly so a mid-load snapshot does not come back empty.
      return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
        `let s = ${call}\n` +
        `let tries = 0\n` +
        `while (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = ${call}; tries++ }\n` +
        `const text = s.content ?? ''\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, text, tries }))\n`
    },
  }))

  reg(t({
    name: 'ego_navigate',
    description: 'Open a URL in the task space, or switch to the existing tab for it. Waits for the document to load. Returns the resulting page info.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL to open, e.g. https://example.com/path.' },
      wait: { type: 'boolean', description: 'Wait for document load (default true).' },
      timeout: { type: 'number', description: 'Load wait timeout in ms (default 20000).' },
      space: spaceParam,
    },
    buildScript: (args) =>
      `${useSpace(str(args.space, cfg.defaultSpace))}` +
      `const tab = await browser.openOrReuseTab(${j(str(args.url, 'https://example.com'))}, { wait: ${bool(args.wait, true)}, timeout: ${num(args.timeout, 20_000)} })\n` +
      `const pginfo = await page.info()\n` +
      `console.log('${SENTINEL}' + JSON.stringify({ ok: true, reused: !!tab?.reused, page: pginfo }))\n`,
  }))

  reg(t({
    name: 'ego_click',
    description: 'Click an element in the current page. Target with a CSS selector, an xpath=.../loc=.../ref=@N value from ego_snapshot, or viewport coordinates.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector, xpath=..., loc=..., or ref=@N from the snapshot. Required unless x/y are given.' },
      x: { type: 'number', description: 'Viewport x coordinate for a coordinate click.' },
      y: { type: 'number', description: 'Viewport y coordinate for a coordinate click.' },
      label: { type: 'string', description: 'Short human label for the action, e.g. "click submit button".' },
      space: spaceParam,
    },
    buildScript: (args) => {
      const sel = str(args.selector, '')
      const x = args.x
      const y = args.y
      if (sel === '' && !(typeof x === 'number' && typeof y === 'number')) {
        throw new Error('ego_click: provide either `selector` (CSS/xpath/loc/ref from ego_snapshot) or both `x` and `y` viewport coordinates')
      }
      let action: string
      if (sel !== '') {
        const labelOpt = str(args.label, '') !== '' ? `{ label: ${j(str(args.label, ''))} }` : ''
        action = `await page.locator(${j(sel)}).click(${labelOpt})`
      } else {
        action = `await page.mouse.click(${x}, ${y})`
      }
      return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
        `${action}\n` +
        `const pginfo = await page.info()\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`
    },
  }))

  reg(t({
    name: 'ego_fill',
    description: 'Type text into an input field. Target with a CSS selector, xpath=..., loc=..., or ref=@N from ego_snapshot.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector, xpath=..., loc=..., or ref=@N for the input.' },
      text: { type: 'string', required: true, description: 'Text to type into the field.' },
      space: spaceParam,
    },
    buildScript: (args) =>
      `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
      `await page.locator(${j(str(args.selector, ''))}).fill(${j(str(args.text, ''))})\n` +
      `const pginfo = await page.info()\n` +
      `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`,
  }))

  reg(t({
    name: 'ego_js',
    description: 'Evaluate a JavaScript expression in the current page and return its JSON-serializable value (e.g. "document.title", "document.querySelectorAll(\'a\').length").',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression string to evaluate in the page.' },
      space: spaceParam,
    },
    buildScript: (args) =>
      `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
      `${SAFE_FN}` +
      `const result = await page.evaluate(${j(str(args.expression, ''))})\n` +
      `console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`,
  }))

  reg(t({
    name: 'ego_cdp',
    description: 'Issue a raw CDP command on the page target, e.g. cdp("Page.handleJavaScriptDialog", { accept: true }).',
    parameters: {
      method: { type: 'string', required: true, description: 'CDP method name, e.g. Page.handleJavaScriptDialog.' },
      params: { type: 'object', additionalProperties: true, description: 'CDP method parameters object.' },
      space: spaceParam,
    },
    buildScript: (args) => {
      const params = args.params
      const call = params !== undefined && params !== null ? `await cdp(${j(str(args.method, ''))}, ${j(params)})` : `await cdp(${j(str(args.method, ''))})`
      return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
        `${SAFE_FN}` +
        `const result = ${call}\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`
    },
  }))

  reg(t({
    name: 'ego_screenshot',
    description: 'Capture a screenshot of the current page. Returns the file path of the saved PNG, which you can then read with a vision/image tool.',
    parameters: {
      space: spaceParam,
    },
    buildScript: (args) =>
      `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
      `const path = await page.screenshot()\n` +
      `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path }))\n`,
  }))

  reg(t({
    name: 'ego_page_info',
    description: 'Return the current page info: url, title, viewport size (w, h), scroll offsets (sx, sy), and device metrics (pw, ph). Also reports when a native browser dialog is open.',
    parameters: {
      space: spaceParam,
    },
    buildScript: (args) =>
      `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
      `const pginfo = await page.info()\n` +
      `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`,
  }))

  reg(t({
    name: 'ego_wait',
    description: 'Pause for a fixed number of milliseconds (e.g. for animations or partial loads). For load waits prefer ego_navigate\'s wait option.',
    parameters: {
      ms: { type: 'number', required: true, description: 'Milliseconds to wait.' },
    },
    buildScript: (args) =>
      `await page.waitForTimeout(${Math.max(0, num(args.ms, 1000))})\n` +
      `console.log('${SENTINEL}' + JSON.stringify({ ok: true, waitedMs: ${Math.max(0, num(args.ms, 1000))} }))\n`,
  }))

  reg((() => {
    const def = defineTool({
      name: 'ego_cli',
      description: 'Escape hatch: run an arbitrary `ego-browser nodejs` heredoc script verbatim (facades page/browser/taskSpaces/site/fetch and the raw cdp() are preloaded). Use when the structured ego_* tools do not cover the task. Returns raw stdout plus the parsed console.log payload when present.',
      parameters: {
        script: { type: 'string', required: true, description: 'Full JS script body for the heredoc; ego-browser helpers are preloaded. End with console.log(JSON.stringify(...)) for a parseable sentinel payload.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            stdout: { type: 'string', required: true },
            stderr: { type: 'string' },
            result: { type: 'json' },
          },
        },
        render: renderText,
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      execute: async (args, exec) => {
        const script = str((args as { script?: unknown }).script, '')
        const result = await runEgoScript(ctx.subprocess, script, exec, cfg)
        if (!result.ok) throw new Error(result.error)
        const parsed = parseSentinel(result.stdout)
        return { ok: true, stdout: result.stdout, stderr: result.stderr, result: parsed ?? null } as never
      },
      presentCall: () => ({ card: 'generic', title: 'ego_cli', kind: 'other', rawInput: null }),
    })
    return def
  })())
}
