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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initCastServer } from './cast-server.js';
export const name = 'ego-browser';
export const inject = ['tools', 'subprocess', 'httpServer'];
// Plain object (no schemastery validation); fields documented above.
export const Config = null; // fixed: plain {} breaks cordis resolveConfig (2026-08-11)
// ── constants ───────────────────────────────────────────────────────────────
const SENTINEL = '@@DSH_RESULT@@';
/** Vendored ego-linux CLI shipped inside this plugin (runtime/ego-linux/bin/). */
const VENDORED_EGO_BIN = fileURLToPath(new URL('../runtime/ego-linux/bin/ego-browser.mjs', import.meta.url));
const DEFAULT_EGO_BIN = VENDORED_EGO_BIN;
const DEFAULT_SPACE = 'dsh-agent';
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_GRACE_MS = 15_000;
const TOOL_TIMEOUT_MS = 120_000;
// ── serialization ───────────────────────────────────────────────────────────
/**
 * The ego-lite host is a single persistent browser shared by every tool call;
 * concurrent tool executions would race on the same task space / tabs. All
 * ego_* executions are therefore serialized through one in-process lock. This
 * guards against concurrent tool calls within this plugin instance; separate
 * harness sessions sharing the same browser remain unsupported (host-level).
 */
let egoLockChain = Promise.resolve();
async function withEgoLock(fn) {
    const run = egoLockChain.then(() => fn(), () => fn());
    egoLockChain = run.then(() => undefined, () => undefined);
    return run;
}
function readAll(reader) {
    if (!reader)
        return '';
    return reader.readFrom(0).text;
}
// ── environment self-adaptation ──────────────────────────────────────────────
/**
 * Build the env handed to `ego-browser nodejs` spawns.
 *
 * The vendored ego-linux CLI reads EGO_LINUX_CHROME (bare Chrome binary/wrapper
 * path) and EGO_LINUX_HEADLESS (=1 to run headless) from the process env. When a
 * host does not set them — the common case on root / Docker / CI boxes — Chrome
 * silently fails to start, and consumers see a 20s `DevTools port` timeout.
 *
 * This function makes the plugin self-sufficient WITHOUT touching the host or
 * other plugins:
 *
 *  - It is a pure function: only reads the current process env, never mutates
 *    it, never writes files, and returns a fresh env to pass to the one spawn.
 *  - It INCREMENTALLY FILLS GAPS: it uses `??` on every value, so an env var the
 *    user already set is always respected and never overridden ("user wins").
 *  - It only compensates for missing pieces, so behavior on a correctly set-up
 *    host is byte-for-byte identical to before.
 *  - It is idempotent: the same env yields the same result every call.
 *  - An opt-out switch EGO_BROWSER_AUTO_ADAPT (set to "0"/"false"/"no") restores
 *    the original "inherit host env verbatim" behavior.
 */
const BUNDLED_WRAPPER = fileURLToPath(new URL('../bin/ego-chrome-wrapper.sh', import.meta.url));
const AUTO_ADAPT_OFF = /^(0|false|no)$/i.test(process.env.EGO_BROWSER_AUTO_ADAPT ?? '');
const COMMON_CHROME_BINS = [
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/google-chrome',
];
/** Find a usable Chrome binary by scanning PATH + common fixed locations. */
function findChromeBinary() {
    if (process.env.EGO_LINUX_CHROME) {
        return process.env.EGO_LINUX_CHROME;
    }
    for (const name of COMMON_CHROME_BINS) {
        if (name.includes('/')) {
            try {
                if (existsSync(name)) {
                    return name;
                }
            }
            catch {
                // fall through
            }
        }
        else {
            for (const dir of (process.env.PATH ?? '').split(':')) {
                if (!dir) {
                    continue;
                }
                const p = `${dir}/${name}`;
                try {
                    if (existsSync(p)) {
                        return p;
                    }
                }
                catch {
                    // fall through
                }
            }
        }
    }
    return undefined;
}
/** Root detection only makes sense on POSIX; Windows doesn't gate on sandbox. */
function isPosixRoot() {
    const uid = process.getuid?.();
    return typeof uid === 'number' && uid === 0 && process.platform !== 'win32';
}
/** No display server → headless is required (Linux/macOS headless servers). */
function isHeadlessDetected() {
    if (process.platform === 'win32') {
        return false; // Windows always has a desktop session.
    }
    return process.env.DISPLAY === undefined || process.env.DISPLAY === '';
}
function resolveEgoEnv(cfg) {
    if (AUTO_ADAPT_OFF) {
        // New switch explicitly disabled: original behavior, inherit verbatim.
        return process.env;
    }
    const env = { ...process.env };
    const chrome = findChromeBinary();
    // Root / Docker / CI: Chrome refuses to run without --no-sandbox. The
    // wrapper execs the real binary with --no-sandbox (EGO_LINUX_CHROME takes a
    // bare path, so a wrapper is required). Never override a user-set value.
    if (env.EGO_LINUX_CHROME === undefined && isPosixRoot() && chrome) {
        env.EGO_LINUX_CHROME = BUNDLED_WRAPPER;
    }
    // Headless servers (no DISPLAY) must run the backing browser headless.
    if (env.EGO_LINUX_HEADLESS === undefined && isHeadlessDetected()) {
        env.EGO_LINUX_HEADLESS = '1';
    }
    return env;
}
function describeStderr(stderr) {
    const tail = stderr.trim();
    return tail === '' ? '' : `\n--- ego-browser stderr (tail) ---\n${tail.slice(-2000)}`;
}
function describeSpawnFailure(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|spawn .* ENOENT|not found|could not load|cannot find module/i.test(msg)) {
        return 'ego-browser CLI could not be started. For the vendored runtime, make sure a Chrome/Chromium is reachable (PATH, or set EGO_LINUX_CHROME; root users need a --no-sandbox wrapper, see AGENTS.md). To use an official host instead, set egoBin to your `ego-browser` command. ' + msg;
    }
    return `failed to start ego-browser: ${msg}`;
}
/** Find the last line carrying the sentinel and JSON-parse its payload. */
function parseSentinel(stdout) {
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const idx = lines[i].indexOf(SENTINEL);
        if (idx === -1)
            continue;
        const payload = lines[i].slice(idx + SENTINEL.length).trim();
        try {
            return JSON.parse(payload);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
async function runEgoScript(subprocess, script, exec, cfg) {
    let handle;
    try {
        handle = subprocess.spawn({
            // Run through the node interpreter so the vendored CLI needs no +x bit.
            argv: [process.execPath, cfg.egoBin, 'nodejs'],
            cwd: process.cwd(),
            env: resolveEgoEnv(cfg),
            stdio: {
                stdin: { data: script },
                stdout: { maxBytes: cfg.maxOutputBytes, spill: { maxBytes: cfg.maxOutputBytes } },
                stderr: { maxBytes: 512_000, spill: { maxBytes: 2_000_000 } },
            },
            graceMs: cfg.graceMs,
            ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        });
    }
    catch (err) {
        return { ok: false, error: describeSpawnFailure(err), stdout: '', stderr: '' };
    }
    let outcome;
    try {
        outcome = await handle.done;
    }
    catch (err) {
        return { ok: false, error: describeSpawnFailure(err), stdout: '', stderr: '' };
    }
    const stdout = readAll(handle.collected.stdout);
    const stderr = readAll(handle.collected.stderr);
    if (exec.signal !== undefined && exec.signal.aborted) {
        return { ok: false, error: 'ego-browser tool aborted (harness timeout or cancellation)', stdout, stderr };
    }
    if (outcome.exitCode !== 0) {
        // When run through the node interpreter, a missing CLI surfaces as a
        // module-load failure with exit 1 instead of a spawn error — normalize it
        // to the same clear "CLI not available" message.
        const missingModule = /Cannot find module|MODULE_NOT_FOUND/i.test(stderr);
        return {
            ok: false,
            error: missingModule
                ? describeSpawnFailure(new Error(`node could not load ${cfg.egoBin}`))
                : `ego-browser exited with ${outcome.exitCode !== null ? `code ${outcome.exitCode}` : `signal ${String(outcome.signal)}`}${describeStderr(stderr)}`,
            stdout,
            stderr,
        };
    }
    const value = parseSentinel(stdout);
    if (value === undefined) {
        return {
            ok: false,
            error: `ego-browser finished but no ${SENTINEL} JSON payload was found on stdout${describeStderr(stderr)}`,
            stdout,
            stderr,
        };
    }
    return { ok: true, value, stdout, stderr };
}
// ── tool plumbing ───────────────────────────────────────────────────────────
const j = (v) => JSON.stringify(v);
/** JS snippet that pins an action tool to one task space. */
const useSpace = (name) => `const task = await taskSpaces.useOrCreate(${j(name)})\n`;
/**
 * JS snippet that makes the harness act on a real page tab.
 *
 * The Linux host (PR #234 ego-linux) does not reliably persist "current tab"
 * across CLI invocations: a fresh process sometimes resolves page actions
 * against a blank/stale tab. Selecting the first non-blank tab in the space
 * before acting makes cross-process tool calls deterministic.
 */
const ensureRealTab = () => `const __tabs = await browser.listTabs()\n` +
    `const __real = __tabs.find(t => !t.url.startsWith('about:') && !t.url.startsWith('chrome://')) ?? __tabs[0]\n` +
    `if (__real) await browser.switchTab(__real.targetId)\n`;
/** Inline helper making arbitrary helper results JSON-safe for the payload. */
const SAFE_FN = 'function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n';
function renderText(_args, value) {
    const v = value;
    if (v !== null && typeof v === 'object' && v.ok === true && typeof v.text === 'string') {
        return [{ type: 'text', text: v.text }];
    }
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}
const commonOutputSchema = {
    type: 'object',
    additionalProperties: true,
    properties: {
        ok: { type: 'boolean', required: true },
    },
};
function defineEgoTool(ctx, cfg, opts) {
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
            const script = opts.buildScript(args);
            const result = await runEgoScript(ctx.subprocess, script, exec, cfg);
            if (!result.ok)
                throw new Error(result.error);
            // Value is JSON.parse output of our own payload — fits the tool JSON contract.
            return result.value;
        }),
        presentCall: () => ({ card: 'generic', title: opts.name, kind: 'other', rawInput: null }),
    });
}
const str = (v, fallback) => (typeof v === 'string' && v !== '' ? v : fallback);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
// ── plugin entry ────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
    const cfg = {
        egoBin: config.egoBin !== undefined && config.egoBin !== '' ? config.egoBin : DEFAULT_EGO_BIN,
        defaultSpace: config.defaultSpace ?? DEFAULT_SPACE,
        maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    };
    const reg = (tool) => {
        const dispose = ctx.tools.register(tool);
        // Cordis lifecycle: unregister the tool when the plugin unmounts.
        ctx.effect?.(() => dispose);
    };
    registerEgoStatus(ctx, cfg, reg);
    registerAuthFlush(ctx, cfg, reg);
    registerActionTools(ctx, cfg, reg);
    // Realtime watch-panel host routes (/api/ego/*). Guarded: only meaningful
    // when the host exposes an HTTP server (web surface); headless safe-no-op.
    if (typeof ctx.httpServer?.register === 'function') {
        try {
            initCastServer(ctx);
        }
        catch (err) {
            ctx.logger?.warn?.(`ego-browser: cast server init failed: ${err?.message ?? err}`);
        }
    }
    // Graceful teardown: stop the persistent browser when the plugin unmounts.
    // AWAITS `--stop` so the graceful Browser.close has time to flush cookies to
    // disk — otherwise a supervisor SIGTERM that also SIGKILLs the child would
    // drop in-memory login cookies (lost logins on DSH restart).
    ctx.effect?.(async () => {
        try {
            const handle = ctx.subprocess.spawn({
                argv: [process.execPath, cfg.egoBin, '--stop'],
                cwd: process.cwd(),
                env: resolveEgoEnv(cfg),
                stdio: {
                    stdin: { data: '' },
                    stdout: { maxBytes: 1024 },
                    stderr: { maxBytes: 1024 },
                },
                // Browser.close + Chrome cookie flush can take a few seconds;
                // give it room so the graceful path (not SIGKILL) wins.
                graceMs: 15_000,
            });
            await handle.done.catch(() => { });
        }
        catch {
            // never let teardown throw
        }
    });
    ctx.logger?.info(`ego-browser: mounted (egoBin=${cfg.egoBin}, defaultSpace=${cfg.defaultSpace})`);
}
/** `ego_status` probes CLI availability by running the real `--status` path. */
function registerEgoStatus(ctx, cfg, reg) {
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
        // Chrome cold-start can exceed the runtime's own 20s DevTools window on
        // a first launch (root/CI boxes in particular). Give --status a generous
        // budget so it does not report "unavailable" merely because the backing
        // browser was still warming up.
        timeoutMs: 25_000,
        execute: async () => withEgoLock(async () => {
            try {
                const handle = ctx.subprocess.spawn({
                    argv: [process.execPath, cfg.egoBin, '--status'],
                    cwd: process.cwd(),
                    env: resolveEgoEnv(cfg),
                    stdio: {
                        stdin: { data: '' },
                        stdout: { maxBytes: 4096 },
                        stderr: { maxBytes: 4096 },
                    },
                    graceMs: 25_000,
                });
                const outcome = await handle.done;
                const out = readAll(handle.collected.stdout).trim();
                return { ok: true, available: outcome.exitCode === 0 && out !== '', path: cfg.egoBin, exitCode: outcome.exitCode };
            }
            catch (err) {
                return { ok: true, available: false, path: '', exitCode: null, error: describeSpawnFailure(err) };
            }
        }),
        presentCall: () => ({ card: 'generic', title: 'ego_status', kind: 'other', rawInput: null }),
    }));
}
/** `ego_auth_flush` — force persistent login cookies down to the disk profile. */
function registerAuthFlush(ctx, cfg, reg) {
    reg(defineTool({
        name: 'ego_auth_flush',
        description: 'Force all persistent login cookies in the agent browser to be written to the on-disk profile. Call this after login (or before ending a browsing task) so the login survives a later DSH/browser restart — Chrome only flushes cookies to disk on graceful close, this nudges it to persist them now.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    total: { type: 'integer' },
                    flushed: { type: 'integer' },
                    error: { type: 'string' },
                },
            },
            render: renderText,
        },
        timeoutMs: 10_000,
        execute: async () => withEgoLock(async () => {
            try {
                const { readFile } = await import('node:fs/promises');
                const stateDir = process.env.XDG_STATE_HOME || `${process.env.HOME || '/root'}/.local/state`;
                let port = null;
                try {
                    const state = JSON.parse(await readFile(`${stateDir}/ego-lite-linux/ego-cast.json`, 'utf8'));
                    port = typeof state.port === 'number' ? state.port : null;
                } catch { port = null; }
                if (port === null) return { ok: false, error: 'no live ego-cast worker (browser not running)' };
                const r = await fetch(`http://127.0.0.1:${port}/api/flush`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{}',
                    signal: AbortSignal.timeout(8000),
                });
                const j = await r.json();
                return { ok: !!j.ok, total: j.total ?? 0, flushed: j.flushed ?? 0, error: j.error };
            }
            catch (err) {
                return { ok: false, error: String(err?.message || err) };
            }
        }),
        presentCall: () => ({ card: 'generic', title: 'ego_auth_flush', kind: 'other', rawInput: null }),
    }));
}
/** The 11 structured action tools that drive `ego-browser nodejs`. */
function registerActionTools(ctx, cfg, reg) {
    const t = (opts) => defineEgoTool(ctx, cfg, opts);
    const spaceParam = { type: 'string', description: 'Task-space name or numeric id; defaults to the configured defaultSpace.' };
    reg(t({
        name: 'ego_space_open',
        description: 'Open (or reuse) an ego-lite task space — an isolated browsing context that inherits your login state. Returns the space id; pass it as `space` to other ego_* tools, or rely on the default space.',
        parameters: {
            name: { type: 'string', required: true, description: 'Short name for the active user goal, e.g. "search github issues". Reuse the same name for follow-ups on the same goal.' },
        },
        buildScript: (args) => `${useSpace(str(args.name, cfg.defaultSpace))}` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, id: task.id ?? null, name: task.name ?? ${j(str(args.name, cfg.defaultSpace))} }))\n`,
    }));
    reg(t({
        name: 'ego_space_close',
        description: 'Complete (close) an ego-lite task space. Must be the final ego_* call for a task — never leave a space hanging. `keep: true` keeps the page open for the user.',
        parameters: {
            name: { type: 'string', required: true, description: 'Task-space name or numeric id to close.' },
            keep: { type: 'boolean', description: 'Keep the live page open (default false: close it).' },
        },
        buildScript: (args) => `const res = await taskSpaces.complete(${j(str(args.name, cfg.defaultSpace))}, { keep: ${bool(args.keep, false)} })\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, done: !!res.done, skipped: !!res.skipped, reason: res.skipped ? ${j('target space was not agent-owned')} : null }))\n`,
    }));
    reg(t({
        name: 'ego_snapshot',
        description: 'Read the current page as text: the full-page semantic tree annotated with [ref=N, loc=...] selectors that ego_click / ego_fill can target. This is the main observation tool for any browser task.',
        parameters: {
            space: spaceParam,
            scope: { type: 'string', description: "snapshot scope: 'full_page' (default) or 'only_within_viewport'." },
        },
        buildScript: (args) => {
            const scope = str(args.scope, '');
            const call = scope === '' ? 'await page.snapshotRaw()' : `await page.snapshotRaw({ scope: ${j(scope)} })`;
            // The host can return an empty DOM capture right after a navigation;
            // retry briefly so a mid-load snapshot does not come back empty.
            return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
                `let s = ${call}\n` +
                `let tries = 0\n` +
                `while (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = ${call}; tries++ }\n` +
                `const text = s.content ?? ''\n` +
                // Distinguish a genuinely empty page from a failed/empty capture:
                // signal ok:false when no content came back after all retries, so
                // callers never mistake a dead capture for a legitimate blank page.
                `console.log('${SENTINEL}' + JSON.stringify(text === ''\n` +
                `  ? { ok: false, text, tries, reason: 'snapshot returned no content after retries (page may be blank, still loading, or the browser dropped)' }\n` +
                `  : { ok: true, text, tries }))\n`;
        },
    }));
    reg(t({
        name: 'ego_navigate',
        description: 'Open a URL in the task space, or switch to the existing tab for it. Waits for the document to load. Returns the resulting page info.',
        parameters: {
            url: { type: 'string', required: true, description: 'Absolute URL to open, e.g. https://example.com/path.' },
            wait: { type: 'boolean', description: 'Wait for document load (default true).' },
            timeout: { type: 'number', description: 'Load wait timeout in ms (default 20000).' },
            space: spaceParam,
        },
        buildScript: (args) => {
            const u = str(args.url, '');
            // Schema marks url required, but never silently navigate to a
            // hard-coded example page on a non-conforming empty value — report
            // back an actionable failure instead.
            if (u === '') {
                return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reused: false, page: null, reason: 'ego_navigate: url is required' }))\n`;
            }
            // Reuse the current tab in this task space (select a real tab, then
            // navigate IN PLACE via page.goto) instead of opening a new tab every
            // time. This keeps the agent's tab count small across a task. If a
            // tab already shows the exact URL, we switch to it; otherwise we
            // navigate the active tab so we don't pile up tabs.
            // NOTE: ensureRealTab() already declares `__tabs`, so reuse it.
            return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
                `const __existing = __tabs.find(t => t.url.split('#')[0] === ${j(u.split('#')[0])})\n` +
                `const tab = __existing ? await browser.switchTab(__existing.targetId) : await page.goto(${j(u)}, { wait: ${bool(args.wait, true)}, timeout: ${num(args.timeout, 20_000)} })\n` +
                `const pginfo = await page.info()\n` +
                `console.log('${SENTINEL}' + JSON.stringify({ ok: true, reused: !!__existing, page: pginfo }))\n`;
        },
    }));
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
            const sel = str(args.selector, '');
            const x = args.x;
            const y = args.y;
            if (sel === '' && !(typeof x === 'number' && typeof y === 'number')) {
                throw new Error('ego_click: provide either `selector` (CSS/xpath/loc/ref from ego_snapshot) or both `x` and `y` viewport coordinates');
            }
            let action;
            if (sel !== '') {
                const labelOpt = str(args.label, '') !== '' ? `{ label: ${j(str(args.label, ''))} }` : '';
                action = `await page.locator(${j(sel)}).click(${labelOpt})`;
            }
            else {
                action = `await page.mouse.click(${x}, ${y})`;
            }
            return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
                `${action}\n` +
                `const pginfo = await page.info()\n` +
                `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`;
        },
    }));
    reg(t({
        name: 'ego_fill',
        description: 'Type text into an input field. Target with a CSS selector, xpath=..., loc=..., or ref=@N from ego_snapshot.',
        parameters: {
            selector: { type: 'string', required: true, description: 'CSS selector, xpath=..., loc=..., or ref=@N for the input.' },
            text: { type: 'string', required: true, description: 'Text to type into the field.' },
            space: spaceParam,
        },
        buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
            `await page.locator(${j(str(args.selector, ''))}).fill(${j(str(args.text, ''))})\n` +
            `const pginfo = await page.info()\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`,
    }));
    reg(t({
        name: 'ego_js',
        description: 'Evaluate a JavaScript expression in the current page and return its JSON-serializable value (e.g. "document.title", "document.querySelectorAll(\'a\').length").',
        parameters: {
            expression: { type: 'string', required: true, description: 'JavaScript expression string to evaluate in the page.' },
            space: spaceParam,
        },
        buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
            `${SAFE_FN}` +
            `const result = await page.evaluate(${j(str(args.expression, ''))})\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`,
    }));
    reg(t({
        name: 'ego_cdp',
        description: 'Issue a raw CDP command on the page target, e.g. cdp("Page.handleJavaScriptDialog", { accept: true }).',
        parameters: {
            method: { type: 'string', required: true, description: 'CDP method name, e.g. Page.handleJavaScriptDialog.' },
            params: { type: 'object', additionalProperties: true, description: 'CDP method parameters object.' },
            space: spaceParam,
        },
        buildScript: (args) => {
            const params = args.params;
            const call = params !== undefined && params !== null ? `await cdp(${j(str(args.method, ''))}, ${j(params)})` : `await cdp(${j(str(args.method, ''))})`;
            return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
                `${SAFE_FN}` +
                `const result = ${call}\n` +
                `console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`;
        },
    }));
    reg(t({
        name: 'ego_screenshot',
        description: 'Capture a screenshot of the current page. Returns the file path of the saved PNG, which you can then read with a vision/image tool.',
        parameters: {
            space: spaceParam,
        },
        buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
            `const path = await page.screenshot()\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path }))\n`,
    }));
    reg(t({
        name: 'ego_page_info',
        description: 'Return the current page info: url, title, viewport size (w, h), scroll offsets (sx, sy), and device metrics (pw, ph). Also reports when a native browser dialog is open.',
        parameters: {
            space: spaceParam,
        },
        buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
            `const pginfo = await page.info()\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`,
    }));
    reg(t({
        name: 'ego_wait',
        description: 'Pause for a fixed number of milliseconds (e.g. for animations or partial loads). For load waits prefer ego_navigate\'s wait option.',
        parameters: {
            ms: { type: 'number', required: true, description: 'Milliseconds to wait.' },
        },
        buildScript: (args) => `await page.waitForTimeout(${Math.max(0, num(args.ms, 1000))})\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, waitedMs: ${Math.max(0, num(args.ms, 1000))} }))\n`,
    }));
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
                const script = str(args.script, '');
                const result = await runEgoScript(ctx.subprocess, script, exec, cfg);
                if (!result.ok)
                    throw new Error(result.error);
                const parsed = parseSentinel(result.stdout);
                return { ok: true, stdout: result.stdout, stderr: result.stderr, result: parsed ?? null };
            },
            presentCall: () => ({ card: 'generic', title: 'ego_cli', kind: 'other', rawInput: null }),
        });
        return def;
    })());
}
