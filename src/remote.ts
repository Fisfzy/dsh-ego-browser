// src/remote.ts — the panel's host control plane, exported over the DSH
// Remote channel instead of plugin-owned HTTP routes.
//
// Why this exists: the watch panel used to POLL three plugin routes
// (`GET /api/ego/executor` every 15s, `GET /api/ego/login-extension/health`
// every 8s, plus the `POST /api/ego/watch/*` lease calls). Those are
// plugin-invented endpoints that re-implement authentication, framing and
// error envelopes the host already owns. This service hands the same facts to
// the page through the host's own RPC dispatch:
//
//   browser: connection.rpc.call('/api', 'egoBrowser/status', { args: {} })
//   browser: connection.rpc.call('/api', 'egoBrowser/watch',
//                                { args: { request: { action: 'stop' } } })
//
// The host claims the endpoints from the `@Remote` markers (typertGateway SRC
// discovery): `TypertRemoteService` keeps the Cordis service key and the wire
// namespace identical ('egoBrowser'), so the two endpoints are
// `egoBrowser/status` and `egoBrowser/watch`.
//
// Wire contract (typertGateway): the payload is exactly `{ args: { <param>: … } }`
// and the result must be lossless JSON — never present a key as `undefined`.
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { EgoContext } from './types.ts'

/** Wire namespace and Cordis service key (one value: they must match). */
export const EGO_REMOTE_NAMESPACE = 'egoBrowser'

/** Lease actions the panel may ask the cast worker for. */
export type EgoWatchAction = 'start' | 'switch' | 'stop'

/** Raw `egoBrowser/watch` argument (validated by {@link normalizeWatchRequest}). */
export interface EgoWatchRequest {
  action?: string
  clientId?: string
  targetId?: string
  maxWidth?: number
}

/** Validated lease request handed to the surface. */
export interface EgoWatchLease {
  action: EgoWatchAction
  clientId?: string
  targetId?: string
  maxWidth?: number
}

/**
 * Everything the panel needs before it decides what to render. One call
 * replaces the three former polls: executor diagnostics (host), the login
 * bridge health (host) and the worker's watch/capture status.
 */
export interface EgoHostStatus {
  /** False while the live frame relay setting is off. */
  relay: boolean
  /** Resident/one-shot executor diagnostics (#73); host-only, no worker. */
  executor: Record<string, unknown>
  /** Worker `/api/watch/status` reply, or an idle refusal when no worker runs. */
  watch: Record<string, unknown>
  /** Login-bridge health (`getLoginExtensionHealth`), including its freshness stamp. */
  login: Record<string, unknown>
}

/** Host capabilities the Remote service exposes to the page. */
export interface EgoRemoteSurface {
  status(): Promise<EgoHostStatus>
  watch(lease: EgoWatchLease): Promise<Record<string, unknown>>
}

const WATCH_ACTIONS: readonly EgoWatchAction[] = ['start', 'switch', 'stop']

/**
 * Validate one wire request into a lease. Unknown or missing actions are
 * refused here (the gateway folds a throw into an `ok: false` result), so the
 * surface never has to re-check the discriminator.
 * @param request - raw `egoBrowser/watch` argument.
 * @returns the validated lease.
 */
export function normalizeWatchRequest(request: EgoWatchRequest | undefined): EgoWatchLease {
  const action = request?.action
  if (typeof action !== 'string' || !WATCH_ACTIONS.includes(action as EgoWatchAction)) {
    throw new Error(`ego-browser: watch action must be one of ${WATCH_ACTIONS.join(', ')}`)
  }
  const lease: EgoWatchLease = { action: action as EgoWatchAction }
  // JSON has no undefined: only carry the keys this action actually uses.
  if (typeof request?.clientId === 'string' && request.clientId !== '') lease.clientId = request.clientId
  if (typeof request?.targetId === 'string' && request.targetId !== '') lease.targetId = request.targetId
  if (typeof request?.maxWidth === 'number' && Number.isFinite(request.maxWidth) && request.maxWidth > 0) {
    lease.maxWidth = request.maxWidth
  }
  return lease
}

/**
 * Host control plane for the watch panel.
 *
 * Endpoints (`@Remote` markers, discovered by the host's typertGateway):
 *   - `egoBrowser/status` — one-shot snapshot; the panel refetches it on mount,
 *     on `connection/reset`, on window focus and whenever the cast worker
 *     pushes a `spaces` frame. No client timer.
 *   - `egoBrowser/watch` — start/switch/stop the worker's watch lease.
 */
export class EgoRemoteGateway extends TypertRemoteService {
  private readonly surface: EgoRemoteSurface

  /**
   * @param ctx - host Cordis Context (the plugin's structural facade).
   * @param surface - host callbacks owned by the cast server.
   */
  constructor(ctx: EgoContext, surface: EgoRemoteSurface) {
    // The plugin matches the host services structurally, so the Context is
    // passed through unchanged; cordis registers this service on the root.
    super(ctx as never, EGO_REMOTE_NAMESPACE)
    this.surface = surface
  }

  /** Read the panel's whole host-side snapshot. */
  status(): Promise<EgoHostStatus> {
    return this.surface.status()
  }

  /**
   * Acquire, retarget or release the worker's watch lease.
   *
   * The parameter NAME is the wire field the host's gateway reads (SRC
   * descriptors parse it out of the method source), so it is deliberately
   * collision-proof: a bundler that has to disambiguate a local `request`
   * would rename the parameter and silently break the contract. The build
   * artifact test in tests/remote-endpoints.test.ts pins it.
   * @param egoWatchRequest - raw lease request.
   */
  watch(egoWatchRequest: EgoWatchRequest): Promise<Record<string, unknown>> {
    return this.surface.watch(normalizeWatchRequest(egoWatchRequest))
  }
}

/**
 * Apply one `@Remote` marker without decorator SYNTAX.
 *
 * This package ships a pre-built `lib/` (tsdown.config.ts) and the bundler
 * emits TC39 decorator syntax verbatim, which is a SyntaxError the moment the
 * host loads the plugin. Driving the exported decorator factory by hand keeps
 * the descriptor owned by `@deepseek-ai/dsh-typert-protocol` — same private
 * key, same v1 shape — instead of re-implementing that marker format here.
 * @param prototype - class prototype owning the Remote method.
 * @param method - public instance method name (also the wire parameter name).
 * @param endpoint - exported endpoint segment.
 */
function markRemote(prototype: object, method: string, endpoint: string): void {
  const initializers: ((this: object) => void)[] = []
  const context = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(initializer: (this: object) => void): void {
      initializers.push(initializer)
    },
    access: {
      has: (target: object) => method in target,
      get: (target: Record<string, unknown>) => target[method],
    },
  }
  const decorate = Remote(endpoint) as unknown as (member: unknown, ctx: unknown) => void
  decorate((prototype as unknown as Record<string, unknown>)[method], context)
  // The marker initializer runs as an instance initializer: it writes the
  // descriptor onto Object.getPrototypeOf(this), so an empty instance suffices.
  const receiver = Object.create(prototype) as object
  for (const initialize of initializers) initialize.call(receiver)
}

// Endpoint names are declared here, next to the methods they export.
markRemote(EgoRemoteGateway.prototype, 'status', 'status')
markRemote(EgoRemoteGateway.prototype, 'watch', 'watch')

/**
 * Register the Remote service. Hosts may compose several plugin fibers, and a
 * host without the typert gateway simply never claims the endpoints — neither
 * case may break plugin load, so a duplicate registration is swallowed.
 * @param ctx - host Context.
 * @param surface - host callbacks owned by the cast server.
 */
export function installEgoRemote(ctx: EgoContext, surface: EgoRemoteSurface): void {
  try {
    void new EgoRemoteGateway(ctx, surface)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      ctx.logger?.('ego-browser')?.warn(`remote service not installed: ${message}`)
    } catch {
      /* logger unavailable — the panel degrades to "no host status" */
    }
  }
}
