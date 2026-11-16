import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
// src/remote.ts
/** Wire namespace and Cordis service key (one value: they must match). */
const EGO_REMOTE_NAMESPACE = "egoBrowser";
const WATCH_ACTIONS = [
	"start",
	"switch",
	"stop"
];
/**
* Validate one wire request into a lease. Unknown or missing actions are
* refused here (the gateway folds a throw into an `ok: false` result), so the
* surface never has to re-check the discriminator.
* @param request - raw `egoBrowser/watch` argument.
* @returns the validated lease.
*/
function normalizeWatchRequest(request) {
	const action = request?.action;
	if (typeof action !== "string" || !WATCH_ACTIONS.includes(action)) throw new Error(`ego-browser: watch action must be one of ${WATCH_ACTIONS.join(", ")}`);
	const lease = { action };
	if (typeof request?.clientId === "string" && request.clientId !== "") lease.clientId = request.clientId;
	if (typeof request?.targetId === "string" && request.targetId !== "") lease.targetId = request.targetId;
	if (typeof request?.maxWidth === "number" && Number.isFinite(request.maxWidth) && request.maxWidth > 0) lease.maxWidth = request.maxWidth;
	return lease;
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
var EgoRemoteGateway = class extends TypertRemoteService {
	surface;
	/**
	* @param ctx - host Cordis Context (the plugin's structural facade).
	* @param surface - host callbacks owned by the cast server.
	*/
	constructor(ctx, surface) {
		super(ctx, EGO_REMOTE_NAMESPACE);
		this.surface = surface;
	}
	/** Read the panel's whole host-side snapshot. */
	status() {
		return this.surface.status();
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
	watch(egoWatchRequest) {
		return this.surface.watch(normalizeWatchRequest(egoWatchRequest));
	}
};
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
function markRemote(prototype, method, endpoint) {
	const initializers = [];
	const context = {
		kind: "method",
		name: method,
		static: false,
		private: false,
		addInitializer(initializer) {
			initializers.push(initializer);
		},
		access: {
			has: (target) => method in target,
			get: (target) => target[method]
		}
	};
	Remote(endpoint)(prototype[method], context);
	const receiver = Object.create(prototype);
	for (const initialize of initializers) initialize.call(receiver);
}
markRemote(EgoRemoteGateway.prototype, "status", "status");
markRemote(EgoRemoteGateway.prototype, "watch", "watch");
/**
* Register the Remote service. Hosts may compose several plugin fibers, and a
* host without the typert gateway simply never claims the endpoints — neither
* case may break plugin load, so a duplicate registration is swallowed.
* @param ctx - host Context.
* @param surface - host callbacks owned by the cast server.
*/
function installEgoRemote(ctx, surface) {
	try {
		new EgoRemoteGateway(ctx, surface);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			ctx.logger?.("ego-browser")?.warn(`remote service not installed: ${message}`);
		} catch {}
	}
}
export { EGO_REMOTE_NAMESPACE, EgoRemoteGateway, installEgoRemote, normalizeWatchRequest };
