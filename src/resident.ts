/**
 * Resident `ego-browser --serve` transport (issue #56).
 *
 * The one-shot path pays Node startup + harness import on EVERY tool call
 * (~300-400 ms measured). `--serve` accepts one JSON request per line
 * (`{"id","code"}`) and answers with one JSON line per request
 * (`{"id","ok","stdout","stderr"}`), paying that cost once.
 *
 * This class is only the transport: the plugin keeps the per-call spawn path as
 * the fallback and turns the resident on with an explicit setting, so a host
 * where the resident misbehaves degrades to exactly today's behaviour.
 *
 * Two failure rules matter:
 *
 *  - A request that was never written (process already dead) throws
 *    `ResidentNotRunningError`; the caller MAY retry it through the one-shot
 *    path, because nothing ran.
 *  - A request that was written and then failed/timeout is NOT retryable: the
 *    script may have half-executed, and replaying a click would double-fire it.
 *    The process is killed instead — a wedged resident is worse than none.
 *
 * The CLI restores globals around each request (see the serve loop), so
 * between-call state isolation is the runtime's job, not this class's.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface ResidentFrame {
  id: string | null
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export interface ResidentOptions {
  /** Full argv; argv[0] is the executable (usually process.execPath). */
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  /** Per-request ceiling. A request that exceeds it kills the process. */
  graceMs: number
  /** Stop after this long without a request. 0 = keep until stop(). */
  idleMs: number
  /** Called when the process dies on its own (not via stop()). */
  onExit?: (reason: string) => void
}

/** Thrown when a request was NOT written because the process is not running. */
export class ResidentNotRunningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResidentNotRunningError'
  }
}

const MAX_STDERR_BYTES = 512_000

export class ResidentProcess {
  private readonly opts: ResidentOptions
  private readonly pending = new Map<
    string,
    { resolve: (frame: ResidentFrame) => void; reject: (error: Error) => void }
  >()
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private stderrText = ''
  private nextId = 1
  private idleTimer: NodeJS.Timeout | null = null
  private deadReason: string | null = null
  private stopping = false

  constructor(opts: ResidentOptions) {
    this.opts = opts
  }

  get alive(): boolean {
    return this.child !== null && this.deadReason === null
  }

  /** PID of the live resident (null when stopped/never started). */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** Spawn the process if it is not running. Idempotent. */
  start(): void {
    if (this.alive || this.stopping) return
    this.deadReason = null
    this.stdoutBuffer = ''
    this.stderrText = ''
    const [executable, ...args] = this.opts.argv
    if (executable === undefined) throw new Error('resident: empty argv')
    const child = spawn(executable, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: 'pipe',
      windowsHide: true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: string) => {
      this.stderrText += chunk
      if (this.stderrText.length > MAX_STDERR_BYTES) {
        this.stderrText = this.stderrText.slice(-MAX_STDERR_BYTES)
      }
    })
    child.on('error', (error) => this.die(`resident process error: ${error.message}`))
    child.on('exit', (code, signal) =>
      this.die(`resident process exited (${code === null ? `signal ${String(signal)}` : `code ${code}`})`),
    )
  }

  /**
   * Send one script and await its frame.
   *
   * @throws ResidentNotRunningError when the request was not written (retryable).
   * @throws Error on timeout/abort/process death (NOT retryable — the process is
   *         killed so a half-executed script cannot keep running).
   */
  async run(script: string, { signal, graceMs }: { signal?: AbortSignal; graceMs?: number } = {}): Promise<ResidentFrame> {
    this.start()
    if (!this.alive || this.child === null) {
      throw new ResidentNotRunningError(this.deadReason ?? 'resident is not running')
    }
    const child = this.child
    const id = String(this.nextId++)
    const timeoutMs = graceMs !== undefined && graceMs > 0 ? graceMs : this.opts.graceMs
    return await new Promise<ResidentFrame>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        // The script is still running inside the process; killing it is the
        // only way to guarantee it stops. The caller must NOT retry.
        this.die(`resident request timed out after ${timeoutMs}ms`)
      }, timeoutMs)
      const onAbort = (): void => {
        this.die('ego-browser tool aborted')
      }
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        if (this.pending.get(id) === entry) this.pending.delete(id)
        fn()
      }
      const entry = {
        resolve: (frame: ResidentFrame) => finish(() => { this.touchIdle(); resolve(frame) }),
        reject: (error: Error) => finish(() => reject(error)),
      }
      this.pending.set(id, entry)
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(() => reject(new Error('ego-browser tool aborted')))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        child.stdin.write(`${JSON.stringify({ id, code: script })}\n`)
      } catch (error) {
        finish(() =>
          reject(
            new ResidentNotRunningError(
              `could not write to the resident process: ${(error as Error)?.message ?? String(error)}`,
            ),
          ),
        )
      }
    })
  }

  /** Gracefully end stdin, then force-kill if it ignores that. */
  stop(): void {
    this.stopping = true
    this.clearIdle()
    const child = this.child
    this.child = null
    this.deadReason = 'resident stopped'
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(new Error('resident stopped'))
    if (child === null) return
    try {
      child.stdin.end()
    } catch {
      // already closed
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }, 1_500)
    killTimer.unref?.()
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.trim() === '') continue
      let frame: ResidentFrame | undefined
      try {
        frame = JSON.parse(line) as ResidentFrame
      } catch {
        // A noisy publish line (e.g. a dependency printing at import time) is
        // not a frame; ignore it rather than failing the request.
        continue
      }
      if (frame === null || typeof frame !== 'object' || typeof frame.id !== 'string') continue
      const entry = this.pending.get(frame.id)
      if (entry === undefined) continue
      this.pending.delete(frame.id)
      entry.resolve({
        id: frame.id,
        ok: frame.ok === true,
        stdout: typeof frame.stdout === 'string' ? frame.stdout : '',
        stderr: typeof frame.stderr === 'string' ? frame.stderr : '',
        ...(typeof frame.error === 'string' ? { error: frame.error } : {}),
      })
    }
  }

  private die(reason: string): void {
    if (this.deadReason !== null) return
    this.deadReason = reason
    this.clearIdle()
    const child = this.child
    this.child = null
    try {
      child?.kill()
    } catch {
      // already gone
    }
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) {
      entry.reject(
        new Error(
          `${reason}${this.stderrText.trim() === '' ? '' : `: ${this.stderrText.trim().slice(-1_000)}`}`,
        ),
      )
    }
    if (!this.stopping) this.opts.onExit?.(reason)
  }

  private touchIdle(): void {
    this.clearIdle()
    if (this.opts.idleMs <= 0 || this.pending.size > 0 || !this.alive) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pending.size === 0) this.stop()
    }, this.opts.idleMs)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
