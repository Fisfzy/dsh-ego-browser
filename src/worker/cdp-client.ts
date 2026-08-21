import type { WebSocket } from 'ws'

export interface CdpError extends Error {
  code?: number
  data?: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type EventHandler = (params: unknown, sessionId?: string) => void

export class CdpClient {
  ws: WebSocket
  nextId: number
  pending: Map<number, Pending>
  events: Map<string, Set<EventHandler>>

  constructor(ws: WebSocket) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.events = new Map()
    ws.addEventListener('message', (event: { data?: unknown }) => this.#handleMessage(event))
    const close = (): void => this.#rejectPending(new Error('CDP connection closed'))
    ws.addEventListener('close', close, { once: true } as AddEventListenerOptions)
    ws.addEventListener('error', close, { once: true } as AddEventListenerOptions)
  }

  #handleMessage(event: { data?: unknown }): void {
    let message: { id?: number; error?: { message?: string; code?: number; data?: unknown }; result?: unknown; method?: string; params?: unknown; sessionId?: string }
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const error = new Error(message.error.message || `CDP error ${message.error.code}`) as CdpError
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result || {})
      }
      return
    }
    if (!message.method) return
    for (const handler of this.events.get(message.method) || []) {
      try {
        handler(message.params || {}, message.sessionId)
      } catch {
        // A consumer error must not break dispatch for the other handlers.
      }
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  call(method: string, params: unknown = {}, sessionId?: string, timeoutMs = 6000): Promise<unknown> {
    const id = ++this.nextId
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  on(method: string, handler: EventHandler): () => void {
    if (!this.events.has(method)) this.events.set(method, new Set())
    this.events.get(method)!.add(handler)
    return () => {
      this.events.get(method)?.delete(handler)
    }
  }
}
