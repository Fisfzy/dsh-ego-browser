#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { writeFile, mkdir, copyFile, rename, unlink, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { stdout, stderr, stdin } from 'node:process';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, "..");
function agentWorkspace() {
    if (process.env.EGO_BROWSER_AGENT_WORKSPACE) {
        return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE);
    }
    const bundledSkill = resolve(SRC_DIR, "ego-browser");
    if (existsSync(bundledSkill)) {
        return bundledSkill;
    }
    return resolve(REPO_ROOT, "..", "..", "skills", "ego-browser");
}
function resolvePath(path) {
    if (path.startsWith("~")) {
        return resolve(process.env.HOME || process.env.USERPROFILE || ".", path.slice(1));
    }
    return resolve(path);
}
function loadEnvFile(path) {
    if (!existsSync(path)) {
        return;
    }
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) {
            continue;
        }
        const index = line.indexOf("=");
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}
function loadEnv() {
    loadEnvFile(resolve(REPO_ROOT, ".env"));
    loadEnvFile(resolve(agentWorkspace(), ".env"));
}

/**
 * Output sink for the agent-facing heredoc runtime.
 *
 * `console.log` is the only channel an agent reads (the runtime routes it here). A
 * single user takeover turns that channel into noise: while the user holds control,
 * every browser command re-reports the same hard-stop error, so a script that loops
 * over work and swallows each error (try/catch, `.catch()`) prints the same guidance
 * on every iteration, buried under its own business logging and success rows.
 *
 * To collapse that to one clean line we buffer console.log output instead of writing it
 * straight through. When a hard-stop error is born (see `buildEgoError`) we record its
 * owned message once. At the end of the run we either:
 *   - a hard stop occurred -> discard the whole buffer and emit the owned message once
 *   - otherwise            -> flush the buffered output verbatim
 * and in both cases append the update-notice trailer (if any) last, so an out-of-band
 * "ego lite update available" hint reads as a footer after the command's own output.
 *
 * Buffering is the price of discarding pre-stop output: bytes already written cannot be
 * recalled, so nothing may be written until we know the run did not hard-stop. Each
 * heredoc runs in its own short-lived process, so this module state is per-run and needs
 * no cross-round reset; `resetSink()` exists only so in-process tests can reuse the run.
 */
let buffer = [];
let hardStopMessage = null;
let noticeTrailer = null;
let flushed = false;
let lifecycleHooked = false;
/** Buffer one already-formatted console.log chunk (the trailing newline is included). */
function bufferOutput(chunk) {
    buffer.push(chunk);
}
/**
 * Record the update-notice line to append after this run's output. Set out-of-band by
 * the fire-and-forget version check; appended by `flushSink` so it trails the command's
 * own output rather than racing ahead of it. Last write wins.
 */
function setNoticeTrailer(line) {
    noticeTrailer = line;
}
/**
 * Record the owned message of the first hard-stop error seen this run. Later hard stops
 * — the same error re-reported on each loop iteration — are ignored so the agent sees
 * the guidance exactly once.
 */
function markHardStop(message) {
    if (hardStopMessage === null) {
        hardStopMessage = message;
    }
}
/**
 * Emit the run's output exactly once.
 *
 * `thrown` separates a completed script from one ending on an uncaught error. On a clean
 * finish we are the only writer, so a hard stop must print its message here. On an
 * uncaught error the propagating Error already surfaces the message (the host prints it),
 * so we stay silent and only drop the buffer. Non-hard-stop output is flushed either way,
 * so an ordinary failure still shows what the script logged before it threw.
 */
function flushSink(stream, thrown) {
    if (flushed)
        return;
    flushed = true;
    if (hardStopMessage !== null) {
        // Drop every buffered line — business logs, success rows, and the repeated error
        // echoes — so the owned guidance is all that remains.
        if (!thrown) {
            stream.write(hardStopMessage.endsWith("\n")
                ? hardStopMessage
                : `${hardStopMessage}\n`);
        }
    }
    else {
        for (const chunk of buffer)
            stream.write(chunk);
    }
    // The update hint is independent of the run's own output (and of a hard stop), so it
    // is appended last in every case — after the business output or the owned guidance.
    if (noticeTrailer !== null) {
        stream.write(noticeTrailer.endsWith("\n") ? noticeTrailer : `${noticeTrailer}\n`);
    }
    buffer = [];
}
/** Clear sink state. Real runs get a fresh process; this is only for in-process tests. */
function resetSink() {
    buffer = [];
    hardStopMessage = null;
    noticeTrailer = null;
    flushed = false;
}
/**
 * Flush on process teardown for the SDK path, where the host runs each heredoc directly
 * and never calls the CLI `execute()` wrapper, so lifecycle events are our only hook.
 *
 * A clean finish drains the event loop and reaches `beforeExit`; an uncaught async
 * rejection skips `beforeExit` but still reaches `exit` (`thrown: true`, so a hard stop
 * stays silent and lets the propagating Error surface the message). The stream still
 * accepts writes in both events, so the same `stream` serves both. Registered once.
 */
function installLifecycleFlush(stream) {
    if (lifecycleHooked)
        return;
    lifecycleHooked = true;
    process.on("beforeExit", () => flushSink(stream, false));
    process.on("exit", () => flushSink(stream, true));
}

/**
 * Shared handling for ego-binding errors.
 *
 * Browser-side failures expose two signals (see the EgoBindings JS API):
 *   - human-readable text (`error` on resolved results, `message` on rejected
 *     Errors), and
 *   - a stable `error_code` such as EGO_TASK_SPACE_USER_IN_CONTROL.
 *
 * The code is the durable contract; the wording can drift between builds. Branch
 * on the code (isEgoUserControlError), not on the message. EGO_ERROR_MESSAGES is
 * where ego-browser owns its wording for the few codes an agent must act on; every
 * other code (and any unknown future code) defers to the native error message.
 *
 * Single source of truth — error handling was previously duplicated across
 * helpers.ts and driver/nav.ts.
 */
/** Stable error codes emitted by the native ego bindings. */
const EGO_ERROR_CODES = [
    "EGO_BROWSER_UNAVAILABLE",
    "EGO_CDP_CHANNEL_UNAVAILABLE",
    "EGO_CDP_SEND_FAILED",
    "EGO_INVALID_ARGUMENT",
    "EGO_INVALID_RESULT_PAYLOAD",
    "EGO_OPERATION_FAILED",
    "EGO_RESULT_CONVERSION_FAILED",
    "EGO_SNAPSHOT_FAILED",
    "EGO_TASK_HOST_DISCONNECTED",
    "EGO_TASK_SPACE_INACTIVE",
    "EGO_TASK_SPACE_NOT_FOUND",
    "EGO_TASK_SPACE_NOT_SELECTED",
    "EGO_TASK_SPACE_UNAVAILABLE",
    "EGO_TASK_SPACE_USER_IN_CONTROL",
    "EGO_WEB_CONTENTS_UNAVAILABLE",
];
/**
 * Codes whose wording ego-browser owns. A listed code returns this static, id-less
 * message instead of the native error message — reserved for the two business signals
 * an agent must react to, not just report. Every other code is absent here and defers
 * to the native error message (and any unknown future code does too), which is more
 * specific than any static line.
 */
const EGO_ERROR_MESSAGES = {
    EGO_TASK_SPACE_INACTIVE: [
        "The user has taken control of this task space and ended the task, so it is no longer assigned to the agent and browser commands are paused.",
        "This is a hard stop, not an obstacle to route around — do not retry and do not take ownership back on your own.",
        "Wait until the user explicitly asks you to continue, then claim the space and resume:",
        "  await taskSpaces.claim(id)",
        "",
        `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
    ].join("\n"),
    EGO_TASK_SPACE_USER_IN_CONTROL: [
        "The user has taken control of this task space, so browser commands are paused.",
        "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
        "Wait until the user explicitly asks you to continue, then take control back and resume:",
        "  await taskSpaces.takeOver()",
        "",
        `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
    ].join("\n"),
};
/** Type guard for codes this build knows about. */
function isEgoErrorCode(value) {
    return (typeof value === "string" &&
        EGO_ERROR_CODES.includes(value));
}
/**
 * Pull the stable error_code out of any ego error shape: resolved
 * `{ error, error_code }` objects, rejected/thrown Errors carrying `.error_code`,
 * or a bare known code string. Returns the raw code (which may be one this build
 * does not know about yet) or undefined when none is present.
 */
function egoErrorCode(err) {
    if (typeof err === "string") {
        return isEgoErrorCode(err) ? err : undefined;
    }
    if (err && typeof err === "object") {
        const code = err.error_code;
        if (typeof code === "string" && code)
            return code;
    }
    return undefined;
}
/**
 * Resolve any ego error into a stable `{ code, message }` pair.
 *
 * For a code ego-browser owns wording for, `message` is that owned wording.
 * Otherwise (a code not owned here, or an unknown future code) it falls back to
 * the native error message the binding returned, then the bare code, then a
 * generic string. `code` is the stable classifier and may be undefined.
 */
function resolveEgoError(err) {
    const code = egoErrorCode(err);
    const message = (isEgoErrorCode(code) ? EGO_ERROR_MESSAGES[code] : undefined) ??
        nativeErrorText(err) ??
        code ??
        "Unknown ego error";
    return { code, message };
}
/** Whether an ego error means the task is currently under user control. */
function isEgoUserControlError(err) {
    return egoErrorCode(err) === "EGO_TASK_SPACE_USER_IN_CONTROL";
}
/**
 * Codes that halt the whole agent task rather than mark a routable obstacle: a task
 * space the user has taken back, or one that is inactive / not assigned to this agent.
 * Both require the user to explicitly hand control back before work can resume.
 */
function isEgoHardStopCode(code) {
    return (code === "EGO_TASK_SPACE_USER_IN_CONTROL" ||
        code === "EGO_TASK_SPACE_INACTIVE");
}
/**
 * Build an Error carrying the resolved message and stable error_code from any ego
 * error shape. `op`, when given, prefixes the message with the failing operation.
 * Shared by assertNoEgoError (which throws it) and the CDP-send failure path (which
 * rejects pending requests with it) so every ego failure surfaces an identical
 * Error shape.
 */
function buildEgoError(err, op) {
    const { code, message } = resolveEgoError(err);
    if (isEgoHardStopCode(code)) {
        // buildEgoError is the single birthplace of every ego error — assertNoEgoError and
        // the CDP-send failure path both route through it — so recording the hard stop here
        // catches it even when the agent's own try/catch later swallows the thrown Error.
        // The op-less owned message is the one the agent should see, regardless of which
        // operation surfaced it.
        markHardStop(message);
    }
    const error = new Error(op ? `${op}: ${message}` : message);
    if (code)
        error.error_code = code;
    return error;
}
function assertNoEgoError(result, op) {
    if (result &&
        typeof result === "object" &&
        "error" in result &&
        result.error != null) {
        throw buildEgoError(result, op);
    }
    return result;
}
/**
 * The native error message from any ego error shape — the binding's runtime
 * `error`/`message` text (dynamic, may vary across builds). Ignores bare codes.
 */
function nativeErrorText(err) {
    if (typeof err === "string") {
        return isEgoErrorCode(err) ? undefined : err;
    }
    if (err && typeof err === "object") {
        const obj = err;
        if (obj.error != null)
            return formatEgoError(obj.error);
        if (typeof obj.message === "string" && obj.message)
            return obj.message;
    }
    return undefined;
}
function formatEgoError(err) {
    if (err == null)
        return String(err);
    if (typeof err === "string")
        return err;
    if (typeof err === "object") {
        const obj = err;
        if (typeof obj.message === "string")
            return obj.message;
        try {
            return JSON.stringify(err);
        }
        catch {
            return String(err);
        }
    }
    return String(err);
}

const RESPONSE_TIMEOUT_MS = 15000;
const SESSION_TTL_MS = 2000;
// Upper bound for buffered CDP events. The runtime can be long-lived (installEgoSdk
// inside the browser); without a cap, undrained events grow without bound.
const MAX_BUFFERED_EVENTS = 10000;
const SESSION_LOST = /Session (?:with given id )?not found|Target closed|No session/i;
const BROWSER_LEVEL = (method) => method.startsWith("Target.") || method.startsWith("Browser.");
let nextMessageId = 1;
const pending = new Map();
const events = [];
const eventWaiters = [];
const eventSubscribers = new Set();
const pageEnabledSessions = new Set();
const pendingDialogs = new Map();
function isBrowserRuntime() {
    return Boolean(globalThis.ego && typeof globalThis.ego.sendCDPMessage === "function");
}
function browserEgo() {
    if (!globalThis.ego) {
        throw new Error("browser runtime is not available");
    }
    return globalThis.ego;
}
function rawCdp(method, params = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const runtime = browserEgo();
    runtime.onCDPMessage = handleMessage;
    runtime.onSendCDPMessageError = handleSendError;
    const id = nextMessageId++;
    const payload = JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
    });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP request timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, {
            resolve: (response) => {
                clearTimeout(timer);
                resolve(response);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });
        try {
            runtime.sendCDPMessage(payload);
        }
        catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
        }
    });
}
async function browserCdp(method, params = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
    // Test mock: cdpOverride bypasses everything including session injection.
    if (state.cdpOverride) {
        return state.cdpOverride(method, params, sessionId);
    }
    const explicit = sessionId !== undefined;
    let effective = sessionId;
    if (!explicit && !BROWSER_LEVEL(method)) {
        effective = await ensureSession();
    }
    try {
        return await rawCdp(method, params, effective, timeoutMs);
    }
    catch (error) {
        const lost = SESSION_LOST.test(error?.message || "");
        if (lost && !explicit && !BROWSER_LEVEL(method)) {
            invalidateSession();
            const fresh = await ensureSession();
            return rawCdp(method, params, fresh, timeoutMs);
        }
        throw error;
    }
}
async function ensureSession() {
    if (state.sessionId && Date.now() - state.sessionAt < SESSION_TTL_MS) {
        return state.sessionId;
    }
    if (state.sessionInflight) {
        return state.sessionInflight;
    }
    state.sessionInflight = (async () => {
        try {
            const result = assertNoEgoError(await browserEgo().listTabs());
            const tabs = result?.tabs || result?.targetInfos || [];
            const preferred = state.preferredTargetId
                ? tabs.find((t) => t.targetId === state.preferredTargetId)
                : null;
            const active = preferred || tabs.find((t) => t.active) || tabs[tabs.length - 1];
            if (!active) {
                throw new Error("no active tab to attach session");
            }
            const targetId = active.targetId;
            if (targetId !== state.sessionTargetId || !state.sessionId) {
                const attached = await rawCdp("Target.attachToTarget", { targetId, flatten: true }, undefined);
                state.sessionId = attached.result?.sessionId || attached.sessionId;
                state.sessionTargetId = targetId;
            }
            await enablePageEvents(state.sessionId);
            state.sessionAt = Date.now();
            return state.sessionId;
        }
        finally {
            state.sessionInflight = null;
        }
    })();
    return state.sessionInflight;
}
function invalidateSession() {
    if (state.sessionId) {
        pageEnabledSessions.delete(state.sessionId);
        pendingDialogs.delete(state.sessionId);
    }
    state.sessionId = null;
    state.sessionTargetId = null;
    state.sessionAt = 0;
}
function setPreferredTarget(targetId) {
    state.preferredTargetId = targetId || null;
}
function clearPreferredTarget() {
    state.preferredTargetId = null;
}
function drainBrowserEvents() {
    const out = events.splice(0, events.length);
    return out;
}
function waitForBrowserEvent(predicate, timeoutMs = state.defaultTimeout) {
    return new Promise((resolve, reject) => {
        const waiter = {
            predicate,
            resolve,
            reject,
            timer: setTimeout(() => {
                const index = eventWaiters.indexOf(waiter);
                if (index >= 0)
                    eventWaiters.splice(index, 1);
                reject(new Error("page.waitForEvent timed out"));
            }, timeoutMs),
        };
        eventWaiters.push(waiter);
    });
}
function subscribeBrowserEvent(method, sessionId, listener) {
    const subscriber = { method, sessionId, listener };
    eventSubscribers.add(subscriber);
    return () => eventSubscribers.delete(subscriber);
}
function pendingDialog(sessionId = state.sessionId) {
    if (sessionId && pendingDialogs.has(sessionId)) {
        return { ...pendingDialogs.get(sessionId) };
    }
    return null;
}
async function enablePageEvents(sessionId) {
    if (!sessionId || pageEnabledSessions.has(sessionId)) {
        return;
    }
    try {
        await rawCdp("Page.enable", {}, sessionId);
        pageEnabledSessions.add(sessionId);
    }
    catch {
        // Dialog tracking is best-effort. Do not make all helpers fail on targets
        // that reject Page.enable, such as unusual internal pages.
    }
}
// Local send failures for ego.sendCDPMessage() arrive here (task inactive,
// user-controlled, not selected/claimed, host gone) instead of as a CDP
// response, so the matching request would otherwise sit until the 15s timeout.
// The callback carries no request id; these failures are task-level (every
// in-flight send fails the same way), so reject all pending requests, routing
// the stable code through buildEgoError to use the ego-browser-owned wording.
function handleSendError(message, error_code) {
    if (pending.size === 0)
        return;
    const error = buildEgoError({ error: message, error_code });
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries)
        entry.reject(error);
}
function handleMessage(message) {
    let data;
    try {
        data = JSON.parse(message);
    }
    catch {
        return;
    }
    if (Object.hasOwn(data, "id")) {
        const entry = pending.get(data.id);
        if (!entry) {
            return;
        }
        pending.delete(data.id);
        if (data.error) {
            entry.reject(new Error(data.error.message || data.error));
            return;
        }
        entry.resolve(data);
        return;
    }
    if (data.method === "Target.detachedFromTarget" ||
        data.method === "Target.targetDestroyed") {
        const sessionId = data.params?.sessionId || data.sessionId;
        if (sessionId) {
            pageEnabledSessions.delete(sessionId);
            pendingDialogs.delete(sessionId);
        }
        const targetId = data.params?.targetId || data.params?.targetInfo?.targetId;
        if (targetId && targetId === state.sessionTargetId) {
            invalidateSession();
        }
    }
    if (data.method === "Page.javascriptDialogOpening") {
        const sessionId = data.sessionId || state.sessionId;
        if (sessionId) {
            pendingDialogs.set(sessionId, data.params || {});
        }
    }
    else if (data.method === "Page.javascriptDialogClosed") {
        const sessionId = data.sessionId || state.sessionId;
        if (sessionId) {
            pendingDialogs.delete(sessionId);
        }
    }
    let deliveredToSubscriber = false;
    for (const subscriber of eventSubscribers) {
        if (subscriber.method !== data.method)
            continue;
        if (subscriber.sessionId && subscriber.sessionId !== data.sessionId) {
            continue;
        }
        deliveredToSubscriber = true;
        subscriber.listener(data);
    }
    if (!(deliveredToSubscriber && data.method === "Page.screencastFrame")) {
        events.push(data);
        if (events.length > MAX_BUFFERED_EVENTS) {
            events.splice(0, events.length - MAX_BUFFERED_EVENTS);
        }
    }
    for (const waiter of [...eventWaiters]) {
        let matched = false;
        try {
            matched = waiter.predicate(data);
        }
        catch (error) {
            clearTimeout(waiter.timer);
            eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
            waiter.reject(error);
            continue;
        }
        if (!matched)
            continue;
        clearTimeout(waiter.timer);
        eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
        waiter.resolve(data);
    }
}
function browserSnapshotRefsToRefMap(refMap, refs = []) {
    refMap.clear();
    for (const ref of refs) {
        if (!ref || typeof ref !== "object") {
            continue;
        }
        if (ref.backendNodeId === undefined || ref.backendNodeId === null) {
            continue;
        }
        refMap.add(String(ref.backendNodeId), ref.backendNodeId, ref.role, ref.name, undefined);
    }
}

loadEnv();
const NAME = process.env.EGO_BROWSER_NAME || "default";
async function defaultSend(req) {
    if (!req || typeof req !== "object" || !req.method) {
        throw new Error(`unsupported browser runtime request: ${JSON.stringify(req)}`);
    }
    const response = await browserCdp(req.method, req.params || {}, req.session_id);
    return { result: response.result || {} };
}
const state = {
    send: defaultSend,
    cdpOverride: null,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    platform: process.platform,
    agentWorkspace: () => agentWorkspace(),
    writeFile,
    sessionId: null,
    sessionTargetId: null,
    sessionAt: 0,
    sessionInflight: null,
    preferredTargetId: null,
    defaultTimeout: 10000,
    // Last observed Network domain state on the default session (tracked in cdp()).
    networkDomainEnabled: false,
};
async function send$1(req) {
    return state.send(req);
}
function setOverrides(overrides) {
    const previous = { ...state };
    Object.assign(state, overrides);
    return () => {
        Object.assign(state, previous);
    };
}

// Helper docs are extracted from the bundle at build time and injected here by
// scripts/build.mjs, which replaces the placeholder below with a JSON string.
// The runtime must never introspect its own source: in the shipped browser the
// SDK is loaded from a compiled .pak resource whose import.meta.url is
// "ego://services/node/resources/index.js", which is not a readable file, so
// the previous readFileSync(fileURLToPath(import.meta.url)) approach silently
// produced an empty docs map. See GitHub issue #84.
const EMBEDDED_DOCS_JSON = "[{\"name\":\"agentWorkspace\",\"signature\":\"agentWorkspace()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"resolvePath\",\"signature\":\"resolvePath(path)\",\"description\":null,\"params\":[{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"loadEnvFile\",\"signature\":\"loadEnvFile(path)\",\"description\":null,\"params\":[{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"loadEnv\",\"signature\":\"loadEnv()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"bufferOutput\",\"signature\":\"bufferOutput(chunk)\",\"description\":\"Buffer one already-formatted console.log chunk (the trailing newline is included).\",\"params\":[{\"name\":\"chunk\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"setNoticeTrailer\",\"signature\":\"setNoticeTrailer(line)\",\"description\":\"Record the update-notice line to append after this run's output. Set out-of-band by the fire-and-forget version check; appended by `flushSink` so it trails the command's own output rather than racing ahead of it. Last write wins.\",\"params\":[{\"name\":\"line\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"markHardStop\",\"signature\":\"markHardStop(message)\",\"description\":\"Record the owned message of the first hard-stop error seen this run. Later hard stops — the same error re-reported on each loop iteration — are ignored so the agent sees the guidance exactly once.\",\"params\":[{\"name\":\"message\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"flushSink\",\"signature\":\"flushSink(stream, thrown)\",\"description\":\"Emit the run's output exactly once. `thrown` separates a completed script from one ending on an uncaught error. On a clean finish we are the only writer, so a hard stop must print its message here. On an uncaught error the propagating Error already surfaces the message (the host prints it), so we stay silent and only drop the buffer. Non-hard-stop output is flushed either way, so an ordinary failure still shows what the script logged before it threw.\",\"params\":[{\"name\":\"stream\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"thrown\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"resetSink\",\"signature\":\"resetSink()\",\"description\":\"Clear sink state. Real runs get a fresh process; this is only for in-process tests.\",\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"installLifecycleFlush\",\"signature\":\"installLifecycleFlush(stream)\",\"description\":\"Flush on process teardown for the SDK path, where the host runs each heredoc directly and never calls the CLI `execute()` wrapper, so lifecycle events are our only hook. A clean finish drains the event loop and reaches `beforeExit`; an uncaught async rejection skips `beforeExit` but still reaches `exit` (`thrown: true`, so a hard stop stays silent and lets the propagating Error surface the message). The stream still accepts writes in both events, so the same `stream` serves both. Registered once.\",\"params\":[{\"name\":\"stream\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isEgoErrorCode\",\"signature\":\"isEgoErrorCode(value)\",\"description\":\"Type guard for codes this build knows about.\",\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"egoErrorCode\",\"signature\":\"egoErrorCode(err)\",\"description\":\"Pull the stable error_code out of any ego error shape: resolved `{ error, error_code }` objects, rejected/thrown Errors carrying `.error_code`, or a bare known code string. Returns the raw code (which may be one this build does not know about yet) or undefined when none is present.\",\"params\":[{\"name\":\"err\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"resolveEgoError\",\"signature\":\"resolveEgoError(err)\",\"description\":\"Resolve any ego error into a stable `{ code, message }` pair. For a code ego-browser owns wording for, `message` is that owned wording. Otherwise (a code not owned here, or an unknown future code) it falls back to the native error message the binding returned, then the bare code, then a generic string. `code` is the stable classifier and may be undefined.\",\"params\":[{\"name\":\"err\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isEgoUserControlError\",\"signature\":\"isEgoUserControlError(err)\",\"description\":\"Whether an ego error means the task is currently under user control.\",\"params\":[{\"name\":\"err\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isEgoHardStopCode\",\"signature\":\"isEgoHardStopCode(code)\",\"description\":\"Codes that halt the whole agent task rather than mark a routable obstacle: a task space the user has taken back, or one that is inactive / not assigned to this agent. Both require the user to explicitly hand control back before work can resume.\",\"params\":[{\"name\":\"code\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"buildEgoError\",\"signature\":\"buildEgoError(err, op)\",\"description\":\"Build an Error carrying the resolved message and stable error_code from any ego error shape. `op`, when given, prefixes the message with the failing operation. Shared by assertNoEgoError (which throws it) and the CDP-send failure path (which rejects pending requests with it) so every ego failure surfaces an identical Error shape.\",\"params\":[{\"name\":\"err\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"op\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"assertNoEgoError\",\"signature\":\"assertNoEgoError(result, op)\",\"description\":null,\"params\":[{\"name\":\"result\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"op\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"nativeErrorText\",\"signature\":\"nativeErrorText(err)\",\"description\":\"The native error message from any ego error shape — the binding's runtime `error`/`message` text (dynamic, may vary across builds). Ignores bare codes.\",\"params\":[{\"name\":\"err\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"formatEgoError\",\"signature\":\"formatEgoError(err)\",\"description\":null,\"params\":[{\"name\":\"err\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isBrowserRuntime\",\"signature\":\"isBrowserRuntime()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"browserEgo\",\"signature\":\"browserEgo()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"rawCdp\",\"signature\":\"rawCdp(method, params?, sessionId?, timeoutMs?)\",\"description\":null,\"params\":[{\"name\":\"method\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"params\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null},{\"name\":\"timeoutMs\",\"optional\":true,\"rest\":false,\"default\":\"RESPONSE_TIMEOUT_MS\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"browserCdp\",\"signature\":\"browserCdp(method, params?, sessionId?, timeoutMs?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"method\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"params\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null},{\"name\":\"timeoutMs\",\"optional\":true,\"rest\":false,\"default\":\"RESPONSE_TIMEOUT_MS\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"ensureSession\",\"signature\":\"ensureSession() → Promise<...>\",\"description\":null,\"params\":[],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"invalidateSession\",\"signature\":\"invalidateSession()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"setPreferredTarget\",\"signature\":\"setPreferredTarget(targetId)\",\"description\":null,\"params\":[{\"name\":\"targetId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"clearPreferredTarget\",\"signature\":\"clearPreferredTarget()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"drainBrowserEvents\",\"signature\":\"drainBrowserEvents()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"waitForBrowserEvent\",\"signature\":\"waitForBrowserEvent(predicate, timeoutMs?)\",\"description\":null,\"params\":[{\"name\":\"predicate\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"timeoutMs\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"subscribeBrowserEvent\",\"signature\":\"subscribeBrowserEvent(method, sessionId, listener)\",\"description\":null,\"params\":[{\"name\":\"method\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"listener\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"pendingDialog\",\"signature\":\"pendingDialog(sessionId?)\",\"description\":null,\"params\":[{\"name\":\"sessionId\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"enablePageEvents\",\"signature\":\"enablePageEvents(sessionId) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"handleSendError\",\"signature\":\"handleSendError(message, error_code)\",\"description\":null,\"params\":[{\"name\":\"message\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"error_code\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"handleMessage\",\"signature\":\"handleMessage(message)\",\"description\":null,\"params\":[{\"name\":\"message\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"browserSnapshotRefsToRefMap\",\"signature\":\"browserSnapshotRefsToRefMap(refMap, refs?)\",\"description\":null,\"params\":[{\"name\":\"refMap\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"refs\",\"optional\":true,\"rest\":false,\"default\":\"[]\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"defaultSend\",\"signature\":\"defaultSend(req) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"req\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"send$1\",\"signature\":\"send$1(req) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"req\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"setOverrides\",\"signature\":\"setOverrides(overrides)\",\"description\":null,\"params\":[{\"name\":\"overrides\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"help\",\"signature\":\"help(helpers, ...names?)\",\"description\":null,\"params\":[{\"name\":\"helpers\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"names\",\"optional\":true,\"rest\":true,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"formatHelp\",\"signature\":\"formatHelp(doc)\",\"description\":null,\"params\":[{\"name\":\"doc\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"getDocsMap\",\"signature\":\"getDocsMap()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"parseEmbeddedDocs\",\"signature\":\"parseEmbeddedDocs(raw)\",\"description\":null,\"params\":[{\"name\":\"raw\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"cdp\",\"signature\":\"cdp(method, params?, sessionId?) → Promise<object>\",\"description\":\"Send a raw Chrome DevTools Protocol command.\",\"params\":[{\"name\":\"method\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CDP method name, for example Runtime.evaluate.\"},{\"name\":\"params\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":\"object\",\"description\":\"CDP command parameters.\"},{\"name\":\"sessionId\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":\"string\",\"description\":\"Optional attached target session id.\"}],\"returns\":\"Promise<object>\",\"async\":true},{\"name\":\"evaluate\",\"signature\":\"evaluate(pageFunction, arg?) → Promise<any>\",\"description\":\"Evaluate JavaScript in the current page, Playwright-style. String expressions with top-level return statements are auto-wrapped in an IIFE for compatibility. For legacy string expressions, a string second argument is treated as a target id to evaluate in.\",\"params\":[{\"name\":\"pageFunction\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string | Function\",\"description\":\"JavaScript expression string or function called with arg.\"},{\"name\":\"arg\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":\"unknown\",\"description\":\"Optional serializable argument passed to function pageFunctions.\"}],\"returns\":\"Promise<any>\",\"async\":true},{\"name\":\"runtimeEvaluate\",\"signature\":\"runtimeEvaluate(expression, sessionId?, awaitPromise?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"expression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null},{\"name\":\"awaitPromise\",\"optional\":true,\"rest\":false,\"default\":\"false\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"runtimeValue\",\"signature\":\"runtimeValue(response, expression)\",\"description\":null,\"params\":[{\"name\":\"response\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"expression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"jsExceptionDescription\",\"signature\":\"jsExceptionDescription(result, details)\",\"description\":null,\"params\":[{\"name\":\"result\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"details\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"decodeUnserializableJsValue\",\"signature\":\"decodeUnserializableJsValue(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"jsSnippet\",\"signature\":\"jsSnippet(expression, limit?)\",\"description\":null,\"params\":[{\"name\":\"expression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"limit\",\"optional\":true,\"rest\":false,\"default\":\"160\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"hasReturnStatement\",\"signature\":\"hasReturnStatement(expression)\",\"description\":null,\"params\":[{\"name\":\"expression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"serializedArg$1\",\"signature\":\"serializedArg$1(arg)\",\"description\":null,\"params\":[{\"name\":\"arg\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"waitForDocumentLoad\",\"signature\":\"waitForDocumentLoad(options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"goto\",\"signature\":\"goto(url, options?) → Promise<{navigation: object, loaded: boolean\",\"description\":\"Navigate the current tab to a URL and, by default, wait for it to load. `waitUntil: \\\"commit\\\"` returns once navigation is issued without waiting for the document to load. `timeout` and `settle` are in milliseconds.\",\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Absolute or browser-supported URL to load.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<{navigation: object, loaded: boolean\",\"async\":true},{\"name\":\"pageInfo\",\"signature\":\"pageInfo() → Promise<{url:string,title:string,w:number,h:number,sx:number,sy:number,pw:number,ph:number\",\"description\":\"Read basic state for the current page.\",\"params\":[],\"returns\":\"Promise<{url:string,title:string,w:number,h:number,sx:number,sy:number,pw:number,ph:number\",\"async\":true},{\"name\":\"listTabs\",\"signature\":\"listTabs(options?) → Promise<Array<{targetId:string,title:string,url:string\",\"description\":\"List open page targets known to the browser.\",\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<Array<{targetId:string,title:string,url:string\",\"async\":true},{\"name\":\"currentTab\",\"signature\":\"currentTab() → Promise<{targetId:string,url:string,title:string\",\"description\":\"Return the currently attached tab.\",\"params\":[],\"returns\":\"Promise<{targetId:string,url:string,title:string\",\"async\":true},{\"name\":\"switchTab\",\"signature\":\"switchTab(target) → Promise<string>\",\"description\":\"Activate an existing tab target.\",\"params\":[{\"name\":\"target\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"newTab\",\"signature\":\"newTab(url?) → Promise<string>\",\"description\":\"Open a new tab and optionally navigate it.\",\"params\":[{\"name\":\"url\",\"optional\":true,\"rest\":false,\"default\":\"\\\"about:blank\\\"\",\"type\":null,\"description\":null}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"openOrReuseTab\",\"signature\":\"openOrReuseTab(url, options?) → Promise<{targetId:string,url:string,title:string,active:boolean,index?:number,reused:boolean\",\"description\":\"Reuse an existing matching tab or open a new one.\",\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"URL to find or open.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<{targetId:string,url:string,title:string,active:boolean,index?:number,reused:boolean\",\"async\":true},{\"name\":\"closeTab\",\"signature\":\"closeTab(target?) → Promise<string>\",\"description\":\"Close a browser tab by target id, tab object, or the current tab when omitted.\",\"params\":[{\"name\":\"target\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"ensureRealTab\",\"signature\":\"ensureRealTab() → Promise<{targetId:string,title:string,url:string\",\"description\":\"Ensure the active harness session points at a real, non-internal page tab.\",\"params\":[],\"returns\":\"Promise<{targetId:string,title:string,url:string\",\"async\":true},{\"name\":\"iframeTarget\",\"signature\":\"iframeTarget(urlSubstring) → Promise<string|null>\",\"description\":\"Find an iframe target whose URL contains a substring.\",\"params\":[{\"name\":\"urlSubstring\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"URL substring to match.\"}],\"returns\":\"Promise<string|null>\",\"async\":true},{\"name\":\"tabMatchesUrl\",\"signature\":\"tabMatchesUrl(tabUrl, wantedUrl, match)\",\"description\":null,\"params\":[{\"name\":\"tabUrl\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"wantedUrl\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"match\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"trimSlash\",\"signature\":\"trimSlash(pathname)\",\"description\":null,\"params\":[{\"name\":\"pathname\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"targetIdFrom\",\"signature\":\"targetIdFrom(target, operation)\",\"description\":null,\"params\":[{\"name\":\"target\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"operation\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"currentTargetFrom\",\"signature\":\"currentTargetFrom(tabs, targetId, operation)\",\"description\":null,\"params\":[{\"name\":\"tabs\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"targetId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"operation\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"waitForClosedTarget\",\"signature\":\"waitForClosedTarget(targetId) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"targetId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"parseRef\",\"signature\":\"parseRef(input)\",\"description\":null,\"params\":[{\"name\":\"input\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"queryAllExpression\",\"signature\":\"queryAllExpression(selector, rootExpression?)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"rootExpression\",\"optional\":true,\"rest\":false,\"default\":\"\\\"document\\\"\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseInternalJson\",\"signature\":\"parseInternalJson(selector, kind)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"kind\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseInternalNth\",\"signature\":\"parseInternalNth(selector)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"filterCondition\",\"signature\":\"filterCondition(filter, elementExpression)\",\"description\":null,\"params\":[{\"name\":\"filter\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"elementExpression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"querySelectorAllExpression\",\"signature\":\"querySelectorAllExpression(rootExpression, selector)\",\"description\":null,\"params\":[{\"name\":\"rootExpression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parsePlaywrightHasTextSelector\",\"signature\":\"parsePlaywrightHasTextSelector(selector)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseQuotedTextArgument\",\"signature\":\"parseQuotedTextArgument(raw)\",\"description\":null,\"params\":[{\"name\":\"raw\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"hrefElementsExpression\",\"signature\":\"hrefElementsExpression(href, rootExpression?)\",\"description\":null,\"params\":[{\"name\":\"href\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"rootExpression\",\"optional\":true,\"rest\":false,\"default\":\"\\\"document\\\"\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseTextLocator$1\",\"signature\":\"parseTextLocator$1(raw)\",\"description\":null,\"params\":[{\"name\":\"raw\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseLocatorString\",\"signature\":\"parseLocatorString(raw)\",\"description\":null,\"params\":[{\"name\":\"raw\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"textMatcherExpression\",\"signature\":\"textMatcherExpression(valueExpression, matcher)\",\"description\":null,\"params\":[{\"name\":\"valueExpression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"matcher\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"textMatchExpression\",\"signature\":\"textMatchExpression(valueExpression, text, exact)\",\"description\":null,\"params\":[{\"name\":\"valueExpression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"text\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"exact\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"textElementsExpression\",\"signature\":\"textElementsExpression(locator, rootExpression?)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"rootExpression\",\"optional\":true,\"rest\":false,\"default\":\"\\\"document\\\"\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"labelElementsExpression\",\"signature\":\"labelElementsExpression(locator, rootExpression?)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"rootExpression\",\"optional\":true,\"rest\":false,\"default\":\"\\\"document\\\"\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"attributeElementsExpression\",\"signature\":\"attributeElementsExpression(selector, attribute, locator, rootExpression?)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"attribute\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"rootExpression\",\"optional\":true,\"rest\":false,\"default\":\"\\\"document\\\"\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseRoleLocator\",\"signature\":\"parseRoleLocator(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"roleElementsExpression\",\"signature\":\"roleElementsExpression(locator, rootExpression?)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"rootExpression\",\"optional\":true,\"rest\":false,\"default\":\"\\\"document\\\"\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"roleNameCondition\",\"signature\":\"roleNameCondition(name)\",\"description\":null,\"params\":[{\"name\":\"name\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseLocatorMatcher\",\"signature\":\"parseLocatorMatcher(raw)\",\"description\":null,\"params\":[{\"name\":\"raw\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isTextMatcher$1\",\"signature\":\"isTextMatcher$1(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"roleCandidateSelector\",\"signature\":\"roleCandidateSelector()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"queryRoleLocatorBackendNodeIds\",\"signature\":\"queryRoleLocatorBackendNodeIds(cdp, sessionId, selectorOrRef) → Promise<...>\",\"description\":\"Return the ordered AX backend-node match set for a root role locator. Non-role selectors return null so callers can use their normal DOM path.\",\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"exceptionText\",\"signature\":\"exceptionText(result)\",\"description\":null,\"params\":[{\"name\":\"result\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"matchCountKind\",\"signature\":\"matchCountKind(message)\",\"description\":null,\"params\":[{\"name\":\"message\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"selectorResolutionError\",\"signature\":\"selectorResolutionError(selector, result)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"result\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"resolveElementCenter\",\"signature\":\"resolveElementCenter(cdp, sessionId, refMap, selectorOrRef, iframeSessions?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"refMap\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"iframeSessions\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"resolveElementObjectId\",\"signature\":\"resolveElementObjectId(cdp, sessionId, refMap, selectorOrRef, iframeSessions?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"refMap\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"iframeSessions\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"resolveFrameSession\",\"signature\":\"resolveFrameSession(frameId, sessionId, iframeSessions)\",\"description\":null,\"params\":[{\"name\":\"frameId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"iframeSessions\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"resolveLocatorCenter\",\"signature\":\"resolveLocatorCenter(cdp, sessionId, locator) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"resolveLocatorObjectId\",\"signature\":\"resolveLocatorObjectId(cdp, sessionId, locator) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"locatorCount\",\"signature\":\"locatorCount(cdp, sessionId, locator) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"findBackendNodeIdByRoleName\",\"signature\":\"findBackendNodeIdByRoleName(cdp, sessionId, role, name, nth?, frameId?, iframeSessions?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"role\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"name\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"nth\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null},{\"name\":\"frameId\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null},{\"name\":\"iframeSessions\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"findBackendNodeIdsByRoleName\",\"signature\":\"findBackendNodeIdsByRoleName(cdp, sessionId, role, name, frameId?, iframeSessions?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"role\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"name\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"frameId\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null},{\"name\":\"iframeSessions\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"findUniqueBackendNodeIdByRoleName\",\"signature\":\"findUniqueBackendNodeIdByRoleName(cdp, sessionId, role, name) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"role\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"name\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"resolveAxSession\",\"signature\":\"resolveAxSession(frameId, sessionId, iframeSessions)\",\"description\":null,\"params\":[{\"name\":\"frameId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"iframeSessions\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"buildFindElementJs\",\"signature\":\"buildFindElementJs(selector)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"buildLocatorFindJs\",\"signature\":\"buildLocatorFindJs(locator)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"buildLocatorCountJs\",\"signature\":\"buildLocatorCountJs(locator)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"buildLocatorCenterJs\",\"signature\":\"buildLocatorCenterJs(locator)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"hrefElementsJs\",\"signature\":\"hrefElementsJs(href)\",\"description\":null,\"params\":[{\"name\":\"href\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"buildLocatorAllJs\",\"signature\":\"buildLocatorAllJs(locator)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"textElementsJs\",\"signature\":\"textElementsJs(locator)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"labelElementsJs\",\"signature\":\"labelElementsJs(locator)\",\"description\":null,\"params\":[{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"attributeElementsJs\",\"signature\":\"attributeElementsJs(selector, attribute, locator)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"attribute\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"locator\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"textMatchJs\",\"signature\":\"textMatchJs(valueExpression, text, exact)\",\"description\":null,\"params\":[{\"name\":\"valueExpression\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"text\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"exact\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"buildSelectorCenterJs\",\"signature\":\"buildSelectorCenterJs(selector)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseLocator\",\"signature\":\"parseLocator(input)\",\"description\":null,\"params\":[{\"name\":\"input\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseLocatorName\",\"signature\":\"parseLocatorName(raw)\",\"description\":null,\"params\":[{\"name\":\"raw\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseTextLocator\",\"signature\":\"parseTextLocator(raw)\",\"description\":null,\"params\":[{\"name\":\"raw\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"boxModelCenter\",\"signature\":\"boxModelCenter(model?)\",\"description\":null,\"params\":[{\"name\":\"model\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"extractAxString\",\"signature\":\"extractAxString(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"axNameMatches\",\"signature\":\"axNameMatches(actual, expected)\",\"description\":null,\"params\":[{\"name\":\"actual\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"expected\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isTextMatcher\",\"signature\":\"isTextMatcher(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"send\",\"signature\":\"send(cdp, method, params?, sessionId?)\",\"description\":null,\"params\":[{\"name\":\"cdp\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"method\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"params\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null},{\"name\":\"sessionId\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"registerSnapshotForRefRefresh\",\"signature\":\"registerSnapshotForRefRefresh(fn)\",\"description\":null,\"params\":[{\"name\":\"fn\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"ensureRefMapForRef\",\"signature\":\"ensureRefMapForRef(selectorOrRef) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"drainEvents\",\"signature\":\"drainEvents()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"snapshotRaw\",\"signature\":\"snapshotRaw(options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"snapshot\",\"signature\":\"snapshot(options?) → Promise<string>\",\"description\":\"Return snapshot content with agent-friendly defaults. The text surface most agents want; use snapshotRaw when you need the structured { content, refs }.\",\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"elementCenter\",\"signature\":\"elementCenter(selectorOrRef) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"screenshot\",\"signature\":\"screenshot(options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"resolveHandle\",\"signature\":\"resolveHandle(selectorOrRef) → Promise<{objectId: string, sessionId?: string\",\"description\":\"Resolve any selector form to a CDP Runtime objectId handle. Accepts @ref / ref=N, loc=css:/loc=role:/loc=href:, xpath=, and raw CSS — the same surface as the pointer/observe helpers, via the unified resolver. Refreshes the RefMap on demand when the input is a ref and the map is empty.\",\"params\":[{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Selector or ref string.\"}],\"returns\":\"Promise<{objectId: string, sessionId?: string\",\"async\":true},{\"name\":\"releaseHandle\",\"signature\":\"releaseHandle(objectId, sessionId) → Promise<void>\",\"description\":\"Release a Runtime objectId handle. Best-effort: swallows \\\"already gone\\\" errors (stale handle, lost session, destroyed context).\",\"params\":[{\"name\":\"objectId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Runtime remote object id to release.\"},{\"name\":\"sessionId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Session that owns the handle.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"withHandle\",\"signature\":\"withHandle(selectorOrRef, fn) → Promise<any>\",\"description\":\"Resolve a handle, run fn(handle), then release the handle — even if fn throws.\",\"params\":[{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Selector or ref string.\"},{\"name\":\"fn\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<any>\",\"async\":true},{\"name\":\"resolveAndCall\",\"signature\":\"resolveAndCall(selectorOrRef, functionDeclaration, args?) → Promise<{result: any, objectId: string, sessionId?: string\",\"description\":\"Resolve an element and call a function on it via Runtime.callFunctionOn, with the element bound as `this`. The resolved handle is released afterward; the returned objectId is already freed and must not be reused.\",\"params\":[{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Selector or ref string.\"},{\"name\":\"functionDeclaration\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Function source whose `this` is the element.\"},{\"name\":\"args\",\"optional\":true,\"rest\":false,\"default\":\"[]\",\"type\":null,\"description\":null}],\"returns\":\"Promise<{result: any, objectId: string, sessionId?: string\",\"async\":true},{\"name\":\"waitForTimeout\",\"signature\":\"waitForTimeout(ms?) → Promise<void>\",\"description\":\"Sleep for a fixed number of milliseconds.\",\"params\":[{\"name\":\"ms\",\"optional\":true,\"rest\":false,\"default\":\"1000\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"waitForFunction\",\"signature\":\"waitForFunction(pageFunction, argOrOptions?, options?) → Promise<unknown|false>\",\"description\":\"Poll a page function or expression until it returns a truthy value.\",\"params\":[{\"name\":\"pageFunction\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|Function\",\"description\":\"Browser-side expression or function.\"},{\"name\":\"argOrOptions\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<unknown|false>\",\"async\":true},{\"name\":\"waitForURL\",\"signature\":\"waitForURL(url, options?) → Promise<boolean>\",\"description\":\"Wait for the current page URL to match a string, glob, RegExp, or predicate. `waitUntil` defaults to `\\\"load\\\"`.\",\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|RegExp|Function\",\"description\":\"URL matcher. Predicate functions receive a URL object. Strings with * are treated as globs; other strings are exact.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"waitForRequest\",\"signature\":\"waitForRequest(urlOrPredicate, options?) → Promise<object>\",\"description\":\"Wait for a network request whose URL or request facade matches.\",\"params\":[{\"name\":\"urlOrPredicate\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|RegExp|Function\",\"description\":\"Exact URL, RegExp, or synchronous request predicate.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<object>\",\"async\":true},{\"name\":\"waitForResponse\",\"signature\":\"waitForResponse(urlOrPredicate, options?) → Promise<object>\",\"description\":\"Wait for a network response whose URL or response facade matches.\",\"params\":[{\"name\":\"urlOrPredicate\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|RegExp|Function\",\"description\":\"Exact URL, RegExp, or synchronous response predicate.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<object>\",\"async\":true},{\"name\":\"waitForLoadState\",\"signature\":\"waitForLoadState(loadState?, options?) → Promise<boolean>\",\"description\":\"Wait for a page load state. `\\\"networkidle\\\"` waits until network traffic goes idle; `\\\"domcontentloaded\\\"` until the DOM is interactive; otherwise until document.readyState is complete.\",\"params\":[{\"name\":\"loadState\",\"optional\":true,\"rest\":false,\"default\":\"\\\"load\\\"\",\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"normalizeLoadStateArgs\",\"signature\":\"normalizeLoadStateArgs(loadState, options)\",\"description\":null,\"params\":[{\"name\":\"loadState\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"normalizeWaitForFunctionArgs\",\"signature\":\"normalizeWaitForFunctionArgs(length, argOrOptions, options)\",\"description\":null,\"params\":[{\"name\":\"length\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"argOrOptions\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isWaitForFunctionOptions\",\"signature\":\"isWaitForFunctionOptions(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"buildWaitForFunctionExpression\",\"signature\":\"buildWaitForFunctionExpression(pageFunction, arg)\",\"description\":null,\"params\":[{\"name\":\"pageFunction\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"arg\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"urlMatches\",\"signature\":\"urlMatches(current, matcher)\",\"description\":null,\"params\":[{\"name\":\"current\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"matcher\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"globToRegExp\",\"signature\":\"globToRegExp(glob)\",\"description\":null,\"params\":[{\"name\":\"glob\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"waitForNetworkMatch\",\"signature\":\"waitForNetworkMatch(kind, matcher, options) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"kind\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"matcher\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"processNetworkEvent\",\"signature\":\"processNetworkEvent(kind, matcher, event, requests, timeout)\",\"description\":null,\"params\":[{\"name\":\"kind\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"matcher\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"event\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"requests\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"timeout\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"networkMatches\",\"signature\":\"networkMatches(facade, matcher, kind)\",\"description\":null,\"params\":[{\"name\":\"facade\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"matcher\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"kind\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"createRequestInfo\",\"signature\":\"createRequestInfo(params)\",\"description\":null,\"params\":[{\"name\":\"params\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"createRequestFacade\",\"signature\":\"createRequestFacade(info)\",\"description\":null,\"params\":[{\"name\":\"info\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"createResponseFacade\",\"signature\":\"createResponseFacade(info, timeout)\",\"description\":null,\"params\":[{\"name\":\"info\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"timeout\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"readResponseBody\",\"signature\":\"readResponseBody(requestId, timeout) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"requestId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"timeout\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"normalizeHeaders\",\"signature\":\"normalizeHeaders(headers?)\",\"description\":null,\"params\":[{\"name\":\"headers\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"networkTimeout\",\"signature\":\"networkTimeout(options)\",\"description\":null,\"params\":[{\"name\":\"options\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"browserEventTimeout\",\"signature\":\"browserEventTimeout(timeout)\",\"description\":null,\"params\":[{\"name\":\"timeout\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"acquireNetworkEvents\",\"signature\":\"acquireNetworkEvents()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"waitForSelector\",\"signature\":\"waitForSelector(selector, options?) → Promise<boolean>\",\"description\":\"Wait until an element exists, optionally requiring visibility.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= to poll.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"waitForNetworkIdle\",\"signature\":\"waitForNetworkIdle(options?) → Promise<boolean>\",\"description\":\"Wait until network events are idle. Module-private; reachable through waitForLoadState(\\\"networkidle\\\"). Enables the CDP Network domain for the duration of the wait so that network events are actually delivered (previously nothing enabled the domain, so this could report \\\"idle\\\" without ever observing traffic). If the caller had already enabled the domain, it is left enabled on return. Best-effort: if the runtime does not deliver Network events, an idle window of idleMs still resolves true.\",\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"click\",\"signature\":\"click(target, options?) → Promise<void>\",\"description\":\"Click a mouse target.\",\"params\":[{\"name\":\"target\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"MouseTarget\",\"description\":\"CSS selector, @ref, viewport point, or selector-relative point.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"dblclick\",\"signature\":\"dblclick(target, options?) → Promise<void>\",\"description\":\"Double-click a mouse target.\",\"params\":[{\"name\":\"target\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"MouseTarget\",\"description\":\"CSS selector, @ref, viewport point, or selector-relative point.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"hover\",\"signature\":\"hover(target, options?) → Promise<void>\",\"description\":\"Move the mouse over a target without pressing a button.\",\"params\":[{\"name\":\"target\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"MouseTarget\",\"description\":\"CSS selector, @ref, viewport point, or selector-relative point.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"drag\",\"signature\":\"drag(points, options?) → Promise<void>\",\"description\":\"Drag the mouse through a sequence of targets while holding a button.\",\"params\":[{\"name\":\"points\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"MouseTarget[]\",\"description\":\"Ordered drag path. Must contain at least two targets.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"down$1\",\"signature\":\"down$1(options?) → Promise<void>\",\"description\":\"Press a mouse button at the current mouse position, Playwright-style.\",\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"up$1\",\"signature\":\"up$1(options?) → Promise<void>\",\"description\":\"Release a mouse button at the current mouse position, Playwright-style.\",\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"inputEventDelay$1\",\"signature\":\"inputEventDelay$1(ms?)\",\"description\":null,\"params\":[{\"name\":\"ms\",\"optional\":true,\"rest\":false,\"default\":\"INPUT_EVENT_DELAY_MS$1\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"installClickProbe\",\"signature\":\"installClickProbe(point) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"finishClickProbe\",\"signature\":\"finishClickProbe(point, id, clickCount) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"id\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"clickCount\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"installMouseUpProbe\",\"signature\":\"installMouseUpProbe(point) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"installHoverProbe\",\"signature\":\"installHoverProbe(point) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"finishHoverProbe\",\"signature\":\"finishHoverProbe(point, id) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"id\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"finishDragProbe\",\"signature\":\"finishDragProbe(points, id, button) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"points\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"id\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"button\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"canProbeInputFallback$1\",\"signature\":\"canProbeInputFallback$1()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"wheel\",\"signature\":\"wheel(deltaX?, deltaY?, options?) → Promise<void>\",\"description\":\"Dispatch a mouse wheel scroll, Playwright-style (mouse.wheel(deltaX, deltaY)). Sign convention follows the DOM WheelEvent: positive deltaY scrolls down, negative scrolls up (CDP negates deltas internally when building the Blink wheel event, so the DOM convention applies end to end). Defaults to scrolling down by 300 CSS pixels. A visible, focused page receives the wheel through CDP (Input.dispatchMouseEvent), exactly like Playwright. A backgrounded or unfocused tab silently drops CDP wheel input, so there the scroll is dispatched as a synthetic WheelEvent on the element at (x, y) instead.\",\"params\":[{\"name\":\"deltaX\",\"optional\":true,\"rest\":false,\"default\":\"0\",\"type\":null,\"description\":null},{\"name\":\"deltaY\",\"optional\":true,\"rest\":false,\"default\":\"300\",\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"isVisibleAndFocused\",\"signature\":\"isVisibleAndFocused() → Promise<...>\",\"description\":\"Whether the page is currently visible and focused. CDP wheel input is delivered only to a foreground, focused target; otherwise wheel() routes through a synthetic WheelEvent. Defaults to true when the probe fails so a flaky probe never blocks a real foreground scroll.\",\"params\":[],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"dispatchSyntheticWheel\",\"signature\":\"dispatchSyntheticWheel(x, y, deltaX, deltaY) → Promise<...>\",\"description\":\"Dispatch a synthetic WheelEvent on the element under (x, y), then perform the native scroll. Used when the tab is backgrounded/unfocused and CDP wheel input would be dropped. The WheelEvent triggers page wheel handlers (virtualized lists, custom scrollers); the window.scrollBy actually moves an ordinary page, since an untrusted WheelEvent does not perform the default scroll action. The manual scroll is skipped when a handler calls preventDefault(), matching how a real CDP wheel leaves the page in place (maps, canvases, custom scrollers).\",\"params\":[{\"name\":\"x\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"y\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"deltaX\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"deltaY\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"scrollIntoViewIfNeeded\",\"signature\":\"scrollIntoViewIfNeeded(selector) → Promise<void>\",\"description\":\"Scroll an element into view only if it is not already fully visible, mirroring Playwright's locator.scrollIntoViewIfNeeded.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector or @ref of the element to reveal.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"maybeHighlight\",\"signature\":\"maybeHighlight(point, label)\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"label\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"rememberMousePoint\",\"signature\":\"rememberMousePoint(point)\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"dispatchMouse\",\"signature\":\"dispatchMouse(point, type, options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"type\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"isInputDispatchTimeout\",\"signature\":\"isInputDispatchTimeout(error)\",\"description\":null,\"params\":[{\"name\":\"error\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"resolveMouseTarget\",\"signature\":\"resolveMouseTarget(target, timeout?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"target\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"timeout\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"elementTopLeft\",\"signature\":\"elementTopLeft(selectorOrRef) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selectorOrRef\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"pointFrom\",\"signature\":\"pointFrom(point)\",\"description\":null,\"params\":[{\"name\":\"point\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"numberValue\",\"signature\":\"numberValue(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"pressedButtons\",\"signature\":\"pressedButtons(button)\",\"description\":null,\"params\":[{\"name\":\"button\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"keyDefinition\",\"signature\":\"keyDefinition(key)\",\"description\":null,\"params\":[{\"name\":\"key\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"editingCommandsForKey\",\"signature\":\"editingCommandsForKey(key, modifiers)\",\"description\":null,\"params\":[{\"name\":\"key\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"modifiers\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"parseKeyCombo\",\"signature\":\"parseKeyCombo(combo)\",\"description\":\"Parse a Playwright-style key combo (\\\"Control+a\\\", \\\"Shift+Tab\\\") into a base key and a CDP modifier bitfield. Modifiers: Control, Shift, Alt, Meta, ControlOrMeta.\",\"params\":[{\"name\":\"combo\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"modifierName\",\"signature\":\"modifierName(key)\",\"description\":null,\"params\":[{\"name\":\"key\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"modifierBitForKey\",\"signature\":\"modifierBitForKey(key)\",\"description\":null,\"params\":[{\"name\":\"key\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"activeModifierBits\",\"signature\":\"activeModifierBits()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"keyEventBase\",\"signature\":\"keyEventBase(key, modifiers)\",\"description\":null,\"params\":[{\"name\":\"key\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"modifiers\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"down\",\"signature\":\"down(keyCombo) → Promise<void>\",\"description\":\"Dispatch a keydown event and keep modifier keys active until keyboard.up().\",\"params\":[{\"name\":\"keyCombo\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Key or modifier+key combo.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"up\",\"signature\":\"up(keyCombo) → Promise<void>\",\"description\":\"Dispatch a keyup event and release modifier keys.\",\"params\":[{\"name\":\"keyCombo\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Key or modifier+key combo.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"press\",\"signature\":\"press(keyCombo) → Promise<void>\",\"description\":\"Dispatch a key press through CDP. Combine modifiers with \\\"+\\\".\",\"params\":[{\"name\":\"keyCombo\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Key or modifier+key combo: \\\"Enter\\\", \\\"a\\\", \\\"Control+a\\\", \\\"Shift+Tab\\\". Modifiers: Control, Shift, Alt, Meta, ControlOrMeta.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"insertText\",\"signature\":\"insertText(text) → Promise<void>\",\"description\":\"Insert text at the focused input using CDP Input.insertText.\",\"params\":[{\"name\":\"text\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Text to insert.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"typeText\",\"signature\":\"typeText(text, options?) → Promise<void>\",\"description\":\"Type text with key events, Playwright-style keyboard.type().\",\"params\":[{\"name\":\"text\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Text to type.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"focus\",\"signature\":\"focus(selector) → Promise<void>\",\"description\":\"Focus an element.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"fill\",\"signature\":\"fill(selector, value, options?) → Promise<void>\",\"description\":\"Focus an input, optionally clear it, write a value, and fire input/change events.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the input-like element.\"},{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Text to write.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"pressSequentially\",\"signature\":\"pressSequentially(selectorOrText, textOrOptions?, options?) → Promise<void>\",\"description\":\"Press a sequence of characters, optionally focusing a target first.\",\"params\":[{\"name\":\"selectorOrText\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Selector when text is provided, otherwise text for the current focus.\"},{\"name\":\"textOrOptions\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"pressOnSelector\",\"signature\":\"pressOnSelector(selector, keyCombo, options?) → Promise<void>\",\"description\":\"Focus an element and press a key combo, Playwright-style locator.press().\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"},{\"name\":\"keyCombo\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Key or modifier+key combo.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"check\",\"signature\":\"check(selector) → Promise<void>\",\"description\":\"Set a checkbox or radio to checked.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the input.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"uncheck\",\"signature\":\"uncheck(selector) → Promise<void>\",\"description\":\"Set a checkbox to unchecked.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the checkbox.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"setChecked\",\"signature\":\"setChecked(selector, checked) → Promise<void>\",\"description\":\"Set the checked state of a checkbox or radio, Playwright-style.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the input.\"},{\"name\":\"checked\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"boolean\",\"description\":\"Desired checked state.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"selectOption\",\"signature\":\"selectOption(selector, values) → Promise<string[]>\",\"description\":\"Select one or more options in a <select>.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the select.\"},{\"name\":\"values\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|number|object|Array<string|number|object>\",\"description\":\"Option value(s), labels, or indexes.\"}],\"returns\":\"Promise<string[]>\",\"async\":true},{\"name\":\"focusWithTimeout\",\"signature\":\"focusWithTimeout(selector, timeout?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"timeout\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"dispatchEvent\",\"signature\":\"dispatchEvent(selector, type, eventInit?) → Promise<void>\",\"description\":\"Dispatch a synthetic DOM event on an element, mirroring Playwright's locator.dispatchEvent. The event type picks the constructor — keydown/keyup/ keypress -> KeyboardEvent, click/mousedown/... -> MouseEvent, and pointer* / focus / blur / drag* / wheel -> their typed events; any other type (input, change, touch*, custom events, ...) uses a generic Event. eventInit is spread verbatim onto { bubbles: true, cancelable: true, composed: true } and passed to the constructor. Note: the dispatched event has isTrusted=false; some frameworks ignore it. For real keyboard input prefer press().\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the target element.\"},{\"name\":\"type\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"DOM event type, e.g. \\\"keydown\\\", \\\"click\\\", \\\"input\\\".\"},{\"name\":\"eventInit\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"inputEventDelay\",\"signature\":\"inputEventDelay()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"dispatchKeyEvent\",\"signature\":\"dispatchKeyEvent(params) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"params\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"installKeyProbe\",\"signature\":\"installKeyProbe(key) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"key\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"finishKeyProbe\",\"signature\":\"finishKeyProbe(id, definition) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"id\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"definition\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"canProbeInputFallback\",\"signature\":\"canProbeInputFallback()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"isKeyDispatchTimeout\",\"signature\":\"isKeyDispatchTimeout(error)\",\"description\":null,\"params\":[{\"name\":\"error\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"textContent\",\"signature\":\"textContent(selector) → Promise<string|null>\",\"description\":\"Return element.textContent for a single element.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<string|null>\",\"async\":true},{\"name\":\"innerText\",\"signature\":\"innerText(selector) → Promise<string>\",\"description\":\"Return element.innerText for a single HTMLElement.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"innerHTML\",\"signature\":\"innerHTML(selector) → Promise<string>\",\"description\":\"Return element.innerHTML for a single element.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"inputValue\",\"signature\":\"inputValue(selector) → Promise<string>\",\"description\":\"Return value for an input, textarea, or select.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the form control.\"}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"isChecked\",\"signature\":\"isChecked(selector) → Promise<boolean>\",\"description\":\"Return checked state for a checkbox or radio.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the input.\"}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"isVisible\",\"signature\":\"isVisible(selector) → Promise<boolean>\",\"description\":\"Return whether the element is visible. Missing elements return false.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"isHidden\",\"signature\":\"isHidden(selector) → Promise<boolean>\",\"description\":\"Return whether the element is hidden. Missing elements return true.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"isEnabled\",\"signature\":\"isEnabled(selector) → Promise<boolean>\",\"description\":\"Return whether the element is enabled. Missing elements return false.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"isDisabled\",\"signature\":\"isDisabled(selector) → Promise<boolean>\",\"description\":\"Return whether the element is disabled. Missing elements return true.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"isEditable\",\"signature\":\"isEditable(selector) → Promise<boolean>\",\"description\":\"Return whether the element is editable. Missing elements return false.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<boolean>\",\"async\":true},{\"name\":\"getAttribute\",\"signature\":\"getAttribute(selector, name) → Promise<string|null>\",\"description\":\"Return a DOM attribute value for a single element.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"},{\"name\":\"name\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Attribute name.\"}],\"returns\":\"Promise<string|null>\",\"async\":true},{\"name\":\"blur\",\"signature\":\"blur(selector) → Promise<void>\",\"description\":\"Remove focus from an element.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"boundingBox\",\"signature\":\"boundingBox(selector) → Promise<{x:number,y:number,width:number,height:number\",\"description\":\"Return the element bounding box in viewport CSS pixels.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"}],\"returns\":\"Promise<{x:number,y:number,width:number,height:number\",\"async\":true},{\"name\":\"count\",\"signature\":\"count(selector) → Promise<number>\",\"description\":\"Count matching elements. Supports CSS, xpath=, loc=css:, loc=href:, and refs.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Selector to query.\"}],\"returns\":\"Promise<number>\",\"async\":true},{\"name\":\"allInnerTexts\",\"signature\":\"allInnerTexts(selector) → Promise<string[]>\",\"description\":\"Return innerText for all matching HTMLElement nodes.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Selector to query.\"}],\"returns\":\"Promise<string[]>\",\"async\":true},{\"name\":\"allTextContents\",\"signature\":\"allTextContents(selector) → Promise<Array<string|null>>\",\"description\":\"Return textContent for all matching nodes.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Selector to query.\"}],\"returns\":\"Promise<Array<string|null>>\",\"async\":true},{\"name\":\"evaluateLocator\",\"signature\":\"evaluateLocator(selector, pageFunction, arg?) → Promise<unknown>\",\"description\":\"Execute JavaScript against one matching element, Playwright-style.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for the element.\"},{\"name\":\"pageFunction\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"Function|string\",\"description\":\"Function source called with (element, arg).\"},{\"name\":\"arg\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":\"unknown\",\"description\":\"Optional serializable argument.\"}],\"returns\":\"Promise<unknown>\",\"async\":true},{\"name\":\"evaluateAll\",\"signature\":\"evaluateAll(selector, pageFunction, arg?) → Promise<unknown>\",\"description\":\"Execute JavaScript against all matching elements, Playwright-style.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Selector to query.\"},{\"name\":\"pageFunction\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"Function|string\",\"description\":\"Function source called with (elements, arg).\"},{\"name\":\"arg\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":\"unknown\",\"description\":\"Optional serializable argument.\"}],\"returns\":\"Promise<unknown>\",\"async\":true},{\"name\":\"readElement\",\"signature\":\"readElement(selector, functionDeclaration, args?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"functionDeclaration\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"args\",\"optional\":true,\"rest\":false,\"default\":\"[]\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"readElementOnce\",\"signature\":\"readElementOnce(selector, functionDeclaration, args?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"functionDeclaration\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"args\",\"optional\":true,\"rest\":false,\"default\":\"[]\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"readOptionalElement\",\"signature\":\"readOptionalElement(selector, functionDeclaration, args?, fallback) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"functionDeclaration\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"args\",\"optional\":true,\"rest\":false,\"default\":\"[]\",\"type\":null,\"description\":null},{\"name\":\"fallback\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"readQueryAll\",\"signature\":\"readQueryAll(selector, body) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"body\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"evaluateRoleBackendNodes\",\"signature\":\"evaluateRoleBackendNodes(backendNodeIds, functionSource, arg, awaitPromise) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"backendNodeIds\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"functionSource\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"arg\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"awaitPromise\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"queryRoleBackendNodeIds\",\"signature\":\"queryRoleBackendNodeIds(selector)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"evaluateQueryAll\",\"signature\":\"evaluateQueryAll(selector, functionSource, arg) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"functionSource\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"arg\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"pageFunctionSource\",\"signature\":\"pageFunctionSource(pageFunction, helperName)\",\"description\":null,\"params\":[{\"name\":\"pageFunction\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"helperName\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"serializedArg\",\"signature\":\"serializedArg(arg)\",\"description\":null,\"params\":[{\"name\":\"arg\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"setInputFiles\",\"signature\":\"setInputFiles(selector, path) → Promise<void>\",\"description\":\"Set files on a file input.\",\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"CSS selector / @ref / loc= / xpath= for an input[type=file].\"},{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|string[]\",\"description\":\"Absolute file path or paths to upload.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"waitForEvent\",\"signature\":\"waitForEvent(eventName, options?) → Promise<object>\",\"description\":\"Wait for a Playwright-style page event. Currently supports \\\"download\\\".\",\"params\":[{\"name\":\"eventName\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"\\\"download\\\"\",\"description\":\"Event name.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<object>\",\"async\":true},{\"name\":\"waitForDownload\",\"signature\":\"waitForDownload(options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"setDownloadBehavior\",\"signature\":\"setDownloadBehavior(downloadDir) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"downloadDir\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"startScreencast\",\"signature\":\"startScreencast(options) → Promise<{dispose:()=>Promise<void>,[Symbol.asyncDispose]:()=>Promise<void>\",\"description\":\"Start recording the current page viewport to a silent VP8 WebM file. The recording is bound to the current CDP session and must be stopped in the same script.\",\"params\":[{\"name\":\"options\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<{dispose:()=>Promise<void>,[Symbol.asyncDispose]:()=>Promise<void>\",\"async\":true},{\"name\":\"stopScreencast\",\"signature\":\"stopScreencast() → Promise<void>\",\"description\":\"Stop and finalize the active page screencast. Resolves after FFmpeg closes the WebM file.\",\"params\":[],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"defaultSize\",\"signature\":\"defaultSize() → Promise<...>\",\"description\":null,\"params\":[],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"evenSize\",\"signature\":\"evenSize(size)\",\"description\":null,\"params\":[{\"name\":\"size\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"serverFetch\",\"signature\":\"serverFetch(url, options?) → Promise<string>\",\"description\":\"Fetch text from Node with a browser-like User-Agent.\",\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"URL to fetch.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"browserFetch\",\"signature\":\"browserFetch(url, options?) → Promise<string>\",\"description\":\"Fetch text in the current browser page context.\",\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"URL to fetch. Relative URLs resolve against the current page.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<string>\",\"async\":true},{\"name\":\"learningsRoot\",\"signature\":\"learningsRoot(workspace?)\",\"description\":null,\"params\":[{\"name\":\"workspace\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"siteSkillsForUrl$1\",\"signature\":\"siteSkillsForUrl$1(url, options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"iterLearningDirs\",\"signature\":\"iterLearningDirs(root) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"root\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"loadLearningManifest\",\"signature\":\"loadLearningManifest(siteDir) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"siteDir\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"learningEntry\",\"signature\":\"learningEntry(siteDir, manifest)\",\"description\":null,\"params\":[{\"name\":\"siteDir\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"manifest\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"urlHostname\",\"signature\":\"urlHostname(url)\",\"description\":null,\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"domainMatches\",\"signature\":\"domainMatches(hostname, pattern)\",\"description\":null,\"params\":[{\"name\":\"hostname\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"pattern\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"toolSchemasNode\",\"signature\":\"toolSchemasNode(manifest)\",\"description\":null,\"params\":[{\"name\":\"manifest\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"toolSchemasBrowser\",\"signature\":\"toolSchemasBrowser(manifest)\",\"description\":null,\"params\":[{\"name\":\"manifest\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"loadLearnedContext\",\"signature\":\"loadLearnedContext(url, options?) → Promise<...>\",\"description\":\"Load learned context for a given URL. Returns site knowledge (notes content, available tools, selector hints).\",\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"isLearningNotePath\",\"signature\":\"isLearningNotePath(siteDir, notePath)\",\"description\":null,\"params\":[{\"name\":\"siteDir\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"notePath\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"findSiteSkill\",\"signature\":\"findSiteSkill(siteId, options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"siteId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"runNodeSiteTool\",\"signature\":\"runNodeSiteTool(siteId, toolName, args?, ctx, options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"siteId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"toolName\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"args\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null},{\"name\":\"ctx\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"loadBrowserToolSource\",\"signature\":\"loadBrowserToolSource(siteId, toolName, options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"siteId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"toolName\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"wrapBrowserTool\",\"signature\":\"wrapBrowserTool(source, args?)\",\"description\":null,\"params\":[{\"name\":\"source\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"args\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"siteSkillNotFoundError\",\"signature\":\"siteSkillNotFoundError(siteId, searchedRoot)\",\"description\":null,\"params\":[{\"name\":\"siteId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"searchedRoot\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"toolSchemas\",\"signature\":\"toolSchemas(manifest, key)\",\"description\":null,\"params\":[{\"name\":\"manifest\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"key\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"relativeSitePath\",\"signature\":\"relativeSitePath(siteDir, manifestPath, label)\",\"description\":null,\"params\":[{\"name\":\"siteDir\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"manifestPath\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"label\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"listTaskSpaces\",\"signature\":\"listTaskSpaces() → Promise<Array<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"description\":\"List all task spaces.\",\"params\":[],\"returns\":\"Promise<Array<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"async\":true},{\"name\":\"isAgentOwned\",\"signature\":\"isAgentOwned(ownership) → boolean\",\"description\":\"Whether the agent owns the space. \\\"agentDelegatedToUser\\\" is still agent-owned — the agent created it but control is temporarily with the user (handoff / GUI takeover). Selecting such a space is fine; the user-control boundary is enforced separately at the native bridge when real commands run.\",\"params\":[{\"name\":\"ownership\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|undefined\",\"description\":null}],\"returns\":\"boolean\",\"async\":false},{\"name\":\"switchTaskSpace\",\"signature\":\"switchTaskSpace(nameOrId) → Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"description\":\"Select an existing task space by id/name for the current Node invocation.\",\"params\":[{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|number\",\"description\":\"Task space id or name.\"}],\"returns\":\"Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"async\":true},{\"name\":\"newTaskSpace\",\"signature\":\"newTaskSpace(name) → Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"description\":\"Create an agent-owned task space and select it for the current Node invocation.\",\"params\":[{\"name\":\"name\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Task space name.\"}],\"returns\":\"Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"async\":true},{\"name\":\"useOrCreateTaskSpace\",\"signature\":\"useOrCreateTaskSpace(nameOrId) → Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"description\":\"Use an existing agent-owned task space, or create it when missing. User-owned spaces are selected but not claimed (the EGO_TASK_SPACE_USER_IN_CONTROL error surfaces) — call claimTaskSpace(nameOrId) to take ownership.\",\"params\":[{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|number\",\"description\":\"Task space name or numeric id.\"}],\"returns\":\"Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"async\":true},{\"name\":\"claimTaskSpace\",\"signature\":\"claimTaskSpace(nameOrId) → Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"description\":\"Claim a user-owned task space (ownership transfers to the agent) and select it for the current Node invocation. Resolves the space by id/name, claims it via ego.claimTaskSpace, then selects it.\",\"params\":[{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|number\",\"description\":\"Task space id or name.\"}],\"returns\":\"Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]\",\"async\":true},{\"name\":\"claimResolvedTaskSpace\",\"signature\":\"claimResolvedTaskSpace(space, op?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"space\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"op\",\"optional\":true,\"rest\":false,\"default\":\"\\\"claimTaskSpace\\\"\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"selectTaskSpace\",\"signature\":\"selectTaskSpace(ego, space, op) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"ego\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"space\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"op\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"selectTaskSpaceIfProvided\",\"signature\":\"selectTaskSpaceIfProvided(ego, nameOrId, op?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"ego\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"op\",\"optional\":true,\"rest\":false,\"default\":\"\\\"taskSpace\\\"\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"completeTaskSpace\",\"signature\":\"completeTaskSpace(nameOrId, options) → Promise<{done: boolean, skipped?: \\\"user-owned\\\"\",\"description\":\"Finish working on a task space. With `{ keep: true }` the page stays open with the agent overlay dismissed so the user can review the result; with `{ keep: false }` the task space is closed entirely. User-owned spaces: `keep:true` is skipped (the user already has the page) and resolves `{ done: false, skipped: \\\"user-owned\\\" }`; `keep:false` claims the space first, then closes it.\",\"params\":[{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|number\",\"description\":\"Task space id or name.\"},{\"name\":\"options\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<{done: boolean, skipped?: \\\"user-owned\\\"\",\"async\":true},{\"name\":\"handOffTaskSpace\",\"signature\":\"handOffTaskSpace(nameOrId) → Promise<{done: boolean, skipped?: \\\"user-owned\\\"\",\"description\":\"Hand off a task space back to the user, hiding the agent overlay. User-owned spaces are skipped (the user already controls them) and resolve `{ done: false, skipped: \\\"user-owned\\\" }`.\",\"params\":[{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|number\",\"description\":\"Task space id or name. If provided, switches to that space first.\"}],\"returns\":\"Promise<{done: boolean, skipped?: \\\"user-owned\\\"\",\"async\":true},{\"name\":\"takeOverTaskSpace\",\"signature\":\"takeOverTaskSpace(nameOrId) → Promise<void>\",\"description\":\"Take over a task space, showing the agent overlay to indicate work has resumed.\",\"params\":[{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|number\",\"description\":\"Task space id or name. If provided, switches to that space first.\"}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"probeAgentControl\",\"signature\":\"probeAgentControl() → Promise<...>\",\"description\":\"Probe whether the agent currently holds control of the active task space. Module-private; used by waitForAgentControl. Uses ego.snapshot, which rejects under user-control (per ego-bindings spec) — a reliable synchronous-error signal that raw CDP sends can't provide. Other rejections (task not found, internal errors) propagate so the caller fails fast instead of busy-looping until timeout.\",\"params\":[],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"waitForAgentControl\",\"signature\":\"waitForAgentControl(nameOrId, options?) → Promise<void>\",\"description\":\"Block until the agent regains control of the named task space. Polls a harmless probe until it succeeds, or throws when the timeout elapses. Read-only — does not call takeOverTaskSpace.\",\"params\":[{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string|number\",\"description\":\"Task space id or name.\"},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<void>\",\"async\":true},{\"name\":\"normalizeTaskSpaces\",\"signature\":\"normalizeTaskSpaces(raw)\",\"description\":null,\"params\":[{\"name\":\"raw\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"normalizeTaskSpace\",\"signature\":\"normalizeTaskSpace(space)\",\"description\":null,\"params\":[{\"name\":\"space\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"taskSpaceNumericId\",\"signature\":\"taskSpaceNumericId(space, op)\",\"description\":null,\"params\":[{\"name\":\"space\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"op\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"findTaskSpace\",\"signature\":\"findTaskSpace(nameOrId) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"findMatchingTaskSpace\",\"signature\":\"findMatchingTaskSpace(spaces, nameOrId)\",\"description\":null,\"params\":[{\"name\":\"spaces\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"nameOrId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"siteSkillsForUrl\",\"signature\":\"siteSkillsForUrl(url) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"url\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"siteSkills\",\"signature\":\"siteSkills(url?) → Promise<Array<object|string>>\",\"description\":\"Return site skills matching a URL, or the current page URL when omitted.\",\"params\":[{\"name\":\"url\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":\"string\",\"description\":\"URL to inspect for site skills.\"}],\"returns\":\"Promise<Array<object|string>>\",\"async\":true},{\"name\":\"runSiteTool\",\"signature\":\"runSiteTool(siteId, toolName, args?) → Promise<any>\",\"description\":\"Run a learned Node site tool with the helper context.\",\"params\":[{\"name\":\"siteId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Site identifier.\"},{\"name\":\"toolName\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Tool name within the site.\"},{\"name\":\"args\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":\"object\",\"description\":\"Tool arguments.\"}],\"returns\":\"Promise<any>\",\"async\":true},{\"name\":\"runSiteBrowserTool\",\"signature\":\"runSiteBrowserTool(siteId, toolName, args?) → Promise<any>\",\"description\":\"Run a learned browser-side site tool in the current page.\",\"params\":[{\"name\":\"siteId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Site identifier.\"},{\"name\":\"toolName\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":\"string\",\"description\":\"Tool name within the site.\"},{\"name\":\"args\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":\"object\",\"description\":\"Tool arguments.\"}],\"returns\":\"Promise<any>\",\"async\":true},{\"name\":\"learnContext\",\"signature\":\"learnContext(url?) → Promise<object>\",\"description\":\"Load learned context for the current page or a given URL. Returns accumulated site knowledge: notes content, available tools, usage examples.\",\"params\":[{\"name\":\"url\",\"optional\":true,\"rest\":false,\"default\":\"undefined\",\"type\":\"string\",\"description\":\"URL to inspect. Defaults to current page.\"}],\"returns\":\"Promise<object>\",\"async\":true},{\"name\":\"createLocator\",\"signature\":\"createLocator(selector)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"nthSelector\",\"signature\":\"nthSelector(selector, index)\",\"description\":null,\"params\":[{\"name\":\"selector\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"index\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"internalSelector\",\"signature\":\"internalSelector(kind, data)\",\"description\":null,\"params\":[{\"name\":\"kind\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"data\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"scopedSelector\",\"signature\":\"scopedSelector(base, child)\",\"description\":null,\"params\":[{\"name\":\"base\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"child\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"locatorSelector\",\"signature\":\"locatorSelector(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"textSelector\",\"signature\":\"textSelector(prefix, text, options?)\",\"description\":null,\"params\":[{\"name\":\"prefix\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"text\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"roleSelector\",\"signature\":\"roleSelector(role, options?)\",\"description\":null,\"params\":[{\"name\":\"role\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"testIdSelector\",\"signature\":\"testIdSelector(testId)\",\"description\":null,\"params\":[{\"name\":\"testId\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"filterSelector\",\"signature\":\"filterSelector(base, options?)\",\"description\":null,\"params\":[{\"name\":\"base\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"textMatcher\",\"signature\":\"textMatcher(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"roleNameMatcher\",\"signature\":\"roleNameMatcher(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"createPageFacade\",\"signature\":\"createPageFacade()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"mousePointArgs\",\"signature\":\"mousePointArgs(x, y, options)\",\"description\":null,\"params\":[{\"name\":\"x\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"y\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"createBrowserFacade\",\"signature\":\"createBrowserFacade()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"createTaskSpacesFacade\",\"signature\":\"createTaskSpacesFacade()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"createSiteFacade\",\"signature\":\"createSiteFacade()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"helperContext\",\"signature\":\"helperContext(extra?)\",\"description\":null,\"params\":[{\"name\":\"extra\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"loadAgentHelpers\",\"signature\":\"loadAgentHelpers() → Promise<...>\",\"description\":null,\"params\":[],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"formatCliLogValue\",\"signature\":\"formatCliLogValue(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"toLoggable\",\"signature\":\"toLoggable(value, path, stack)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"stack\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"functionLogValue\",\"signature\":\"functionLogValue(fn, path)\",\"description\":null,\"params\":[{\"name\":\"fn\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"docKeyForPath\",\"signature\":\"docKeyForPath(path)\",\"description\":null,\"params\":[{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"signatureForPath\",\"signature\":\"signatureForPath(signature, path)\",\"description\":null,\"params\":[{\"name\":\"signature\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"exampleForPath\",\"signature\":\"exampleForPath(example, path)\",\"description\":null,\"params\":[{\"name\":\"example\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"runMain\",\"signature\":\"runMain(options?) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"execute\",\"signature\":\"execute(code, stdout) → Promise<...>\",\"description\":null,\"params\":[{\"name\":\"code\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"stdout\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"executionContext\",\"signature\":\"executionContext() → Promise<...>\",\"description\":null,\"params\":[],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"readAll\",\"signature\":\"readAll(stream)\",\"description\":null,\"params\":[{\"name\":\"stream\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"write\",\"signature\":\"write(stream, text)\",\"description\":null,\"params\":[{\"name\":\"stream\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"text\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"noticeSuppressed\",\"signature\":\"noticeSuppressed(env?)\",\"description\":\"Suppress the hint entirely. Mirrors lark's opt-out (`*_NO_UPDATE_NOTIFIER`) and stays quiet in CI, where a nag line is noise no one acts on.\",\"params\":[{\"name\":\"env\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isNonEmptyString\",\"signature\":\"isNonEmptyString(value)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"composeNotice\",\"signature\":\"composeNotice(info)\",\"description\":\"Format the version info into one line, or null when there is nothing to say. This is the single boundary check on the bridge's return: the source crosses a runtime seam (an injected app method), so every field is validated to its declared type here. `updateAvailable`/`mandatory` must be the literal boolean `true` — a truthy non-boolean (e.g. the string \\\"false\\\") does not count — and the version strings must be non-blank, so a missing/empty `currentVersion` yields null and a missing/empty `latestVersion` degrades to the generic phrase.\",\"params\":[{\"name\":\"info\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"withTimeout\",\"signature\":\"withTimeout(promise, ms)\",\"description\":\"Race a promise against a timeout, resolving to null if the timeout wins. The timer is unref'd so it never keeps the process alive on its own, and it is cleared as soon as the probe settles. This bounds how long the check waits on the bridge: a slow (or stuck) `getBrowserVersion()` can no longer leave the update check pending forever. (It cannot cancel the underlying bridge call — that handle is the app's to release.)\",\"params\":[{\"name\":\"promise\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"ms\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"updateNoticeLine\",\"signature\":\"updateNoticeLine(options) → Promise<...>\",\"description\":\"Ask the injected source (bounded by a timeout) and return the line to append, or null. Swallows every failure: an update check must never be what breaks a command.\",\"params\":[{\"name\":\"options\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":\"Promise<...>\",\"async\":true},{\"name\":\"emitUpdateNotice\",\"signature\":\"emitUpdateNotice(ego, emit, env)\",\"description\":\"The one real entry point: given the app's injected `ego` bridge (or none, on older builds), fire the check and hand the resulting line to `emit`. Fire-and-forget — `installEgoSdk()` calls this without awaiting it, so the check runs concurrently with the rest of the heredoc rather than delaying it. `emit` decides where the line goes and when: the SDK path routes it to the output sink so it is appended after the command's own output. Fully guarded: `updateNoticeLine` never rejects, and the trailing `.catch` covers a throwing `emit`, so neither a failed check nor a failed write can surface as an unhandled rejection that breaks the command.\",\"params\":[{\"name\":\"ego\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"emit\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"env\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"installEgoSdk\",\"signature\":\"installEgoSdk(target?, options?)\",\"description\":null,\"params\":[{\"name\":\"target\",\"optional\":true,\"rest\":false,\"default\":\"globalThis\",\"type\":null,\"description\":null},{\"name\":\"options\",\"optional\":true,\"rest\":false,\"default\":\"{}\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"wrapReady\",\"signature\":\"wrapReady(value, readySignal, readyError, path?)\",\"description\":null,\"params\":[{\"name\":\"value\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"readySignal\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"readyError\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"path\",\"optional\":true,\"rest\":false,\"default\":\"[]\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"isSyncFactoryHelper\",\"signature\":\"isSyncFactoryHelper(path)\",\"description\":null,\"params\":[{\"name\":\"path\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"createBufferedLog\",\"signature\":\"createBufferedLog()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"isDirectCli\",\"signature\":\"isDirectCli()\",\"description\":null,\"params\":[],\"returns\":null,\"async\":false},{\"name\":\"wrapInvalidating\",\"signature\":\"wrapInvalidating(ego, methodNames)\",\"description\":null,\"params\":[{\"name\":\"ego\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"methodNames\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"wrapCreateTab\",\"signature\":\"wrapCreateTab(ego)\",\"description\":null,\"params\":[{\"name\":\"ego\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"exposeEgoMethods\",\"signature\":\"exposeEgoMethods(target, ego)\",\"description\":null,\"params\":[{\"name\":\"target\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null},{\"name\":\"ego\",\"optional\":false,\"rest\":false,\"default\":null,\"type\":null,\"description\":null}],\"returns\":null,\"async\":false},{\"name\":\"siteSkillsRoot\",\"signature\":\"learningsRoot(workspace?)\",\"description\":null,\"params\":[{\"name\":\"workspace\",\"optional\":true,\"rest\":false,\"default\":\"...\",\"type\":null,\"description\":null}],\"returns\":null,\"async\":false}]";
let cache = null;
function help(helpers, ...names) {
    const docs = getDocsMap();
    if (names.length === 0) {
        const all = [...docs.values()].filter((d) => d.name in helpers);
        return all;
    }
    if (names.length === 1) {
        const doc = docs.get(names[0]);
        if (!doc)
            return `Unknown helper: ${names[0]}`;
        return doc;
    }
    return names.map((n) => docs.get(n) || {
        name: n,
        signature: n,
        description: null,
        params: [],
        returns: null,
        async: false,
    });
}
function formatHelp(doc) {
    const lines = [];
    if (doc.description) {
        lines.push(doc.description);
    }
    for (const p of doc.params) {
        const opt = p.optional ? "?" : "";
        const type = p.type ? `: ${p.type}` : "";
        const desc = p.description ? ` — ${p.description}` : "";
        const def = p.default ? ` (default: ${p.default})` : "";
        lines.push(`@param ${p.rest ? "..." : ""}${p.name}${opt}${type}${desc}${def}`);
    }
    if (doc.returns) {
        lines.push(`@returns ${doc.returns}`);
    }
    lines.push("");
    lines.push(doc.signature);
    return lines.join("\n");
}
function getDocsMap() {
    if (cache)
        return cache;
    cache = new Map();
    for (const doc of parseEmbeddedDocs(EMBEDDED_DOCS_JSON)) {
        cache.set(doc.name, doc);
    }
    return cache;
}
function parseEmbeddedDocs(raw) {
    // If the build injection did not run (e.g. importing raw TypeScript), `raw`
    // is still the placeholder and JSON.parse throws; there are simply no docs.
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}

class TimeoutError extends Error {
}
/**
 * Send a raw Chrome DevTools Protocol command.
 * @param {string} method CDP method name, for example Runtime.evaluate.
 * @param {object} [params] CDP command parameters.
 * @param {string} [sessionId] Optional attached target session id.
 * @returns {Promise<object>} CDP result object.
 */
async function cdp(method, params = {}, sessionId = undefined) {
    const result = state.cdpOverride
        ? await state.cdpOverride(method, params, sessionId)
        : (await send$1({ method, params, session_id: sessionId })).result || {};
    if (!sessionId &&
        (method === "Network.enable" || method === "Network.disable")) {
        // Mirror the default session's Network domain state so helpers like
        // waitForNetworkIdle can restore it instead of tearing down a domain
        // the caller still relies on for drainEvents().
        state.networkDomainEnabled = method === "Network.enable";
    }
    return result;
}
/**
 * Evaluate JavaScript in the current page, Playwright-style.
 * @param {string | Function} pageFunction JavaScript expression string or function called with arg.
 *   String expressions with top-level return statements are auto-wrapped in an IIFE for compatibility.
 * @param {unknown} [arg] Optional serializable argument passed to function pageFunctions.
 *   For legacy string expressions, a string second argument is treated as a target id to evaluate in.
 * @returns {Promise<any>} Runtime.evaluate return-by-value result.
 */
async function evaluate(pageFunction, arg = undefined) {
    let expression;
    let sessionId;
    if (typeof pageFunction === "function") {
        expression = `(${pageFunction.toString()})(${serializedArg$1(arg)})`;
    }
    else if (typeof pageFunction === "string") {
        if (arg !== undefined && typeof arg !== "string") {
            throw new TypeError("page.evaluate string form only accepts a legacy target id as its second argument; pass a function pageFunction to use args");
        }
        expression = pageFunction;
        if (arg !== undefined) {
            sessionId = (await cdp("Target.attachToTarget", {
                targetId: arg,
                flatten: true,
            })).sessionId;
        }
    }
    else {
        throw new TypeError(`page.evaluate expects a string expression or function pageFunction, got ${pageFunction === null ? "null" : typeof pageFunction}`);
    }
    if (hasReturnStatement(expression) && !expression.trim().startsWith("(")) {
        expression = `(function(){${expression}})()`;
    }
    return runtimeEvaluate(expression, sessionId, true);
}
async function runtimeEvaluate(expression, sessionId = undefined, awaitPromise = false) {
    try {
        const response = await cdp("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
        }, sessionId);
        return runtimeValue(response, expression);
    }
    catch (error) {
        if (error instanceof TimeoutError ||
            /timed out/i.test(error?.message || "")) {
            throw new Error(`Runtime.evaluate timed out; expression: ${jsSnippet(expression)}`);
        }
        throw error;
    }
}
function runtimeValue(response, expression) {
    const result = response.result || {};
    const details = response.exceptionDetails;
    if (details || result.subtype === "error") {
        const desc = jsExceptionDescription(result, details);
        const loc = details?.lineNumber !== undefined && details?.columnNumber !== undefined
            ? ` at line ${details.lineNumber}, column ${details.columnNumber}`
            : "";
        throw new Error(`JavaScript evaluation failed${loc}: ${desc}; expression: ${jsSnippet(expression)}`);
    }
    if (Object.hasOwn(result, "value")) {
        return result.value;
    }
    if (Object.hasOwn(result, "unserializableValue")) {
        return decodeUnserializableJsValue(result.unserializableValue);
    }
    return null;
}
function jsExceptionDescription(result, details) {
    let desc = result.description;
    const exception = details?.exception;
    if (!desc && exception && typeof exception === "object") {
        desc = exception.description;
        if (desc === undefined && Object.hasOwn(exception, "value")) {
            desc = String(exception.value);
        }
        if (desc === undefined) {
            desc = exception.className;
        }
    }
    return desc || details?.text || "JavaScript evaluation failed";
}
function decodeUnserializableJsValue(value) {
    if (value === "NaN") {
        return Number.NaN;
    }
    if (value === "Infinity") {
        return Number.POSITIVE_INFINITY;
    }
    if (value === "-Infinity") {
        return Number.NEGATIVE_INFINITY;
    }
    if (value === "-0") {
        return -0;
    }
    if (value.endsWith("n")) {
        return BigInt(value.slice(0, -1));
    }
    return value;
}
function jsSnippet(expression, limit = 160) {
    const snippet = expression.trim().replace(/\n/g, "\\n");
    return snippet.length > limit ? `${snippet.slice(0, limit - 3)}...` : snippet;
}
function hasReturnStatement(expression) {
    let i = 0;
    let stateName = "code";
    let quote = "";
    while (i < expression.length) {
        const ch = expression[i];
        const next = expression[i + 1] || "";
        if (stateName === "code") {
            if (ch === "'" || ch === '"' || ch === "`") {
                stateName = "string";
                quote = ch;
                i += 1;
                continue;
            }
            if (ch === "/" && next === "/") {
                stateName = "line_comment";
                i += 2;
                continue;
            }
            if (ch === "/" && next === "*") {
                stateName = "block_comment";
                i += 2;
                continue;
            }
            if (expression.startsWith("return", i)) {
                const before = i > 0 ? expression[i - 1] : "";
                const after = expression[i + 6] || "";
                if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
                    return true;
                }
            }
            i += 1;
            continue;
        }
        if (stateName === "line_comment") {
            if (ch === "\n") {
                stateName = "code";
            }
            i += 1;
            continue;
        }
        if (stateName === "block_comment") {
            if (ch === "*" && next === "/") {
                stateName = "code";
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if (stateName === "string") {
            if (ch === "\\") {
                i += 2;
                continue;
            }
            if (ch === quote) {
                stateName = "code";
                quote = "";
            }
            i += 1;
        }
    }
    return false;
}
function serializedArg$1(arg) {
    return arg === undefined ? "" : JSON.stringify(arg);
}

async function waitForDocumentLoad(options = {}) {
    const timeout = options.timeout ?? 15000;
    const ready = options.until === "domcontentloaded"
        ? ["interactive", "complete"]
        : ["complete"];
    const deadline = state.now() + timeout;
    while (state.now() < deadline) {
        let committed = true;
        try {
            const tree = await cdp("Page.getFrameTree");
            const url = tree.frameTree?.frame?.url || "";
            committed = url !== "" && url !== ":" && url !== "about:blank";
        }
        catch {
            // Page.getFrameTree may not be supported in some sessions; fall back to readyState only.
        }
        if (committed && ready.includes(await evaluate("document.readyState"))) {
            return true;
        }
        await state.sleep(300);
    }
    return false;
}

const INTERNAL_URL_PREFIXES = [
    "chrome://",
    "chrome-untrusted://",
    "devtools://",
    "chrome-extension://",
    "about:",
];
/**
 * Navigate the current tab to a URL and, by default, wait for it to load.
 * @param {string} url Absolute or browser-supported URL to load.
 * @param {{waitUntil?: "load"|"domcontentloaded"|"commit", timeout?: number, settle?: number}} [options]
 *   `waitUntil: "commit"` returns once navigation is issued without waiting for the document to load.
 *   `timeout` and `settle` are in milliseconds.
 * @returns {Promise<{navigation: object, loaded: boolean}>}
 */
async function goto(url, options = {}) {
    const navigation = await cdp("Page.navigate", { url });
    const loaded = options.waitUntil === "commit"
        ? false
        : await waitForDocumentLoad({
            timeout: options.timeout ?? 20000,
            until: options.waitUntil === "domcontentloaded"
                ? "domcontentloaded"
                : "load",
        });
    const settle = Number(options.settle ?? 0);
    if (settle > 0) {
        await state.sleep(settle);
    }
    return { navigation, loaded };
}
/**
 * Read basic state for the current page.
 * @returns {Promise<{url:string,title:string,w:number,h:number,sx:number,sy:number,pw:number,ph:number}|{dialog:object}>}
 */
async function pageInfo() {
    if (isBrowserRuntime()) {
        await ensureSession();
        const dialog = pendingDialog();
        if (dialog) {
            return { dialog };
        }
    }
    const expression = `(() => {
    const root = document.documentElement;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      w: innerWidth,
      h: innerHeight,
      sx: scrollX,
      sy: scrollY,
      pw: root?.scrollWidth ?? innerWidth,
      ph: root?.scrollHeight ?? innerHeight,
    });
  })()`;
    return JSON.parse(await evaluate(expression));
}
/**
 * List open page targets known to the browser.
 * @param {{includeChrome?: boolean}} [options]
 * @returns {Promise<Array<{targetId:string,title:string,url:string}>>}
 */
async function listTabs(options = {}) {
    const includeChrome = options.includeChrome ?? true;
    const result = assertNoEgoError(await browserEgo().listTabs(), "listTabs");
    const tabs = result.tabs || [];
    return tabs
        .filter((tab) => includeChrome ||
        !INTERNAL_URL_PREFIXES.some((prefix) => (tab.url || "").startsWith(prefix)))
        .map((tab) => ({
        targetId: tab.targetId,
        title: tab.title || "",
        url: tab.url || "",
        active: Boolean(tab.active),
        index: tab.index,
    }));
}
/**
 * Return the currently attached tab.
 * @returns {Promise<{targetId:string,url:string,title:string}>}
 */
async function currentTab() {
    const tabs = await listTabs();
    const active = tabs.find((tab) => tab.active) || tabs[0];
    if (!active) {
        throw new Error("no active browser tab");
    }
    return { targetId: active.targetId, url: active.url, title: active.title };
}
/**
 * Activate an existing tab target.
 * @param {string|{targetId:string}} target Target id or tab-like object.
 * @returns {Promise<string>} Target id.
 */
async function switchTab(target) {
    const targetId = targetIdFrom(target, "switchTab");
    const tabs = await listTabs();
    currentTargetFrom(tabs, targetId, "switchTab");
    await cdp("Target.activateTarget", { targetId });
    invalidateSession();
    setPreferredTarget(targetId);
    return targetId;
}
/**
 * Open a new tab and optionally navigate it.
 * @param {string} [url="about:blank"] URL to open.
 * @returns {Promise<string>} New target id.
 */
async function newTab(url = "about:blank") {
    const result = assertNoEgoError(await browserEgo().createTab(url), "newTab");
    if (!result.targetId) {
        throw new Error("newTab returned no targetId");
    }
    return result.targetId;
}
/**
 * Reuse an existing matching tab or open a new one.
 * @param {string} url URL to find or open.
 * @param {{match?: "exact"|"origin"|"origin+path"|"includes", wait?: boolean, timeout?: number, settle?: number}} [options]
 * @returns {Promise<{targetId:string,url:string,title:string,active:boolean,index?:number,reused:boolean}>}
 */
async function openOrReuseTab(url, options = {}) {
    const tabs = await listTabs({ includeChrome: false });
    const match = options.match || "exact";
    const existing = tabs.find((tab) => tabMatchesUrl(tab.url, url, match));
    if (existing) {
        await switchTab(existing.targetId);
        if (options.wait) {
            await waitForDocumentLoad({ timeout: options.timeout ?? 20000 });
        }
        const settle = Number(options.settle ?? 0);
        if (settle > 0) {
            await state.sleep(settle);
        }
        return { ...existing, active: true, reused: true };
    }
    const targetId = await newTab(url);
    if (options.wait !== false) {
        await waitForDocumentLoad({ timeout: options.timeout ?? 20000 });
    }
    const settle = Number(options.settle ?? 0);
    if (settle > 0) {
        await state.sleep(settle);
    }
    return { targetId, url, title: "", active: true, reused: false };
}
/**
 * Close a browser tab by target id, tab object, or the current tab when omitted.
 * @param {string|{targetId:string}} [target] Target id or tab-like object. Defaults to the current tab.
 * @returns {Promise<string>} Closed target id.
 */
async function closeTab(target = undefined) {
    const tabs = await listTabs();
    const targetId = target === undefined
        ? (tabs.find((tab) => tab.active) || tabs[0])?.targetId
        : targetIdFrom(target, "closeTab");
    if (!targetId)
        throw new Error("closeTab requires a targetId");
    currentTargetFrom(tabs, targetId, "closeTab");
    await cdp("Target.closeTarget", { targetId });
    invalidateSession();
    if (state.preferredTargetId === targetId) {
        clearPreferredTarget();
    }
    if (tabs.length > 1) {
        await waitForClosedTarget(targetId);
    }
    return targetId;
}
/**
 * Ensure the active harness session points at a real, non-internal page tab.
 * @returns {Promise<{targetId:string,title:string,url:string}|null>}
 */
async function ensureRealTab() {
    const tabs = await listTabs({ includeChrome: false });
    if (tabs.length === 0) {
        return null;
    }
    const current = await currentTab().catch(() => null);
    if (current?.url &&
        !INTERNAL_URL_PREFIXES.some((prefix) => current.url.startsWith(prefix))) {
        return current;
    }
    await switchTab(tabs[0].targetId);
    return tabs[0];
}
/**
 * Find an iframe target whose URL contains a substring.
 * @param {string} urlSubstring URL substring to match.
 * @returns {Promise<string|null>} Matching iframe target id, if any.
 */
async function iframeTarget(urlSubstring) {
    const targets = (await cdp("Target.getTargets")).targetInfos || [];
    return (targets.find((target) => target.type === "iframe" && (target.url || "").includes(urlSubstring))?.targetId || null);
}
function tabMatchesUrl(tabUrl, wantedUrl, match) {
    if (!tabUrl) {
        return false;
    }
    if (match === "includes") {
        return tabUrl.includes(wantedUrl);
    }
    let tab;
    let wanted;
    try {
        tab = new URL(tabUrl);
        wanted = new URL(wantedUrl);
    }
    catch {
        return tabUrl === wantedUrl;
    }
    if (match === "origin") {
        return tab.origin === wanted.origin;
    }
    if (match === "origin+path") {
        return (tab.origin === wanted.origin &&
            trimSlash(tab.pathname) === trimSlash(wanted.pathname));
    }
    return tab.href === wanted.href;
}
function trimSlash(pathname) {
    return pathname.replace(/\/+$/, "") || "/";
}
function targetIdFrom(target, operation) {
    const targetId = typeof target === "string"
        ? target
        : target && typeof target === "object"
            ? target.targetId
            : undefined;
    if (typeof targetId !== "string" || !targetId) {
        throw new Error(`${operation} requires a targetId; received ${JSON.stringify(target)}`);
    }
    return targetId;
}
function currentTargetFrom(tabs, targetId, operation) {
    const tab = tabs.find((candidate) => candidate.targetId === targetId);
    if (tab)
        return tab;
    const available = tabs.map(({ targetId, title, url }) => ({
        targetId,
        title,
        url,
    }));
    throw new Error(`${operation} target not found: ${JSON.stringify(targetId)}. ` +
        `Refresh browser.listTabs() and select a current targetId. ` +
        `Available tabs: ${JSON.stringify(available)}`);
}
async function waitForClosedTarget(targetId) {
    const deadline = state.now() + 2000;
    while (true) {
        const tabs = await listTabs();
        if (!tabs.some((tab) => tab.targetId === targetId))
            return tabs;
        if (state.now() >= deadline) {
            throw new Error(`closeTab timed out waiting for target to close: ${JSON.stringify(targetId)}`);
        }
        await state.sleep(50);
    }
}

class RefMap {
    map;
    constructor() {
        this.map = new Map();
    }
    add(refId, backendNodeId, role, name, nth = undefined) {
        this.addWithFrame(refId, backendNodeId, role, name, nth, undefined);
    }
    addWithFrame(refId, backendNodeId, role, name, nth = undefined, frameId = undefined) {
        this.map.set(refId, {
            backendNodeId,
            role,
            name,
            nth,
            selector: undefined,
            frameId,
        });
    }
    get(refId) {
        return this.map.get(refId);
    }
    remove(refId) {
        this.map.delete(refId);
    }
    clear() {
        this.map.clear();
    }
}
function parseRef(input) {
    const trimmed = String(input || "").trim();
    for (const candidate of [
        trimmed.startsWith("@") ? trimmed.slice(1) : null,
        trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
        trimmed,
    ]) {
        if (candidate && /^\d+$/.test(candidate)) {
            return candidate;
        }
    }
    return null;
}

function queryAllExpression(selector, rootExpression = "document") {
    const raw = String(selector);
    const nth = parseInternalNth(raw);
    if (nth) {
        return `(() => {
      const elements = ${queryAllExpression(nth.selector, rootExpression)};
      const element = ${nth.index === "last" ? "elements.at(-1)" : `elements[${JSON.stringify(nth.index)}]`};
      return element ? [element] : [];
    })()`;
    }
    const scope = parseInternalJson(raw, "scope");
    if (scope) {
        return `(() => {
      const roots = ${queryAllExpression(scope.base, rootExpression)};
      const out = [];
      for (const root of roots) out.push(...${queryAllExpression(scope.child, "root")});
      return Array.from(new Set(out));
    })()`;
    }
    const filter = parseInternalJson(raw, "filter");
    if (filter) {
        return `(() => {
      const elements = ${queryAllExpression(filter.base, rootExpression)};
      return elements.filter((element) => ${filterCondition(filter, "element")});
    })()`;
    }
    const normalized = raw.startsWith("loc=") ? raw.slice(4) : raw;
    if (raw.startsWith("xpath=")) {
        return `(() => {
      const snapshot = document.evaluate(${JSON.stringify(raw.slice(6))}, ${rootExpression}, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const elements = [];
      for (let i = 0; i < snapshot.snapshotLength; i += 1) elements.push(snapshot.snapshotItem(i));
      return elements;
    })()`;
    }
    if (normalized.startsWith("css:")) {
        return querySelectorAllExpression(rootExpression, normalized.slice(4));
    }
    if (normalized.startsWith("href:")) {
        return hrefElementsExpression(normalized.slice(5), rootExpression);
    }
    if (normalized.startsWith("text:")) {
        return textElementsExpression(parseTextLocator$1(normalized.slice(5)), rootExpression);
    }
    if (raw.startsWith("text=")) {
        return textElementsExpression({ text: raw.slice(5), exact: false }, rootExpression);
    }
    if (normalized.startsWith("label:")) {
        return labelElementsExpression(parseTextLocator$1(normalized.slice(6)), rootExpression);
    }
    if (normalized.startsWith("placeholder:")) {
        return attributeElementsExpression("input[placeholder], textarea[placeholder]", "placeholder", parseTextLocator$1(normalized.slice(12)), rootExpression);
    }
    if (normalized.startsWith("alt:")) {
        return attributeElementsExpression("img[alt], input[alt]", "alt", parseTextLocator$1(normalized.slice(4)), rootExpression);
    }
    if (normalized.startsWith("title:")) {
        return attributeElementsExpression("[title]", "title", parseTextLocator$1(normalized.slice(6)), rootExpression);
    }
    if (normalized.startsWith("testid:")) {
        return attributeElementsExpression("[data-testid]", "data-testid", parseTextLocator$1(normalized.slice(7)), rootExpression);
    }
    const role = parseRoleLocator(normalized);
    if (role) {
        return roleElementsExpression(role, rootExpression);
    }
    return querySelectorAllExpression(rootExpression, raw);
}
function parseInternalJson(selector, kind) {
    const prefix = `internal:${kind}:`;
    if (!selector.startsWith(prefix)) {
        return null;
    }
    try {
        return JSON.parse(decodeURIComponent(selector.slice(prefix.length)));
    }
    catch {
        return null;
    }
}
function parseInternalNth(selector) {
    const nthMatch = /^internal:nth=(\d+);([\s\S]+)$/.exec(String(selector));
    if (nthMatch)
        return { index: Number(nthMatch[1]), selector: nthMatch[2] };
    const lastMatch = /^internal:last;([\s\S]+)$/.exec(String(selector));
    if (lastMatch)
        return { index: "last", selector: lastMatch[1] };
    return null;
}
function filterCondition(filter, elementExpression) {
    const checks = [];
    if (filter.hasText) {
        checks.push(textMatcherExpression(`${elementExpression}.innerText || ${elementExpression}.textContent`, filter.hasText));
    }
    if (filter.hasNotText) {
        checks.push(`!(${textMatcherExpression(`${elementExpression}.innerText || ${elementExpression}.textContent`, filter.hasNotText)})`);
    }
    if (filter.has) {
        checks.push(`${queryAllExpression(filter.has, elementExpression)}.length > 0`);
    }
    if (filter.hasNot) {
        checks.push(`${queryAllExpression(filter.hasNot, elementExpression)}.length === 0`);
    }
    return checks.length ? checks.join(" && ") : "true";
}
function querySelectorAllExpression(rootExpression, selector) {
    const hasText = parsePlaywrightHasTextSelector(selector);
    if (hasText) {
        const match = textMatchExpression("el.innerText || el.textContent", hasText.text, false);
        return `${querySelectorAllExpression(rootExpression, hasText.base)}.filter((el) => ${match})`;
    }
    return `Array.from(${rootExpression}.querySelectorAll(${JSON.stringify(selector)}))`;
}
function parsePlaywrightHasTextSelector(selector) {
    const raw = String(selector).trim();
    const marker = ":has-text(";
    const index = raw.lastIndexOf(marker);
    if (index < 0 || !raw.endsWith(")")) {
        return null;
    }
    const text = parseQuotedTextArgument(raw.slice(index + marker.length, -1).trim());
    if (text === null) {
        return null;
    }
    return {
        base: raw.slice(0, index).trim() || "*",
        text,
    };
}
function parseQuotedTextArgument(raw) {
    if (raw.length < 2) {
        return null;
    }
    const quote = raw[0];
    if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) {
        return null;
    }
    if (quote === '"') {
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed === "string" ? parsed : null;
        }
        catch {
            return raw.slice(1, -1);
        }
    }
    return raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}
function hrefElementsExpression(href, rootExpression = "document") {
    return `${querySelectorAllExpression(rootExpression, "a[href]")}.filter((el) => {
    try {
      const url = new URL(el.href, location.href);
      const path = url.pathname + url.search + url.hash;
      return path === ${JSON.stringify(href)} || url.href === ${JSON.stringify(href)};
    } catch {
      return false;
    }
  })`;
}
function parseTextLocator$1(raw) {
    if (raw.startsWith("exact:")) {
        return { text: parseLocatorString(raw.slice(6)), exact: true };
    }
    return { text: parseLocatorString(raw), exact: false };
}
function parseLocatorString(raw) {
    const trimmed = String(raw).trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}
function textMatcherExpression(valueExpression, matcher) {
    if (matcher.regex !== undefined) {
        return `new RegExp(${JSON.stringify(matcher.regex)}, ${JSON.stringify(matcher.flags || "")}).test(String(${valueExpression} || ''))`;
    }
    return textMatchExpression(valueExpression, matcher.text ?? "", Boolean(matcher.exact));
}
function textMatchExpression(valueExpression, text, exact) {
    const needle = JSON.stringify(String(text).replace(/\s+/g, " ").trim());
    const normalized = `String(${valueExpression} || '').replace(/\\s+/g, ' ').trim()`;
    return exact
        ? `${normalized} === ${needle}`
        : `${normalized}.includes(${needle})`;
}
function textElementsExpression(locator, rootExpression = "document") {
    const query = rootExpression === "document"
        ? "document.querySelectorAll('body *')"
        : `${rootExpression}.querySelectorAll('*')`;
    const match = textMatchExpression("el.innerText || el.textContent", locator.text, locator.exact);
    const childMatch = textMatchExpression("child.innerText || child.textContent", locator.text, locator.exact);
    return `Array.from(${query}).filter((el) => {
    if (!(${match})) return false;
    return !Array.from(el.children || []).some((child) => ${childMatch});
  })`;
}
function labelElementsExpression(locator, rootExpression = "document") {
    const labelMatch = textMatchExpression("label.innerText || label.textContent", locator.text, locator.exact);
    const ariaMatch = textMatchExpression("el.getAttribute('aria-label')", locator.text, locator.exact);
    const labelledByMatch = textMatchExpression("labelledBy", locator.text, locator.exact);
    return `(() => {
    const controls = [];
    for (const label of ${querySelectorAllExpression(rootExpression, "label")}) {
      if (!(${labelMatch})) continue;
      const control = label.control || (label.getAttribute('for') ? document.getElementById(label.getAttribute('for')) : null);
      if (control) controls.push(control);
    }
    for (const el of ${querySelectorAllExpression(rootExpression, "input, textarea, select, button, [role]")}) {
      if (el.getAttribute('aria-label') && ${ariaMatch}) controls.push(el);
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
      if (ids.length) {
        const labelledBy = ids.map((id) => document.getElementById(id)?.textContent || '').join(' ');
        if (${labelledByMatch}) controls.push(el);
      }
    }
    return Array.from(new Set(controls));
  })()`;
}
function attributeElementsExpression(selector, attribute, locator, rootExpression = "document") {
    const match = textMatchExpression(`el.getAttribute(${JSON.stringify(attribute)})`, locator.text, locator.exact);
    return `${querySelectorAllExpression(rootExpression, selector)}.filter((el) => ${match})`;
}
function parseRoleLocator(value) {
    const roleMatch = /^role:([A-Za-z0-9_-]+)(?:\[name=(.+)\])?$/.exec(value);
    if (!roleMatch) {
        return null;
    }
    return {
        role: roleMatch[1],
        name: roleMatch[2] === undefined
            ? undefined
            : parseLocatorMatcher(roleMatch[2]),
    };
}
function roleElementsExpression(locator, rootExpression = "document") {
    return `(() => {
    const accessibleName = (el) => {
      const labelledBy = (el.getAttribute('aria-labelledby') || '')
        .split(/\\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .replace(/\\s+/g, ' ')
        .trim();
      if (labelledBy) return labelledBy;
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.replace(/\\s+/g, ' ').trim();
      if (el instanceof HTMLImageElement) return (el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim();
      if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) {
        return (el.value || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim();
      }
      if ('labels' in el && el.labels && el.labels.length) {
        return Array.from(el.labels).map((label) => label.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
      }
      return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    };
    return ${querySelectorAllExpression(rootExpression, roleCandidateSelector())}.filter((el) => {
      const explicitRole = (el.getAttribute('role') || '').split(/\\s+/).filter(Boolean)[0];
      const implicitRole = (() => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a' && el.hasAttribute('href')) return 'link';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'img' && el.hasAttribute('alt')) return 'img';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'input') {
          if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'range') return 'slider';
          return 'textbox';
        }
        return '';
      })();
      const role = explicitRole || implicitRole;
      if (role !== ${JSON.stringify(locator.role)}) return false;
      ${roleNameCondition(locator.name)}
    });
  })()`;
}
function roleNameCondition(name) {
    if (name === undefined) {
        return "return true;";
    }
    if (isTextMatcher$1(name)) {
        return `return ${textMatcherExpression("accessibleName(el)", name)};`;
    }
    return `return accessibleName(el) === ${JSON.stringify(String(name))};`;
}
function parseLocatorMatcher(raw) {
    const parsed = parseLocatorString(raw);
    if (typeof parsed === "string" &&
        parsed.trim().startsWith("{") &&
        parsed.trim().endsWith("}")) {
        try {
            const value = JSON.parse(parsed);
            if (isTextMatcher$1(value)) {
                return value;
            }
        }
        catch {
            return parsed;
        }
    }
    return parsed;
}
function isTextMatcher$1(value) {
    return Boolean(value &&
        typeof value === "object" &&
        (typeof value.regex === "string" || typeof value.text === "string"));
}
function roleCandidateSelector() {
    return "button, a[href], input, textarea, select, img[alt], h1, h2, h3, h4, h5, h6, [role]";
}

class ElementResolutionError extends Error {
    kind;
    constructor(message, kind) {
        super(message);
        this.name = "ElementResolutionError";
        this.kind = kind;
    }
}
/**
 * Return the ordered AX backend-node match set for a root role locator.
 * Non-role selectors return null so callers can use their normal DOM path.
 */
async function queryRoleLocatorBackendNodeIds(cdp, sessionId, selectorOrRef) {
    const locator = parseLocator(selectorOrRef);
    if (locator?.kind !== "role") {
        return null;
    }
    const backendNodeIds = await findBackendNodeIdsByRoleName(cdp, sessionId, locator.role, locator.name);
    const nth = locator.nth;
    if (nth === undefined) {
        return backendNodeIds;
    }
    const nthIndex = nth === "last" ? backendNodeIds.length - 1 : nth;
    const backendNodeId = backendNodeIds[nthIndex];
    return backendNodeId === undefined ? [] : [backendNodeId];
}
function exceptionText(result) {
    const d = result?.exceptionDetails;
    return d?.exception?.description || d?.text || "evaluation error";
}
function matchCountKind(message) {
    const m = /matched (\d+)/.exec(message);
    const n = m ? Number(m[1]) : 0;
    return n > 1 ? "permanent" : "transient";
}
function selectorResolutionError(selector, result) {
    const message = exceptionText(result);
    if (/\bmatched \d+ elements\b/.test(message)) {
        return new ElementResolutionError(message, matchCountKind(message));
    }
    return new ElementResolutionError(`Invalid selector: ${selector}: ${message}`, "permanent");
}
async function resolveElementCenter(cdp, sessionId, refMap, selectorOrRef, iframeSessions = new Map()) {
    const refId = parseRef(selectorOrRef);
    if (refId) {
        const entry = refMap.get(refId);
        if (!entry) {
            throw new ElementResolutionError(`Unknown ref: ${refId}`, "transient");
        }
        const effectiveSessionId = resolveFrameSession(entry.frameId, sessionId, iframeSessions);
        if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
            try {
                const result = await send(cdp, "DOM.getBoxModel", { backendNodeId: entry.backendNodeId }, effectiveSessionId);
                return {
                    ...boxModelCenter(result.model),
                    sessionId: effectiveSessionId,
                };
            }
            catch (error) {
                if (error instanceof ElementResolutionError) {
                    // The node resolved but has no usable box model (not rendered yet).
                    // Propagate the retryable state instead of falling back to role/name,
                    // which could silently target a different node with the same label.
                    throw error;
                }
                // The backend node can become stale after DOM updates; fall back to role/name lookup below.
            }
        }
        const backendNodeId = await findBackendNodeIdByRoleName(cdp, sessionId, entry.role, entry.name, entry.nth, entry.frameId, iframeSessions);
        const result = await send(cdp, "DOM.getBoxModel", { backendNodeId }, effectiveSessionId);
        return { ...boxModelCenter(result.model), sessionId: effectiveSessionId };
    }
    const locator = parseLocator(selectorOrRef);
    if (locator) {
        return resolveLocatorCenter(cdp, sessionId, locator);
    }
    const result = await send(cdp, "Runtime.evaluate", {
        expression: buildSelectorCenterJs(selectorOrRef),
        returnByValue: true,
        awaitPromise: false,
    }, sessionId);
    if (result.exceptionDetails) {
        throw selectorResolutionError(selectorOrRef, result);
    }
    const value = result.result?.value;
    if (typeof value?.x !== "number" || typeof value?.y !== "number") {
        throw new ElementResolutionError(`Element not found: ${selectorOrRef}`, "transient");
    }
    return { x: value.x, y: value.y, sessionId };
}
async function resolveElementObjectId(cdp, sessionId, refMap, selectorOrRef, iframeSessions = new Map()) {
    const refId = parseRef(selectorOrRef);
    if (refId) {
        const entry = refMap.get(refId);
        if (!entry) {
            throw new ElementResolutionError(`Unknown ref: ${refId}`, "transient");
        }
        const effectiveSessionId = resolveFrameSession(entry.frameId, sessionId, iframeSessions);
        if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
            try {
                const result = await send(cdp, "DOM.resolveNode", {
                    backendNodeId: entry.backendNodeId,
                    objectGroup: "ego-browser",
                }, effectiveSessionId);
                const objectId = result.object?.objectId;
                if (objectId) {
                    return { objectId, sessionId: effectiveSessionId };
                }
            }
            catch {
                // The backend node can become stale after DOM updates; fall back to role/name lookup below.
            }
        }
        const backendNodeId = await findBackendNodeIdByRoleName(cdp, sessionId, entry.role, entry.name, entry.nth, entry.frameId, iframeSessions);
        const result = await send(cdp, "DOM.resolveNode", { backendNodeId, objectGroup: "ego-browser" }, effectiveSessionId);
        const objectId = result.object?.objectId;
        if (!objectId) {
            throw new ElementResolutionError(`No objectId for ref ${refId}`, "permanent");
        }
        return { objectId, sessionId: effectiveSessionId };
    }
    const locator = parseLocator(selectorOrRef);
    if (locator) {
        return resolveLocatorObjectId(cdp, sessionId, locator);
    }
    const result = await send(cdp, "Runtime.evaluate", {
        expression: buildFindElementJs(selectorOrRef),
        returnByValue: false,
        awaitPromise: false,
        objectGroup: "ego-browser",
    }, sessionId);
    if (result.exceptionDetails) {
        throw selectorResolutionError(selectorOrRef, result);
    }
    const objectId = result.result?.objectId;
    if (!objectId) {
        throw new ElementResolutionError(`Element not found: ${selectorOrRef}`, "transient");
    }
    return { objectId, sessionId };
}
function resolveFrameSession(frameId, sessionId, iframeSessions) {
    if (!frameId) {
        return sessionId;
    }
    if (iframeSessions instanceof Map) {
        return iframeSessions.get(frameId) || sessionId;
    }
    return iframeSessions?.[frameId] || sessionId;
}
async function resolveLocatorCenter(cdp, sessionId, locator) {
    if (locator.kind === "role") {
        const backendNodeId = locator.nth === undefined
            ? await findUniqueBackendNodeIdByRoleName(cdp, sessionId, locator.role, locator.name)
            : await findBackendNodeIdByRoleName(cdp, sessionId, locator.role, locator.name, locator.nth);
        const result = await send(cdp, "DOM.getBoxModel", { backendNodeId }, sessionId);
        return { ...boxModelCenter(result.model), sessionId };
    }
    const result = await send(cdp, "Runtime.evaluate", {
        expression: buildLocatorCenterJs(locator),
        returnByValue: true,
        awaitPromise: false,
    }, sessionId);
    if (result.exceptionDetails) {
        throw new ElementResolutionError(`Invalid selector: ${locator.raw}: ${exceptionText(result)}`, "permanent");
    }
    const value = result.result?.value;
    if (value?.error) {
        throw new ElementResolutionError(value.error, matchCountKind(value.error));
    }
    if (typeof value?.x !== "number" || typeof value?.y !== "number") {
        throw new ElementResolutionError(`Element not found: ${locator.raw}`, "transient");
    }
    return { x: value.x, y: value.y, sessionId };
}
async function resolveLocatorObjectId(cdp, sessionId, locator) {
    if (locator.kind === "role") {
        const backendNodeId = locator.nth === undefined
            ? await findUniqueBackendNodeIdByRoleName(cdp, sessionId, locator.role, locator.name)
            : await findBackendNodeIdByRoleName(cdp, sessionId, locator.role, locator.name, locator.nth);
        const result = await send(cdp, "DOM.resolveNode", { backendNodeId, objectGroup: "ego-browser" }, sessionId);
        const objectId = result.object?.objectId;
        if (!objectId) {
            throw new ElementResolutionError(`No objectId for locator ${locator.raw}`, "permanent");
        }
        return { objectId, sessionId };
    }
    const count = await locatorCount(cdp, sessionId, locator);
    if (count === 0) {
        throw new ElementResolutionError(`Locator ${locator.raw} matched 0 elements`, "transient");
    }
    if (typeof locator.nth === "number" && count <= locator.nth) {
        throw new ElementResolutionError(`Locator ${locator.raw} matched 0 elements`, "transient");
    }
    if (locator.nth === undefined && count > 1) {
        throw new ElementResolutionError(`Locator ${locator.raw} matched ${count} elements`, "permanent");
    }
    const result = await send(cdp, "Runtime.evaluate", {
        expression: buildLocatorFindJs(locator),
        returnByValue: false,
        awaitPromise: false,
        objectGroup: "ego-browser",
    }, sessionId);
    const objectId = result.result?.objectId;
    if (!objectId) {
        throw new ElementResolutionError(`Element not found: ${locator.raw}`, "transient");
    }
    return { objectId, sessionId };
}
async function locatorCount(cdp, sessionId, locator) {
    const result = await send(cdp, "Runtime.evaluate", {
        expression: buildLocatorCountJs(locator),
        returnByValue: true,
        awaitPromise: false,
    }, sessionId);
    if (result.exceptionDetails) {
        throw new ElementResolutionError(`Invalid selector: ${locator.raw}: ${exceptionText(result)}`, "permanent");
    }
    return Number(result.result?.value || 0);
}
async function findBackendNodeIdByRoleName(cdp, sessionId, role, name, nth = undefined, frameId = undefined, iframeSessions = new Map()) {
    const matches = await findBackendNodeIdsByRoleName(cdp, sessionId, role, name, frameId, iframeSessions);
    const nthIndex = nth === "last" ? matches.length - 1 : (nth ?? 0);
    const match = matches[nthIndex];
    if (match !== undefined) {
        return match;
    }
    throw new ElementResolutionError(`Could not locate element with role=${role} name=${name}`, "transient");
}
async function findBackendNodeIdsByRoleName(cdp, sessionId, role, name, frameId = undefined, iframeSessions = new Map()) {
    const [params, effectiveSessionId] = resolveAxSession(frameId, sessionId, iframeSessions);
    const result = await send(cdp, "Accessibility.getFullAXTree", params, effectiveSessionId);
    const matches = [];
    for (const node of result.nodes || []) {
        if (node.ignored) {
            continue;
        }
        if (extractAxString(node.role) !== role) {
            continue;
        }
        if (name !== undefined &&
            !axNameMatches(extractAxString(node.name), name)) {
            continue;
        }
        const backendNodeId = node.backendDOMNodeId;
        if (backendNodeId === undefined || backendNodeId === null) {
            throw new ElementResolutionError(`AX node has no backendDOMNodeId for role=${role} name=${name}`, "permanent");
        }
        matches.push(backendNodeId);
    }
    return matches;
}
async function findUniqueBackendNodeIdByRoleName(cdp, sessionId, role, name) {
    const matches = await findBackendNodeIdsByRoleName(cdp, sessionId, role, name);
    if (matches.length === 0) {
        throw new ElementResolutionError(`Locator role:${role}[name=${JSON.stringify(name)}] matched 0 elements`, "transient");
    }
    if (matches.length > 1) {
        throw new ElementResolutionError(`Locator role:${role}[name=${JSON.stringify(name)}] matched ${matches.length} elements`, "permanent");
    }
    return matches[0];
}
function resolveAxSession(frameId, sessionId, iframeSessions) {
    if (!frameId) {
        return [{}, sessionId];
    }
    const iframeSession = iframeSessions instanceof Map
        ? iframeSessions.get(frameId)
        : iframeSessions?.[frameId];
    if (iframeSession) {
        return [{}, iframeSession];
    }
    return [{ frameId }, sessionId];
}
function buildFindElementJs(selector) {
    const matchError = JSON.stringify(`Locator ${String(selector)} matched `);
    return `(() => {
    const elements = ${queryAllExpression(selector)};
    if (elements.length > 1) throw new Error(${matchError} + elements.length + ' elements');
    return elements[0] || null;
  })()`;
}
function buildLocatorFindJs(locator) {
    if (locator.kind === "query") {
        return `(() => {
      const elements = ${queryAllExpression(locator.selector)};
      return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth ?? 0)}] || null;
    })()`;
    }
    if (locator.kind === "css") {
        const selector = `loc=css:${locator.selector}`;
        if (locator.nth !== undefined) {
            return `(() => {
        const elements = ${queryAllExpression(selector)};
        return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth)}] || null;
      })()`;
        }
        return `(() => ${queryAllExpression(selector)}[0] || null)()`;
    }
    if (locator.kind === "xpath") {
        return `(() => {
      const snapshot = document.evaluate(${JSON.stringify(locator.xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return snapshot.snapshotItem(${locator.nth === "last" ? "snapshot.snapshotLength - 1" : JSON.stringify(locator.nth ?? 0)});
    })()`;
    }
    if (locator.kind === "text" ||
        locator.kind === "label" ||
        locator.kind === "placeholder" ||
        locator.kind === "alt" ||
        locator.kind === "title" ||
        locator.kind === "testid") {
        return `(() => {
      const elements = ${buildLocatorAllJs(locator)};
      return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth ?? 0)}] || null;
    })()`;
    }
    return locator.nth === "last"
        ? `(() => ${hrefElementsJs(locator.href)}.at(-1) || null)()`
        : `(() => ${hrefElementsJs(locator.href)}[${JSON.stringify(locator.nth ?? 0)}] || null)()`;
}
function buildLocatorCountJs(locator) {
    if (locator.kind === "query") {
        return `(() => ${queryAllExpression(locator.selector)}.length)()`;
    }
    if (locator.kind === "css") {
        return `(() => ${queryAllExpression(`loc=css:${locator.selector}`)}.length)()`;
    }
    if (locator.kind === "xpath") {
        return `(() => document.evaluate(${JSON.stringify(locator.xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength)()`;
    }
    if (locator.kind === "text" ||
        locator.kind === "label" ||
        locator.kind === "placeholder" ||
        locator.kind === "alt" ||
        locator.kind === "title" ||
        locator.kind === "testid") {
        return `(() => ${buildLocatorAllJs(locator)}.length)()`;
    }
    return `(() => ${hrefElementsJs(locator.href)}.length)()`;
}
function buildLocatorCenterJs(locator) {
    if (locator.nth !== undefined) {
        return `(() => {
            const el = ${buildLocatorFindJs(locator)};
            if (!el) return { error: ${JSON.stringify(`Locator ${locator.raw} matched 0 elements`)} };
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
    }
    return `(() => {
            const count = ${buildLocatorCountJs(locator)};
            if (count !== 1) return { error: ${JSON.stringify(`Locator ${locator.raw} matched`)} + ' ' + count + ' elements' };
            const el = ${buildLocatorFindJs(locator)};
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
}
function hrefElementsJs(href) {
    return `Array.from(document.querySelectorAll('a[href]')).filter((el) => {
            try {
              const u = new URL(el.href, location.href);
              const path = u.pathname + u.search + u.hash;
              return path === ${JSON.stringify(href)} || u.href === ${JSON.stringify(href)};
            } catch {
              return false;
            }
          })`;
}
function buildLocatorAllJs(locator) {
    if (locator.kind === "text") {
        return textElementsJs(locator);
    }
    if (locator.kind === "label") {
        return labelElementsJs(locator);
    }
    if (locator.kind === "placeholder") {
        return attributeElementsJs("input[placeholder], textarea[placeholder]", "placeholder", locator);
    }
    if (locator.kind === "alt") {
        return attributeElementsJs("img[alt], input[alt]", "alt", locator);
    }
    if (locator.kind === "title") {
        return attributeElementsJs("[title]", "title", locator);
    }
    if (locator.kind === "testid") {
        return attributeElementsJs("[data-testid]", "data-testid", locator);
    }
    throw new Error(`unsupported locator kind: ${locator.kind}`);
}
function textElementsJs(locator) {
    const match = textMatchJs("el.innerText || el.textContent", locator.text, locator.exact);
    const childMatch = textMatchJs("child.innerText || child.textContent", locator.text, locator.exact);
    return `Array.from(document.querySelectorAll('body *')).filter((el) => {
            if (!(${match})) return false;
            return !Array.from(el.children || []).some((child) => ${childMatch});
          })`;
}
function labelElementsJs(locator) {
    const labelMatch = textMatchJs("label.innerText || label.textContent", locator.text, locator.exact);
    const ariaMatch = textMatchJs("el.getAttribute('aria-label')", locator.text, locator.exact);
    const labelledByMatch = textMatchJs("labelledBy", locator.text, locator.exact);
    return `(() => {
            const controls = [];
            for (const label of document.querySelectorAll('label')) {
              if (!(${labelMatch})) continue;
              const control = label.control || (label.getAttribute('for') ? document.getElementById(label.getAttribute('for')) : null);
              if (control) controls.push(control);
            }
            for (const el of document.querySelectorAll('input, textarea, select, button, [role]')) {
              if (el.getAttribute('aria-label') && ${ariaMatch}) controls.push(el);
              const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
              if (ids.length) {
                const labelledBy = ids.map((id) => document.getElementById(id)?.textContent || '').join(' ');
                if (${labelledByMatch}) controls.push(el);
              }
            }
            return Array.from(new Set(controls));
          })()`;
}
function attributeElementsJs(selector, attribute, locator) {
    const match = textMatchJs(`el.getAttribute(${JSON.stringify(attribute)})`, locator.text, locator.exact);
    return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((el) => ${match})`;
}
function textMatchJs(valueExpression, text, exact) {
    const needle = JSON.stringify(String(text).replace(/\s+/g, " ").trim());
    const normalized = `String(${valueExpression} || '').replace(/\\s+/g, ' ').trim()`;
    return exact
        ? `${normalized} === ${needle}`
        : `${normalized}.includes(${needle})`;
}
function buildSelectorCenterJs(selector) {
    const findExpr = buildFindElementJs(selector);
    return `(() => {
            const el = ${findExpr};
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
}
function parseLocator(input) {
    let value = String(input || "").trim();
    let nth;
    const nthMatch = /^internal:nth=(\d+);([\s\S]+)$/.exec(value);
    if (nthMatch) {
        nth = Number(nthMatch[1]);
        value = nthMatch[2];
    }
    const lastMatch = /^internal:last;([\s\S]+)$/.exec(value);
    if (lastMatch) {
        nth = "last";
        value = lastMatch[1];
    }
    if (value.startsWith("internal:scope:") ||
        value.startsWith("internal:filter:")) {
        return { kind: "query", selector: value, raw: value, nth };
    }
    if (value.startsWith("loc=")) {
        value = value.slice(4);
    }
    if (value.startsWith("css:")) {
        const selector = value.slice(4);
        return selector ? { kind: "css", selector, raw: value, nth } : null;
    }
    if (value.startsWith("href:")) {
        const href = value.slice(5);
        return href ? { kind: "href", href, raw: value, nth } : null;
    }
    if (value.startsWith("text:")) {
        return {
            kind: "text",
            ...parseTextLocator(value.slice(5)),
            raw: value,
            nth,
        };
    }
    if (value.startsWith("text=")) {
        return {
            kind: "text",
            text: value.slice(5),
            exact: false,
            raw: value,
            nth,
        };
    }
    if (value.startsWith("label:")) {
        return {
            kind: "label",
            ...parseTextLocator(value.slice(6)),
            raw: value,
            nth,
        };
    }
    if (value.startsWith("placeholder:")) {
        return {
            kind: "placeholder",
            ...parseTextLocator(value.slice(12)),
            raw: value,
            nth,
        };
    }
    if (value.startsWith("alt:")) {
        return {
            kind: "alt",
            ...parseTextLocator(value.slice(4)),
            raw: value,
            nth,
        };
    }
    if (value.startsWith("title:")) {
        return {
            kind: "title",
            ...parseTextLocator(value.slice(6)),
            raw: value,
            nth,
        };
    }
    if (value.startsWith("testid:")) {
        return {
            kind: "testid",
            ...parseTextLocator(value.slice(7)),
            raw: value,
            nth,
        };
    }
    const roleMatch = /^role:([A-Za-z0-9_-]+)(?:\[name=(.+)\])?$/.exec(value);
    if (roleMatch) {
        return {
            kind: "role",
            role: roleMatch[1],
            name: roleMatch[2] === undefined ? undefined : parseLocatorName(roleMatch[2]),
            raw: value,
            nth,
        };
    }
    if (nth !== undefined) {
        if (value.startsWith("xpath=")) {
            return { kind: "xpath", xpath: value.slice(6), raw: value, nth };
        }
        return { kind: "css", selector: value, raw: value, nth };
    }
    return null;
}
function parseLocatorName(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return trimmed.slice(1, -1);
        }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1);
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (isTextMatcher(parsed)) {
                return parsed;
            }
        }
        catch {
            return trimmed;
        }
    }
    return trimmed;
}
function parseTextLocator(raw) {
    if (raw.startsWith("exact:")) {
        return { text: parseLocatorName(raw.slice(6)), exact: true };
    }
    return { text: parseLocatorName(raw), exact: false };
}
function boxModelCenter(model = {}) {
    const content = model.content || [];
    if (content.length < 8) {
        // Returning a fake (0,0) here would silently click the viewport corner.
        // Treat a missing/degenerate box model as "element not ready" so callers
        // with retry semantics (waitForSelector, ref fallback) can poll.
        throw new ElementResolutionError("Element has no box model (not rendered or zero-sized)", "transient");
    }
    return {
        x: (content[0] + content[2] + content[4] + content[6]) / 4,
        y: (content[1] + content[3] + content[5] + content[7]) / 4,
    };
}
function extractAxString(value) {
    const raw = value?.value;
    if (typeof raw === "string") {
        return raw;
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
        return String(raw);
    }
    return "";
}
function axNameMatches(actual, expected) {
    if (isTextMatcher(expected)) {
        if (typeof expected.regex === "string") {
            try {
                return new RegExp(expected.regex, expected.flags || "").test(String(actual));
            }
            catch {
                return false;
            }
        }
        const text = String(expected.text ?? "")
            .replace(/\s+/g, " ")
            .trim();
        const normalized = String(actual || "")
            .replace(/\s+/g, " ")
            .trim();
        return expected.exact ? normalized === text : normalized.includes(text);
    }
    return String(actual) === String(expected);
}
function isTextMatcher(value) {
    return Boolean(value &&
        typeof value === "object" &&
        (typeof value.regex === "string" || typeof value.text === "string"));
}
function send(cdp, method, params = {}, sessionId = undefined) {
    return cdp.sendRaw(method, params, sessionId);
}

const browserRefMap = new RefMap();
let ensuring = false;
let snapshotImpl = null;
function registerSnapshotForRefRefresh(fn) {
    snapshotImpl = fn;
}
async function ensureRefMapForRef(selectorOrRef) {
    if (ensuring)
        return;
    if (typeof selectorOrRef !== "string")
        return;
    if (!parseRef(selectorOrRef))
        return;
    if (browserRefMap.map.size > 0)
        return;
    if (!snapshotImpl)
        return;
    ensuring = true;
    try {
        await snapshotImpl();
    }
    finally {
        ensuring = false;
    }
}

function drainEvents() {
    return drainBrowserEvents();
}
async function snapshotRaw(options = {}) {
    let result;
    try {
        result = await browserEgo().snapshot(options);
    }
    catch (err) {
        // ego.snapshot rejects directly (it never resolves with { error }), so it never
        // reached buildEgoError — the single birthplace that records a hard stop for the
        // output sink and swaps native wording for ego-browser's owned guidance. Route the
        // rejection through it so a swallowed snapshot hard stop collapses like every other
        // ego error instead of leaking repeated native text.
        throw buildEgoError(err, "snapshot");
    }
    browserSnapshotRefsToRefMap(browserRefMap, result.refs || []);
    return result;
}
registerSnapshotForRefRefresh(() => snapshotRaw());
/**
 * Return snapshot content with agent-friendly defaults. The text surface most
 * agents want; use snapshotRaw when you need the structured { content, refs }.
 * @param {{scope?: "only_within_viewport"|"full_page", includeActionMarks?: boolean, includeStableLocator?: boolean}} [options]
 * @returns {Promise<string>}
 */
async function snapshot(options = {}) {
    const result = await snapshotRaw({
        scope: options.scope ?? "full_page",
        includeActionMarks: options.includeActionMarks ?? true,
        includeStableLocator: options.includeStableLocator ?? true,
    });
    return result.content || "";
}
async function elementCenter(selectorOrRef) {
    await ensureRefMapForRef(selectorOrRef);
    return resolveElementCenter({ sendRaw: cdp }, undefined, browserRefMap, selectorOrRef);
}
// Sequence number for default screenshot file names. Combined with the pid it
// keeps concurrent agent processes (parallel task spaces) from overwriting each
// other's shots in the shared tmpdir, and successive shots in one run distinct.
let screenshotSeq = 0;
async function screenshot(options = {}) {
    const path = options.path ??
        join(tmpdir(), `ego-browser-shot-${process.pid}-${++screenshotSeq}.png`);
    const full = options.fullPage ?? false;
    const raw = options.raw ?? false;
    const params = {
        format: "png",
        captureBeyondViewport: full,
    };
    if (raw) {
        if (options.clip) {
            params.clip = { ...options.clip };
        }
    }
    else {
        if (isBrowserRuntime()) {
            await ensureSession();
        }
        if (!pendingDialog()) {
            const dpr = Number(await evaluate("window.devicePixelRatio")) || 1;
            const cssScale = 1 / dpr;
            if (options.clip) {
                params.clip = { scale: cssScale, ...options.clip };
            }
            else {
                const info = await pageInfo();
                if ("dialog" in info) {
                    return screenshot({ ...options, path, raw: true });
                }
                params.clip = {
                    x: 0,
                    y: 0,
                    width: full ? info.pw : info.w,
                    height: full ? info.ph : info.h,
                    scale: cssScale,
                };
            }
        }
    }
    const result = await cdp("Page.captureScreenshot", params);
    await mkdir(dirname(path), { recursive: true });
    await state.writeFile(path, Buffer.from(result.data, "base64"));
    return path;
}

/**
 * Resolve any selector form to a CDP Runtime objectId handle.
 * Accepts @ref / ref=N, loc=css:/loc=role:/loc=href:, xpath=, and raw CSS —
 * the same surface as the pointer/observe helpers, via the unified resolver.
 * Refreshes the RefMap on demand when the input is a ref and the map is empty.
 * @param {string} selectorOrRef Selector or ref string.
 * @returns {Promise<{objectId: string, sessionId?: string}>}
 */
async function resolveHandle(selectorOrRef) {
    await ensureRefMapForRef(selectorOrRef);
    return resolveElementObjectId({ sendRaw: cdp }, undefined, browserRefMap, selectorOrRef);
}
/**
 * Release a Runtime objectId handle. Best-effort: swallows "already gone"
 * errors (stale handle, lost session, destroyed context).
 * @param {string} objectId Runtime remote object id to release.
 * @param {string} [sessionId] Session that owns the handle.
 * @returns {Promise<void>}
 */
async function releaseHandle(objectId, sessionId) {
    if (!objectId)
        return;
    try {
        await cdp("Runtime.releaseObject", { objectId }, sessionId);
    }
    catch {
        // Handle/session already invalid; releasing is best-effort.
    }
}
/**
 * Resolve a handle, run fn(handle), then release the handle — even if fn throws.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {(handle: {objectId: string, sessionId?: string}) => Promise<any>} fn Callback bound to the resolved handle.
 * @returns {Promise<any>} Whatever fn returns.
 */
async function withHandle(selectorOrRef, fn) {
    const handle = await resolveHandle(selectorOrRef);
    try {
        return await fn(handle);
    }
    finally {
        await releaseHandle(handle.objectId, handle.sessionId);
    }
}
/**
 * Resolve an element and call a function on it via Runtime.callFunctionOn,
 * with the element bound as `this`. The resolved handle is released afterward;
 * the returned objectId is already freed and must not be reused.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {string} functionDeclaration Function source whose `this` is the element.
 * @param {Array<unknown>} [args=[]] Arguments passed by value.
 * @returns {Promise<{result: any, objectId: string, sessionId?: string}>}
 */
async function resolveAndCall(selectorOrRef, functionDeclaration, args = []) {
    return withHandle(selectorOrRef, async ({ objectId, sessionId }) => {
        const result = await cdp("Runtime.callFunctionOn", {
            functionDeclaration,
            objectId,
            arguments: args.map((value) => ({ value })),
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
        if (result.exceptionDetails || result.result?.subtype === "error") {
            runtimeValue(result, functionDeclaration);
        }
        return { result, objectId, sessionId };
    });
}

let networkEventUsers = 0;
let networkEventsOwnDomain = false;
let networkEnableInFlight = null;
/**
 * Sleep for a fixed number of milliseconds.
 * @param {number} [ms=1000] Milliseconds to wait.
 * @returns {Promise<void>}
 */
async function waitForTimeout(ms = 1000) {
    await state.sleep(ms);
}
/**
 * Poll a page function or expression until it returns a truthy value.
 * @param {string|Function} pageFunction Browser-side expression or function.
 * @param {unknown|{timeout?: number, polling?: number}} [argOrOptions] Optional function argument, or options.
 * @param {{timeout?: number, polling?: number}} [options] timeout and polling in milliseconds.
 * @returns {Promise<unknown|false>} The first truthy return value, or false on timeout.
 */
async function waitForFunction(pageFunction, argOrOptions = undefined, options = {}) {
    const [arg, effectiveOptions] = normalizeWaitForFunctionArgs(arguments.length, argOrOptions, options);
    const timeout = effectiveOptions.timeout ?? state.defaultTimeout;
    const polling = effectiveOptions.polling ?? 100;
    const deadline = state.now() + timeout;
    const expression = buildWaitForFunctionExpression(pageFunction, arg);
    while (state.now() < deadline) {
        const response = await cdp("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        const value = runtimeValue(response, expression);
        if (value) {
            return value;
        }
        await state.sleep(polling);
    }
    return false;
}
/**
 * Wait for the current page URL to match a string, glob, RegExp, or predicate.
 * @param {string|RegExp|Function} url URL matcher. Predicate functions receive a URL object. Strings with * are treated as globs; other strings are exact.
 * @param {{timeout?: number, waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"}} [options]
 *   `waitUntil` defaults to `"load"`.
 * @returns {Promise<boolean>} True when matched before timeout.
 */
async function waitForURL(url, options = {}) {
    const timeout = options.timeout ?? state.defaultTimeout;
    const deadline = state.now() + timeout;
    while (state.now() < deadline) {
        const current = runtimeValue(await cdp("Runtime.evaluate", {
            expression: "location.href",
            returnByValue: true,
            awaitPromise: false,
        }), "location.href");
        if (urlMatches(current, url)) {
            const waitUntil = options.waitUntil ?? "load";
            // waitForDocumentLoad treats about:blank as an uncommitted transient,
            // so skip document-load states for a matched blank page. Explicit
            // networkidle still needs to observe its idle window.
            return waitUntil === "commit" ||
                (current === "about:blank" && waitUntil !== "networkidle")
                ? true
                : waitForLoadState(waitUntil, {
                    timeout: Math.max(0, deadline - state.now()),
                });
        }
        await state.sleep(100);
    }
    return false;
}
/**
 * Wait for a network request whose URL or request facade matches.
 * @param {string|RegExp|Function} urlOrPredicate Exact URL, RegExp, or synchronous request predicate.
 * @param {{timeout?: number}} [options] timeout in milliseconds; 0 disables timeout.
 * @returns {Promise<object>} Playwright-style request facade.
 */
async function waitForRequest(urlOrPredicate, options = {}) {
    return waitForNetworkMatch("request", urlOrPredicate, options);
}
/**
 * Wait for a network response whose URL or response facade matches.
 * @param {string|RegExp|Function} urlOrPredicate Exact URL, RegExp, or synchronous response predicate.
 * @param {{timeout?: number}} [options] timeout in milliseconds; 0 disables timeout.
 * @returns {Promise<object>} Playwright-style response facade.
 */
async function waitForResponse(urlOrPredicate, options = {}) {
    return waitForNetworkMatch("response", urlOrPredicate, options);
}
/**
 * Wait for a page load state. `"networkidle"` waits until network traffic goes
 * idle; `"domcontentloaded"` until the DOM is interactive; otherwise until
 * document.readyState is complete.
 * @param {"load"|"domcontentloaded"|"networkidle"|{timeout?: number, idleMs?: number}} [loadState="load"] Load state to wait for, or options for the default "load" state.
 * @param {{timeout?: number, idleMs?: number}} [options] timeout in milliseconds; idleMs only applies to "networkidle".
 * @returns {Promise<boolean>} True when the state was reached before timeout.
 */
async function waitForLoadState(loadState = "load", options = {}) {
    const [stateName, effectiveOptions] = normalizeLoadStateArgs(loadState, options);
    if (stateName === "networkidle") {
        return waitForNetworkIdle(effectiveOptions);
    }
    return waitForDocumentLoad({
        timeout: effectiveOptions.timeout,
        until: stateName === "domcontentloaded" ? "domcontentloaded" : "load",
    });
}
function normalizeLoadStateArgs(loadState, options) {
    if (loadState && typeof loadState === "object") {
        return ["load", loadState];
    }
    return [(loadState || "load"), options];
}
function normalizeWaitForFunctionArgs(length, argOrOptions, options) {
    if (length >= 3) {
        return [argOrOptions, options];
    }
    if (isWaitForFunctionOptions(argOrOptions)) {
        return [undefined, argOrOptions];
    }
    return [argOrOptions, {}];
}
function isWaitForFunctionOptions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    return "timeout" in value || "polling" in value;
}
function buildWaitForFunctionExpression(pageFunction, arg) {
    if (typeof pageFunction === "function") {
        return `(${pageFunction.toString()})(${JSON.stringify(arg)})`;
    }
    if (typeof pageFunction !== "string") {
        throw new TypeError(`waitForFunction expects a string expression or function, got ${pageFunction === null ? "null" : typeof pageFunction}`);
    }
    return `(${pageFunction})`;
}
function urlMatches(current, matcher) {
    if (matcher instanceof RegExp) {
        return matcher.test(current);
    }
    if (typeof matcher === "function") {
        return Boolean(matcher(new URL(current)));
    }
    if (typeof matcher !== "string") {
        throw new TypeError(`waitForURL expects a string, RegExp, or function matcher, got ${matcher === null ? "null" : typeof matcher}`);
    }
    if (matcher.includes("*")) {
        return globToRegExp(matcher).test(current);
    }
    return current === matcher;
}
function globToRegExp(glob) {
    let source = "^";
    for (let i = 0; i < glob.length; i += 1) {
        const char = glob[i];
        if (char === "*") {
            if (glob[i + 1] === "*") {
                source += ".*";
                i += 1;
            }
            else {
                source += "[^/]*";
            }
        }
        else {
            source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
        }
    }
    return new RegExp(`${source}$`);
}
async function waitForNetworkMatch(kind, matcher, options) {
    const timeout = networkTimeout(options);
    const requests = new Map();
    const networkEvents = acquireNetworkEvents();
    let matched;
    try {
        void networkEvents.ready;
        await waitForBrowserEvent((event) => {
            matched = processNetworkEvent(kind, matcher, event, requests, timeout);
            return Boolean(matched);
        }, browserEventTimeout(timeout));
        return matched;
    }
    catch (error) {
        if (/page\.waitForEvent timed out/i.test(error?.message || "")) {
            throw new Error(`page.waitFor${kind === "request" ? "Request" : "Response"} timed out after ${timeout}ms`);
        }
        throw error;
    }
    finally {
        await networkEvents.release();
    }
}
function processNetworkEvent(kind, matcher, event, requests, timeout) {
    const method = event?.method;
    const params = event?.params || {};
    if (method === "Network.requestWillBeSent") {
        const previousRequest = requests.get(params.requestId);
        if (kind === "response" && params.redirectResponse) {
            const response = createResponseFacade({
                requestId: params.requestId,
                response: params.redirectResponse,
                request: previousRequest,
            }, timeout);
            if (networkMatches(response, matcher, kind)) {
                return response;
            }
        }
        const request = createRequestInfo(params);
        requests.set(params.requestId, request);
        if (kind === "request") {
            const facade = createRequestFacade(request);
            if (networkMatches(facade, matcher, kind)) {
                return facade;
            }
        }
        return null;
    }
    if (kind === "response" && method === "Network.responseReceived") {
        const response = createResponseFacade({
            requestId: params.requestId,
            response: params.response || {},
            request: requests.get(params.requestId),
        }, timeout);
        if (networkMatches(response, matcher, kind)) {
            return response;
        }
    }
    return null;
}
function networkMatches(facade, matcher, kind) {
    if (typeof matcher === "string") {
        return facade.url() === matcher;
    }
    if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;
        return matcher.test(facade.url());
    }
    if (typeof matcher === "function") {
        const result = matcher(facade);
        if (result && typeof result.then === "function") {
            throw new Error(`page.waitFor${kind === "request" ? "Request" : "Response"} does not support async predicates`);
        }
        return Boolean(result);
    }
    throw new TypeError(`page.waitFor${kind === "request" ? "Request" : "Response"} expects a string, RegExp, or function matcher, got ${matcher === null ? "null" : typeof matcher}`);
}
function createRequestInfo(params) {
    const request = params.request || {};
    return {
        requestId: params.requestId,
        url: request.url || "",
        method: request.method || "",
        headers: normalizeHeaders(request.headers),
        postData: request.postData ?? null,
        resourceType: String(params.type || "").toLowerCase(),
    };
}
function createRequestFacade(info) {
    return {
        url: () => info.url,
        method: () => info.method,
        headers: () => ({ ...info.headers }),
        postData: () => info.postData,
        resourceType: () => info.resourceType,
    };
}
function createResponseFacade(info, timeout) {
    const response = info.response || {};
    const request = info.request ||
        createRequestInfo({
            requestId: info.requestId,
            request: {
                url: response.url || "",
                method: "",
                headers: response.requestHeaders || {},
            },
            type: response.type,
        });
    const status = Number(response.status || 0);
    const headers = normalizeHeaders(response.headers);
    const facade = {
        url: () => response.url || request.url || "",
        status: () => status,
        statusText: () => response.statusText || "",
        ok: () => status >= 200 && status <= 299,
        headers: () => ({ ...headers }),
        request: () => createRequestFacade(request),
        body: async () => {
            const body = await readResponseBody(info.requestId, timeout);
            return body.base64Encoded
                ? Buffer.from(body.body || "", "base64")
                : Buffer.from(body.body || "", "utf8");
        },
        text: async () => {
            const body = await readResponseBody(info.requestId, timeout);
            return body.base64Encoded
                ? Buffer.from(body.body || "", "base64").toString("utf8")
                : body.body || "";
        },
    };
    facade.json = async () => JSON.parse(await facade.text());
    return facade;
}
async function readResponseBody(requestId, timeout) {
    if (!requestId) {
        throw new Error("response body is unavailable without a requestId");
    }
    try {
        return await cdp("Network.getResponseBody", { requestId });
    }
    catch (firstError) {
        await waitForBrowserEvent((event) => (event?.method === "Network.loadingFinished" ||
            event?.method === "Network.loadingFailed") &&
            event?.params?.requestId === requestId, browserEventTimeout(timeout)).catch(() => null);
        try {
            return await cdp("Network.getResponseBody", { requestId });
        }
        catch (error) {
            throw new Error(`response body is unavailable for request ${requestId}: ${error?.message || firstError?.message || error}`);
        }
    }
}
function normalizeHeaders(headers = {}) {
    const out = {};
    for (const [name, value] of Object.entries(headers || {})) {
        out[String(name).toLowerCase()] = String(value);
    }
    return out;
}
function networkTimeout(options) {
    const timeout = options.timeout ?? state.defaultTimeout;
    if (!Number.isFinite(timeout) || timeout < 0) {
        throw new Error("network wait timeout must be a non-negative number");
    }
    return timeout;
}
function browserEventTimeout(timeout) {
    return timeout === 0 ? 2147483647 : Math.min(timeout, 2147483647);
}
function acquireNetworkEvents() {
    if (networkEventUsers === 0 && !state.networkDomainEnabled) {
        networkEnableInFlight = cdp("Network.enable")
            .then(() => {
            networkEventsOwnDomain = true;
        })
            .catch(() => {
            // Some bridges do not expose the Network domain. The waiter will time out
            // with the normal waitForRequest/waitForResponse error.
        })
            .finally(() => {
            networkEnableInFlight = null;
        });
    }
    networkEventUsers += 1;
    let released = false;
    return {
        ready: networkEnableInFlight || Promise.resolve(),
        release: async () => {
            if (released)
                return;
            released = true;
            networkEventUsers = Math.max(0, networkEventUsers - 1);
            if (networkEventUsers > 0)
                return;
            if (networkEnableInFlight) {
                await networkEnableInFlight;
            }
            if (networkEventsOwnDomain) {
                networkEventsOwnDomain = false;
                await cdp("Network.disable").catch(() => {
                    // Best-effort cleanup; the next wait can enable the domain again.
                });
            }
        },
    };
}
/**
 * Wait until an element exists, optionally requiring visibility.
 * @param {string} selector CSS selector / @ref / loc= / xpath= to poll.
 * @param {{timeout?: number, state?: "visible"|"attached"}} [options] timeout in milliseconds; state defaults to "attached".
 * @returns {Promise<boolean>} True when found before timeout.
 */
async function waitForSelector(selector, options = {}) {
    const timeout = options.timeout ?? state.defaultTimeout;
    const requireVisible = options.state === "visible";
    const deadline = state.now() + timeout;
    const visibilityFn = "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}";
    while (state.now() < deadline) {
        let handle;
        try {
            handle = await resolveHandle(selector);
        }
        catch (err) {
            if (err instanceof ElementResolutionError && err.kind === "transient") {
                await state.sleep(300);
                continue; // not found / not ready yet — keep polling.
            }
            throw err; // permanent (bad selector / ambiguous) or unknown error — fail loud.
        }
        try {
            if (!requireVisible)
                return true;
            const response = await cdp("Runtime.callFunctionOn", {
                functionDeclaration: visibilityFn,
                objectId: handle.objectId,
                returnByValue: true,
                awaitPromise: false,
            }, handle.sessionId);
            if (response.result?.value)
                return true;
        }
        catch {
            // visibility check failed (element raced away); treat as not-ready, keep polling.
        }
        finally {
            await releaseHandle(handle.objectId, handle.sessionId);
        }
        await state.sleep(300);
    }
    return false;
}
/**
 * Wait until network events are idle. Module-private; reachable through
 * waitForLoadState("networkidle").
 * Enables the CDP Network domain for the duration of the wait so that network
 * events are actually delivered (previously nothing enabled the domain, so this
 * could report "idle" without ever observing traffic). If the caller had
 * already enabled the domain, it is left enabled on return. Best-effort: if
 * the runtime does not deliver Network events, an idle window of idleMs still
 * resolves true.
 * @param {{timeout?: number, idleMs?: number}} [options] timeout & idleMs in milliseconds.
 * @returns {Promise<boolean>} True when idle before timeout.
 */
async function waitForNetworkIdle(options = {}) {
    const timeout = options.timeout ?? 10000;
    const idleMs = options.idleMs ?? 500;
    const deadline = state.now() + timeout;
    let lastActivity = state.now();
    const inflight = new Set();
    const networkEvents = acquireNetworkEvents();
    await networkEvents.ready;
    try {
        while (state.now() < deadline) {
            for (const event of await drainEvents()) {
                const method = event.method || "";
                const params = event.params || {};
                if (method === "Network.requestWillBeSent") {
                    inflight.add(params.requestId);
                    lastActivity = state.now();
                }
                else if (method === "Network.loadingFinished" ||
                    method === "Network.loadingFailed") {
                    inflight.delete(params.requestId);
                    lastActivity = state.now();
                }
                else if (method.startsWith("Network.")) {
                    lastActivity = state.now();
                }
            }
            if (inflight.size === 0 && state.now() - lastActivity >= idleMs) {
                return true;
            }
            await state.sleep(100);
        }
        return false;
    }
    finally {
        await networkEvents.release();
    }
}

const INPUT_EVENT_DELAY_MS$1 = 25;
const INPUT_DISPATCH_TIMEOUT_MS$1 = 1000;
let currentMousePoint = { x: 0, y: 0, sessionId: undefined };
/**
 * Mouse target accepted by mouse helpers.
 *
 * Forms:
 * - string: CSS selector or @ref, resolves to the element center.
 * - [x, y]: viewport coordinates in CSS pixels.
 * - {x, y}: viewport coordinates in CSS pixels.
 * - {selector}: CSS selector or @ref, resolves to the element center.
 * - {selector, x, y}: element top-left plus x/y offset in CSS pixels.
 *
 * @typedef {string | [number, number] | {x:number,y:number} | {selector:string,x?:number,y?:number}} MouseTarget
 */
/**
 * Click a mouse target.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{button?: "left"|"middle"|"right", clickCount?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
async function click(target, options = {}) {
    const point = await resolveMouseTarget(target, options.timeout);
    rememberMousePoint(point);
    const button = options.button || "left";
    const buttons = pressedButtons(button);
    const clickCount = options.clickCount ?? 1;
    maybeHighlight(point, options.label);
    const probeId = await installClickProbe(point);
    let dispatchError = null;
    try {
        await dispatchMouse(point, "mouseMoved", {
            button: "none",
            buttons: 0,
        });
        await inputEventDelay$1();
        await dispatchMouse(point, "mousePressed", {
            button,
            buttons,
            clickCount,
        });
        await inputEventDelay$1();
        await dispatchMouse(point, "mouseReleased", {
            button,
            buttons: 0,
            clickCount,
        });
    }
    catch (error) {
        if (!isInputDispatchTimeout(error))
            throw error;
        dispatchError = error;
    }
    const completed = await finishClickProbe(point, probeId, clickCount);
    if (dispatchError && !completed)
        throw dispatchError;
}
/**
 * Double-click a mouse target.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{button?: "left"|"middle"|"right", label?: string}} [options]
 * @returns {Promise<void>}
 */
async function dblclick(target, options = {}) {
    await click(target, { ...options, clickCount: 2 });
}
/**
 * Move the mouse over a target without pressing a button.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{label?: string}} [options]
 * @returns {Promise<void>}
 */
async function hover(target, options = {}) {
    const point = await resolveMouseTarget(target, options.timeout);
    rememberMousePoint(point);
    maybeHighlight(point, options.label);
    const probeId = await installHoverProbe(point);
    let dispatchError = null;
    try {
        await dispatchMouse(point, "mouseMoved", { buttons: 0 });
    }
    catch (error) {
        if (!isInputDispatchTimeout(error))
            throw error;
        dispatchError = error;
    }
    const completed = await finishHoverProbe(point, probeId);
    if (dispatchError && !completed)
        throw dispatchError;
}
/**
 * Drag the mouse through a sequence of targets while holding a button.
 * @param {MouseTarget[]} points Ordered drag path. Must contain at least two targets.
 * @param {{button?: "left"|"middle"|"right", delay?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
async function drag(points, options = {}) {
    if (!Array.isArray(points) || points.length < 2) {
        throw new Error("drag requires at least two points");
    }
    const resolved = [];
    for (const point of points) {
        resolved.push(await resolveMouseTarget(point, options.timeout));
    }
    const button = options.button || "left";
    const buttons = pressedButtons(button);
    const first = resolved[0];
    const last = resolved.at(-1);
    if (last) {
        rememberMousePoint(last);
    }
    maybeHighlight(first, options.label);
    const probeId = await installMouseUpProbe(last);
    let dispatchError = null;
    try {
        await dispatchMouse(first, "mousePressed", {
            button,
            buttons,
            clickCount: 1,
        });
        await inputEventDelay$1();
        for (let i = 1; i < resolved.length; i += 1) {
            const point = resolved[i];
            await dispatchMouse({ ...point, sessionId: point.sessionId ?? first.sessionId }, "mouseMoved", {
                button,
                buttons,
            });
            await inputEventDelay$1(options.delay > 0 ? options.delay : undefined);
        }
        await dispatchMouse({ ...last, sessionId: last.sessionId ?? first.sessionId }, "mouseReleased", {
            button,
            buttons: 0,
            clickCount: 1,
        });
    }
    catch (error) {
        if (!isInputDispatchTimeout(error))
            throw error;
        dispatchError = error;
    }
    const completed = await finishDragProbe(resolved, probeId, button);
    if (dispatchError && !completed)
        throw dispatchError;
}
/**
 * Press a mouse button at the current mouse position, Playwright-style.
 * @param {{button?: "left"|"middle"|"right", clickCount?: number}} [options]
 * @returns {Promise<void>}
 */
async function down$1(options = {}) {
    const button = options.button || "left";
    await dispatchMouse(currentMousePoint, "mousePressed", {
        button,
        buttons: pressedButtons(button),
        clickCount: options.clickCount ?? 1,
    });
}
/**
 * Release a mouse button at the current mouse position, Playwright-style.
 * @param {{button?: "left"|"middle"|"right", clickCount?: number}} [options]
 * @returns {Promise<void>}
 */
async function up$1(options = {}) {
    const button = options.button || "left";
    await dispatchMouse(currentMousePoint, "mouseReleased", {
        button,
        buttons: 0,
        clickCount: options.clickCount ?? 1,
    });
}
function inputEventDelay$1(ms = INPUT_EVENT_DELAY_MS$1) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function installClickProbe(point) {
    if (!canProbeInputFallback$1())
        return null;
    const id = `click_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("click", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        return result.result?.value ? id : null;
    }
    catch {
        return null;
    }
}
async function finishClickProbe(point, id, clickCount) {
    if (!id)
        return false;
    await inputEventDelay$1(50);
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("click", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", { ...init, buttons: 0, detail: 0 }));
        target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        if (${JSON.stringify(clickCount)} > 1) {
          target.dispatchEvent(new MouseEvent("dblclick", { ...init, buttons: 0, detail: 2 }));
        }
        return { seen: false, fallback: true };
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        const value = result.result?.value;
        return Boolean(value?.seen || value?.fallback);
    }
    catch {
        return false;
    }
}
async function installMouseUpProbe(point) {
    if (!canProbeInputFallback$1())
        return null;
    const id = `drag_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mouseup", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        return result.result?.value ? id : null;
    }
    catch {
        return null;
    }
}
async function installHoverProbe(point) {
    if (!canProbeInputFallback$1())
        return null;
    const id = `hover_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mousemove", probe.handler, true);
        document.addEventListener("mouseover", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        return result.result?.value ? id : null;
    }
    catch {
        return null;
    }
}
async function finishHoverProbe(point, id) {
    if (!id)
        return false;
    await inputEventDelay$1(50);
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mousemove", probe.handler, true);
        document.removeEventListener("mouseover", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
          buttons: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", init));
        target.dispatchEvent(new MouseEvent("mouseover", init));
        return { seen: false, fallback: true };
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        const value = result.result?.value;
        return Boolean(value?.seen || value?.fallback);
    }
    catch {
        return false;
    }
}
async function finishDragProbe(points, id, button) {
    if (!id)
        return false;
    await inputEventDelay$1(50);
    const first = points[0];
    const last = points.at(-1);
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mouseup", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen) return { seen: true, fallback: false };
        const mouseButton = ${JSON.stringify(button === "left" ? 0 : button === "middle" ? 1 : 2)};
        const eventFor = (type, point, buttons) => {
          const target = document.elementFromPoint(point.x, point.y) || document.body;
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: point.x,
            clientY: point.y,
            button: mouseButton,
            buttons,
            detail: type === "mousemove" ? 0 : 1,
          }));
        };
        const points = ${JSON.stringify(points.map(({ x, y }) => ({ x, y })))};
        eventFor("mousedown", points[0], 1);
        for (const point of points.slice(1)) eventFor("mousemove", point, 1);
        eventFor("mouseup", points.at(-1), 0);
        return { seen: false, fallback: true };
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, last.sessionId ?? first.sessionId);
        const value = result.result?.value;
        return Boolean(value?.seen || value?.fallback);
    }
    catch {
        return false;
    }
}
function canProbeInputFallback$1() {
    return Boolean(globalThis.ego?.sendCDPMessage);
}
/**
 * Dispatch a mouse wheel scroll, Playwright-style (mouse.wheel(deltaX, deltaY)).
 *
 * Sign convention follows the DOM WheelEvent: positive deltaY scrolls down,
 * negative scrolls up (CDP negates deltas internally when building the Blink
 * wheel event, so the DOM convention applies end to end). Defaults to scrolling
 * down by 300 CSS pixels.
 *
 * A visible, focused page receives the wheel through CDP
 * (Input.dispatchMouseEvent), exactly like Playwright. A backgrounded or
 * unfocused tab silently drops CDP wheel input, so there the scroll is
 * dispatched as a synthetic WheelEvent on the element at (x, y) instead.
 *
 * @param {number} [deltaX=0] Horizontal scroll delta in CSS pixels.
 * @param {number} [deltaY=300] Vertical scroll delta in CSS pixels; positive scrolls down.
 * @param {{x?: number, y?: number}} [options] Viewport point to dispatch the wheel at (default 0,0).
 * @returns {Promise<void>}
 */
async function wheel(deltaX = 0, deltaY = 300, options = {}) {
    const x = numberValue(options.x ?? 0);
    const y = numberValue(options.y ?? 0);
    const dx = numberValue(deltaX);
    const dy = numberValue(deltaY);
    if (await isVisibleAndFocused()) {
        await browserCdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy }, undefined, 1000);
        return;
    }
    await dispatchSyntheticWheel(x, y, dx, dy);
}
/**
 * Whether the page is currently visible and focused. CDP wheel input is
 * delivered only to a foreground, focused target; otherwise wheel() routes
 * through a synthetic WheelEvent. Defaults to true when the probe fails so a
 * flaky probe never blocks a real foreground scroll.
 */
async function isVisibleAndFocused() {
    try {
        return Boolean(await evaluate("document.visibilityState === 'visible' && document.hasFocus()"));
    }
    catch {
        return true;
    }
}
/**
 * Dispatch a synthetic WheelEvent on the element under (x, y), then perform the
 * native scroll. Used when the tab is backgrounded/unfocused and CDP wheel input
 * would be dropped. The WheelEvent triggers page wheel handlers (virtualized
 * lists, custom scrollers); the window.scrollBy actually moves an ordinary page,
 * since an untrusted WheelEvent does not perform the default scroll action.
 * The manual scroll is skipped when a handler calls preventDefault(), matching
 * how a real CDP wheel leaves the page in place (maps, canvases, custom scrollers).
 */
async function dispatchSyntheticWheel(x, y, deltaX, deltaY) {
    await evaluate(`(() => {
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)})
      || document.scrollingElement || document.body;
    if (!target) return;
    const notPrevented = target.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: ${JSON.stringify(deltaX)},
      deltaY: ${JSON.stringify(deltaY)},
      clientX: ${JSON.stringify(x)},
      clientY: ${JSON.stringify(y)}
    }));
    if (notPrevented) {
      window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)});
    }
  })()`);
}
/**
 * Scroll an element into view only if it is not already fully visible,
 * mirroring Playwright's locator.scrollIntoViewIfNeeded.
 * @param {string} selector CSS selector or @ref of the element to reveal.
 * @returns {Promise<void>}
 */
async function scrollIntoViewIfNeeded(selector) {
    await resolveAndCall(selector, "function(){ if (typeof this.scrollIntoViewIfNeeded === 'function') { this.scrollIntoViewIfNeeded(true); } else { this.scrollIntoView({ block: 'center', inline: 'center' }); } }");
}
function maybeHighlight(point, label) {
    const ego = globalThis.ego;
    if (!ego)
        return;
    ego.animationHighlightMouseToPosition?.(point.x, point.y);
    if (label) {
        ego.setAgentTaskState?.(label);
    }
}
function rememberMousePoint(point) {
    currentMousePoint = { ...point };
}
async function dispatchMouse(point, type, options = {}) {
    await browserCdp("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        ...options,
    }, point.sessionId, INPUT_DISPATCH_TIMEOUT_MS$1);
}
function isInputDispatchTimeout(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /CDP request timed out: Input\.dispatchMouseEvent/.test(message);
}
async function resolveMouseTarget(target, timeout = undefined) {
    if (typeof target === "string") {
        await waitForSelector(target, { timeout, state: "visible" });
        await scrollIntoViewIfNeeded(target);
        return elementCenter(target);
    }
    if (Array.isArray(target)) {
        return pointFrom(target);
    }
    if (target && typeof target === "object") {
        if ("selector" in target &&
            typeof target.selector === "string" &&
            target.selector) {
            if (target.x === undefined && target.y === undefined) {
                await waitForSelector(target.selector, { timeout, state: "visible" });
                await scrollIntoViewIfNeeded(target.selector);
                return elementCenter(target.selector);
            }
            await waitForSelector(target.selector, { timeout, state: "visible" });
            await scrollIntoViewIfNeeded(target.selector);
            const [topLeft, center] = await Promise.all([
                elementTopLeft(target.selector),
                elementCenter(target.selector),
            ]);
            return {
                x: topLeft.x + numberValue(target.x),
                y: topLeft.y + numberValue(target.y),
                sessionId: center.sessionId,
            };
        }
        if (target.x !== undefined || target.y !== undefined) {
            return pointFrom(target);
        }
    }
    throw new Error(`invalid mouse target: ${JSON.stringify(target)}`);
}
async function elementTopLeft(selectorOrRef) {
    const { result } = await resolveAndCall(selectorOrRef, "function(){const rect=this.getBoundingClientRect();return {x:rect.left,y:rect.top};}");
    const value = result.result?.value;
    if (typeof value?.x !== "number" || typeof value?.y !== "number") {
        throw new Error(`element top-left unavailable: ${selectorOrRef}`);
    }
    return { x: value.x, y: value.y };
}
function pointFrom(point) {
    const x = Array.isArray(point) ? point[0] : point?.x;
    const y = Array.isArray(point) ? point[1] : point?.y;
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
        throw new Error(`invalid mouse target: ${JSON.stringify(point)}`);
    }
    return { x: Number(x), y: Number(y), sessionId: undefined };
}
function numberValue(value) {
    const out = value === undefined ? 0 : Number(value);
    if (!Number.isFinite(out)) {
        throw new Error(`invalid mouse offset: ${JSON.stringify(value)}`);
    }
    return out;
}
function pressedButtons(button) {
    if (button === "left") {
        return 1;
    }
    if (button === "right") {
        return 2;
    }
    if (button === "middle") {
        return 4;
    }
    throw new Error(`unsupported mouse button: ${button}`);
}

const KEYS = {
    Enter: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
    Tab: { vk: 9, key: "Tab", code: "Tab", text: "\t" },
    Backspace: { vk: 8, key: "Backspace", code: "Backspace", text: "" },
    Escape: { vk: 27, key: "Escape", code: "Escape", text: "" },
    Delete: { vk: 46, key: "Delete", code: "Delete", text: "" },
    " ": { vk: 32, key: " ", code: "Space", text: " " },
    ArrowLeft: { vk: 37, key: "ArrowLeft", code: "ArrowLeft", text: "" },
    ArrowUp: { vk: 38, key: "ArrowUp", code: "ArrowUp", text: "" },
    ArrowRight: { vk: 39, key: "ArrowRight", code: "ArrowRight", text: "" },
    ArrowDown: { vk: 40, key: "ArrowDown", code: "ArrowDown", text: "" },
    Home: { vk: 36, key: "Home", code: "Home", text: "" },
    End: { vk: 35, key: "End", code: "End", text: "" },
    PageUp: { vk: 33, key: "PageUp", code: "PageUp", text: "" },
    PageDown: { vk: 34, key: "PageDown", code: "PageDown", text: "" },
    Shift: { vk: 16, key: "Shift", code: "ShiftLeft", text: "" },
    Control: { vk: 17, key: "Control", code: "ControlLeft", text: "" },
    Alt: { vk: 18, key: "Alt", code: "AltLeft", text: "" },
    Meta: { vk: 91, key: "Meta", code: "MetaLeft", text: "" },
};
const PRINTABLE_CODE_RE = /^[A-Za-z0-9]$/;
const CTRL_MODIFIER = 2;
const META_MODIFIER = 4;
const INPUT_EVENT_DELAY_MS = 25;
const INPUT_DISPATCH_TIMEOUT_MS = 1000;
function keyDefinition(key) {
    const special = KEYS[key];
    if (special) {
        return special;
    }
    if (key.length !== 1) {
        return { vk: 0, key, code: key, text: "" };
    }
    const vk = key.toUpperCase().codePointAt(0);
    const code = PRINTABLE_CODE_RE.test(key)
        ? `${/[0-9]/.test(key) ? "Digit" : "Key"}${key.toUpperCase()}`
        : key;
    return { vk, key, code, text: key };
}
function editingCommandsForKey(key, modifiers) {
    if ((modifiers === CTRL_MODIFIER || modifiers === META_MODIFIER) &&
        key.toLowerCase() === "a") {
        return ["selectAll"];
    }
    if (modifiers === 0 && key === "Backspace") {
        return ["deleteBackward"];
    }
    if (modifiers === 0 && key === "Delete") {
        return ["deleteForward"];
    }
    return undefined;
}
const MODIFIER_BITS = {
    Alt: 1,
    Control: 2,
    Meta: 4,
    Shift: 8,
};
const MODIFIER_KEYS = {
    Alt: "Alt",
    Control: "Control",
    ControlLeft: "Control",
    ControlRight: "Control",
    Meta: "Meta",
    MetaLeft: "Meta",
    MetaRight: "Meta",
    Shift: "Shift",
    ShiftLeft: "Shift",
    ShiftRight: "Shift",
};
const pressedModifiers = new Set();
/**
 * Parse a Playwright-style key combo ("Control+a", "Shift+Tab") into a base key
 * and a CDP modifier bitfield. Modifiers: Control, Shift, Alt, Meta, ControlOrMeta.
 */
function parseKeyCombo(combo) {
    const parts = combo.split("+");
    let key = parts.pop() ?? combo;
    if (key === "" && parts.length > 0) {
        // A trailing "+" denotes the literal plus key, e.g. "+", "Shift++". split()
        // turns that "+" into two empty segments; the pop above consumed one, so
        // drop the remaining empty slot too instead of reading it as a modifier.
        key = "+";
        if (parts[parts.length - 1] === "") {
            parts.pop();
        }
    }
    let modifiers = 0;
    for (const name of parts) {
        if (name === "ControlOrMeta") {
            modifiers |=
                process.platform === "darwin" ? META_MODIFIER : CTRL_MODIFIER;
            continue;
        }
        const bit = MODIFIER_BITS[name];
        if (bit === undefined) {
            throw new Error(`press: unknown key modifier ${JSON.stringify(name)}`);
        }
        modifiers |= bit;
    }
    return { key, modifiers };
}
function modifierName(key) {
    return MODIFIER_KEYS[key];
}
function modifierBitForKey(key) {
    const name = modifierName(key);
    return name ? MODIFIER_BITS[name] : 0;
}
function activeModifierBits() {
    let bits = 0;
    for (const name of pressedModifiers) {
        bits |= MODIFIER_BITS[name] || 0;
    }
    return bits;
}
function keyEventBase(key, modifiers) {
    const { vk, code } = keyDefinition(key);
    return {
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
    };
}
/**
 * Dispatch a keydown event and keep modifier keys active until keyboard.up().
 * @param {string} keyCombo Key or modifier+key combo.
 * @returns {Promise<void>}
 */
async function down(keyCombo) {
    const { key, modifiers } = parseKeyCombo(keyCombo);
    const keyModifierBit = modifierBitForKey(key);
    const eventModifiers = activeModifierBits() | modifiers | keyModifierBit;
    await dispatchKeyEvent({
        type: "keyDown",
        ...keyEventBase(key, eventModifiers),
    });
    const name = modifierName(key);
    if (name) {
        pressedModifiers.add(name);
    }
}
/**
 * Dispatch a keyup event and release modifier keys.
 * @param {string} keyCombo Key or modifier+key combo.
 * @returns {Promise<void>}
 */
async function up(keyCombo) {
    const { key, modifiers } = parseKeyCombo(keyCombo);
    const keyModifierBit = modifierBitForKey(key);
    const eventModifiers = activeModifierBits() | modifiers | keyModifierBit;
    await dispatchKeyEvent({
        type: "keyUp",
        ...keyEventBase(key, eventModifiers),
    });
    const name = modifierName(key);
    if (name) {
        pressedModifiers.delete(name);
    }
}
/**
 * Dispatch a key press through CDP. Combine modifiers with "+".
 * @param {string} keyCombo Key or modifier+key combo: "Enter", "a", "Control+a", "Shift+Tab". Modifiers: Control, Shift, Alt, Meta, ControlOrMeta.
 * @returns {Promise<void>}
 */
async function press(keyCombo) {
    const { key, modifiers } = parseKeyCombo(keyCombo);
    const effectiveModifiers = activeModifierBits() | modifiers;
    const downModifiers = effectiveModifiers | modifierBitForKey(key);
    const { vk, code, text } = keyDefinition(key);
    const base = {
        key,
        code,
        modifiers: effectiveModifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
    };
    const commands = editingCommandsForKey(key, effectiveModifiers);
    const probeId = await installKeyProbe(key);
    let dispatchError = null;
    try {
        await dispatchKeyEvent({
            type: "keyDown",
            ...base,
            modifiers: downModifiers,
            ...(text ? { text, unmodifiedText: text } : {}),
            ...(commands ? { commands } : {}),
        });
        await inputEventDelay();
        await dispatchKeyEvent({
            type: "keyUp",
            ...base,
            modifiers: downModifiers,
        });
    }
    catch (error) {
        if (!isKeyDispatchTimeout(error))
            throw error;
        dispatchError = error;
    }
    const completed = await finishKeyProbe(probeId, {
        key,
        code,
        text,
        commands,
    });
    if (dispatchError && !completed)
        throw dispatchError;
}
/**
 * Insert text at the focused input using CDP Input.insertText.
 * @param {string} text Text to insert.
 * @returns {Promise<void>}
 */
async function insertText(text) {
    await cdp("Input.insertText", { text });
}
/**
 * Type text with key events, Playwright-style keyboard.type().
 * @param {string} text Text to type.
 * @param {{delay?: number}} [options] delay in milliseconds between key presses.
 * @returns {Promise<void>}
 */
async function typeText(text, options = {}) {
    await pressSequentially(String(text), options);
}
/**
 * Focus an element.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<void>}
 */
async function focus(selector) {
    await resolveAndCall(selector, "function(){this.focus();}");
}
/**
 * Focus an input, optionally clear it, write a value, and fire input/change events.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input-like element.
 * @param {string} value Text to write.
 * @param {{clearFirst?: boolean, timeout?: number}} [options] clearFirst defaults to true (Playwright fill always clears); clearFirst:false appends (ego-browser extension). timeout in milliseconds.
 * @returns {Promise<void>}
 */
async function fill(selector, value, options = {}) {
    const clearFirst = options.clearFirst ?? true;
    const timeout = options.timeout ?? state.defaultTimeout;
    if (timeout > 0 && !(await waitForSelector(selector, { timeout }))) {
        throw new Error(`fill: element not found: ${JSON.stringify(selector)}`);
    }
    await withHandle(selector, async ({ objectId, sessionId }) => {
        const focusSource = clearFirst
            ? "function(){this.focus(); if(this.isContentEditable){const range=document.createRange();range.selectNodeContents(this);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);}else if(typeof this.select==='function') this.select();}"
            : "function(){this.focus();}";
        await cdp("Runtime.callFunctionOn", {
            functionDeclaration: focusSource,
            objectId,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
        if (clearFirst) {
            await cdp("Runtime.callFunctionOn", {
                functionDeclaration: "function(){if(this.isContentEditable){this.textContent='';}else if('value' in this){this.value='';}else{throw new Error('fill target is not editable');} this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));}",
                objectId,
                returnByValue: true,
                awaitPromise: false,
            }, sessionId);
        }
        await cdp("Input.insertText", { text: value }, sessionId);
        await cdp("Runtime.callFunctionOn", {
            functionDeclaration: "function(){this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));}",
            objectId,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
    });
}
/**
 * Press a sequence of characters, optionally focusing a target first.
 * @param {string} selectorOrText Selector when text is provided, otherwise text for the current focus.
 * @param {string|{delay?: number, timeout?: number}} [textOrOptions] Text to type, or options when typing into current focus.
 * @param {{delay?: number, timeout?: number}} [options] delay in milliseconds between key presses.
 * @returns {Promise<void>}
 */
async function pressSequentially(selectorOrText, textOrOptions = undefined, options = {}) {
    let text;
    let effectiveOptions;
    if (typeof textOrOptions === "string") {
        await focusWithTimeout(selectorOrText, options.timeout);
        text = textOrOptions;
        effectiveOptions = options;
    }
    else {
        text = selectorOrText;
        effectiveOptions = textOrOptions || {};
    }
    for (const char of String(text)) {
        await press(char);
        const delay = Number(effectiveOptions.delay ?? 0);
        if (delay > 0) {
            await state.sleep(delay);
        }
    }
}
/**
 * Focus an element and press a key combo, Playwright-style locator.press().
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @param {string} keyCombo Key or modifier+key combo.
 * @param {{timeout?: number}} [options] timeout in milliseconds.
 * @returns {Promise<void>}
 */
async function pressOnSelector(selector, keyCombo, options = {}) {
    await focusWithTimeout(selector, options.timeout);
    await press(keyCombo);
}
/**
 * Set a checkbox or radio to checked.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input.
 * @returns {Promise<void>}
 */
async function check(selector) {
    await setChecked(selector, true);
}
/**
 * Set a checkbox to unchecked.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the checkbox.
 * @returns {Promise<void>}
 */
async function uncheck(selector) {
    await setChecked(selector, false);
}
/**
 * Set the checked state of a checkbox or radio, Playwright-style.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input.
 * @param {boolean} checked Desired checked state.
 * @returns {Promise<void>}
 */
async function setChecked(selector, checked) {
    await resolveAndCall(selector, `function(checked){
      if (!(this instanceof HTMLInputElement) || (this.type !== "checkbox" && this.type !== "radio")) {
        throw new Error("setChecked target must be a checkbox or radio input");
      }
      if (this.type === "radio" && !checked) {
        throw new Error("setChecked cannot uncheck a radio input");
      }
      if (this.checked === checked) return;
      this.checked = checked;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }`, [Boolean(checked)]);
}
/**
 * Select one or more options in a <select>.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the select.
 * @param {string|number|object|Array<string|number|object>} values Option value(s), labels, or indexes.
 * @returns {Promise<string[]>} Selected option values.
 */
async function selectOption(selector, values) {
    const { result } = await resolveAndCall(selector, `function(values){
      if (!(this instanceof HTMLSelectElement)) {
        throw new Error("selectOption target must be a select element");
      }
      const wanted = Array.isArray(values) ? values : [values];
      const selected = [];
      for (const option of this.options) option.selected = false;
      for (const wantedOption of wanted) {
        let match;
        if (typeof wantedOption === "object" && wantedOption !== null) {
          if (typeof wantedOption.index === "number") match = this.options[wantedOption.index];
          if (!match && wantedOption.value !== undefined) {
            match = [...this.options].find((option) => option.value === String(wantedOption.value));
          }
          if (!match && wantedOption.label !== undefined) {
            match = [...this.options].find((option) => option.label === String(wantedOption.label) || option.text === String(wantedOption.label));
          }
        } else {
          match = [...this.options].find((option) => option.value === String(wantedOption));
        }
        if (!match) throw new Error("selectOption could not find option " + JSON.stringify(wantedOption));
        match.selected = true;
        selected.push(match.value);
        if (!this.multiple) break;
      }
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return selected;
    }`, [values]);
    return result.result?.value || [];
}
async function focusWithTimeout(selector, timeout = state.defaultTimeout) {
    if (timeout > 0 && !(await waitForSelector(selector, { timeout }))) {
        throw new Error(`focus: element not found: ${JSON.stringify(selector)}`);
    }
    await focus(selector);
}
// Page-side dispatcher, mirroring Playwright's injected dispatchEvent: the type
// selects the event constructor and eventInit is spread onto the same defaults
// Playwright uses. Types outside this table (input/change, touch*, custom, ...)
// fall back to a generic Event. Kept as a string for Runtime.callFunctionOn.
const DISPATCH_EVENT_SOURCE = `function(type, eventInit){
  const init = { bubbles: true, cancelable: true, composed: true, ...(eventInit || {}) };
  const category = {
    auxclick: "mouse", click: "mouse", dblclick: "mouse", mousedown: "mouse",
    mouseenter: "mouse", mouseleave: "mouse", mousemove: "mouse", mouseout: "mouse",
    mouseover: "mouse", mouseup: "mouse", mousewheel: "mouse",
    keydown: "keyboard", keyup: "keyboard", keypress: "keyboard", textInput: "keyboard",
    pointerover: "pointer", pointerout: "pointer", pointerenter: "pointer",
    pointerleave: "pointer", pointerdown: "pointer", pointerup: "pointer",
    pointermove: "pointer", pointercancel: "pointer", gotpointercapture: "pointer",
    lostpointercapture: "pointer",
    focus: "focus", blur: "focus",
    dragstart: "drag", drag: "drag", dragend: "drag", dragenter: "drag",
    dragleave: "drag", dragover: "drag", dragexit: "drag", drop: "drag",
    wheel: "wheel"
  };
  let event;
  switch (category[type]) {
    case "mouse": event = new MouseEvent(type, init); break;
    case "keyboard": event = new KeyboardEvent(type, init); break;
    case "pointer": event = new PointerEvent(type, init); break;
    case "focus": event = new FocusEvent(type, init); break;
    case "drag": event = new DragEvent(type, init); break;
    case "wheel": event = new WheelEvent(type, init); break;
    default: event = new Event(type, init); break;
  }
  this.dispatchEvent(event);
}`;
/**
 * Dispatch a synthetic DOM event on an element, mirroring Playwright's
 * locator.dispatchEvent. The event type picks the constructor — keydown/keyup/
 * keypress -> KeyboardEvent, click/mousedown/... -> MouseEvent, and pointer* /
 * focus / blur / drag* / wheel -> their typed events; any other type (input,
 * change, touch*, custom events, ...) uses a generic Event. eventInit is spread
 * verbatim onto { bubbles: true, cancelable: true, composed: true } and passed
 * to the constructor.
 * Note: the dispatched event has isTrusted=false; some frameworks ignore it. For
 * real keyboard input prefer press().
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the target element.
 * @param {string} type DOM event type, e.g. "keydown", "click", "input".
 * @param {Record<string, unknown>} [eventInit={}] Event-specific init properties (key, code, clientX, ...).
 * @returns {Promise<void>}
 */
async function dispatchEvent(selector, type, eventInit = {}) {
    if (typeof type !== "string" || type === "") {
        throw new Error("dispatchEvent requires an event type string");
    }
    await resolveAndCall(selector, DISPATCH_EVENT_SOURCE, [type, eventInit]);
}
function inputEventDelay() {
    return new Promise((resolve) => setTimeout(resolve, INPUT_EVENT_DELAY_MS));
}
async function dispatchKeyEvent(params) {
    await browserCdp("Input.dispatchKeyEvent", params, undefined, INPUT_DISPATCH_TIMEOUT_MS);
}
async function installKeyProbe(key) {
    if (!canProbeInputFallback())
        return null;
    const id = `key_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
      window.__egoBrowserInputProbes ||= {};
      const probe = { seen: false };
      probe.handler = (event) => {
        if (event.isTrusted && event.key === ${JSON.stringify(key)}) probe.seen = true;
      };
      document.addEventListener("keydown", probe.handler, true);
      window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
      return true;
    })()`,
            returnByValue: true,
            awaitPromise: false,
        });
        return result.result?.value ? id : null;
    }
    catch {
        return null;
    }
}
async function finishKeyProbe(id, definition) {
    if (!id)
        return false;
    await inputEventDelay();
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
      const probes = window.__egoBrowserInputProbes || {};
      const probe = probes[${JSON.stringify(id)}];
      if (!probe) return { seen: false, fallback: false };
      document.removeEventListener("keydown", probe.handler, true);
      delete probes[${JSON.stringify(id)}];
      if (probe.seen) return { seen: true, fallback: false };

      const target = document.activeElement || document.body;
      const key = ${JSON.stringify(definition.key)};
      const code = ${JSON.stringify(definition.code)};
      const text = ${JSON.stringify(definition.text)};
      const commands = ${JSON.stringify(definition.commands || [])};
      const keyboardInit = {
        key,
        code,
        bubbles: true,
        cancelable: true,
        keyCode: ${JSON.stringify(keyDefinition(definition.key).vk)},
        which: ${JSON.stringify(keyDefinition(definition.key).vk)},
      };
      target.dispatchEvent(new KeyboardEvent("keydown", keyboardInit));

      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (isEditable) {
        if (commands.includes("selectAll") && typeof target.select === "function") {
          target.select();
        } else if (commands.includes("deleteBackward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const from = start === end ? Math.max(0, start - 1) : start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentBackward",
          }));
          target.value = before.slice(0, from) + before.slice(end);
          target.setSelectionRange(from, from);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
          }));
        } else if (commands.includes("deleteForward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const to = start === end ? Math.min(target.value.length, end + 1) : end;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentForward",
          }));
          target.value = before.slice(0, start) + before.slice(to);
          target.setSelectionRange(start, start);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentForward",
          }));
        } else if (text) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: "insertText",
          }));
          target.value = before.slice(0, start) + text + before.slice(end);
          const next = start + text.length;
          target.setSelectionRange(next, next);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            data: text,
            inputType: "insertText",
          }));
        }
      }

      target.dispatchEvent(new KeyboardEvent("keyup", keyboardInit));
      return { seen: false, fallback: true };
    })()`,
            returnByValue: true,
            awaitPromise: false,
        });
        const value = result.result?.value;
        return Boolean(value?.seen || value?.fallback);
    }
    catch {
        return false;
    }
}
function canProbeInputFallback() {
    return Boolean(globalThis.ego?.sendCDPMessage);
}
function isKeyDispatchTimeout(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /CDP request timed out: Input\.dispatchKeyEvent/.test(message);
}

/**
 * Return element.textContent for a single element.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<string|null>}
 */
async function textContent(selector) {
    return readElement(selector, "function(){return this.textContent;}");
}
/**
 * Return element.innerText for a single HTMLElement.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<string>}
 */
async function innerText(selector) {
    return readElement(selector, `function(){
      if (!(this instanceof HTMLElement)) throw new Error("innerText target must be an HTMLElement");
      return this.innerText;
    }`);
}
/**
 * Return element.innerHTML for a single element.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<string>}
 */
async function innerHTML(selector) {
    return readElement(selector, `function(){
      if (!(this instanceof Element)) throw new Error("innerHTML target must be an Element");
      return this.innerHTML;
    }`);
}
/**
 * Return value for an input, textarea, or select.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the form control.
 * @returns {Promise<string>}
 */
async function inputValue(selector) {
    return readElement(selector, `function(){
      const target = this instanceof HTMLLabelElement && this.control ? this.control : this;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return target.value;
      }
      throw new Error("inputValue target must be an input, textarea, or select");
    }`);
}
/**
 * Return checked state for a checkbox or radio.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input.
 * @returns {Promise<boolean>}
 */
async function isChecked(selector) {
    return readElement(selector, `function(){
      const target = this instanceof HTMLLabelElement && this.control ? this.control : this;
      if (!(target instanceof HTMLInputElement) || (target.type !== "checkbox" && target.type !== "radio")) {
        throw new Error("isChecked target must be a checkbox or radio input");
      }
      return target.checked;
    }`);
}
/**
 * Return whether the element is visible. Missing elements return false.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<boolean>}
 */
async function isVisible(selector) {
    return readOptionalElement(selector, `function(){
      if (!(this instanceof Element)) return false;
      if (typeof this.checkVisibility === "function") {
        return this.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const style = getComputedStyle(this);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = this.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }`, [], false);
}
/**
 * Return whether the element is hidden. Missing elements return true.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<boolean>}
 */
async function isHidden(selector) {
    return !(await isVisible(selector));
}
/**
 * Return whether the element is enabled. Missing elements return false.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<boolean>}
 */
async function isEnabled(selector) {
    return readOptionalElement(selector, `function(){
      const target = this instanceof HTMLLabelElement && this.control ? this.control : this;
      if (!(target instanceof Element)) return false;
      if (target.getAttribute("aria-disabled") === "true") return false;
      if ("disabled" in target && target.disabled) return false;
      const disabledFieldset = target.closest("fieldset[disabled]");
      return !disabledFieldset;
    }`, [], false);
}
/**
 * Return whether the element is disabled. Missing elements return true.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<boolean>}
 */
async function isDisabled(selector) {
    return !(await isEnabled(selector));
}
/**
 * Return whether the element is editable. Missing elements return false.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<boolean>}
 */
async function isEditable(selector) {
    return readOptionalElement(selector, `function(){
      const target = this instanceof HTMLLabelElement && this.control ? this.control : this;
      if (!(target instanceof Element)) return false;
      if (target.isContentEditable) return true;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return !target.disabled && !target.readOnly;
      }
      return false;
    }`, [], false);
}
/**
 * Return a DOM attribute value for a single element.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @param {string} name Attribute name.
 * @returns {Promise<string|null>}
 */
async function getAttribute(selector, name) {
    return readElement(selector, "function(name){return this.getAttribute(String(name));}", [name]);
}
/**
 * Remove focus from an element.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<void>}
 */
async function blur(selector) {
    await readElement(selector, "function(){this.blur();}");
}
/**
 * Return the element bounding box in viewport CSS pixels.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<{x:number,y:number,width:number,height:number}|null>}
 */
async function boundingBox(selector) {
    return readElement(selector, `function(){
      if (!(this instanceof Element)) return null;
      const rect = this.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }`);
}
/**
 * Count matching elements. Supports CSS, xpath=, loc=css:, loc=href:, and refs.
 * @param {string} selector Selector to query.
 * @returns {Promise<number>}
 */
async function count(selector) {
    if (parseRef(selector)) {
        const handle = await resolveHandle(selector);
        await releaseHandle(handle.objectId, handle.sessionId);
        return 1;
    }
    const backendNodeIds = await queryRoleBackendNodeIds(selector);
    if (backendNodeIds !== null) {
        return backendNodeIds.length;
    }
    return readQueryAll(selector, "return elements.length;");
}
/**
 * Return innerText for all matching HTMLElement nodes.
 * @param {string} selector Selector to query.
 * @returns {Promise<string[]>}
 */
async function allInnerTexts(selector) {
    return readQueryAll(selector, `return elements.map((element) => {
      if (!(element instanceof HTMLElement)) throw new Error("allInnerTexts targets must be HTMLElements");
      return element.innerText;
    });`);
}
/**
 * Return textContent for all matching nodes.
 * @param {string} selector Selector to query.
 * @returns {Promise<Array<string|null>>}
 */
async function allTextContents(selector) {
    return readQueryAll(selector, "return elements.map((element) => element.textContent);");
}
/**
 * Execute JavaScript against one matching element, Playwright-style.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @param {Function|string} pageFunction Function source called with (element, arg).
 * @param {unknown} [arg] Optional serializable argument.
 * @returns {Promise<unknown>} Serializable return value from pageFunction.
 */
async function evaluateLocator(selector, pageFunction, arg = undefined) {
    const functionSource = pageFunctionSource(pageFunction, "locator.evaluate");
    return readElement(selector, `function(functionSource, arg){
      const pageFunction = (0, eval)("(" + functionSource + ")");
      return pageFunction(this, arg);
    }`, [functionSource, arg]);
}
/**
 * Execute JavaScript against all matching elements, Playwright-style.
 * @param {string} selector Selector to query.
 * @param {Function|string} pageFunction Function source called with (elements, arg).
 * @param {unknown} [arg] Optional serializable argument.
 * @returns {Promise<unknown>} Serializable return value from pageFunction.
 */
async function evaluateAll(selector, pageFunction, arg = undefined) {
    const functionSource = pageFunctionSource(pageFunction, "evaluateAll");
    if (parseRef(selector)) {
        return readElement(selector, `function(functionSource, arg){
        const pageFunction = (0, eval)("(" + functionSource + ")");
        return pageFunction([this], arg);
      }`, [functionSource, arg]);
    }
    const backendNodeIds = await queryRoleBackendNodeIds(selector);
    if (backendNodeIds !== null) {
        return evaluateRoleBackendNodes(backendNodeIds, functionSource, arg, true);
    }
    return evaluateQueryAll(selector, functionSource, arg);
}
async function readElement(selector, functionDeclaration, args = []) {
    const deadline = state.now() + state.defaultTimeout;
    while (true) {
        try {
            return await readElementOnce(selector, functionDeclaration, args);
        }
        catch (error) {
            if (!(error instanceof ElementResolutionError) ||
                error.kind !== "transient" ||
                state.now() >= deadline) {
                throw error;
            }
            await state.sleep(Math.min(100, deadline - state.now()));
        }
    }
}
async function readElementOnce(selector, functionDeclaration, args = []) {
    const { result } = await resolveAndCall(selector, functionDeclaration, args);
    return runtimeValue(result, functionDeclaration);
}
async function readOptionalElement(selector, functionDeclaration, args = [], fallback) {
    try {
        return await readElementOnce(selector, functionDeclaration, args);
    }
    catch (error) {
        if (error instanceof ElementResolutionError && error.kind === "transient") {
            return fallback;
        }
        throw error;
    }
}
async function readQueryAll(selector, body) {
    const backendNodeIds = await queryRoleBackendNodeIds(selector);
    if (backendNodeIds !== null) {
        return evaluateRoleBackendNodes(backendNodeIds, `function(elements){${body}}`, undefined, false);
    }
    const expression = `(() => {
    const elements = ${queryAllExpression(selector)};
    ${body}
  })()`;
    const result = await cdp("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: false,
    });
    return runtimeValue(result, expression);
}
async function evaluateRoleBackendNodes(backendNodeIds, functionSource, arg, awaitPromise) {
    if (backendNodeIds.length === 0) {
        const expression = `(() => {
      const pageFunction = (0, eval)(${JSON.stringify(`(${functionSource})`)});
      return pageFunction([], ${serializedArg(arg)});
    })()`;
        const result = await cdp("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
        });
        return runtimeValue(result, expression);
    }
    const handles = [];
    try {
        for (const backendNodeId of backendNodeIds) {
            const result = await cdp("DOM.resolveNode", {
                backendNodeId,
                objectGroup: "ego-browser-role-collection",
            });
            const objectId = result.object?.objectId;
            if (!objectId) {
                throw new ElementResolutionError(`No objectId for AX backend node ${backendNodeId}`, "permanent");
            }
            handles.push({ objectId });
        }
        const [first, ...rest] = handles;
        const functionDeclaration = `function(...args) {
      const functionSource = args.at(-2);
      const arg = args.at(-1);
      const elements = [this, ...args.slice(0, -2)];
      const pageFunction = (0, eval)("(" + functionSource + ")");
      return pageFunction(elements, arg);
    }`;
        const result = await cdp("Runtime.callFunctionOn", {
            functionDeclaration,
            objectId: first.objectId,
            arguments: [
                ...rest.map(({ objectId }) => ({ objectId })),
                { value: functionSource },
                { value: arg },
            ],
            returnByValue: true,
            awaitPromise,
        });
        return runtimeValue(result, functionDeclaration);
    }
    finally {
        for (const { objectId } of handles) {
            await releaseHandle(objectId, undefined);
        }
    }
}
function queryRoleBackendNodeIds(selector) {
    return queryRoleLocatorBackendNodeIds({ sendRaw: cdp }, undefined, selector);
}
async function evaluateQueryAll(selector, functionSource, arg) {
    const expression = `(() => {
    const elements = ${queryAllExpression(selector)};
    const pageFunction = (0, eval)(${JSON.stringify(`(${functionSource})`)});
    return pageFunction(elements, ${serializedArg(arg)});
  })()`;
    const result = await cdp("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    });
    return runtimeValue(result, expression);
}
function pageFunctionSource(pageFunction, helperName) {
    if (typeof pageFunction === "function") {
        return pageFunction.toString();
    }
    if (typeof pageFunction === "string") {
        return pageFunction;
    }
    throw new TypeError(`${helperName} expects a function or string pageFunction, got ${pageFunction === null ? "null" : typeof pageFunction}`);
}
function serializedArg(arg) {
    return arg === undefined ? "undefined" : JSON.stringify(arg);
}

/**
 * Set files on a file input.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for an input[type=file].
 * @param {string|string[]} path Absolute file path or paths to upload.
 * @returns {Promise<void>}
 */
async function setInputFiles(selector, path) {
    const files = Array.isArray(path) ? path : [path];
    await withHandle(selector, async ({ objectId, sessionId }) => {
        await cdp("DOM.setFileInputFiles", { files, objectId }, sessionId);
    });
}

/**
 * Wait for a Playwright-style page event. Currently supports "download".
 * @param {"download"} eventName Event name.
 * @param {{timeout?: number}} [options] Timeout in milliseconds.
 * @returns {Promise<object>} Download facade with suggestedFilename(), path(), saveAs(path), url().
 */
async function waitForEvent(eventName, options = {}) {
    if (eventName !== "download") {
        throw new Error(`page.waitForEvent currently supports only "download", got ${JSON.stringify(eventName)}`);
    }
    return waitForDownload(options);
}
async function waitForDownload(options = {}) {
    const timeout = options.timeout ?? state.defaultTimeout;
    const downloadDir = join(tmpdir(), `ego-browser-downloads-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(downloadDir, { recursive: true });
    const sessionPromise = ensureSession();
    const behaviorPromise = setDownloadBehavior(downloadDir);
    const willBeginPromise = waitForBrowserEvent((event) => event?.method === "Page.downloadWillBegin", timeout);
    let downloadGuid;
    const progressPromise = waitForBrowserEvent((event) => event?.method === "Page.downloadProgress" &&
        (!downloadGuid || event?.params?.guid === downloadGuid) &&
        (event?.params?.state === "completed" ||
            event?.params?.state === "canceled"), timeout);
    await Promise.all([sessionPromise, behaviorPromise]);
    const willBegin = await willBeginPromise;
    const guid = willBegin.params?.guid;
    downloadGuid = guid;
    const suggestedFilename = willBegin.params?.suggestedFilename || guid || "download";
    const progress = await progressPromise;
    if (progress.params?.state === "canceled") {
        throw new Error(`Download canceled: ${suggestedFilename}`);
    }
    const downloadedPath = join(downloadDir, suggestedFilename);
    return {
        suggestedFilename: () => suggestedFilename,
        url: () => willBegin.params?.url || "",
        path: async () => downloadedPath,
        saveAs: async (targetPath) => {
            await copyFile(downloadedPath, targetPath);
            return targetPath;
        },
    };
}
async function setDownloadBehavior(downloadDir) {
    try {
        await cdp("Browser.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: downloadDir,
            eventsEnabled: true,
        });
    }
    catch (error) {
        if (!/Browser\.setDownloadBehavior.*wasn't found|wasn't found/i.test(error?.message || "")) {
            throw error;
        }
        await cdp("Page.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: downloadDir,
        });
    }
}

const FPS = 25;
class VideoRecorder {
    _options;
    _process;
    _exitPromise;
    _writePromise = Promise.resolve();
    _firstFrameTimestamp;
    _lastFrame;
    _lastFrameReceivedAt = 0;
    _stderr = "";
    _stdinError;
    _stopPromise;
    _tempOutputPath;
    constructor(options) {
        this._options = options;
    }
    async start() {
        const { outputPath, size } = this._options;
        await mkdir(dirname(outputPath), { recursive: true });
        this._tempOutputPath = `${outputPath}.${process.pid}-${Math.random()
            .toString(16)
            .slice(2)}.webm`;
        const args = [
            "-loglevel",
            "error",
            "-f",
            "image2pipe",
            "-avioflags",
            "direct",
            "-fpsprobesize",
            "0",
            "-probesize",
            "32",
            "-analyzeduration",
            "0",
            "-c:v",
            "mjpeg",
            "-i",
            "pipe:0",
            "-y",
            "-an",
            "-r",
            "25",
            "-c:v",
            "vp8",
            "-qmin",
            "0",
            "-qmax",
            "50",
            "-crf",
            "8",
            "-deadline",
            "realtime",
            "-speed",
            "8",
            "-b:v",
            "1M",
            "-threads",
            "1",
            "-vf",
            `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
            this._tempOutputPath,
        ];
        const spawnProcess = this._options.spawnProcess ?? spawn;
        this._process = spawnProcess(this._options.ffmpegPath ??
            process.env.EGO_BROWSER_FFMPEG_PATH ??
            "ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
        this._exitPromise = new Promise((resolve) => {
            this._process.once("close", (code, signal) => resolve({ code, signal }));
            this._process.once("error", (error) => resolve({ error }));
        });
        this._process.stderr?.on("data", (chunk) => {
            this._stderr = `${this._stderr}${String(chunk)}`.slice(-65536);
        });
        this._process.stdin?.on("error", (error) => {
            this._stdinError ??= error;
        });
        try {
            await new Promise((resolve, reject) => {
                this._process.once("spawn", resolve);
                this._process.once("error", reject);
            });
        }
        catch (error) {
            if (error?.code === "ENOENT") {
                throw new Error("FFmpeg executable was not found. Install ffmpeg or set EGO_BROWSER_FFMPEG_PATH.", { cause: error });
            }
            throw error;
        }
    }
    writeFrame(buffer, timestamp) {
        const frameNumber = this._firstFrameTimestamp !== undefined
            ? Math.floor(((timestamp - this._firstFrameTimestamp) * FPS) / 1000)
            : 0;
        if (this._lastFrame) {
            this._queueFrames(this._lastFrame.buffer, Math.max(0, frameNumber - this._lastFrame.frameNumber));
        }
        else {
            this._firstFrameTimestamp = timestamp;
        }
        this._lastFrame = { buffer, timestamp, frameNumber };
        this._lastFrameReceivedAt = this._now();
        return this._writePromise;
    }
    stop() {
        this._stopPromise ??= this._stop();
        return this._stopPromise;
    }
    async _stop() {
        if (this._lastFrame && this._firstFrameTimestamp !== undefined) {
            const elapsed = Math.max(this._now() - this._lastFrameReceivedAt, 1000);
            const finalFrameNumber = Math.floor(((this._lastFrame.timestamp + elapsed - this._firstFrameTimestamp) *
                FPS) /
                1000);
            this._queueFrames(this._lastFrame.buffer, Math.max(0, finalFrameNumber - this._lastFrame.frameNumber));
        }
        let writeError;
        try {
            await this._writePromise;
        }
        catch (error) {
            writeError = error;
        }
        try {
            this._process.stdin.end();
        }
        catch (error) {
            this._stdinError ??= error;
        }
        const result = await this._exitPromise;
        const failure = result?.error ?? writeError ?? this._stdinError;
        if (failure || result?.code !== 0) {
            await this._removeTempOutput();
            const detail = this._stderr.trim();
            const status = result?.error
                ? result.error.message
                : `exited with code ${result?.code}`;
            throw new Error(`ffmpeg ${status}${detail ? `: ${detail}` : ""}`, {
                cause: failure,
            });
        }
        try {
            await rename(this._tempOutputPath, this._options.outputPath);
        }
        catch (error) {
            await this._removeTempOutput();
            throw error;
        }
    }
    _queueFrames(buffer, count) {
        this._writePromise = this._writePromise.then(async () => {
            for (let i = 0; i < count; i++) {
                await new Promise((resolve, reject) => {
                    this._process.stdin.write(buffer, (error) => error ? reject(error) : resolve());
                });
            }
        });
    }
    _now() {
        return (this._options.now ?? Date.now)();
    }
    async _removeTempOutput() {
        if (!this._tempOutputPath)
            return;
        await unlink(this._tempOutputPath).catch((error) => {
            if (error?.code !== "ENOENT")
                throw error;
        });
    }
}

const defaults = {
    browserCdp,
    ensureSession,
    pageInfo,
    subscribeBrowserEvent,
    createRecorder: (options) => new VideoRecorder(options),
    now: Date.now,
};
let dependencies = { ...defaults };
let activeRecording;
/**
 * Start recording the current page viewport to a silent VP8 WebM file.
 * The recording is bound to the current CDP session and must be stopped in the same script.
 * @param {{path:string,size?:{width:number,height:number},quality?:number}} options Output path, optional frame bounds, and JPEG quality from 0 to 100.
 * @returns {Promise<{dispose:()=>Promise<void>,[Symbol.asyncDispose]:()=>Promise<void>}>} Disposable that stops and finalizes the recording.
 */
async function startScreencast(options) {
    if (!options ||
        typeof options.path !== "string" ||
        !options.path.endsWith(".webm")) {
        throw new Error("page.screencast.start path must end with .webm");
    }
    const quality = options.quality ?? 90;
    if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
        throw new Error("page.screencast.start quality must be between 0 and 100");
    }
    if (options.size &&
        (!Number.isInteger(options.size.width) ||
            !Number.isInteger(options.size.height) ||
            options.size.width < 2 ||
            options.size.height < 2)) {
        throw new Error("page.screencast.start width and height must be at least 2 pixels");
    }
    if (activeRecording)
        throw new Error("Screencast is already started");
    const sessionId = await dependencies.ensureSession();
    const size = evenSize(options.size ?? (await defaultSize()));
    const recorder = dependencies.createRecorder({
        outputPath: resolve(options.path),
        size,
    });
    await recorder.start();
    const recording = {
        sessionId,
        recorder,
        unsubscribe: () => { },
        receivedFrames: false,
        quality,
        frameChain: Promise.resolve(),
    };
    activeRecording = recording;
    try {
        recording.unsubscribe = dependencies.subscribeBrowserEvent("Page.screencastFrame", sessionId, (event) => {
            recording.receivedFrames = true;
            recording.frameChain = recording.frameChain
                .then(async () => {
                const cdpTimestamp = event.params?.metadata?.timestamp;
                const timestamp = typeof cdpTimestamp === "number"
                    ? cdpTimestamp * 1000
                    : dependencies.now();
                await recorder.writeFrame(Buffer.from(event.params.data, "base64"), timestamp);
                await dependencies.browserCdp("Page.screencastFrameAck", { sessionId: event.params.sessionId }, sessionId);
            })
                .catch((error) => {
                recording.error ??= error;
            });
        });
        await dependencies.browserCdp("Page.startScreencast", {
            format: "jpeg",
            quality,
            maxWidth: size.width,
            maxHeight: size.height,
        }, sessionId);
    }
    catch (error) {
        activeRecording = undefined;
        recording.unsubscribe();
        await recorder.stop().catch(() => { });
        throw error;
    }
    const dispose = async () => {
        if (activeRecording === recording)
            await stopScreencast();
    };
    return { dispose, [Symbol.asyncDispose]: dispose };
}
/**
 * Stop and finalize the active page screencast. Resolves after FFmpeg closes the WebM file.
 * @returns {Promise<void>}
 */
async function stopScreencast() {
    const recording = activeRecording;
    if (!recording)
        return;
    activeRecording = undefined;
    let stopError = recording.error;
    recording.unsubscribe();
    await recording.frameChain;
    stopError ??= recording.error;
    try {
        if (!recording.receivedFrames) {
            const response = await dependencies.browserCdp("Page.captureScreenshot", { format: "jpeg", quality: recording.quality }, recording.sessionId);
            const data = response.result?.data ?? response.data;
            await recording.recorder.writeFrame(Buffer.from(data, "base64"), dependencies.now());
        }
    }
    catch (error) {
        stopError ??= error;
    }
    try {
        await dependencies.browserCdp("Page.stopScreencast", {}, recording.sessionId);
    }
    catch (error) {
        stopError ??= error;
    }
    try {
        await recording.recorder.stop();
    }
    catch (error) {
        stopError ??= error;
    }
    if (stopError)
        throw stopError;
}
async function defaultSize() {
    const info = await dependencies.pageInfo();
    const scale = Math.min(1, 800 / Math.max(info.w, info.h));
    return evenSize({
        width: Math.floor(info.w * scale),
        height: Math.floor(info.h * scale),
    });
}
function evenSize(size) {
    return { width: size.width & -2, height: size.height & -2 };
}

const nativeFetch = globalThis.fetch?.bind(globalThis);
/**
 * Fetch text from Node with a browser-like User-Agent.
 * @param {string} url URL to fetch.
 * @param {{headers?: Record<string,string>, timeout?: number, method?: string, body?: any}} [options]
 * @returns {Promise<string>} Response body text.
 */
async function serverFetch(url, options = {}) {
    if (!nativeFetch) {
        throw new Error("serverFetch requires globalThis.fetch");
    }
    const { timeout = 20.0, headers = {}, ...fetchOptions } = options;
    const response = await nativeFetch(url, {
        ...fetchOptions,
        headers: { "User-Agent": "Mozilla/5.0", ...headers },
        signal: AbortSignal.timeout(timeout * 1000),
    });
    if (!response.ok) {
        throw new Error(`${fetchOptions.method || "GET"} ${url} failed: HTTP ${response.status}`);
    }
    return response.text();
}
/**
 * Fetch text in the current browser page context.
 * @param {string} url URL to fetch. Relative URLs resolve against the current page.
 * @param {{headers?: Record<string,string>, timeout?: number, method?: string, body?: any}} [options]
 * @returns {Promise<string>} Response body text.
 */
async function browserFetch(url, options = {}) {
    const { timeout = 20.0, ...fetchOptions } = options;
    const payload = JSON.stringify({ url, options: fetchOptions, timeout });
    return evaluate(`(async () => {
    const { url, options, timeout } = ${payload};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        throw new Error(\`\${options.method || "GET"} \${url} failed: HTTP \${response.status}\`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  })()`);
}

function learningsRoot(workspace = agentWorkspace()) {
    return join(workspace, "learnings");
}
const siteSkillsRoot = learningsRoot;
async function siteSkillsForUrl$1(url, options = {}) {
    const hostname = urlHostname(url);
    if (!hostname) {
        return [];
    }
    const root = options.root || learningsRoot(options.agentWorkspace || agentWorkspace());
    const matches = [];
    for (const siteDir of await iterLearningDirs(root)) {
        let manifest;
        try {
            manifest = await loadLearningManifest(siteDir);
        }
        catch {
            continue;
        }
        const domains = Array.isArray(manifest.domains) ? manifest.domains : [];
        if (domains.some((domain) => typeof domain === "string" && domainMatches(hostname, domain))) {
            matches.push(learningEntry(siteDir, manifest));
        }
    }
    return matches;
}
async function iterLearningDirs(root) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
        .map((entry) => join(root, entry.name))
        .sort();
}
async function loadLearningManifest(siteDir) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(join(siteDir, "manifest.json"), "utf8"));
    }
    catch (error) {
        throw new Error(`site skill ${JSON.stringify(siteDir)} has invalid or missing manifest.json: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`site skill ${JSON.stringify(siteDir)} manifest must be an object`);
    }
    return parsed;
}
function learningEntry(siteDir, manifest) {
    const notes = Array.isArray(manifest.notes) ? manifest.notes : [];
    return {
        id: manifest.id || siteDir.split(/[\\/]/).at(-1),
        name: manifest.name || manifest.id || siteDir.split(/[\\/]/).at(-1),
        path: siteDir,
        domains: Array.isArray(manifest.domains) ? [...manifest.domains] : [],
        notes: notes.map((note) => join(siteDir, note)),
        nodeTools: toolSchemasNode(manifest),
        browserTools: toolSchemasBrowser(manifest),
    };
}
function urlHostname(url) {
    try {
        const parsed = String(url).includes("://")
            ? new URL(String(url))
            : new URL(`https://${url}`);
        return (parsed.hostname || "").toLowerCase().replace(/\.$/, "");
    }
    catch {
        return "";
    }
}
function domainMatches(hostname, pattern) {
    const normalized = String(pattern || "")
        .toLowerCase()
        .replace(/\.$/, "");
    if (normalized.startsWith("*.")) {
        const suffix = normalized.slice(2);
        return hostname.endsWith(`.${suffix}`);
    }
    return hostname === normalized;
}
function toolSchemasNode(manifest) {
    const value = manifest.nodeTools;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return { ...value };
}
function toolSchemasBrowser(manifest) {
    const value = manifest.browserTools;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return { ...value };
}

/**
 * Load learned context for a given URL.
 * Returns site knowledge (notes content, available tools, selector hints).
 */
async function loadLearnedContext(url, options = {}) {
    const matches = await siteSkillsForUrl$1(url, options);
    if (matches.length === 0) {
        return {
            exists: false,
            siteId: null,
            siteName: null,
            domain: urlHostname(url),
            knowledge: [],
            tools: [],
        };
    }
    const toolSignatures = [];
    const knowledgeNotes = [];
    for (const entry of matches) {
        const siteId = entry.id;
        for (const notePath of entry.notes) {
            if (!isLearningNotePath(entry.path, notePath)) {
                continue;
            }
            let content;
            try {
                content = await readFile(notePath, "utf8");
            }
            catch {
                continue;
            }
            const fileName = notePath.split(/[\\/]/).pop() || "";
            knowledgeNotes.push({ siteId, fileName, content });
        }
        // Build tool signatures with usage examples
        const nodeTools = entry.nodeTools || {};
        for (const [toolName, schema] of Object.entries(nodeTools)) {
            toolSignatures.push({
                siteId,
                toolName,
                toolType: "node",
                description: schema.description || "",
                args: schema.args || {},
                returns: schema.returns || null,
                example: `await site.runTool("${siteId}", "${toolName}", { ... })`,
            });
        }
        const browserTools = entry.browserTools || {};
        for (const [toolName, schema] of Object.entries(browserTools)) {
            toolSignatures.push({
                siteId,
                toolName,
                toolType: "browser",
                description: schema.description || "",
                args: schema.args || {},
                returns: schema.returns || null,
                example: `await site.runBrowserTool("${siteId}", "${toolName}", { ... })`,
            });
        }
    }
    return {
        exists: true,
        siteId: matches[0].id,
        siteName: matches[0].name,
        domain: urlHostname(url),
        knowledge: knowledgeNotes,
        tools: toolSignatures,
    };
}
function isLearningNotePath(siteDir, notePath) {
    const relativePath = relative(resolve(siteDir), resolve(notePath));
    const parts = relativePath.split(/[\\/]/);
    return (parts.length === 2 &&
        parts[0] === "notes" &&
        parts[1].endsWith(".md") &&
        parts.every((part) => part && part !== "." && part !== ".."));
}
async function findSiteSkill(siteId, options = {}) {
    const root = options.root || siteSkillsRoot(options.agentWorkspace);
    for (const siteDir of await iterLearningDirs(root)) {
        const manifest = await loadLearningManifest(siteDir);
        if (manifest.id === siteId) {
            return { siteDir, manifest };
        }
    }
    throw siteSkillNotFoundError(siteId, root);
}
async function runNodeSiteTool(siteId, toolName, args = {}, ctx, options = {}) {
    const { siteDir, manifest } = await findSiteSkill(siteId, options);
    const schema = toolSchemas(manifest, "nodeTools")[toolName];
    if (!schema || typeof schema !== "object") {
        throw new Error(`Node tool ${JSON.stringify(toolName)} is not declared by site skill ${JSON.stringify(siteId)}`);
    }
    const toolPath = relativeSitePath(siteDir, schema.path, "Node tool");
    const module = await import(`${pathToFileURL(toolPath).href}?t=${Date.now()}`);
    const callableName = schema.callable;
    if (typeof callableName !== "string" || !callableName.trim()) {
        throw new Error(`Node tool ${JSON.stringify(toolName)} must declare a callable`);
    }
    const tool = module[callableName];
    if (typeof tool !== "function") {
        throw new Error(`site skill ${JSON.stringify(siteId)} is missing Node callable ${JSON.stringify(callableName)}`);
    }
    return tool(ctx, args || {});
}
async function loadBrowserToolSource(siteId, toolName, options = {}) {
    const { siteDir, manifest } = await findSiteSkill(siteId, options);
    const schema = toolSchemas(manifest, "browserTools")[toolName];
    if (!schema || typeof schema !== "object") {
        throw new Error(`browser tool ${JSON.stringify(toolName)} is not declared by site skill ${JSON.stringify(siteId)}`);
    }
    const toolPath = relativeSitePath(siteDir, schema.path, "browser tool");
    return readFile(toolPath, "utf8");
}
function wrapBrowserTool(source, args = {}) {
    return `(async () => { const __egoBrowserTool = ${source}; return await __egoBrowserTool(${JSON.stringify(args || {})}); })()`;
}
function siteSkillNotFoundError(siteId, searchedRoot) {
    const workspace = process.env.EGO_BROWSER_AGENT_WORKSPACE || "unset";
    const lines = [
        `site skill not found: ${JSON.stringify(siteId)}`,
        `  searched: ${searchedRoot}`,
        `  EGO_BROWSER_AGENT_WORKSPACE: ${workspace}`,
        `  hint: ensure your write path begins with the searched root above`,
    ];
    return new Error(lines.join("\n"));
}
function toolSchemas(manifest, key) {
    const value = manifest[key] || {};
    return value && typeof value === "object" && !Array.isArray(value)
        ? { ...value }
        : {};
}
function relativeSitePath(siteDir, manifestPath, label) {
    if (typeof manifestPath !== "string" || !manifestPath.trim()) {
        throw new Error(`${label} path must be a non-empty relative path`);
    }
    if (manifestPath.includes("\\") ||
        isAbsolute(manifestPath) ||
        manifestPath.split("/").includes("..")) {
        throw new Error(`${label} path must be relative to the site skill directory`);
    }
    const resolved = resolve(siteDir, manifestPath);
    const siteRoot = resolve(siteDir);
    if (resolved !== siteRoot && !resolved.startsWith(`${siteRoot}/`)) {
        throw new Error(`${label} path must stay inside the site skill directory`);
    }
    return resolved;
}

/**
 * List all task spaces.
 * @returns {Promise<Array<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>>}
 */
async function listTaskSpaces() {
    const ego = globalThis.ego;
    if (!ego || typeof ego.listTaskSpaces !== "function") {
        throw new Error("listTaskSpaces requires ego.listTaskSpaces");
    }
    return normalizeTaskSpaces(assertNoEgoError(await ego.listTaskSpaces(), "listTaskSpaces"));
}
/*
 * Task space ownership policy (`ownership`: "agent" | "agentDelegatedToUser" | "user").
 * "agent" and "agentDelegatedToUser" are both agent-owned (see isAgentOwned) — the
 * latter is the agent's own space with control temporarily handed to the user
 * (handoff or GUI takeover). The user-control boundary is enforced at the native
 * bridge when real commands run, not here. The rows below describe what each helper
 * does when the target space is user-owned:
 *
 *   switchTaskSpace                     -> throws (agent-owned only)
 *   claimTaskSpace                      -> claims it (ownership transfers to the agent), then selects it
 *   handOffTaskSpace                    -> skipped, resolves { done: false, skipped: "user-owned" }
 *   completeTaskSpace { keep: true }    -> skipped, resolves { done: false, skipped: "user-owned" }
 *   completeTaskSpace { keep: false }   -> claims it, then closes it
 *   takeOverTaskSpace / waitForAgentControl -> no ownership check (operates as-is)
 *
 * Keep this table in sync with the one in skills/ego-browser/SKILL.md.
 */
/**
 * Whether the agent owns the space. "agentDelegatedToUser" is still agent-owned —
 * the agent created it but control is temporarily with the user (handoff / GUI
 * takeover). Selecting such a space is fine; the user-control boundary is enforced
 * separately at the native bridge when real commands run.
 * @param {string|undefined} ownership
 * @returns {boolean}
 */
function isAgentOwned(ownership) {
    return ownership === "agent" || ownership === "agentDelegatedToUser";
}
/**
 * Select an existing task space by id/name for the current Node invocation.
 * @param {string|number} nameOrId Task space id or name.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
async function switchTaskSpace(nameOrId) {
    const ego = globalThis.ego;
    if (!ego || typeof ego.useTaskSpace !== "function") {
        throw new Error("switchTaskSpace requires ego.useTaskSpace");
    }
    const space = await findTaskSpace(nameOrId);
    if (!isAgentOwned(space.ownership)) {
        throw new Error(`switchTaskSpace requires an agent-owned task space, got ownership ${JSON.stringify(space.ownership)}`);
    }
    return selectTaskSpace(ego, space, "switchTaskSpace");
}
/**
 * Create an agent-owned task space and select it for the current Node invocation.
 * @param {string} name Task space name.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
async function newTaskSpace(name) {
    const ego = globalThis.ego;
    if (!ego || typeof ego.createTaskSpace !== "function") {
        throw new Error("newTaskSpace requires ego.createTaskSpace");
    }
    const created = normalizeTaskSpace(assertNoEgoError(await ego.createTaskSpace(name), "newTaskSpace"));
    if (!created) {
        throw new Error("newTaskSpace returned an invalid task space");
    }
    taskSpaceNumericId(created, "newTaskSpace");
    return selectTaskSpace(ego, created, "newTaskSpace");
}
/**
 * Use an existing agent-owned task space, or create it when missing. User-owned
 * spaces are selected but not claimed (the EGO_TASK_SPACE_USER_IN_CONTROL error
 * surfaces) — call claimTaskSpace(nameOrId) to take ownership.
 * @param {string|number} nameOrId Task space name or numeric id.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
async function useOrCreateTaskSpace(nameOrId) {
    const spaces = await listTaskSpaces();
    const existing = findMatchingTaskSpace(spaces, nameOrId);
    if (!existing) {
        if (typeof nameOrId === "number") {
            throw new Error(`task space not found: ${nameOrId}`);
        }
        return newTaskSpace(nameOrId);
    }
    if (isAgentOwned(existing.ownership)) {
        return selectTaskSpace(globalThis.ego, existing, "useOrCreateTaskSpace");
    }
    if (existing.ownership === "user") {
        // Don't claim user-owned spaces here. Select it as-is; the user stays in
        // control, so EGO_TASK_SPACE_USER_IN_CONTROL surfaces (as ego-browser's owned
        // guidance, not the raw native text). Call claimTaskSpace(nameOrId) to take
        // ownership.
        return selectTaskSpace(globalThis.ego, existing, "useOrCreateTaskSpace");
    }
    throw new Error(`useOrCreateTaskSpace cannot use task space ${JSON.stringify(nameOrId)} with ownership ${JSON.stringify(existing.ownership)}`);
}
/**
 * Claim a user-owned task space (ownership transfers to the agent) and select it
 * for the current Node invocation. Resolves the space by id/name, claims it via
 * ego.claimTaskSpace, then selects it.
 * @param {string|number} nameOrId Task space id or name.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
async function claimTaskSpace(nameOrId) {
    const space = await findTaskSpace(nameOrId);
    return claimResolvedTaskSpace(space, "claimTaskSpace");
}
async function claimResolvedTaskSpace(space, op = "claimTaskSpace") {
    const ego = globalThis.ego;
    if (!ego || typeof ego.claimTaskSpace !== "function") {
        throw new Error(`${op} requires ego.claimTaskSpace`);
    }
    const id = taskSpaceNumericId(space, op);
    const claimed = normalizeTaskSpace(assertNoEgoError(await ego.claimTaskSpace(id, space.name), op));
    if (!claimed) {
        throw new Error(`${op} returned an invalid task space`);
    }
    taskSpaceNumericId(claimed, op);
    return selectTaskSpace(ego, claimed, op);
}
async function selectTaskSpace(ego, space, op) {
    if (!ego || typeof ego.useTaskSpace !== "function") {
        throw new Error(`${op} requires ego.useTaskSpace`);
    }
    assertNoEgoError(await ego.useTaskSpace(taskSpaceNumericId(space, op)), op);
    return space;
}
async function selectTaskSpaceIfProvided(ego, nameOrId, op = "taskSpace") {
    if (nameOrId === undefined)
        return;
    const match = await findTaskSpace(nameOrId);
    await selectTaskSpace(ego, match, op);
}
/**
 * Finish working on a task space. With `{ keep: true }` the page stays open
 * with the agent overlay dismissed so the user can review the result; with
 * `{ keep: false }` the task space is closed entirely.
 * User-owned spaces: `keep:true` is skipped (the user already has the page) and
 * resolves `{ done: false, skipped: "user-owned" }`; `keep:false` claims the
 * space first, then closes it.
 * @param {string|number} nameOrId Task space id or name.
 * @param {{ keep: boolean }} options Required. `keep:true` hands the page to the user; `keep:false` closes the space.
 * @returns {Promise<{done: boolean, skipped?: "user-owned"}>} `{ done: true }` when the space was completed or closed; `{ done: false, skipped: "user-owned" }` when nothing was done.
 */
async function completeTaskSpace(nameOrId, options) {
    if ((typeof nameOrId !== "string" && typeof nameOrId !== "number") ||
        nameOrId === "") {
        throw new Error("completeTaskSpace requires a task space name or id");
    }
    if (!options || typeof options.keep !== "boolean") {
        throw new Error("completeTaskSpace requires { keep: boolean }");
    }
    const ego = globalThis.ego;
    if (!ego) {
        throw new Error("completeTaskSpace requires ego runtime");
    }
    const spaces = await listTaskSpaces();
    const match = findMatchingTaskSpace(spaces, nameOrId);
    if (!match) {
        throw new Error(`task space not found: ${nameOrId}`);
    }
    if (options.keep) {
        if (match.ownership === "user") {
            return { done: false, skipped: "user-owned" };
        }
        await selectTaskSpace(ego, match, "completeTaskSpace");
        if (typeof ego.completeTaskSpace !== "function") {
            throw new Error("completeTaskSpace requires ego.completeTaskSpace");
        }
        assertNoEgoError(await ego.completeTaskSpace(), "completeTaskSpace");
    }
    else {
        if (match.ownership === "user") {
            await claimResolvedTaskSpace(match, "completeTaskSpace");
        }
        else {
            await selectTaskSpace(ego, match, "completeTaskSpace");
        }
        if (typeof ego.closeTaskSpace !== "function") {
            throw new Error("completeTaskSpace requires ego.closeTaskSpace");
        }
        assertNoEgoError(await ego.closeTaskSpace(), "completeTaskSpace");
    }
    return { done: true };
}
/**
 * Hand off a task space back to the user, hiding the agent overlay.
 * User-owned spaces are skipped (the user already controls them) and resolve
 * `{ done: false, skipped: "user-owned" }`.
 * @param {string|number} [nameOrId] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<{done: boolean, skipped?: "user-owned"}>} `{ done: true }` when control was handed off; `{ done: false, skipped: "user-owned" }` when nothing was done.
 */
async function handOffTaskSpace(nameOrId) {
    const ego = globalThis.ego;
    if (!ego || typeof ego.handOffTaskSpace !== "function") {
        throw new Error("handOffTaskSpace requires ego.handOffTaskSpace");
    }
    if (nameOrId !== undefined) {
        const match = await findTaskSpace(nameOrId);
        if (match.ownership === "user") {
            return { done: false, skipped: "user-owned" };
        }
        await selectTaskSpace(ego, match, "handOffTaskSpace");
    }
    assertNoEgoError(await ego.handOffTaskSpace(), "handOffTaskSpace");
    return { done: true };
}
/**
 * Take over a task space, showing the agent overlay to indicate work has resumed.
 * @param {string|number} [nameOrId] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<void>}
 */
async function takeOverTaskSpace(nameOrId) {
    const ego = globalThis.ego;
    if (!ego || typeof ego.takeOverTaskSpace !== "function") {
        throw new Error("takeOverTaskSpace requires ego.takeOverTaskSpace");
    }
    await selectTaskSpaceIfProvided(ego, nameOrId, "takeOverTaskSpace");
    assertNoEgoError(await ego.takeOverTaskSpace(), "takeOverTaskSpace");
}
/**
 * Probe whether the agent currently holds control of the active task space.
 * Module-private; used by waitForAgentControl. Uses ego.snapshot, which
 * rejects under user-control (per ego-bindings spec) — a reliable
 * synchronous-error signal that raw CDP sends can't provide. Other rejections
 * (task not found, internal errors) propagate so the caller fails fast instead
 * of busy-looping until timeout.
 */
async function probeAgentControl() {
    const ego = globalThis.ego;
    if (!ego || typeof ego.snapshot !== "function")
        return false;
    try {
        await ego.snapshot({ maxResultLength: 1 });
        return true;
    }
    catch (err) {
        if (isEgoUserControlError(err))
            return false;
        throw err;
    }
}
/**
 * Block until the agent regains control of the named task space.
 * Polls a harmless probe until it succeeds, or throws when the timeout
 * elapses. Read-only — does not call takeOverTaskSpace.
 * @param {string|number} nameOrId Task space id or name.
 * @param {{ interval?: number, timeout?: number }} [options] interval & timeout in seconds (default 20s / 600s).
 * @returns {Promise<void>}
 */
async function waitForAgentControl(nameOrId, options = {}) {
    if ((typeof nameOrId !== "string" && typeof nameOrId !== "number") ||
        nameOrId === "") {
        throw new Error("waitForAgentControl requires a task space name or id");
    }
    const ego = globalThis.ego;
    if (!ego) {
        throw new Error("waitForAgentControl requires ego runtime");
    }
    await selectTaskSpaceIfProvided(ego, nameOrId, "waitForAgentControl");
    const interval = typeof options.interval === "number" ? options.interval : 20;
    const timeout = typeof options.timeout === "number" ? options.timeout : 600;
    const deadline = Date.now() + timeout * 1000;
    while (true) {
        if (await probeAgentControl())
            return;
        if (Date.now() >= deadline) {
            throw new Error(`waitForAgentControl timed out after ${timeout}s`);
        }
        await waitForTimeout(interval * 1000);
    }
}
function normalizeTaskSpaces(raw) {
    if (Array.isArray(raw?.taskSpaces)) {
        return raw.taskSpaces.map(normalizeTaskSpace).filter(Boolean);
    }
    throw new Error("listTaskSpaces expected { taskSpaces: [...] }");
}
function normalizeTaskSpace(space) {
    const taskId = space?.taskId ?? space?.name ?? space?.id;
    if (taskId === undefined || taskId === null || taskId === "") {
        return null;
    }
    return {
        ...space,
        taskId,
        id: space?.id ?? taskId,
        name: space?.name ?? taskId,
    };
}
function taskSpaceNumericId(space, op) {
    if (typeof space?.id !== "number" || !Number.isFinite(space.id)) {
        throw new Error(`${op} requires a numeric task space id, got ${JSON.stringify(space?.id)}`);
    }
    return space.id;
}
async function findTaskSpace(nameOrId) {
    const spaces = await listTaskSpaces();
    const match = findMatchingTaskSpace(spaces, nameOrId);
    if (!match)
        throw new Error(`task space not found: ${nameOrId}`);
    return match;
}
function findMatchingTaskSpace(spaces, nameOrId) {
    if (typeof nameOrId === "number") {
        return spaces.find((space) => space.id === nameOrId);
    }
    const byName = spaces.find((space) => space.name === nameOrId || space.taskId === nameOrId);
    if (byName)
        return byName;
    if (/^\d+$/.test(nameOrId)) {
        const id = Number(nameOrId);
        if (Number.isFinite(id)) {
            return spaces.find((space) => space.id === id);
        }
    }
    return undefined;
}
async function siteSkillsForUrl(url) {
    return siteSkillsForUrl$1(url, {
        agentWorkspace: state.agentWorkspace(),
    });
}
/**
 * Return site skills matching a URL, or the current page URL when omitted.
 * @param {string} [url] URL to inspect for site skills.
 * @returns {Promise<Array<object|string>>}
 */
async function siteSkills(url = undefined) {
    const targetUrl = url ?? (await pageInfo()).url ?? "";
    return siteSkillsForUrl(targetUrl);
}
/**
 * Run a learned Node site tool with the helper context.
 * @param {string} siteId Site identifier.
 * @param {string} toolName Tool name within the site.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<any>} Tool result.
 */
async function runSiteTool(siteId, toolName, args = {}) {
    return runNodeSiteTool(siteId, toolName, args, helperContext(), {
        agentWorkspace: state.agentWorkspace(),
    });
}
/**
 * Run a learned browser-side site tool in the current page.
 * @param {string} siteId Site identifier.
 * @param {string} toolName Tool name within the site.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<any>} Browser tool result.
 */
async function runSiteBrowserTool(siteId, toolName, args = {}) {
    const source = await loadBrowserToolSource(siteId, toolName, {
        agentWorkspace: state.agentWorkspace(),
    });
    return evaluate(wrapBrowserTool(source, args));
}
/**
 * Load learned context for the current page or a given URL.
 * Returns accumulated site knowledge: notes content, available tools, usage examples.
 * @param {string} [url] URL to inspect. Defaults to current page.
 * @returns {Promise<object>} Learned context with knowledge and tool signatures.
 */
async function learnContext(url = undefined) {
    const targetUrl = url ?? (await pageInfo()).url ?? "";
    return loadLearnedContext(targetUrl, {
        agentWorkspace: state.agentWorkspace(),
    });
}
function createLocator(selector) {
    return {
        selector,
        first: () => createLocator(nthSelector(selector, 0)),
        last: () => createLocator(`internal:last;${selector}`),
        nth: (index) => {
            const value = Number(index);
            if (!Number.isInteger(value) || value < 0) {
                throw new Error("locator.nth requires a non-negative integer");
            }
            return createLocator(nthSelector(selector, value));
        },
        locator: (child) => createLocator(scopedSelector(selector, locatorSelector(child))),
        getByRole: (role, options = {}) => createLocator(scopedSelector(selector, roleSelector(role, options))),
        getByText: (text, options = {}) => createLocator(scopedSelector(selector, textSelector("text", text, options))),
        getByLabel: (text, options = {}) => createLocator(scopedSelector(selector, textSelector("label", text, options))),
        getByPlaceholder: (text, options = {}) => createLocator(scopedSelector(selector, textSelector("placeholder", text, options))),
        getByAltText: (text, options = {}) => createLocator(scopedSelector(selector, textSelector("alt", text, options))),
        getByTitle: (text, options = {}) => createLocator(scopedSelector(selector, textSelector("title", text, options))),
        getByTestId: (testId) => createLocator(scopedSelector(selector, testIdSelector(testId))),
        filter: (options = {}) => createLocator(filterSelector(selector, options)),
        click: (options = {}) => click(selector, options),
        dblclick: (options = {}) => dblclick(selector, options),
        hover: (options = {}) => hover(selector, options),
        dragTo: (target, options = {}) => drag([selector, target?.selector || target], options),
        scrollIntoViewIfNeeded: () => scrollIntoViewIfNeeded(selector),
        focus: () => focus(selector),
        fill: (value, options = {}) => fill(selector, value, options),
        clear: (options = {}) => fill(selector, "", options),
        press: (key, options = {}) => pressOnSelector(selector, key, options),
        pressSequentially: (text, options = {}) => pressSequentially(selector, text, options),
        check: () => check(selector),
        uncheck: () => uncheck(selector),
        setChecked: (checked) => setChecked(selector, checked),
        selectOption: (values) => selectOption(selector, values),
        setInputFiles: (filesValue) => setInputFiles(selector, filesValue),
        dispatchEvent: (type, eventInit = {}) => dispatchEvent(selector, type, eventInit),
        blur: () => blur(selector),
        textContent: () => textContent(selector),
        innerText: () => innerText(selector),
        innerHTML: () => innerHTML(selector),
        inputValue: () => inputValue(selector),
        isChecked: () => isChecked(selector),
        isVisible: () => isVisible(selector),
        isHidden: () => isHidden(selector),
        isEnabled: () => isEnabled(selector),
        isDisabled: () => isDisabled(selector),
        isEditable: () => isEditable(selector),
        getAttribute: (name) => getAttribute(selector, name),
        boundingBox: () => boundingBox(selector),
        screenshot: async (options = {}) => {
            const box = await boundingBox(selector);
            if (!box) {
                throw new Error(`locator.screenshot target has no bounding box: ${selector}`);
            }
            return screenshot({ ...options, clip: box });
        },
        count: () => count(selector),
        allInnerTexts: () => allInnerTexts(selector),
        allTextContents: () => allTextContents(selector),
        evaluate: (pageFunction, arg = undefined) => evaluateLocator(selector, pageFunction, arg),
        evaluateAll: (pageFunction, arg = undefined) => evaluateAll(selector, pageFunction, arg),
        waitFor: (options = {}) => waitForSelector(selector, options),
    };
}
function nthSelector(selector, index) {
    return `internal:nth=${index};${selector}`;
}
function internalSelector(kind, data) {
    return `internal:${kind}:${encodeURIComponent(JSON.stringify(data))}`;
}
function scopedSelector(base, child) {
    return internalSelector("scope", { base, child });
}
function locatorSelector(value) {
    if (value &&
        typeof value === "object" &&
        typeof value.selector === "string") {
        return value.selector;
    }
    return String(value);
}
function textSelector(prefix, text, options = {}) {
    const value = `${options.exact ? "exact:" : ""}${JSON.stringify(String(text))}`;
    return `loc=${prefix}:${value}`;
}
function roleSelector(role, options = {}) {
    const name = options && Object.prototype.hasOwnProperty.call(options, "name")
        ? `[name=${JSON.stringify(roleNameMatcher(options.name))}]`
        : "";
    return `loc=role:${role}${name}`;
}
function testIdSelector(testId) {
    return textSelector("testid", testId, { exact: true });
}
function filterSelector(base, options = {}) {
    const data = { base };
    if (Object.prototype.hasOwnProperty.call(options, "hasText")) {
        data.hasText = textMatcher(options.hasText);
    }
    if (Object.prototype.hasOwnProperty.call(options, "hasNotText")) {
        data.hasNotText = textMatcher(options.hasNotText);
    }
    if (options.has !== undefined) {
        data.has = locatorSelector(options.has);
    }
    if (options.hasNot !== undefined) {
        data.hasNot = locatorSelector(options.hasNot);
    }
    return internalSelector("filter", data);
}
function textMatcher(value) {
    if (value instanceof RegExp) {
        return { regex: value.source, flags: value.flags };
    }
    return { text: String(value), exact: false };
}
function roleNameMatcher(value) {
    if (value instanceof RegExp) {
        return { regex: value.source, flags: value.flags };
    }
    return value;
}
function createPageFacade() {
    return {
        setDefaultTimeout: (timeout) => {
            const value = Number(timeout);
            if (!Number.isFinite(value) || value < 0) {
                throw new Error("page.setDefaultTimeout requires a non-negative number");
            }
            state.defaultTimeout = value;
        },
        goto: goto,
        reload: async (options = {}) => {
            await cdp("Page.reload", { ignoreCache: Boolean(options.ignoreCache) });
            if (options.waitUntil === "commit") {
                return false;
            }
            return waitForLoadState(options.waitUntil || "load", {
                timeout: options.timeout,
            });
        },
        info: pageInfo,
        url: async () => (await pageInfo()).url,
        title: async () => (await pageInfo()).title,
        locator: createLocator,
        getByRole: (role, options = {}) => {
            return createLocator(roleSelector(role, options));
        },
        getByText: (text, options = {}) => createLocator(textSelector("text", text, options)),
        getByLabel: (text, options = {}) => createLocator(textSelector("label", text, options)),
        getByPlaceholder: (text, options = {}) => createLocator(textSelector("placeholder", text, options)),
        getByAltText: (text, options = {}) => createLocator(textSelector("alt", text, options)),
        getByTitle: (text, options = {}) => createLocator(textSelector("title", text, options)),
        getByTestId: (testId) => createLocator(testIdSelector(testId)),
        waitForTimeout: waitForTimeout,
        waitForLoadState: waitForLoadState,
        waitForSelector: waitForSelector,
        waitForFunction: waitForFunction,
        waitForURL: waitForURL,
        waitForRequest: waitForRequest,
        waitForResponse: waitForResponse,
        waitForEvent: waitForEvent,
        evaluate,
        screenshot: screenshot,
        snapshot: snapshot,
        snapshotRaw: snapshotRaw,
        elementCenter: elementCenter,
        drainEvents: drainEvents,
        screencast: {
            start: startScreencast,
            stop: stopScreencast,
        },
        keyboard: {
            press: press,
            down: down,
            up: up,
            insertText: insertText,
            type: typeText,
        },
        mouse: {
            click: (x, y, options = {}) => {
                const [target, effectiveOptions] = mousePointArgs(x, y, options);
                return click(target, effectiveOptions);
            },
            dblclick: (x, y, options = {}) => {
                const [target, effectiveOptions] = mousePointArgs(x, y, options);
                return dblclick(target, effectiveOptions);
            },
            move: (x, y) => hover([x, y]),
            down: down$1,
            up: up$1,
            wheel: wheel,
            drag: drag,
        },
    };
}
function mousePointArgs(x, y, options) {
    if (Array.isArray(x) || (x && typeof x === "object")) {
        return [x, y || {}];
    }
    return [[x, y], options || {}];
}
function createBrowserFacade() {
    return {
        listTabs: listTabs,
        currentTab: currentTab,
        switchTab: switchTab,
        openOrReuseTab: openOrReuseTab,
        closeTab: closeTab,
        ensureRealTab: ensureRealTab,
        iframeTarget: iframeTarget,
    };
}
function createTaskSpacesFacade() {
    return {
        list: listTaskSpaces,
        switch: switchTaskSpace,
        new: newTaskSpace,
        useOrCreate: useOrCreateTaskSpace,
        claim: claimTaskSpace,
        complete: completeTaskSpace,
        handOff: handOffTaskSpace,
        takeOver: takeOverTaskSpace,
        waitForAgentControl,
    };
}
function createSiteFacade() {
    return {
        skills: siteSkills,
        skillsForUrl: siteSkillsForUrl,
        runTool: runSiteTool,
        runBrowserTool: runSiteBrowserTool,
        learnContext,
    };
}
const FACADE_HELP = {
    page: 'page: Playwright-style page facade. page.url() asynchronously returns the current URL; always call await page.url() before using the string. Use page.goto(url), page.locator(selector), page.getByText(text), page.getByLabel(text), page.getByPlaceholder(text), page.getByTestId(testId), page.setDefaultTimeout(ms), page.waitForEvent("download"), page.waitForLoadState(state, options), page.waitForURL(url, options), page.waitForRequest(urlOrPredicate, options), page.waitForResponse(urlOrPredicate, options), page.evaluate(expression), page.screenshot(options), page.screencast.start({ path, size, quality }), page.screencast.stop(), page.keyboard.press(key), page.keyboard.type(text), and page.mouse.click(x, y). waitForURL predicates receive URL objects and waitUntil defaults to load.',
    locator: "page.locator(selector): returns a strict, auto-waiting locator facade with locator(), getByRole(), getByText(), filter(), first(), nth(index), last(), click(), hover(), dragTo(target), scrollIntoViewIfNeeded(), fill(value), clear(), press(key), check(), selectOption(value), textContent(), innerText(), innerHTML(), isVisible(), isEnabled(), getAttribute(name), screenshot(), count(), evaluate(fn, arg), evaluateAll(fn, arg), and waitFor(options). Narrow multiple matches; use first()/nth() only for confirmed legitimate duplicates.",
    browser: "browser: tab facade. Use browser.listTabs(), browser.currentTab(), browser.switchTab(target), browser.openOrReuseTab(url, options), and browser.closeTab(target). Treat targetId as short-lived: obtain and validate it in the current script; switchTab/closeTab refresh the tab list before acting.",
    taskSpaces: "taskSpaces: task-space facade. Use taskSpaces.useOrCreate(nameOrId), taskSpaces.claim(nameOrId), taskSpaces.switch(nameOrId), taskSpaces.complete(nameOrId, options), taskSpaces.handOff(nameOrId), taskSpaces.takeOver(nameOrId), and taskSpaces.waitForAgentControl(nameOrId, options).",
    site: "site: learned site-skill facade. Use site.skills(url), site.skillsForUrl(url), site.runTool(siteId, toolName, args), site.runBrowserTool(siteId, toolName, args), and site.learnContext(url).",
    fetch: "fetch: network facade. Use fetch.server(url, options) for Node-side fetch and fetch.browser(url, options) for browser-origin fetch.",
};
function helperContext(extra = {}) {
    const all = {
        page: createPageFacade(),
        browser: createBrowserFacade(),
        taskSpaces: createTaskSpacesFacade(),
        site: createSiteFacade(),
        fetch: {
            server: serverFetch,
            browser: browserFetch,
        },
        cdp,
        ...extra,
    };
    return {
        ...all,
        help: (...names) => {
            if (names.length === 1 && FACADE_HELP[names[0]]) {
                return FACADE_HELP[names[0]];
            }
            if (names.length === 0) {
                return Object.values(FACADE_HELP).join("\n\n");
            }
            const result = help(all, ...names);
            if (typeof result === "string")
                return result;
            if (Array.isArray(result))
                return result.map(formatHelp).join("\n\n");
            return formatHelp(result);
        },
    };
}
async function loadAgentHelpers() {
    const path = join(state.agentWorkspace(), "agent_helpers.js");
    if (!existsSync(path)) {
        return {};
    }
    const module = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
    const out = {};
    for (const [name, value] of Object.entries(module)) {
        if (!name.startsWith("_")) {
            out[name] = value;
        }
    }
    return out;
}
const __testing = { setOverrides, decodeUnserializableJsValue };

const FUNCTION_DOCS = {
    "page.setDefaultTimeout": {
        signature: "page.setDefaultTimeout(timeoutMs) => void",
        description: "Set the default timeout, in milliseconds, for page helper operations.",
        params: [
            {
                name: "timeoutMs",
                type: "number",
                required: true,
                description: "Timeout in milliseconds.",
            },
        ],
        returns: "void",
        example: "page.setDefaultTimeout(10000)",
    },
    "page.goto": {
        signature: "page.goto(url, options?) => Promise<any>",
        description: "Navigate the current tab to a URL.",
        params: [
            {
                name: "url",
                type: "string",
                required: true,
                description: "Destination URL.",
            },
            {
                name: "options",
                type: "object",
                description: "Supports timeout, waitUntil, and settle options.",
            },
        ],
        returns: "Promise<any>",
        example: "await page.goto('https://example.com', { timeout: 20000 })",
    },
    "page.reload": {
        signature: "page.reload(options?) => Promise<any>",
        description: "Reload the current page and optionally wait for a load state.",
        params: [
            {
                name: "options",
                type: "object",
                description: "Supports ignoreCache, waitUntil, and timeout.",
            },
        ],
        returns: "Promise<any>",
        example: "await page.reload({ waitUntil: 'load', timeout: 10000 })",
    },
    "page.info": {
        signature: "page.info() => Promise<object>",
        description: "Return current page URL, title, viewport, scroll, and page size information.",
        returns: "Promise<{ url, title, w, h, sx, sy, pw, ph }>",
        example: "console.log(await page.info())",
    },
    "page.url": {
        signature: "page.url() => Promise<string>",
        description: "Asynchronously return the current page URL.",
        returns: "Promise<string>",
        example: "console.log(await page.url())",
    },
    "page.title": {
        signature: "page.title() => Promise<string>",
        description: "Return the current page title.",
        returns: "Promise<string>",
        example: "console.log(await page.title())",
    },
    "page.locator": {
        signature: "page.locator(selector) => Locator",
        description: "Create a locator for CSS, XPath, text, loc=..., or @ref selectors.",
        params: [
            {
                name: "selector",
                type: "string",
                required: true,
                description: "CSS selector, xpath=..., text=..., loc=..., or @N snapshot ref.",
            },
        ],
        returns: "Locator",
        example: "await page.locator('button[type=submit]').click()",
    },
    "page.getByRole": {
        signature: "page.getByRole(role, options?) => Locator",
        description: "Create a locator by accessibility role and optional accessible name.",
        params: [
            {
                name: "role",
                type: "string",
                required: true,
                description: "ARIA role such as button, link, textbox.",
            },
            {
                name: "options",
                type: "{ name?: string }",
                description: "Accessible name filter.",
            },
        ],
        returns: "Locator",
        example: "await page.getByRole('button', { name: 'Submit' }).click()",
    },
    "page.getByText": {
        signature: "page.getByText(text, options?) => Locator",
        description: "Create a locator by visible text.",
        params: [
            {
                name: "text",
                type: "string",
                required: true,
                description: "Text to match.",
            },
            {
                name: "options",
                type: "{ exact?: boolean }",
                description: "Set exact true for exact text.",
            },
        ],
        returns: "Locator",
        example: "await page.getByText('Save', { exact: true }).click()",
    },
    "page.getByLabel": {
        signature: "page.getByLabel(text, options?) => Locator",
        description: "Create a locator for a form control by label text.",
        params: [
            {
                name: "text",
                type: "string",
                required: true,
                description: "Label text.",
            },
            {
                name: "options",
                type: "{ exact?: boolean }",
                description: "Set exact true for exact label matching.",
            },
        ],
        returns: "Locator",
        example: "await page.getByLabel('Email').fill('me@example.com')",
    },
    "page.getByPlaceholder": {
        signature: "page.getByPlaceholder(text, options?) => Locator",
        description: "Create a locator for an input by placeholder text.",
        params: [
            {
                name: "text",
                type: "string",
                required: true,
                description: "Placeholder text.",
            },
            {
                name: "options",
                type: "{ exact?: boolean }",
                description: "Set exact true for exact placeholder matching.",
            },
        ],
        returns: "Locator",
        example: "await page.getByPlaceholder('Search').fill('openai')",
    },
    "page.getByAltText": {
        signature: "page.getByAltText(text, options?) => Locator",
        description: "Create a locator for an element by image alt text.",
        params: [
            {
                name: "text",
                type: "string",
                required: true,
                description: "Alt text.",
            },
            {
                name: "options",
                type: "{ exact?: boolean }",
                description: "Set exact true for exact alt matching.",
            },
        ],
        returns: "Locator",
        example: "await page.getByAltText('Logo').click()",
    },
    "page.getByTitle": {
        signature: "page.getByTitle(text, options?) => Locator",
        description: "Create a locator by title attribute.",
        params: [
            {
                name: "text",
                type: "string",
                required: true,
                description: "Title text.",
            },
            {
                name: "options",
                type: "{ exact?: boolean }",
                description: "Set exact true for exact title matching.",
            },
        ],
        returns: "Locator",
        example: "await page.getByTitle('More').click()",
    },
    "page.waitForTimeout": {
        signature: "page.waitForTimeout(ms) => Promise<void>",
        description: "Wait for a fixed duration. Prefer locator/page state waits for page readiness.",
        params: [
            {
                name: "ms",
                type: "number",
                required: true,
                description: "Milliseconds to wait.",
            },
        ],
        returns: "Promise<void>",
        example: "await page.waitForTimeout(250)",
    },
    "page.waitForLoadState": {
        signature: "page.waitForLoadState(state?, options?) => Promise<void>",
        description: "Wait for a load state such as load, domcontentloaded, or networkidle.",
        params: [
            {
                name: "state",
                type: "string",
                description: "Load state. Defaults to load.",
            },
            {
                name: "options",
                type: "{ timeout?: number }",
                description: "Timeout in milliseconds.",
            },
        ],
        returns: "Promise<void>",
        example: "await page.waitForLoadState('networkidle', { timeout: 10000 })",
    },
    "page.waitForSelector": {
        signature: "page.waitForSelector(selector, options?) => Promise<any>",
        description: "Wait for a selector or locator to reach a desired state.",
        params: [
            {
                name: "selector",
                type: "string",
                required: true,
                description: "CSS, XPath, loc=..., text, or @ref selector.",
            },
            {
                name: "options",
                type: "{ state?: string, timeout?: number }",
                description: "State and timeout options.",
            },
        ],
        returns: "Promise<any>",
        example: "await page.waitForSelector('button.submit', { state: 'visible' })",
    },
    "page.waitForFunction": {
        signature: "page.waitForFunction(pageFunction, options?) => Promise<any>",
        description: "Poll browser-side JavaScript until it returns a truthy value.",
        params: [
            {
                name: "pageFunction",
                type: "string | Function",
                required: true,
                description: "Browser-side predicate.",
            },
            {
                name: "options",
                type: "{ timeout?: number, polling?: number }",
                description: "Wait options.",
            },
        ],
        returns: "Promise<any>",
        example: "await page.waitForFunction(() => document.readyState === 'complete')",
    },
    "page.waitForURL": {
        signature: "page.waitForURL(url, options?) => Promise<boolean>",
        description: "Wait until the current URL matches a string, glob, regex, or predicate receiving a URL object, then wait for load by default.",
        params: [
            {
                name: "url",
                type: "string | RegExp | Function",
                required: true,
                description: "URL matcher. Predicate functions receive a URL object; use url.href, url.pathname, or url.searchParams.",
            },
            {
                name: "options",
                type: "{ timeout?: number, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }",
                description: "Timeout in milliseconds and completion state; waitUntil defaults to 'load'.",
            },
        ],
        returns: "Promise<boolean>",
        example: "await page.waitForURL(url => url.pathname === '/done', { timeout: 10000 })",
    },
    "page.waitForRequest": {
        signature: "page.waitForRequest(urlOrPredicate, options?) => Promise<Request>",
        description: "Wait for a network request matching an exact URL, regex, or synchronous predicate.",
        params: [
            {
                name: "urlOrPredicate",
                type: "string | RegExp | Function",
                required: true,
                description: "Exact URL, URL regex, or request predicate.",
            },
            {
                name: "options",
                type: "{ timeout?: number }",
                description: "Timeout in milliseconds; 0 disables timeout.",
            },
        ],
        returns: "Promise<{ url(), method(), headers(), postData(), resourceType() }>",
        example: "const req = await page.waitForRequest(/\\/api\\/search/)",
    },
    "page.waitForResponse": {
        signature: "page.waitForResponse(urlOrPredicate, options?) => Promise<Response>",
        description: "Wait for a network response matching an exact URL, regex, or synchronous predicate.",
        params: [
            {
                name: "urlOrPredicate",
                type: "string | RegExp | Function",
                required: true,
                description: "Exact URL, URL regex, or response predicate.",
            },
            {
                name: "options",
                type: "{ timeout?: number }",
                description: "Timeout in milliseconds; 0 disables timeout.",
            },
        ],
        returns: "Promise<{ url(), status(), ok(), headers(), request(), text(), json(), body() }>",
        example: "const res = await page.waitForResponse(r => r.url().includes('/api') && r.status() === 200)",
    },
    "page.waitForEvent": {
        signature: "page.waitForEvent(eventName, options?) => Promise<any>",
        description: "Wait for a page event. Currently useful for download events.",
        params: [
            {
                name: "eventName",
                type: "string",
                required: true,
                description: "Event name, such as download.",
            },
            {
                name: "options",
                type: "{ timeout?: number }",
                description: "Timeout in milliseconds.",
            },
        ],
        returns: "Promise<any>",
        example: "const download = await page.waitForEvent('download')",
    },
    "page.evaluate": {
        signature: "page.evaluate(expression) => Promise<any>",
        description: "Evaluate page-wide browser JavaScript. Prefer locator.evaluateAll or extractAll for element collections.",
        params: [
            {
                name: "expression",
                type: "string | Function",
                required: true,
                description: "Browser-side expression or function.",
            },
        ],
        returns: "Promise<any>",
        example: "console.log(await page.evaluate('document.title'))",
    },
    "page.screenshot": {
        signature: "page.screenshot(options?) => Promise<string>",
        description: "Capture a screenshot and return the saved path or data depending on options.",
        params: [
            { name: "options", type: "object", description: "Screenshot options." },
        ],
        returns: "Promise<string>",
        example: "console.log(await page.screenshot({ path: '/tmp/page.png' }))",
    },
    "page.snapshot": {
        signature: "page.snapshot(options?) => Promise<string>",
        description: "Return a semantic page snapshot with refs and stable locators.",
        params: [
            {
                name: "options",
                type: "object",
                description: "Snapshot options such as scope.",
            },
        ],
        returns: "Promise<string>",
        example: "console.log(await page.snapshot())",
    },
    "page.snapshotRaw": {
        signature: "page.snapshotRaw(options?) => Promise<object>",
        description: "Return the raw structured snapshot object.",
        params: [
            { name: "options", type: "object", description: "Snapshot options." },
        ],
        returns: "Promise<object>",
        example: "console.log(await page.snapshotRaw())",
    },
    "page.elementCenter": {
        signature: "page.elementCenter(selector) => Promise<{ x, y }>",
        description: "Resolve an element and return its viewport center point.",
        params: [
            {
                name: "selector",
                type: "string",
                required: true,
                description: "Selector or @ref.",
            },
        ],
        returns: "Promise<{ x: number, y: number }>",
        example: "console.log(await page.elementCenter('@12'))",
    },
    "page.drainEvents": {
        signature: "page.drainEvents() => Promise<object[]>",
        description: "Drain buffered page/CDP events.",
        returns: "Promise<object[]>",
        example: "console.log(await page.drainEvents())",
    },
    "page.keyboard.press": {
        signature: "page.keyboard.press(key, options?) => Promise<void>",
        description: "Press a keyboard key or shortcut.",
        params: [
            {
                name: "key",
                type: "string",
                required: true,
                description: "Key or shortcut such as Enter or Meta+A.",
            },
            { name: "options", type: "object", description: "Keyboard options." },
        ],
        returns: "Promise<void>",
        example: "await page.keyboard.press('Enter')",
    },
    "page.keyboard.insertText": {
        signature: "page.keyboard.insertText(text) => Promise<void>",
        description: "Insert text at the current focus.",
        params: [
            {
                name: "text",
                type: "string",
                required: true,
                description: "Text to insert.",
            },
        ],
        returns: "Promise<void>",
        example: "await page.keyboard.insertText('hello')",
    },
    "page.mouse.click": {
        signature: "page.mouse.click(x, y, options?) => Promise<void>",
        description: "Click viewport coordinates. Prefer locators unless using a visual/canvas workflow.",
        params: [
            {
                name: "x",
                type: "number | object | array",
                required: true,
                description: "X coordinate or point object/array.",
            },
            {
                name: "y",
                type: "number",
                description: "Y coordinate when x is numeric.",
            },
            { name: "options", type: "object", description: "Click options." },
        ],
        returns: "Promise<void>",
        example: "await page.mouse.click(420, 260)",
    },
    "page.mouse.dblclick": {
        signature: "page.mouse.dblclick(x, y, options?) => Promise<void>",
        description: "Double-click viewport coordinates. Prefer locators when possible.",
        params: [
            {
                name: "x",
                type: "number | object | array",
                required: true,
                description: "X coordinate or point object/array.",
            },
            {
                name: "y",
                type: "number",
                description: "Y coordinate when x is numeric.",
            },
            { name: "options", type: "object", description: "Double-click options." },
        ],
        returns: "Promise<void>",
        example: "await page.mouse.dblclick(420, 260)",
    },
    "page.mouse.move": {
        signature: "page.mouse.move(x, y) => Promise<void>",
        description: "Move the mouse to viewport coordinates.",
        params: [
            {
                name: "x",
                type: "number",
                required: true,
                description: "X coordinate.",
            },
            {
                name: "y",
                type: "number",
                required: true,
                description: "Y coordinate.",
            },
        ],
        returns: "Promise<void>",
        example: "await page.mouse.move(420, 260)",
    },
    "page.mouse.wheel": {
        signature: "page.mouse.wheel(deltaX, deltaY) => Promise<void>",
        description: "Scroll with a mouse wheel. Positive deltaY scrolls down.",
        params: [
            {
                name: "deltaX",
                type: "number",
                required: true,
                description: "Horizontal wheel delta.",
            },
            {
                name: "deltaY",
                type: "number",
                required: true,
                description: "Vertical wheel delta.",
            },
        ],
        returns: "Promise<void>",
        example: "await page.mouse.wheel(0, 900)",
    },
    "page.mouse.drag": {
        signature: "page.mouse.drag(points, options?) => Promise<void>",
        description: "Drag between points or element selectors.",
        params: [
            {
                name: "points",
                type: "array",
                required: true,
                description: "Source and destination points/selectors.",
            },
            { name: "options", type: "object", description: "Drag options." },
        ],
        returns: "Promise<void>",
        example: "await page.mouse.drag([[100, 100], [300, 300]])",
    },
    "browser.listTabs": {
        signature: "browser.listTabs() => Promise<object[]>",
        description: "List tabs in the current task space.",
        returns: "Promise<object[]>",
        example: "console.log(await browser.listTabs())",
    },
    "browser.currentTab": {
        signature: "browser.currentTab() => Promise<object | null>",
        description: "Return the current selected tab.",
        returns: "Promise<object | null>",
        example: "console.log(await browser.currentTab())",
    },
    "browser.switchTab": {
        signature: "browser.switchTab(target) => Promise<string>",
        description: "Refresh the current tab list, validate a target id/tab object, then switch to that tab.",
        params: [
            {
                name: "target",
                type: "string | object",
                required: true,
                description: "Target id or tab object.",
            },
        ],
        returns: "Promise<string>",
        example: "const tab = (await browser.listTabs()).find(t => t.url.includes('/docs')); if (!tab) throw new Error('docs tab not found'); await browser.switchTab(tab.targetId)",
    },
    "browser.openOrReuseTab": {
        signature: "browser.openOrReuseTab(url, options?) => Promise<object>",
        description: "Open a URL in a new or reusable tab, then select it.",
        params: [
            {
                name: "url",
                type: "string",
                required: true,
                description: "URL to open.",
            },
            {
                name: "options",
                type: "{ wait?: boolean, timeout?: number, settle?: number }",
                description: "Open and wait options.",
            },
        ],
        returns: "Promise<object>",
        example: "await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 20000 })",
    },
    "browser.closeTab": {
        signature: "browser.closeTab(target?) => Promise<string>",
        description: "Refresh the current tab list, validate, and close a tab by target id/object, or close the current tab when omitted.",
        params: [
            {
                name: "target",
                type: "string | object",
                description: "Target id or tab object.",
            },
        ],
        returns: "Promise<string>",
        example: "await browser.closeTab()",
    },
    "browser.ensureRealTab": {
        signature: "browser.ensureRealTab() => Promise<object | null>",
        description: "Switch to an existing non-internal page tab if one exists.",
        returns: "Promise<object | null>",
        example: "await browser.ensureRealTab()",
    },
    "browser.iframeTarget": {
        signature: "browser.iframeTarget(frameSelector) => Promise<object | null>",
        description: "Resolve an iframe target for advanced CDP interactions.",
        params: [
            {
                name: "frameSelector",
                type: "string",
                required: true,
                description: "Iframe selector.",
            },
        ],
        returns: "Promise<object | null>",
        example: "console.log(await browser.iframeTarget('iframe'))",
    },
    "taskSpaces.list": {
        signature: "taskSpaces.list() => Promise<object[]>",
        description: "List browser task spaces.",
        returns: "Promise<object[]>",
        example: "console.log(await taskSpaces.list())",
    },
    "taskSpaces.switch": {
        signature: "taskSpaces.switch(nameOrId) => Promise<object>",
        description: "Switch to an agent-owned task space.",
        params: [
            {
                name: "nameOrId",
                type: "string | number",
                required: true,
                description: "Task space name, taskId, or numeric id.",
            },
        ],
        returns: "Promise<object>",
        example: "await taskSpaces.switch(3)",
    },
    "taskSpaces.new": {
        signature: "taskSpaces.new(name) => Promise<object>",
        description: "Create and select a new task space.",
        params: [
            {
                name: "name",
                type: "string",
                required: true,
                description: "Task space name.",
            },
        ],
        returns: "Promise<object>",
        example: "const task = await taskSpaces.new('research task')",
    },
    "taskSpaces.useOrCreate": {
        signature: "taskSpaces.useOrCreate(nameOrId) => Promise<object>",
        description: "Reuse an agent-owned task space or create one by name.",
        params: [
            {
                name: "nameOrId",
                type: "string | number",
                required: true,
                description: "Task space name, taskId, or numeric id.",
            },
        ],
        returns: "Promise<object>",
        example: "const task = await taskSpaces.useOrCreate('google sheets task')",
    },
    "taskSpaces.claim": {
        signature: "taskSpaces.claim(nameOrId) => Promise<object>",
        description: "Claim a user-owned task space and select it.",
        params: [
            {
                name: "nameOrId",
                type: "string | number",
                required: true,
                description: "Task space name, taskId, or numeric id.",
            },
        ],
        returns: "Promise<object>",
        example: "await taskSpaces.claim(3)",
    },
    "taskSpaces.complete": {
        signature: "taskSpaces.complete(nameOrId, options) => Promise<object>",
        description: "Finish a task space. options.keep is required.",
        params: [
            {
                name: "nameOrId",
                type: "string | number",
                required: true,
                description: "Task space name, taskId, or numeric id.",
            },
            {
                name: "options",
                type: "{ keep: boolean }",
                required: true,
                description: "Whether to keep the task space open.",
            },
        ],
        returns: "Promise<object>",
        example: "await taskSpaces.complete(task.id, { keep: false })",
    },
    "taskSpaces.handOff": {
        signature: "taskSpaces.handOff(nameOrId?) => Promise<object>",
        description: "Hand control of a task space to the user for manual action.",
        params: [
            {
                name: "nameOrId",
                type: "string | number",
                description: "Task space name, taskId, or numeric id. Defaults to current task space.",
            },
        ],
        returns: "Promise<object>",
        example: "await taskSpaces.handOff(task.id)",
    },
    "taskSpaces.takeOver": {
        signature: "taskSpaces.takeOver(nameOrId?) => Promise<object>",
        description: "Take control back after the user explicitly confirms continuation.",
        params: [
            {
                name: "nameOrId",
                type: "string | number",
                description: "Task space name, taskId, or numeric id. Defaults to current task space.",
            },
        ],
        returns: "Promise<object>",
        example: "await taskSpaces.takeOver(task.id)",
    },
    "taskSpaces.waitForAgentControl": {
        signature: "taskSpaces.waitForAgentControl(nameOrId?, options?) => Promise<void>",
        description: "Poll until agent control is restored without taking control.",
        params: [
            {
                name: "nameOrId",
                type: "string | number",
                description: "Task space name, taskId, or numeric id.",
            },
            {
                name: "options",
                type: "{ interval?: number, timeout?: number }",
                description: "Polling options in seconds.",
            },
        ],
        returns: "Promise<void>",
        example: "await taskSpaces.waitForAgentControl(task.id)",
    },
    "site.skills": {
        signature: "site.skills(url?) => Promise<object[]>",
        description: "List site learning packs matching a URL, or the current page URL when omitted.",
        params: [
            {
                name: "url",
                type: "string",
                description: "URL to inspect. Defaults to current page URL.",
            },
        ],
        returns: "Promise<object[]>",
        example: "console.log(await site.skills('https://www.google.com/search?q=test'))",
    },
    "site.skillsForUrl": {
        signature: "site.skillsForUrl(url) => Promise<object[]>",
        description: "List site learning packs whose manifest domains match the URL.",
        params: [
            {
                name: "url",
                type: "string",
                required: true,
                description: "URL or domain to inspect.",
            },
        ],
        returns: "Promise<object[]>",
        example: "console.log(await site.skillsForUrl('https://x.com/home'))",
    },
    "site.runTool": {
        signature: "site.runTool(siteId, toolName, args?) => Promise<tool result>",
        description: "Run a Node-side learned site tool. Inspect site.learnContext(url).tools[].args and tools[].returns for the exact schema before calling.",
        params: [
            {
                name: "siteId",
                type: "string",
                required: true,
                description: "Learning pack id, such as google or x-com.",
            },
            {
                name: "toolName",
                type: "string",
                required: true,
                description: "Tool name declared in manifest.json nodeTools.",
            },
            {
                name: "args",
                type: "object",
                description: "Tool arguments matching the manifest schema.",
            },
        ],
        returns: "Promise<tool result declared by manifest.json returns; inspect site.learnContext(url).tools[].returns>",
        example: "const ctx = await site.learnContext('https://www.google.com/search?q=test'); console.log(ctx.tools); const results = await site.runTool('google', 'search_and_extract', { query: 'openai', maxResults: 5 })",
    },
    "site.runBrowserTool": {
        signature: "site.runBrowserTool(siteId, toolName, args?) => Promise<tool result>",
        description: "Run a browser-side learned tool in the current page context. Inspect site.learnContext(url).tools[].args and tools[].returns for the exact schema before calling.",
        params: [
            {
                name: "siteId",
                type: "string",
                required: true,
                description: "Learning pack id.",
            },
            {
                name: "toolName",
                type: "string",
                required: true,
                description: "Tool name declared in manifest.json browserTools.",
            },
            {
                name: "args",
                type: "object",
                description: "Tool arguments matching the manifest schema.",
            },
        ],
        returns: "Promise<tool result declared by manifest.json returns; inspect site.learnContext(url).tools[].returns>",
        example: "const ctx = await site.learnContext('https://x.com/home'); console.log(ctx.tools); const post = await site.runBrowserTool('x-com', 'post_from_active_element')",
    },
    "site.learnContext": {
        signature: "site.learnContext(url?) => Promise<object>",
        description: "Load matching learning notes and exact tool schemas, including args and returns, for a URL or the current page URL.",
        params: [
            {
                name: "url",
                type: "string",
                description: "URL to inspect. Defaults to current page URL.",
            },
        ],
        returns: "Promise<{ exists, siteId, siteName, knowledge, tools: Array<{ siteId, toolName, toolType, description, args, returns, example }> }>",
        example: "console.log(await site.learnContext('https://www.google.com/search?q=test'))",
    },
    "fetch.server": {
        signature: "fetch.server(url, options?) => Promise<string>",
        description: "Fetch text from Node with a browser-like User-Agent.",
        params: [
            {
                name: "url",
                type: "string",
                required: true,
                description: "URL to fetch.",
            },
            {
                name: "options",
                type: "object",
                description: "Fetch options including method, headers, body, timeout seconds.",
            },
        ],
        returns: "Promise<string>",
        example: "const html = await fetch.server('https://example.com')",
    },
    "fetch.browser": {
        signature: "fetch.browser(url, options?) => Promise<string>",
        description: "Fetch text inside the current browser page context.",
        params: [
            {
                name: "url",
                type: "string",
                required: true,
                description: "URL to fetch. Relative URLs resolve against current page.",
            },
            {
                name: "options",
                type: "object",
                description: "Fetch options including method, headers, body, timeout seconds.",
            },
        ],
        returns: "Promise<string>",
        example: "const body = await fetch.browser('/api/data')",
    },
    cdp: {
        signature: "cdp(method, params?) => Promise<any>",
        description: "Send a supported raw Chrome DevTools Protocol command to the current target. Browser.grantPermissions and Browser.setPermission are not exposed by the task-space bridge.",
        params: [
            {
                name: "method",
                type: "string",
                required: true,
                description: "CDP method, such as Runtime.evaluate.",
            },
            {
                name: "params",
                type: "object",
                description: "CDP command parameters.",
            },
        ],
        returns: "Promise<any>",
        example: "console.log(await cdp('Runtime.evaluate', { expression: 'document.title' }))",
    },
    help: {
        signature: "help(name?) => string",
        description: "Print helper documentation. Use this when console output is not enough.",
        params: [
            {
                name: "name",
                type: "string",
                description: "Helper or facade name, such as page, locator, browser, site.",
            },
        ],
        returns: "string",
        example: "console.log(help('site'))",
    },
};
function formatCliLogValue(value) {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "bigint") {
        return `${value}n`;
    }
    if (value === undefined) {
        return "undefined";
    }
    return JSON.stringify(toLoggable(value, [], new WeakSet()), null, 2);
}
function toLoggable(value, path, stack) {
    if (typeof value === "function") {
        return functionLogValue(value, path);
    }
    if (typeof value === "bigint") {
        return `${value}n`;
    }
    if (value === undefined) {
        return "undefined";
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof RegExp) {
        return value.toString();
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }
    if (stack.has(value)) {
        return "[Circular]";
    }
    stack.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item, index) => toLoggable(item, [...path, String(index)], stack));
        }
        const out = {};
        for (const [key, child] of Object.entries(value)) {
            out[key] = toLoggable(child, [...path, key], stack);
        }
        return out;
    }
    finally {
        stack.delete(value);
    }
}
function functionLogValue(fn, path) {
    const key = docKeyForPath(path);
    const doc = key ? FUNCTION_DOCS[key] : undefined;
    const displayName = path.at(-1) || fn.name || "anonymous";
    if (!doc) {
        const callPath = path.length ? path.join(".") : displayName;
        return {
            kind: "function",
            name: fn.name || displayName,
            signature: `${callPath}(...)`,
            description: "Callable function. Inspect the surrounding facade or use help(name) when available.",
        };
    }
    return {
        kind: "function",
        name: displayName,
        signature: signatureForPath(doc.signature, path),
        description: doc.description,
        ...(doc.params ? { params: doc.params } : {}),
        ...(doc.returns ? { returns: doc.returns } : {}),
        ...(doc.example ? { example: exampleForPath(doc.example, path) } : {}),
    };
}
function docKeyForPath(path) {
    if (path[0] === "helpers") {
        return path.slice(1).join(".");
    }
    if (path[0] === "learnings") {
        return ["site", ...path.slice(1)].join(".");
    }
    return path.join(".");
}
function signatureForPath(signature, path) {
    if (path[0] === "learnings") {
        return signature.replace(/^site\./, "learnings.");
    }
    return signature;
}
function exampleForPath(example, path) {
    if (path[0] === "learnings") {
        return example.replace(/\bsite\./g, "learnings.");
    }
    return example;
}

const HELP = `ego-browser

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser <<'JS'
  await page.waitForLoadState()
  console.log(await page.info())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.

Commands:
  ego-browser --doctor         inspect browser and connection state
  ego-browser --reload         reset the browser connection on next call
`;
const USAGE = `Usage:
  ego-browser <<'JS'
  console.log(await page.info())
  JS
`;
async function runMain(options = {}) {
    const argv = options.argv || process.argv.slice(2);
    const stdout$1 = options.stdout || stdout;
    const stderr$1 = options.stderr || stderr;
    const env = options.env || process.env;
    const services = {
        resetConnection: async () => { },
        printUpdateBanner: () => { },
        runDoctor: async () => 0,
        ...options.services,
    };
    if (argv[0] === "-h" || argv[0] === "--help") {
        write(stdout$1, HELP);
        return 0;
    }
    if (argv[0] === "--doctor") {
        return services.runDoctor(stdout$1);
    }
    if (argv[0] === "--reload") {
        await services.resetConnection();
        write(stdout$1, "browser connection reset on next call\n");
        return 0;
    }
    if (argv[0] === "--debug-clicks") {
        env.EGO_BROWSER_DEBUG_CLICKS = "1";
        argv.shift();
    }
    if (argv.length > 0) {
        write(stderr$1, USAGE);
        return 2;
    }
    const code = options.stdinText !== undefined
        ? options.stdinText
        : await readAll(options.stdin || stdin);
    if (!code.trim()) {
        write(stderr$1, USAGE);
        return 2;
    }
    services.printUpdateBanner(stderr$1);
    await execute(code, stdout$1);
    return 0;
}
async function execute(code, stdout) {
    resetSink();
    const context = await executionContext();
    Object.assign(globalThis, context);
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    const names = Object.keys(context);
    const values = Object.values(context);
    const fn = new AsyncFunction(...names, `"use strict";\n${code}`);
    let thrown;
    try {
        await fn(...values);
    }
    catch (error) {
        thrown = error;
    }
    try {
        await stopScreencast();
    }
    catch (error) {
        thrown ??= error;
    }
    // A thrown Error surfaces a hard-stop message on its own, so flush as a thrown
    // completion (drop the buffer, stay silent) and let it propagate.
    flushSink(stdout, Boolean(thrown));
    if (thrown)
        throw thrown;
}
async function executionContext() {
    const agentHelpers = await loadAgentHelpers();
    // Single source of truth for the agent-facing surface: the same helperContext()
    // that installEgoSdk() exposes in the browser runtime, so the CLI and SDK paths
    // cannot drift apart (and `help` exists in both).
    const context = helperContext(agentHelpers);
    // Route the agent's primary output channel (console.log) through the output sink:
    // execute() flushes (or discards on hard stop) once the script settles, keeping the
    // CLI path identical to the SDK path. console.error/warn are left untouched. Each
    // heredoc runs in its own short-lived process, so overriding the global is per-run.
    console.log = (...args) => {
        bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
    };
    return context;
}
function readAll(stream) {
    return new Promise((resolve, reject) => {
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
            data += chunk;
        });
        stream.on("end", () => resolve(data));
        stream.on("error", reject);
    });
}
function write(stream, text) {
    stream.write(text);
}

/**
 * "ego lite has an update" hint for the agent-facing runtime.
 *
 * Loosely modeled on lark cli's `_notice` — surface one tagged line telling the
 * agent a newer ego lite exists — but deliberately WITHOUT lark's cache. lark
 * persists a throttled state file because every check is an HTTP round-trip to
 * npm, an expensive cost worth amortizing. Our source is `ego.getBrowserVersion()`:
 * a cheap local bridge call into the app, whose updater already knows
 * `updateAvailable`. There is no cost to amortize and nothing to persist, so every
 * command just asks directly and the answer is always current. (Don't re-add a
 * cache; it would only reintroduce staleness this version exists to avoid.)
 *
 * The version source is injected — in production `installEgoSdk` builds it from the
 * app's `ego` bridge. On older app builds without `getBrowserVersion`, that source
 * yields null and the check degrades to "no update". The remedy is *not* a symmetric
 * `ego.upgradeBrowser()` bridge call — the app exposes that half as the native CLI
 * subcommand `ego-browser upgrade`, so the composed line tells the agent to run it as
 * a shell command.
 *
 * `emitUpdateNotice` never writes output itself: it hands the resolved line to a
 * caller-supplied `emit`, so the caller owns the channel and timing. The SDK path
 * registers it as an output-sink trailer, so the hint is appended after the command's
 * own output instead of racing ahead of it. The whole module is pure given an injected
 * version source, so it is exercised without a real browser.
 */
/** Prefix that marks the appended line as out-of-band, not real command output. */
const NOTICE_PREFIX = "[ego-browser:notice]";
/** Upper bound on how long the version probe may run before the check gives up. */
const NOTICE_PROBE_TIMEOUT_MS = 2000;
/**
 * Suppress the hint entirely. Mirrors lark's opt-out (`*_NO_UPDATE_NOTIFIER`) and
 * stays quiet in CI, where a nag line is noise no one acts on.
 */
function noticeSuppressed(env = process.env) {
    return Boolean(env.EGO_BROWSER_NO_UPDATE_NOTIFIER || env.CI);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}
/**
 * Format the version info into one line, or null when there is nothing to say.
 *
 * This is the single boundary check on the bridge's return: the source crosses a
 * runtime seam (an injected app method), so every field is validated to its declared
 * type here. `updateAvailable`/`mandatory` must be the literal boolean `true` — a
 * truthy non-boolean (e.g. the string "false") does not count — and the version
 * strings must be non-blank, so a missing/empty `currentVersion` yields null and a
 * missing/empty `latestVersion` degrades to the generic phrase.
 */
function composeNotice(info) {
    if (!info ||
        info.updateAvailable !== true ||
        !isNonEmptyString(info.currentVersion)) {
        return null;
    }
    const target = isNonEmptyString(info.latestVersion)
        ? `ego lite ${info.latestVersion}`
        : "an ego lite update";
    const urgency = info.mandatory === true ? "is required" : "is available";
    return `${NOTICE_PREFIX} ${target} ${urgency} (current ${info.currentVersion}) — run: ego-browser upgrade in your shell, then re-read the ego-browser skill`;
}
/**
 * Race a promise against a timeout, resolving to null if the timeout wins. The timer is
 * unref'd so it never keeps the process alive on its own, and it is cleared as soon as
 * the probe settles. This bounds how long the check waits on the bridge: a slow (or
 * stuck) `getBrowserVersion()` can no longer leave the update check pending forever.
 * (It cannot cancel the underlying bridge call — that handle is the app's to release.)
 */
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
/**
 * Ask the injected source (bounded by a timeout) and return the line to append, or null.
 * Swallows every failure: an update check must never be what breaks a command.
 */
async function updateNoticeLine(options) {
    if (noticeSuppressed(process.env))
        return null;
    try {
        const info = await withTimeout(Promise.resolve(options.source()), options.timeoutMs ?? NOTICE_PROBE_TIMEOUT_MS);
        return composeNotice(info);
    }
    catch {
        return null;
    }
}
/**
 * The one real entry point: given the app's injected `ego` bridge (or none, on older
 * builds), fire the check and hand the resulting line to `emit`. Fire-and-forget —
 * `installEgoSdk()` calls this without awaiting it, so the check runs concurrently with
 * the rest of the heredoc rather than delaying it. `emit` decides where the line goes
 * and when: the SDK path routes it to the output sink so it is appended after the
 * command's own output.
 *
 * Fully guarded: `updateNoticeLine` never rejects, and the trailing `.catch` covers a
 * throwing `emit`, so neither a failed check nor a failed write can surface as an
 * unhandled rejection that breaks the command.
 */
function emitUpdateNotice(ego, emit, env) {
    updateNoticeLine({
        source: () => ego?.getBrowserVersion?.() ?? Promise.resolve(null),
        env,
    })
        .then((line) => {
        if (line)
            emit(line);
    })
        .catch(() => { });
}

const SYNC_HELPERS = new Set(["help"]);
const SYNC_FACTORY_HELPERS = new Set([
    "page.locator",
    "page.getByRole",
    "page.getByText",
    "page.getByLabel",
    "page.getByPlaceholder",
    "page.getByAltText",
    "page.getByTitle",
    "page.getByTestId",
    "page.locator.first",
    "page.locator.nth",
    "page.locator.last",
    "page.locator.locator",
    "page.locator.getByRole",
    "page.locator.getByText",
    "page.locator.getByLabel",
    "page.locator.getByPlaceholder",
    "page.locator.getByAltText",
    "page.locator.getByTitle",
    "page.locator.getByTestId",
    "page.locator.filter",
]);
const SYNC_FACTORY_METHODS = new Set([
    "locator",
    "getByRole",
    "getByText",
    "getByLabel",
    "getByPlaceholder",
    "getByAltText",
    "getByTitle",
    "getByTestId",
    "first",
    "nth",
    "last",
    "filter",
]);
const LEGACY_GLOBAL_HELPERS = [
    "click",
    "dblclick",
    "hover",
    "drag",
    "wheel",
    "scrollIntoViewIfNeeded",
    "press",
    "insertText",
    "focus",
    "fill",
    "pressSequentially",
    "check",
    "uncheck",
    "setChecked",
    "selectOption",
    "dispatchEvent",
    "textContent",
    "innerText",
    "inputValue",
    "isChecked",
    "getAttribute",
    "count",
    "allInnerTexts",
    "allTextContents",
    "evaluateAll",
    "goto",
    "pageInfo",
    "listTabs",
    "currentTab",
    "switchTab",
    "openOrReuseTab",
    "closeTab",
    "snapshot",
    "snapshotRaw",
    "screenshot",
    "elementCenter",
    "drainEvents",
    "waitForTimeout",
    "waitForLoadState",
    "waitForSelector",
    "waitForFunction",
    "waitForURL",
    "waitForRequest",
    "waitForResponse",
    "setInputFiles",
    "evaluate",
    "serverFetch",
    "browserFetch",
    "listTaskSpaces",
    "switchTaskSpace",
    "newTaskSpace",
    "useOrCreateTaskSpace",
    "claimTaskSpace",
    "completeTaskSpace",
    "handOffTaskSpace",
    "takeOverTaskSpace",
    "waitForAgentControl",
    "siteSkills",
    "siteSkillsForUrl",
    "runSiteTool",
    "runSiteBrowserTool",
    "learnContext",
];
// Marks an ego runtime whose mutating methods have already been wrapped, so a
// second installEgoSdk call cannot double-wrap createTab / task-space methods.
const EGO_WRAPPED = Symbol.for("egoBrowser.sdkWrapped");
function installEgoSdk(target = globalThis, options = {}) {
    if (!target || typeof target !== "object") {
        return target;
    }
    const context = options.context || helperContext();
    for (const name of LEGACY_GLOBAL_HELPERS) {
        if (Object.prototype.hasOwnProperty.call(target, name)) {
            delete target[name];
        }
    }
    const readySignal = Promise.resolve(options.ready);
    let readyError = null;
    readySignal.catch((error) => {
        readyError = error;
    });
    const installed = {};
    for (const [name, value] of Object.entries(context)) {
        const exposed = SYNC_HELPERS.has(name)
            ? value
            : wrapReady(value, readySignal, () => readyError, [name]);
        Object.defineProperty(target, name, {
            value: exposed,
            writable: true,
            configurable: true,
            enumerable: false,
        });
        installed[name] = exposed;
    }
    const usingDefaultLog = !options.cliLog;
    // The agent's primary output channel is console.log. Route it through the host's
    // sink (options.cliLog) when provided, otherwise the buffered default. There is no
    // dedicated cliLog global anymore; console.error/warn are left untouched. Each
    // heredoc runs in its own short-lived process, so overriding the global is per-run.
    console.log = options.cliLog || createBufferedLog();
    if (usingDefaultLog) {
        // SDK path: the host runs each heredoc in a fresh short-lived process and never
        // calls execute(), so reset the per-run sink and flush it on process teardown.
        resetSink();
        installLifecycleFlush(process.stdout);
    }
    if (target.ego && typeof target.ego === "object") {
        // Fire-and-forget update hint. Route the resolved line to the same channel the
        // command's own output uses: the buffered-sink path registers it as a trailer the
        // sink appends after that output (so it reads as a footer, not a prefix), while a
        // host-provided cliLog gets the line directly. Never touches process.stdout blindly.
        emitUpdateNotice(target.ego, usingDefaultLog ? setNoticeTrailer : (line) => options.cliLog?.(line));
        target.ego.helpers = installed;
        target.ego.learnings =
            installed.site && typeof installed.site === "object"
                ? installed.site
                : {};
        if (!target.ego[EGO_WRAPPED]) {
            wrapCreateTab(target.ego);
            wrapInvalidating(target.ego, [
                "useTaskSpace",
                "closeTaskSpace",
                "createTaskSpace",
                "claimTaskSpace",
            ]);
            Object.defineProperty(target.ego, EGO_WRAPPED, {
                value: true,
                enumerable: false,
            });
        }
        exposeEgoMethods(target, target.ego);
    }
    return target;
}
function wrapReady(value, readySignal, readyError, path = []) {
    if (typeof value === "function") {
        if (isSyncFactoryHelper(path)) {
            return (...args) => wrapReady(value(...args), readySignal, readyError, path);
        }
        return async (...args) => {
            await readySignal;
            const error = readyError();
            if (error) {
                throw error;
            }
            return value(...args);
        };
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const wrapped = {};
    for (const [key, child] of Object.entries(value)) {
        wrapped[key] = wrapReady(child, readySignal, readyError, [...path, key]);
    }
    return wrapped;
}
function isSyncFactoryHelper(path) {
    if (SYNC_FACTORY_HELPERS.has(path.join("."))) {
        return true;
    }
    return path[0] === "page" && SYNC_FACTORY_METHODS.has(path.at(-1) || "");
}
if (isDirectCli()) {
    try {
        process.exitCode = await runMain();
    }
    catch (error) {
        console.error(error?.stack || error?.message || String(error));
        process.exitCode = 1;
    }
}
else {
    installEgoSdk();
}
function createBufferedLog() {
    return (...args) => {
        // Buffer instead of writing through: a hard stop later in the run must be able to
        // discard everything logged so far. The buffer is flushed on process teardown.
        bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
    };
}
function isDirectCli() {
    return (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url);
}
function wrapInvalidating(ego, methodNames) {
    for (const name of methodNames) {
        const original = ego[name];
        if (typeof original !== "function")
            continue;
        const after = () => {
            invalidateSession();
            clearPreferredTarget();
        };
        ego[name] = function (...args) {
            const result = original.apply(this, args);
            if (result && typeof result.then === "function") {
                return result.then((value) => {
                    after();
                    return value;
                });
            }
            after();
            return result;
        };
    }
}
function wrapCreateTab(ego) {
    const original = ego.createTab;
    if (typeof original !== "function")
        return;
    ego.createTab = function (...args) {
        const result = original.apply(this, args);
        if (result && typeof result.then === "function") {
            return result.then((value) => {
                invalidateSession();
                const id = value?.targetId || value?.result?.targetId;
                if (id)
                    setPreferredTarget(id);
                return value;
            });
        }
        invalidateSession();
        return result;
    };
}
function exposeEgoMethods(target, ego) {
    const skip = new Set([
        "helpers",
        "learnings",
        "useTaskSpace",
        "createTaskSpace",
        "claimTaskSpace",
        "closeTaskSpace",
    ]);
    for (const key of Object.keys(ego)) {
        if (skip.has(key))
            continue;
        if (key in target)
            continue;
        const value = ego[key];
        if (typeof value !== "function")
            continue;
        const bound = value.bind(ego);
        Object.defineProperty(target, key, {
            value: bound,
            writable: true,
            configurable: true,
            enumerable: false,
        });
    }
}

export { INTERNAL_URL_PREFIXES, NAME, __testing, allInnerTexts, allTextContents, blur, boundingBox, browserFetch, cdp, check, claimTaskSpace, click, closeTab, completeTaskSpace, count, currentTab, dblclick, dispatchEvent, down, drag, drainEvents, elementCenter, ensureRealTab, evaluate, evaluateAll, evaluateLocator, fill, focus, getAttribute, goto, handOffTaskSpace, helperContext, hover, iframeTarget, innerHTML, innerText, inputValue, insertText, installEgoSdk, isChecked, isDisabled, isEditable, isEnabled, isHidden, isVisible, learnContext, listTabs, listTaskSpaces, loadAgentHelpers, newTaskSpace, openOrReuseTab, pageInfo, press, pressSequentially, runMain, runSiteBrowserTool, runSiteTool, screenshot, scrollIntoViewIfNeeded, selectOption, serverFetch, setChecked, setInputFiles, siteSkills, siteSkillsForUrl, snapshot, snapshotRaw, startScreencast, stopScreencast, switchTab, switchTaskSpace, takeOverTaskSpace, textContent, uncheck, up, useOrCreateTaskSpace, waitForAgentControl, waitForFunction, waitForLoadState, waitForRequest, waitForResponse, waitForSelector, waitForTimeout, waitForURL, wheel };
