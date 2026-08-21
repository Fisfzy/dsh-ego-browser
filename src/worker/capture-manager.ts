export interface CaptureStatus {
  backend: string
  state: string
  targetId: string | null
  generation: number
  code?: string | null
  message?: string | null
  watchers?: number
  [key: string]: unknown
}

export interface CaptureBackend {
  start(opts: { targetId: string; generation: number }): Promise<void>
  stop(reason: string): Promise<void>
  dispose?(): void | Promise<void>
}

export type CaptureBackendFactory = (opts: {
  generation: number
  onStatus: (status: Record<string, unknown>) => void
}) => CaptureBackend

interface Lease {
  clientId: string
  backend: string
  targetId: string
  expiresAt: number
}

export interface CaptureManagerOptions {
  backendFactories: Record<string, CaptureBackendFactory>
  getConfig: () => { captureBackend: string; ffmpegFallbackReason?: string }
  onStatus: (status: Record<string, unknown>) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (timer: NodeJS.Timeout) => void
  leaseTtlMs?: number
  idleGraceMs?: number
}

export class CaptureManager {
  backendFactories: Record<string, CaptureBackendFactory>
  getConfig: () => { captureBackend: string; ffmpegFallbackReason?: string }
  onStatus: (status: Record<string, unknown>) => void
  now: () => number
  setTimer: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer: (timer: NodeJS.Timeout) => void
  leaseTtlMs: number
  idleGraceMs: number
  leases: Map<string, Lease>
  backend: CaptureBackend | null
  backendName: string | null
  targetId: string | null
  generation: number
  statusValue: Record<string, unknown>
  transition: Promise<unknown>
  stopTimer: NodeJS.Timeout | null
  sweepTimer: NodeJS.Timeout

  constructor({ backendFactories, getConfig, onStatus, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, leaseTtlMs = 120000, idleGraceMs = 1500 }: CaptureManagerOptions) {
    this.backendFactories = backendFactories
    this.getConfig = getConfig
    this.onStatus = onStatus
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.leaseTtlMs = leaseTtlMs
    this.idleGraceMs = idleGraceMs
    this.leases = new Map()
    this.backend = null
    this.backendName = null
    this.targetId = null
    this.generation = 0
    const fallbackReason = this.getConfig().ffmpegFallbackReason
    this.statusValue = { backend: this.#resolvedBackend(), state: 'idle', targetId: null, generation: 0, ...(fallbackReason ? { code: 'ffmpeg-fallback-cdp', message: fallbackReason } : {}) }
    this.transition = Promise.resolve()
    this.stopTimer = null
    this.sweepTimer = this.setTimer(() => this.#sweep(), Math.min(5000, this.leaseTtlMs))
  }

  #resolvedBackend(requested?: string): string {
    const value = requested || this.getConfig().captureBackend
    return value === 'auto' ? 'cdp' : value
  }

  async startWatch({ clientId, backend, targetId }: { clientId: string; backend?: string; targetId: string }): Promise<Record<string, unknown>> {
    if (!clientId || !targetId) throw new Error('clientId and targetId are required')
    this.clearTimer(this.stopTimer!)
    this.stopTimer = null
    const requestedBackend = backend || this.getConfig().captureBackend
    const existing = this.leases.get(clientId)
    this.leases.set(clientId, { clientId, backend: requestedBackend, targetId, expiresAt: this.now() + this.leaseTtlMs })
    if (existing && existing.backend === requestedBackend && existing.targetId === targetId) {
      const resolved = this.#resolvedBackend(requestedBackend)
      if (this.targetId !== targetId || (this.backendName && this.backendName !== resolved)) return this.status()
      if (this.backend && this.backendName === resolved) return this.status()
    }
    return this.#enqueue(async () => { await this.#activate(this.#resolvedBackend(backend), targetId); return this.status() })
  }

  async switchWatch({ clientId, targetId }: { clientId: string; targetId: string }): Promise<Record<string, unknown>> {
    const lease = this.leases.get(clientId)
    if (!lease) throw new Error('watch lease not found')
    lease.targetId = targetId
    lease.expiresAt = this.now() + this.leaseTtlMs
    return this.#enqueue(async () => { await this.#activate(this.#resolvedBackend(lease.backend), targetId); return this.status() })
  }

  async stopWatch({ clientId }: { clientId: string }): Promise<Record<string, unknown>> {
    this.leases.delete(clientId)
    if (this.leases.size === 0 && !this.stopTimer) {
      this.stopTimer = this.setTimer(() => {
        this.stopTimer = null
        if (this.leases.size === 0) this.stop('no-watchers').catch(() => {
          /* ignore */
        })
      }, this.idleGraceMs)
    }
    return this.status()
  }

  async updateConfig(): Promise<void | Record<string, unknown>> {
    const desired = this.#resolvedBackend()
    if (!this.backend) {
      const lease = [...this.leases.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0]
      if (lease) return this.#enqueue(() => this.#activate(this.#resolvedBackend(lease.backend), lease.targetId, true))
      const fallbackReason = this.getConfig().ffmpegFallbackReason
      this.#setStatus({ backend: desired, state: 'idle', targetId: null, code: fallbackReason ? 'ffmpeg-fallback-cdp' : null, message: fallbackReason || 'config-updated' })
      return
    }
    return this.#enqueue(() => this.#activate(desired, this.targetId!, true))
  }

  async browserDisconnected(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#stopBackend('browser-disconnected')
      this.#setStatus({ backend: this.#resolvedBackend(), state: 'failed', targetId: null, code: 'browser-disconnected', message: 'Browser disconnected' })
    }) as Promise<void>
  }

  async browserConnected(): Promise<void | Record<string, unknown>> {
    const lease = [...this.leases.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0]
    if (lease) return this.#enqueue(() => this.#activate(this.#resolvedBackend(lease.backend), lease.targetId))
  }

  async #activate(backendName: string, targetId: string, force = false): Promise<void> {
    if (!force && this.backend && this.backendName === backendName && this.targetId === targetId) return
    await this.#stopBackend('backend-change')
    const factory = this.backendFactories[backendName]
    if (!factory) {
      const message = `${backendName} backend is unavailable`
      this.#setStatus({ backend: backendName, state: 'failed', targetId, code: 'capture-backend-unavailable', message })
      if (backendName === 'ffmpeg' && this.backendFactories.cdp) {
        await this.#activate('cdp', targetId, true)
        if (this.backend && this.backendName === 'cdp') this.#setStatus({ backend: 'cdp', code: 'ffmpeg-fallback-cdp', message: `FFmpeg unavailable; using CDP: ${message}` })
      }
      return
    }
    try {
      this.backendName = backendName
      this.targetId = targetId
      this.generation += 1
      const generation = this.generation
      const fallbackReason = backendName === 'cdp' ? this.getConfig().ffmpegFallbackReason : null
      this.#setStatus({ backend: backendName, state: 'starting', targetId, generation, code: fallbackReason ? 'ffmpeg-fallback-cdp' : null, message: fallbackReason || null })
      let candidate: CaptureBackend
      candidate = factory({ generation, onStatus: (status) => {
        if (this.backend !== candidate || this.generation !== generation) return
        this.#setStatus({ ...status, generation })
      } })
      this.backend = candidate
      await candidate.start({ targetId, generation })
    } catch (error) {
      const e = error as Error & { code?: string }
      const failed = this.backend
      this.backend = null
      if (failed) {
        await failed.stop?.('start-failed').catch(() => {
          /* ignore */
        })
        await Promise.resolve(failed.dispose?.()).catch(() => {
          /* ignore */
        })
      }
      this.#setStatus({ backend: backendName, state: 'failed', targetId, generation: this.generation, code: e.code, message: e.message })
      if (backendName === 'ffmpeg' && this.backendFactories.cdp) {
        await this.#activate('cdp', targetId, true)
        if (this.backend && this.backendName === 'cdp') this.#setStatus({ backend: 'cdp', code: 'ffmpeg-fallback-cdp', message: `FFmpeg unavailable; using CDP: ${e.message}` })
      }
    }
  }

  async #stopBackend(reason = 'stopped'): Promise<void> {
    const backend = this.backend
    this.backend = null
    this.backendName = null
    this.targetId = null
    if (backend) {
      await backend.stop(reason)
      await backend.dispose?.()
    }
    this.#setStatus({ backend: this.#resolvedBackend(), state: 'idle', targetId: null, generation: this.generation, message: reason })
  }

  stop(reason = 'stopped'): Promise<void> {
    return this.#enqueue(() => this.#stopBackend(reason)) as Promise<void>
  }

  #enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.transition.then(work, work) as Promise<T>
    this.transition = run.catch(() => {
      /* ignore */
    })
    return run
  }

  status(): Record<string, unknown> {
    return { ...this.statusValue, watchers: this.leases.size }
  }

  #setStatus(status: Record<string, unknown>): void {
    this.statusValue = { ...this.statusValue, ...status }
    this.onStatus(this.status())
  }

  #sweep(): void {
    const now = this.now()
    for (const [clientId, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(clientId)
    if (this.leases.size === 0 && this.backend) this.stop('lease-expired').catch(() => {
      /* ignore */
    })
    this.sweepTimer = this.setTimer(() => this.#sweep(), Math.min(5000, this.leaseTtlMs))
  }

  async dispose(): Promise<void> {
    this.clearTimer(this.stopTimer!)
    this.clearTimer(this.sweepTimer)
    this.leases.clear()
    await this.stop('disposed')
  }
}
