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
 *
 * == 文件内部结构（改动前先看 docs/ARCH.md）==
 *   顶部常量     : SENTINEL / HUMAN_CHECK_PROBE / 默认值
 *   withEgoLock  : 全插件互斥锁（工具串行，防争浏览器）
 *   chrome/env   : Chrome 探测 / 环境自适应
 *   runEgoScript : 脚本执行引擎 + 哨兵解析 + 冷启动重试
 *   defineEgoTool: t() 工具封装基座（自动加锁 + 重试）
 *   registerActionTools   : 大部分 ego_* 工具（用 t() 逐个注册）
 *   registerHelpAndDoctor : ego_help/doctor/script/captcha
 *   EGO_HELP_INDEX / HUMAN_CHECK_PROBE : 工具索引文案 / 人机验证探针
 * 加工具：在 registerActionTools 里 reg(t({...}))，并同步 EGO_HELP_INDEX，跑 npm run build。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { initCastServer } from "./cast-server.js";
import { EGO_HELP_INDEX } from "./help.js";
import { HUMAN_CHECK_PROBE } from "./captcha.js";
import { Config as ConfigSchema } from "./config.js";
import { resolveConfig } from "./config.js";
import { installEgoBrowserSettings } from "./settings.js";
import { registerEgoBrowserGateway } from "./gateway.js";
export const name = "ego-browser";
// Platform-aware host services: the web shell exposes `webServer`, other Web
// hosts expose `httpServer`. Declare both as optional so the plugin mounts on
// either runner; initCastServer picks whichever one is present.
// cordis 0.1.0 requires a plain string array (the object-optional syntax it
// previously used is unsupported and broke cast-server registration — the
// 2026-08-13 regression). Declaring the HTTP service as a plain string is how
// every working host plugin (aionui-panel, client-connection, web-app) does it:
// plain-string services resolve through fiber.store, keeping ctx.webServer
// reachable so initCastServer can re-register the /api/ego/* watch routes.
export const inject = ["tools", "subprocess", "webServer"];
// Schemastery schema for the composition entry and the `ego-browser` settings
// namespace. Re-exported from config.js so cordis's loader validates the
// composition layer and ctx.settings.register() validates the user layer.
export const Config = ConfigSchema;
// ── constants ───────────────────────────────────────────────────────────────
const SENTINEL = "@@DSH_RESULT@@";
/** Build the script that runs the probe and emits a sentinel payload. */
function humanCheckScript(space) {
  return (
    `${useSpace(space)}${ensureRealTab()}` +
    `let __hc = null\n` +
    `try { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}) } catch { __hc = null }\n` +
    `console.log('${SENTINEL}' + JSON.stringify({ ok: true, humanCheck: __hc }))\n`
  );
}
/** Vendored ego-linux CLI shipped inside this plugin (runtime/ego-linux/bin/). */
const VENDORED_EGO_BIN = fileURLToPath(
  new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url)
);
const DEFAULT_EGO_BIN = VENDORED_EGO_BIN;
const DEFAULT_SPACE = "dsh-agent";
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
  const run = egoLockChain.then(
    () => fn(),
    () => fn()
  );
  egoLockChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
function readAll(reader) {
  if (!reader) return "";
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
const BUNDLED_WRAPPER = fileURLToPath(
  new URL("../bin/ego-chrome-wrapper.sh", import.meta.url)
);
const IS_WIN = process.platform === "win32";
const AUTO_ADAPT_OFF = /^(0|false|no)$/i.test(
  process.env.EGO_BROWSER_AUTO_ADAPT ?? ""
);
const COMMON_CHROME_BINS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/google-chrome",
];
/** Windows registry-free probe of the usual install dirs (no subprocess). */
function windowsChromeCandidates() {
  const pf = process.env.ProgramFiles;
  const pfx86 = process.env["ProgramFiles(x86)"];
  const local = process.env.LOCALAPPDATA;
  const base =
    local ||
    `${process.env.USERPROFILE || process.env.HOME || ""}\\AppData\\Local`;
  const b = (p) => (p ? p.replace(/\\+$/, "") : p);
  const out = [
    b(pf) + "\\Google\\Chrome\\Application\\chrome.exe",
    b(pfx86) + "\\Google\\Chrome\\Application\\chrome.exe",
    b(local) + "\\Google\\Chrome\\Application\\chrome.exe",
    b(pf) + "\\Microsoft\\Edge\\Application\\msedge.exe",
    b(pfx86) + "\\Microsoft\\Edge\\Application\\msedge.exe",
    b(local) + "\\Microsoft\\Edge\\Application\\msedge.exe",
    b(pfx86) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    b(local) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  ];
  return out.filter(Boolean);
}
/** Find a usable Chrome binary by scanning PATH + common fixed locations. */
export function findChromeBinary() {
  if (process.env.EGO_LINUX_CHROME) {
    return process.env.EGO_LINUX_CHROME;
  }
  // Windows: probe install dirs first, then walk PATH with %PATHEXT%.
  if (IS_WIN) {
    for (const p of windowsChromeCandidates()) {
      try {
        if (existsSync(p)) {
          return p;
        }
      } catch {
        // fall through
      }
    }
    const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .filter(Boolean)
      .map((e) =>
        e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`
      );
    const dirs = (process.env.PATH ?? "")
      .split(";")
      .map((d) => d.replace(/^"|"$/g, ""))
      .filter(Boolean);
    for (const dir of dirs) {
      for (const name of ["chrome", "msedge", "brave"]) {
        for (const ext of exts) {
          try {
            const p = `${dir}\\${name}${ext}`;
            if (existsSync(p)) {
              return p;
            }
          } catch {
            // fall through
          }
        }
      }
    }
    return undefined;
  }
  // POSIX: absolute + PATH walk.
  for (const name of COMMON_CHROME_BINS) {
    if (name.includes("/")) {
      try {
        if (existsSync(name)) {
          return name;
        }
      } catch {
        // fall through
      }
    } else {
      for (const dir of (process.env.PATH ?? "").split(":")) {
        if (!dir) {
          continue;
        }
        const p = `${dir}/${name}`;
        try {
          if (existsSync(p)) {
            return p;
          }
        } catch {
          // fall through
        }
      }
    }
  }
  return undefined;
}
/** Root detection only makes sense on POSIX; Windows doesn't gate on sandbox. */
function isPosixRoot(platform = process.platform) {
  const uid = process.getuid?.();
  return typeof uid === "number" && uid === 0 && platform !== "win32";
}
/** No display server → headless is required (Linux/macOS headless servers). */
function isHeadlessDetected(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return false; // Windows always has a desktop session.
  }
  return env.DISPLAY === undefined || env.DISPLAY === "";
}
/**
 * Build the env handed to `ego-browser nodejs` spawns. See the block comment
 * above ("environment self-adaptation") for the design contract.
 *
 * Platform/env are injectable for testing; production calls use process defaults.
 */
export function resolveEgoEnv(cfg, { platform = process.platform, baseEnv = process.env } = {}) {
  if (AUTO_ADAPT_OFF) {
    // New switch explicitly disabled: original behavior, inherit verbatim.
    return baseEnv;
  }
  const env = { ...baseEnv };
  const chrome = findChromeBinary();
  // Settings-configured chrome path (highest priority after user-set env).
  // An empty string means "auto-detect" — skip so the platform branches below
  // can run.
  const configChrome = cfg?.chromePath;
  if (env.EGO_LINUX_CHROME === undefined && configChrome) {
    env.EGO_LINUX_CHROME = configChrome;
  }
  // Root / Docker / CI: Chrome refuses to run without --no-sandbox. The
  // wrapper execs the real binary with --no-sandbox (EGO_LINUX_CHROME takes a
  // bare path, so a wrapper is required). Never override a user-set value.
  if (env.EGO_LINUX_CHROME === undefined && isPosixRoot(platform) && chrome) {
    env.EGO_LINUX_CHROME = BUNDLED_WRAPPER;
  }
  // Windows: no --no-sandbox needed (Windows Chrome has no sandbox gate), and
  // the bundled wrapper is a POSIX shell script that cannot run here. Pass the
  // binary path directly so the vendored runtime (which uses POSIX `which`)
  // doesn't have to resolve it itself.
  if (env.EGO_LINUX_CHROME === undefined && platform === "win32" && chrome) {
    env.EGO_LINUX_CHROME = chrome;
  }
  // Headless servers (no DISPLAY) must run the backing browser headless.
  if (env.EGO_LINUX_HEADLESS === undefined && isHeadlessDetected(platform, env)) {
    env.EGO_LINUX_HEADLESS = "1";
  }
  return env;
}
function describeStderr(stderr) {
  const tail = stderr.trim();
  return tail === ""
    ? ""
    : `\n--- ego-browser stderr (tail) ---\n${tail.slice(-2000)}`;
}
function describeSpawnFailure(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /ENOENT|spawn .* ENOENT|not found|could not load|cannot find module/i.test(
      msg
    )
  ) {
    return (
      "ego-browser CLI could not be started. For the vendored runtime, make sure a Chrome/Chromium is reachable (PATH, or set EGO_LINUX_CHROME; root users need a --no-sandbox wrapper, see AGENTS.md). To use an official host instead, set egoBin to your `ego-browser` command. " +
      msg
    );
  }
  return `failed to start ego-browser: ${msg}`;
}
/**
 * Error signatures that indicate a TRANSIENT browser cold-start / channel
 * not-yet-ready problem rather than a real defect. The ego-lite host is a
 * single persistent Chromium that cold-starts on the first tool call of a
 * session; a probe that arrives while the DevTools/CDP channel is still
 * coming up can fail with one of these. Such failures are safe to retry
 * briefly (the browser keeps warming up in the background). Anything else
 * must pass through immediately — never mask a genuine error.
 */
const COLD_START_SIGNS = [
  /CDP channel is not open/i,
  /DevTools.*(port|timeout|active)/i,
  /could not connect to/i,
  /browser (was |is )?not (reachable|running|ready)/i,
  /target.*(closed|not found|detached|crashed)/i,
  /ECONNREFUSED/i,
];
function isColdStartError(message) {
  return COLD_START_SIGNS.some((re) => re.test(message));
}
/**
 * Run `fn` (a per-call `ego-browser` spawn) up to `tries` times with a short
 * backoff, retrying ONLY when the failure matches a transient cold-start
 * signature. Real errors return on their first occurrence so they are never
 * masked. Each retry re-spawns a fresh process, which is exactly what lets a
 * warmed-up browser connect on a later attempt.
 */
async function withWarmupRetry(fn, { tries = 3, baseDelayMs = 600 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const result = await fn();
    if (result.ok || !isColdStartError(result.error ?? "")) {
      return result;
    }
    last = result;
    if (i < tries - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * (i + 1))
      );
    }
  }
  return last;
}
/** Find the last line carrying the sentinel and JSON-parse its payload. */
function parseSentinel(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(SENTINEL);
    if (idx === -1) continue;
    const payload = lines[i].slice(idx + SENTINEL.length).trim();
    try {
      return JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
async function runEgoScript(subprocess, script, exec, cfg, graceOverrideMs) {
  let handle;
  try {
    handle = subprocess.spawn({
      // Run through the node interpreter so the vendored CLI needs no +x bit.
      argv: [process.execPath, cfg.egoBin, "nodejs"],
      cwd: process.cwd(),
      env: resolveEgoEnv(cfg),
      stdio: {
        stdin: { data: script },
        stdout: {
          maxBytes: cfg.maxOutputBytes,
          spill: { maxBytes: cfg.maxOutputBytes },
        },
        stderr: { maxBytes: 512_000, spill: { maxBytes: 2_000_000 } },
      },
      graceMs: Number.isFinite(graceOverrideMs) && graceOverrideMs > 0
        ? graceOverrideMs
        : cfg.graceMs,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: describeSpawnFailure(err),
      stdout: "",
      stderr: "",
    };
  }
  let outcome;
  try {
    outcome = await handle.done;
  } catch (err) {
    return {
      ok: false,
      error: describeSpawnFailure(err),
      stdout: "",
      stderr: "",
    };
  }
  const stdout = readAll(handle.collected.stdout);
  const stderr = readAll(handle.collected.stderr);
  if (exec.signal !== undefined && exec.signal.aborted) {
    return {
      ok: false,
      error: "ego-browser tool aborted (harness timeout or cancellation)",
      stdout,
      stderr,
    };
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
        : `ego-browser exited with ${
            outcome.exitCode !== null
              ? `code ${outcome.exitCode}`
              : `signal ${String(outcome.signal)}`
          }${describeStderr(stderr)}`,
      stdout,
      stderr,
    };
  }
  const value = parseSentinel(stdout);
  if (value === undefined) {
    return {
      ok: false,
      error: `ego-browser finished but no ${SENTINEL} JSON payload was found on stdout${describeStderr(
        stderr
      )}`,
      stdout,
      stderr,
    };
  }
  return { ok: true, value, stdout, stderr };
}
// ── tool plumbing ───────────────────────────────────────────────────────────
const j = (v) => JSON.stringify(v);
/** JS snippet that pins an action tool to one task space. */
const useSpace = (name) =>
  `const task = await taskSpaces.useOrCreate(${j(name)})\n`;
/**
 * JS snippet that makes the harness act on a real page tab.
 *
 * The Linux host (PR #234 ego-linux) does not reliably persist "current tab"
 * across CLI invocations: a fresh process sometimes resolves page actions
 * against a blank/stale tab. Selecting the first non-blank tab in the space
 * before acting makes cross-process tool calls deterministic.
 */
const ensureRealTab = () =>
  `const __tabs = await browser.listTabs()\n` +
  `const __real = __tabs.find(t => !t.url.startsWith('about:') && !t.url.startsWith('chrome://')) ?? __tabs[0]\n` +
  `if (__real) await browser.switchTab(__real.targetId)\n`;
/** Inline helper making arbitrary helper results JSON-safe for the payload. */
const SAFE_FN =
  "function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n";
function renderText(_args, value) {
  const v = value;
  if (
    v !== null &&
    typeof v === "object" &&
    v.ok === true &&
    typeof v.text === "string"
  ) {
    return [{ type: "text", text: v.text }];
  }
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}
const commonOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean", required: true },
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
    execute: async (args, exec) =>
      withEgoLock(async () => {
        const script = opts.buildScript(args);
        // A first-call cold Chromium can make the spawn fail transiently
        // ("CDP channel is not open" etc.); retry only that case so a warmed
        // browser connects on a later attempt without masking real errors.
        const result = await withWarmupRetry(() =>
          runEgoScript(ctx.subprocess, script, exec, cfg)
        );
        if (!result.ok) throw new Error(result.error);
        // Value is JSON.parse output of our own payload — fits the tool JSON contract.
        return result.value;
      }),
    presentCall: () => ({
      card: "generic",
      title: opts.name,
      kind: "other",
      rawInput: null,
    }),
  });
}
const str = (v, fallback) => (typeof v === "string" && v !== "" ? v : fallback);
const num = (v, fallback) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);
// ── plugin entry ────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  // Install the settings bridge first: the live config source (composition
  // entry + user-layer overrides) feeds `chromePath` into cfg via a getter so
  // every spawn reads the latest value without needing re-registration.
  const entry = resolveConfig({
    chromePath:
      typeof config.chromePath === "string" ? config.chromePath : "",
  });
  const bridge = installEgoBrowserSettings(ctx, entry);

  const cfg = {
    egoBin:
      config.egoBin !== undefined && config.egoBin !== ""
        ? config.egoBin
        : DEFAULT_EGO_BIN,
    defaultSpace: config.defaultSpace ?? DEFAULT_SPACE,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    // Live getter: reads from the settings bridge so GUI edits take effect on
    // the next spawn without restarting the plugin.
    get chromePath() {
      return bridge.source().chromePath || "";
    },
  };
  const reg = (tool) => {
    const dispose = ctx.tools.register(tool);
    // Cordis lifecycle: unregister the tool when the plugin unmounts.
    ctx.effect?.(() => dispose);
  };
  registerEgoStatus(ctx, cfg, reg);
  registerAuthFlush(ctx, cfg, reg);
  registerActionTools(ctx, cfg, reg);
  registerHelpAndDoctor(ctx, cfg, reg);
  // Realtime watch-panel host routes (/api/ego/*). Guarded: only meaningful
  // when the host exposes an HTTP server (web surface); headless safe-no-op.
  // The host service is `webServer` on the web shell (current runner). We only
  // reach for `webServer` here (declared in inject) so a strict-inject host
  // never trips on an undeclared `httpServer` read. [restored 2026-08-13: the
  // earlier disable dropped both the webServer inject and this registration,
  // killing the bottom-right live browser view. Plain-string `webServer`
  // inject resolves through fiber.store and is fully supported by cordis.]
  if (typeof ctx.webServer?.register === "function") {
    try {
      initCastServer(ctx);
    } catch (err) {
      ctx.logger?.warn?.(
        `ego-browser: cast server init failed: ${err?.message ?? err}`
      );
    }
    // Settings HTTP gateway (/ego/api/get + /ego/api/set) — lets the browser
    // read/write the `chromePath` config through a self-hosted HTTP route,
    // bypassing the host's settings-RPC allowlist. Same webServer the cast
    // server uses; guarded so a headless host without webServer is a no-op.
    try {
      registerEgoBrowserGateway(ctx, bridge);
    } catch (err) {
      ctx.logger?.warn?.(
        `ego-browser: settings gateway init failed: ${err?.message ?? err}`
      );
    }
  }
  // Graceful teardown: stop the persistent browser when the plugin unmounts.
  // CRITICAL: this must be fire-and-forget, NOT awaited. Awaiting `--stop`
  // (which asks the browser to graceful-close, ~seconds) stalls the host process
  // teardown when DSH is killed/restarted. With a self-healing guard that kills
  // web and expects the old process to exit promptly before restarting it, a
  // slow/frozen browser here hangs the restart forever ("waiting to restart").
  // Losing in-memory login cookies on a dirty shutdown beats a restart that
  // never completes — the clean path still flushes cookies on a graceful DSH
  // close, and ego_auth_flush exists for explicit persistence.
  ctx.effect?.(() => {
    try {
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, cfg.egoBin, "--stop"],
        cwd: process.cwd(),
        env: resolveEgoEnv(cfg),
        stdio: {
          stdin: { data: "" },
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        // Keep it short; never let this outlive the host's own teardown budget.
        // But DO give the graceful stop enough time (>= the runtime's
        // Browser.close + waitForProcessExit window) so the browser merges its
        // cookie journal into the on-disk profile before DSH is gone — that is
        // what keeps logins across a restart (original ego-lite behavior).
        graceMs: 8_000,
      });
      // Fire and forget: do NOT return this promise from the effect cleanup.
      handle.done.catch(() => {});
    } catch {
      // never let teardown throw
    }
  });
  ctx.logger?.info(
    `ego-browser: mounted (egoBin=${cfg.egoBin}, defaultSpace=${cfg.defaultSpace})`
  );
}
/** `ego_status` probes CLI availability by running the real `--status` path. */
function registerEgoStatus(ctx, cfg, reg) {
  reg(
    defineTool({
      name: "ego_status",
      description:
        'Check whether the ego-browser CLI is usable (runs `ego-browser --status`). Use this first when other ego_* tools report "CLI not found".',
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            available: { type: "boolean", required: true },
            path: { type: "string" },
            exitCode: { type: "integer" },
          },
        },
        render: renderText,
      },
      // Chrome cold-start can exceed the runtime's own 20s DevTools window on
      // a first launch (root/CI boxes in particular). Give --status a generous
      // budget so it does not report "unavailable" merely because the backing
      // browser was still warming up.
      timeoutMs: 25_000,
      execute: async () =>
        withEgoLock(async () => {
          try {
            const handle = ctx.subprocess.spawn({
              argv: [process.execPath, cfg.egoBin, "--status"],
              cwd: process.cwd(),
              env: resolveEgoEnv(cfg),
              stdio: {
                stdin: { data: "" },
                stdout: { maxBytes: 4096 },
                stderr: { maxBytes: 4096 },
              },
              graceMs: 25_000,
            });
            const outcome = await handle.done;
            const out = readAll(handle.collected.stdout).trim();
            return {
              ok: true,
              available: outcome.exitCode === 0 && out !== "",
              path: cfg.egoBin,
              exitCode: outcome.exitCode,
            };
          } catch (err) {
            return {
              ok: true,
              available: false,
              path: "",
              exitCode: null,
              error: describeSpawnFailure(err),
            };
          }
        }),
      presentCall: () => ({
        card: "generic",
        title: "ego_status",
        kind: "other",
        rawInput: null,
      }),
    })
  );
}
/** `ego_auth_flush` — force persistent login cookies down to the disk profile. */
function registerAuthFlush(ctx, cfg, reg) {
  reg(
    defineTool({
      name: "ego_auth_flush",
      description:
        "Force all persistent login cookies in the agent browser to be written to the on-disk profile. Call this after login (or before ending a browsing task) so the login survives a later DSH/browser restart — Chrome only flushes cookies to disk on graceful close, this nudges it to persist them now.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            total: { type: "integer" },
            flushed: { type: "integer" },
            error: { type: "string" },
          },
        },
        render: renderText,
      },
      timeoutMs: 10_000,
      execute: async () =>
        withEgoLock(async () => {
          try {
            const { readFile } = await import("node:fs/promises");
            // Mirror the ego-cast worker's state-dir discovery so the flush
            // tool actually finds ego-cast.json on every platform. The worker
            // (cast-worker.mjs) uses %LOCALAPPDATA%\ego-lite-linux on Windows
            // and $XDG_STATE_HOME/ego-lite-linux on POSIX; this used to hardcode
            // `$HOME/.local/state` which resolves to a dead path on Windows and
            // made ego_auth_flush report "no live ego-cast worker" there.
            const e = process.env;
            const isWin = process.platform === "win32";
            const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
            const stateDir =
              e.EGO_LINUX_STATE_DIR ||
              (isWin
                ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux"
                : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
            let port = null;
            try {
              const state = JSON.parse(
                await readFile(`${stateDir}/ego-cast.json`, "utf8")
              );
              port = typeof state.port === "number" ? state.port : null;
            } catch {
              port = null;
            }
            if (port === null)
              return {
                ok: false,
                error: "no live ego-cast worker (browser not running)",
              };
            const r = await fetch(`http://127.0.0.1:${port}/api/flush`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
              signal: AbortSignal.timeout(8000),
            });
            const j = await r.json();
            return {
              ok: !!j.ok,
              total: j.total ?? 0,
              flushed: j.flushed ?? 0,
              error: j.error,
            };
          } catch (err) {
            return { ok: false, error: String(err?.message || err) };
          }
        }),
      presentCall: () => ({
        card: "generic",
        title: "ego_auth_flush",
        kind: "other",
        rawInput: null,
      }),
    })
  );
}
/** The 11 structured action tools that drive `ego-browser nodejs`. */
function registerActionTools(ctx, cfg, reg) {
  const t = (opts) => defineEgoTool(ctx, cfg, opts);
  const spaceParam = {
    type: "string",
    description:
      "Task-space name or numeric id; defaults to the configured defaultSpace.",
  };
  reg(
    t({
      name: "ego_space_open",
      description:
        "Open (or reuse) an ego-lite task space — an isolated browsing context that inherits your login state. Returns the space id; pass it as `space` to other ego_* tools, or rely on the default space.",
      parameters: {
        name: {
          type: "string",
          required: true,
          description:
            'Short name for the active user goal, e.g. "search github issues". Reuse the same name for follow-ups on the same goal.',
        },
      },
      buildScript: (args) =>
        `${useSpace(str(args.name, cfg.defaultSpace))}` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, id: task.id ?? null, name: task.name ?? ${j(
          str(args.name, cfg.defaultSpace)
        )} }))\n`,
    })
  );
  reg(
    t({
      name: "ego_space_close",
      description:
        "Complete (close) an ego-lite task space. Must be the final ego_* call for a task — never leave a space hanging. `keep: true` keeps the page open for the user.",
      parameters: {
        name: {
          type: "string",
          required: true,
          description: "Task-space name or numeric id to close.",
        },
        keep: {
          type: "boolean",
          description: "Keep the live page open (default false: close it).",
        },
      },
      buildScript: (args) =>
        `const res = await taskSpaces.complete(${j(
          str(args.name, cfg.defaultSpace)
        )}, { keep: ${bool(args.keep, false)} })\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, done: !!res.done, skipped: !!res.skipped, reason: res.skipped ? ${j(
          "target space was not agent-owned"
        )} : null }))\n`,
    })
  );
  reg(
    t({
      name: "ego_snapshot",
      description:
        "Read the current page as text: the full-page semantic tree annotated with [ref=N, loc=...] selectors that ego_click / ego_fill can target. This is the main observation tool for any browser task.",
      parameters: {
        space: spaceParam,
        scope: {
          type: "string",
          description:
            "snapshot scope: 'full_page' (default) or 'only_within_viewport'.",
        },
      },
      buildScript: (args) => {
        const scope = str(args.scope, "");
        const call =
          scope === ""
            ? "await page.snapshotRaw()"
            : `await page.snapshotRaw({ scope: ${j(scope)} })`;
        // The host can return an empty DOM capture right after a navigation;
        // retry briefly so a mid-load snapshot does not come back empty.
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `let s = ${call}\n` +
          `let tries = 0\n` +
          `while (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = ${call}; tries++ }\n` +
          `const text = s.content ?? ''\n` +
          // Distinguish a genuinely empty page from a failed/empty capture:
          // signal ok:false when no content came back after all retries, so
          // callers never mistake a dead capture for a legitimate blank page.
          `console.log('${SENTINEL}' + JSON.stringify(text === ''\n` +
          `  ? { ok: false, text, tries, reason: 'snapshot returned no content after retries (page may be blank, still loading, or the browser dropped)' }\n` +
          `  : { ok: true, text, tries }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_navigate",
      description:
        "Open a URL in the task space, or switch to the existing tab for it. Waits for the document to load. Returns the resulting page info.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "Absolute URL to open, e.g. https://example.com/path.",
        },
        wait: {
          type: "boolean",
          description: "Wait for document load (default true).",
        },
        timeout: {
          type: "number",
          description: "Load wait timeout in ms (default 20000).",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const u = str(args.url, "");
        // Schema marks url required, but never silently navigate to a
        // hard-coded example page on a non-conforming empty value — report
        // back an actionable failure instead.
        if (u === "") {
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reused: false, page: null, reason: 'ego_navigate: url is required' }))\n`;
        }
        // Reuse the current tab in this task space (select a real tab, then
        // navigate IN PLACE via page.goto) instead of opening a new tab every
        // time. This keeps the agent's tab count small across a task. If a
        // tab already shows the exact URL, we switch to it; otherwise we
        // navigate the active tab so we don't pile up tabs.
        // NOTE: ensureRealTab() already declares `__tabs`, so reuse it.
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `const __existing = __tabs.find(t => t.url.split('#')[0] === ${j(
            u.split("#")[0]
          )})\n` +
          `const tab = __existing ? await browser.switchTab(__existing.targetId) : await page.goto(${j(
            u
          )}, { wait: ${bool(args.wait, true)}, timeout: ${num(
            args.timeout,
            20_000
          )} })\n` +
          `const pginfo = await page.info()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, reused: !!__existing, page: pginfo }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_click",
      description:
        "Click an element in the current page. Target with a CSS selector, an xpath=.../loc=.../ref=@N value from ego_snapshot, or viewport coordinates.",
      parameters: {
        selector: {
          type: "string",
          description:
            "CSS selector, xpath=..., loc=..., or ref=@N from the snapshot. Required unless x/y are given.",
        },
        x: {
          type: "number",
          description: "Viewport x coordinate for a coordinate click.",
        },
        y: {
          type: "number",
          description: "Viewport y coordinate for a coordinate click.",
        },
        label: {
          type: "string",
          description:
            'Short human label for the action, e.g. "click submit button".',
        },
        double: {
          type: "boolean",
          description:
            "Double-click instead of single-click. Useful for opening files/rows or triggering dblclick handlers.",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, "");
        const x = args.x;
        const y = args.y;
        if (sel === "" && !(typeof x === "number" && typeof y === "number")) {
          throw new Error(
            "ego_click: provide either `selector` (CSS/xpath/loc/ref from ego_snapshot) or both `x` and `y` viewport coordinates"
          );
        }
        const dbl = bool(args.double, false);
        let action;
        if (sel !== "") {
          const labelOpt =
            str(args.label, "") !== ""
              ? `{ label: ${j(str(args.label, ""))} }`
              : "";
          action = dbl
            ? `await page.locator(${j(sel)}).dblclick(${labelOpt})`
            : `await page.locator(${j(sel)}).click(${labelOpt})`;
        } else {
          action = dbl
            ? `await page.mouse.dblclick(${x}, ${y})`
            : `await page.mouse.click(${x}, ${y})`;
        }
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `${action}\n` +
          `const pginfo = await page.info()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, double: ${dbl}, page: pginfo }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_fill",
      description:
        "Type text into an input field. Target with a CSS selector, xpath=..., loc=..., or ref=@N from ego_snapshot.",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description:
            "CSS selector, xpath=..., loc=..., or ref=@N for the input.",
        },
        text: {
          type: "string",
          required: true,
          description: "Text to type into the field.",
        },
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
        `await page.locator(${j(str(args.selector, ""))}).fill(${j(
          str(args.text, "")
        )})\n` +
        `const pginfo = await page.info()\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`,
    })
  );
  reg(
    t({
      name: "ego_js",
      description:
        'Evaluate a JavaScript expression in the current page and return its JSON-serializable value (e.g. "document.title", "document.querySelectorAll(\'a\').length").',
      parameters: {
        expression: {
          type: "string",
          required: true,
          description: "JavaScript expression string to evaluate in the page.",
        },
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
        `${SAFE_FN}` +
        `const result = await page.evaluate(${j(str(args.expression, ""))})\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`,
    })
  );
  reg(
    t({
      name: "ego_cdp",
      description:
        'Issue a raw CDP command on the page target, e.g. cdp("Page.handleJavaScriptDialog", { accept: true }).',
      parameters: {
        method: {
          type: "string",
          required: true,
          description: "CDP method name, e.g. Page.handleJavaScriptDialog.",
        },
        params: {
          type: "object",
          additionalProperties: true,
          description: "CDP method parameters object.",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const params = args.params;
        const call =
          params !== undefined && params !== null
            ? `await cdp(${j(str(args.method, ""))}, ${j(params)})`
            : `await cdp(${j(str(args.method, ""))})`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `${SAFE_FN}` +
          `const result = ${call}\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_screenshot",
      description:
        "Capture a screenshot of the current page (or of a single element if selector is given). Returns the file path of the saved PNG, which you can then read with a vision/image tool.",
      parameters: {
        selector: {
          type: "string",
          description:
            "Optional CSS selector of an element to screenshot instead of the whole page.",
        },
        path: {
          type: "string",
          description: "Optional absolute output path for the PNG.",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, "");
        const pth = str(args.path, "");
        const shot =
          sel !== ""
            ? `await page.locator(${j(sel)}).screenshot(${pth ? `{ path: ${j(pth)} }` : ""})`
            : `await page.screenshot(${pth ? `{ path: ${j(pth)} }` : ""})`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `const path = ${shot}\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_page_info",
      description:
        "Return the current page info: url, title, viewport size (w, h), scroll offsets (sx, sy), device metrics (pw, ph), and whether a native dialog is open. Also reports `humanCheck` — whether a CAPTCHA / human-verification challenge is detected on the page (so the agent can alert the user to complete it).",
      parameters: {
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
        `const pginfo = await page.info()\n` +
        `let __hc = null\n` +
        `try { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}).catch(() => null); } catch { __hc = null }\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo, humanCheck: __hc }))\n`,
    })
  );
  reg(
    t({
      name: "ego_wait",
      description:
        "Pause for a fixed number of milliseconds (e.g. for animations or partial loads). For load waits prefer ego_navigate's wait option.",
      parameters: {
        ms: {
          type: "number",
          required: true,
          description: "Milliseconds to wait.",
        },
      },
      buildScript: (args) =>
        `await page.waitForTimeout(${Math.max(0, num(args.ms, 1000))})\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, waitedMs: ${Math.max(
          0,
          num(args.ms, 1000)
        )} }))\n`,
    })
  );
  reg(
    t({
      name: "ego_wait_for_selector",
      description:
        "Wait until an element matching a CSS selector appears (state=visible, default) or disappears (state=hidden). Use instead of a blind fixed wait when a page renders asynchronously.",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description:
            "CSS selector of the element to wait for, e.g. '.results' or '[data-id=done]'.",
        },
        state: {
          type: "string",
          description:
            "Target state: 'visible' (default) | 'attached' | 'hidden' | 'detached'.",
        },
        timeout: {
          type: "number",
          description: "How long to wait in ms (default 10000).",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, "").trim();
        if (sel === "")
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, waited: false, reason: 'ego_wait_for_selector: selector is required' }))\n`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `await page.waitForSelector(${j(sel)}, { state: ${j(
            str(args.state, "visible")
          )}, timeout: ${num(args.timeout, 10000)} })\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, waited: true, selector: ${j(
            sel
          )}, state: ${j(str(args.state, "visible"))} }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_wait_for_url",
      description:
        "Wait until the page navigates to a URL matching a substring / glob / regex. Use to catch login redirects or pagination.",
      parameters: {
        pattern: {
          type: "string",
          required: true,
          description:
            "URL/glob to match (e.g. '/login?done', 'https://*/post/*', or a /regex/).",
        },
        timeout: {
          type: "number",
          description: "How long to wait in ms (default 10000).",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const p = str(args.pattern, "").trim();
        if (p === "")
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reached: false, reason: 'ego_wait_for_url: pattern is required' }))\n`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `const __ok = await page.waitForURL(${j(p)}, { timeout: ${num(
            args.timeout,
            10000
          )} }).catch(() => false)\n` +
          `const __u = await page.url()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: !!__ok, reached: !!__ok, url: __u }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_wait_for_response",
      description:
        "Wait for a network response matching a URL/glob/regex and return it. Optionally return the body (text or JSON) — ideal for scraping API responses or confirming a submission.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description:
            "URL/glob/regex to match, e.g. '/api/search' or 'https://*.com/data'.",
        },
        timeout: {
          type: "number",
          description: "How long to wait in ms (default 10000).",
        },
        body: {
          type: "string",
          description:
            "Return the response body: 'none' (default) | 'text' | 'json'.",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const u = str(args.url, "").trim();
        const mode = str(args.body, "none");
        const wantBody = mode === "text" || mode === "json";
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `const __res = await page.waitForResponse(${j(u)}, { timeout: ${num(
            args.timeout,
            10000
          )} })\n` +
          `${wantBody ? `const __body = ${mode === "json" ? "await __res.json().catch(()=>null)" : "await __res.text().catch(()=>null)"}\n` : ""}` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, url: __res.url(), status: __res.status()${wantBody ? ", body: __body" : ""} }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_key",
      description:
        "Press a keyboard key or shortcut combination on the current page, e.g. 'Enter', 'Tab', 'Control+a', 'Escape', 'ArrowDown'. Useful for forms, shortcuts and navigation. Pass `text` to type a string of characters instead (keyboard.type).",
      parameters: {
        key: {
          type: "string",
          description:
            "Key or combo: 'Enter', 'Tab', 'Control+c', 'Meta+v', 'ArrowDown', 'Escape', 'F5', etc. (ignored when `text` is given).",
        },
        text: {
          type: "string",
          description:
            "Type this text character-by-character (keyboard.type). Use instead of `key` for typing words into the focused element.",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const txt = str(args.text, "");
        const k = str(args.key, "").trim();
        if (txt !== "") {
          return (
            `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
            `await page.keyboard.type(${j(txt)})\n` +
            `console.log('${SENTINEL}' + JSON.stringify({ ok: true, typed: ${j(txt)} }))\n`
          );
        }
        if (k === "")
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_key: provide key or text to type' }))\n`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `await page.keyboard.press(${j(k)})\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, key: ${j(k)} }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_hover",
      description:
        "Move the pointer over an element (CSS selector / ref) or to viewport coordinates. Triggers CSS :hover, dropdowns and mouseenter handlers.",
      parameters: {
        selector: {
          type: "string",
          description: "CSS selector, xpath=..., loc=..., or ref=@N for the element.",
        },
        x: { type: "number", description: "Viewport x (only with y)." },
        y: { type: "number", description: "Viewport y (only with x)." },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, "");
        const hasXY = typeof args.x === "number" && typeof args.y === "number";
        if (sel === "" && !hasXY)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_hover: provide selector or both x and y' }))\n`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          (sel !== ""
            ? `await page.locator(${j(sel)}).hover()\n`
            : `await page.mouse.move(${args.x}, ${args.y})\n`) +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_read_element",
      description:
        "Read a single element (by selector): its text, HTML, input value, an attribute, or visibility/enabled/count. Cheaper and more precise than a full-page snapshot.",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description: "CSS selector of the target element.",
        },
        what: {
          type: "string",
          description:
            "What to read: 'text' (default) | 'html' | 'value' | 'attribute' | 'visible' | 'enabled' | 'count'.",
        },
        attribute: {
          type: "string",
          description: "Attribute name when what=attribute.",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.selector, "").trim();
        const what = str(args.what, "text");
        if (sel === "")
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_read_element: selector is required' }))\n`;
        const selExpr = `page.locator(${j(sel)})`;
        let expr;
        switch (what) {
          case "html": expr = `await ${selExpr}.innerHTML()`; break;
          case "value": expr = `await ${selExpr}.inputValue()`; break;
          case "attribute": expr = `await ${selExpr}.getAttribute(${j(str(args.attribute, ""))})`; break;
          case "visible": expr = `await ${selExpr}.isVisible()`; break;
          case "enabled": expr = `await ${selExpr}.isEnabled()`; break;
          case "count": expr = `await ${selExpr}.count()`; break;
          default: expr = `await ${selExpr}.textContent()`;
        }
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `${SAFE_FN}` +
          `const __v = ${expr}\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, what: ${j(what)}, selector: ${j(
            sel
          )}, value: safe(__v) }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_select",
      description:
        "Choose an option in a <select> dropdown by value, label, or index (a single value or an array for multi-select).",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description: "CSS selector of the <select> element.",
        },
        value: {
          type: "json",
          description:
            "The option: a string value/label, or {value:'..'}, {label:'..'}, {index:n}, or an array of these for multi-select.",
        },
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
        `await page.locator(${j(str(args.selector, ""))}).selectOption(${j(
          args.value ?? ""
        )})\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, select: ${j(
          str(args.selector, "")
        )} }))\n`,
    })
  );
  reg(
    t({
      name: "ego_drag",
      description:
        "Drag an element to a target (Playwright dragTo) or drag the pointer through coordinates. Use for sliders, sortable rows, and drag-drop zones.",
      parameters: {
        from: {
          type: "string",
          description: "CSS selector of the element to drag from.",
        },
        to: {
          type: "string",
          description: "CSS selector of the drop target (used with from).",
        },
        points: {
          type: "array",
          items: { type: "number" },
          description:
            "Alternative: a flat list of [x1,y1,x2,y2,...] viewport coordinates to drag the mouse through.",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const pts = Array.isArray(args.points)
          ? args.points.map(Number).filter((n) => Number.isFinite(n))
          : [];
        const hasEl =
          str(args.from, "") !== "" && str(args.to, "") !== "";
        if (!hasEl && pts.length < 4)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_drag: provide from+to selectors, or at least 4 points (x1,y1,x2,y2)' }))\n`;
        const action = hasEl
          ? `await page.locator(${j(str(args.from, ""))}).dragTo(page.locator(${j(
              str(args.to, "")
            )}))\n`
          : `const __pts = ${j(pts)}\nconst __coords=[];for(let __i=0;__i<__pts.length;__i+=2){__coords.push([__pts[__i],__pts[__i+1]])}\nawait page.mouse.drag(__coords)\n`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          action +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_scroll",
      description:
        "Scroll the page: by pixel deltas (wheel), or bring an element into view (scrollIntoView).",
      parameters: {
        deltaX: { type: "number", description: "Horizontal scroll delta (wheel) in px." },
        deltaY: { type: "number", description: "Vertical scroll delta (wheel) in px." },
        selector: {
          type: "string",
          description: "CSS selector to scroll into view (primary if given).",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const hasSelector = str(args.selector, "") !== "";
        const hasDelta = Number.isFinite(args.deltaX) || Number.isFinite(args.deltaY);
        if (!hasSelector && !hasDelta)
          return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_scroll: provide deltaX/deltaY or a selector' }))\n`;
        const action = hasSelector
          ? `await page.locator(${j(str(args.selector, ""))}).scrollIntoViewIfNeeded()\n`
          : `await page.mouse.wheel(${num(args.deltaX, 0)}, ${num(
              args.deltaY,
              300
            )})\n`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          action +
          `const __p = await page.info()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, scrollX: __p.sx ?? null, scrollY: __p.sy ?? null }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_upload",
      description:
        "Set files on a file <input> element (path-driven). Use to upload a dataset/attachment from a local path.",
      parameters: {
        selector: {
          type: "string",
          required: true,
          description: "CSS selector of the <input type=file> element.",
        },
        path: {
          type: "string",
          required: true,
          description: "Absolute path of the file(s) to upload on this machine.",
        },
        space: spaceParam,
      },
      buildScript: (args) =>
        `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
        `await page.locator(${j(str(args.selector, ""))}).setInputFiles(${j(
          str(args.path, "")
        )})\n` +
        `console.log('${SENTINEL}' + JSON.stringify({ ok: true, upload: ${j(
          str(args.selector, "")
        )} }))\n`,
    })
  );
  reg(
    t({
      name: "ego_download",
      description:
        "Wait for a file download triggered by the current action, then return its saved path. Provide `triggerSelector` (a download button/link to click) or `triggerScript` (arbitrary JS that triggers the download). The file is captured into a temp dir and (optionally) copied to `savePath`. Returns { path, suggestedFilename, url }.",
      parameters: {
        triggerSelector: {
          type: "string",
          description:
            "CSS selector of the element (button/link) whose click starts the download.",
        },
        triggerScript: {
          type: "string",
          description:
            "Full JS snippet that triggers the download (e.g. window.open() or a fetch-to-blob download); runs in the page before waiting for the download.",
        },
        savePath: {
          type: "string",
          description:
            "Optional absolute destination path to also copy the downloaded file to. Otherwise only the temp-captured path is returned.",
        },
        timeout: {
          type: "number",
          description: "How long to wait for the download in ms (default 30000).",
        },
        space: spaceParam,
      },
      buildScript: (args) => {
        const sel = str(args.triggerSelector, "");
        const script = str(args.triggerScript, "");
        const savePath = str(args.savePath, "");
        const timeout = num(args.timeout, 30000);
        const trigger =
          sel !== ""
            ? `await page.locator(${j(sel)}).click()\n`
            : script !== ""
              ? `await page.evaluate(() => { ${script} })\n`
              : "/* no trigger given — the download may be started by an earlier navigation */\n";
        const save =
          savePath !== ""
            ? `const __final = await __dl.saveAs(${j(savePath)}).catch(()=>null)\n`
            : `const __final = await __dl.path().catch(()=>null)\n`;
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `const __dlPromise = page.waitForEvent('download', { timeout: ${timeout} })\n` +
          trigger +
          `const __dl = await __dlPromise\n` +
          `const __name = typeof __dl.suggestedFilename === 'function' ? __dl.suggestedFilename() : null\n` +
          `const __url = typeof __dl.url === 'function' ? __dl.url() : null\n` +
          save +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path: __final, suggestedFilename: __name, url: __url }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_check",
      description:
        "Check (tick) or uncheck a checkbox/radio element. Does nothing if already in the desired state.",
      parameters: {
        selector: { type: "string", required: true, description: "CSS selector of the checkbox/radio." },
        checked: { type: "boolean", description: "true=check (default), false=uncheck." },
        space: spaceParam,
      },
      buildScript: (args) => {
        const chk = bool(args.checked, true);
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `await page.locator(${j(str(args.selector, ""))}).${chk ? "check" : "uncheck"}()\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, checked: ${chk} }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_dialog",
      description:
        "Accept or dismiss a native browser dialog (alert/confirm/prompt), optionally supplying text for a prompt. Use right after the action that triggers the dialog.",
      parameters: {
        accept: { type: "boolean", description: "true=Accept/OK (default), false=Dismiss/Cancel." },
        text: { type: "string", description: "Text to type into a prompt dialog." },
        space: spaceParam,
      },
      buildScript: (args) => {
        const accept = bool(args.accept, true);
        const text = str(args.text, "");
        const params = `{ accept: ${accept}${
          text !== "" ? `, promptText: ${j(text)}` : ""
        } }`;
        // Do NOT run any page.evaluate here: while a dialog is showing the page
        // JS is paused, so a Runtime.evaluate would hang. handleJavaScriptDialog
        // is a CDP command and works even under a blocking dialog.
        return (
          `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` +
          `const __r = await cdp("Page.handleJavaScriptDialog", ${params}).catch((e) => ({ error: String(e) }))\n` +
          `const __ok = !!(__r && !__r.error)\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, handled: __ok, accept: ${accept}, error: __r?.error ?? null }))\n`
        );
      },
    })
  );
  reg(
    t({
      name: "ego_http",
      description:
        "Make an HTTP request and return status + body. Default runs in the agent page's browser context (cross-origin allowed when the server's CORS permits); set `mode: server` to use Node-side fetch.server. Use to scrape an API, POST data, or hit a service. (Note: on the vendored ego-linux Windows runtime, fetch.server can hit a libuv crash, so prefer the default browser mode there.)",
      parameters: {
        url: { type: "string", required: true, description: "Absolute URL to request." },
        method: { type: "string", description: "HTTP method, default GET." },
        headers: { type: "object", additionalProperties: true, description: "Request headers, e.g. { 'Content-Type': 'application/json' }." },
        body: { type: "string", description: "Request body (for POST/PUT)." },
        timeout: { type: "number", description: "Timeout in ms (default 20000)." },
        mode: { type: "string", description: "'browser' (default) runs via the page context; 'server' uses Node-side fetch.server." },
        space: spaceParam,
      },
      buildScript: (args) => {
        const opts = {
          method: str(args.method, "GET"),
          headers: args.headers && typeof args.headers === "object" ? args.headers : {},
          timeout: num(args.timeout, 20000),
        };
        if (str(args.body, "") !== "") opts.body = str(args.body, "");
        const mode = str(args.mode, "browser");
        const pre = mode === "server" ? "" : `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}`;
        return (
          `${pre}${SAFE_FN}` +
          `const __r = await fetch.${mode === "server" ? "server" : "browser"}(${j(
            str(args.url, "")
          )}, ${j(opts)})\n` +
          `const __status = typeof __r.status !== "undefined" ? __r.status : 200\n` +
          `let __body = null\n` +
          `try { __body = typeof __r.text === "function" ? await __r.text() : (typeof __r === "string" ? __r : JSON.stringify(safe(__r))) } catch { __body = null }\n` +
          `console.log('${SENTINEL}' + JSON.stringify({ ok: true, mode: ${j(mode)}, status: __status, body: __body, url: ${j(
            str(args.url, "")
          )} }))\n`
        );
      },
    })
  );
  reg(
    (() => {
      const def = defineTool({
        name: "ego_cli",
        description:
          "Escape hatch: run an arbitrary `ego-browser nodejs` heredoc script verbatim (facades page/browser/taskSpaces/site/fetch and the raw cdp() are preloaded). Use when the structured ego_* tools do not cover the task. Returns raw stdout plus the parsed console.log payload when present.",
        parameters: {
          script: {
            type: "string",
            required: true,
            description:
              "Full JS script body for the heredoc; ego-browser helpers are preloaded. End with console.log(JSON.stringify(...)) for a parseable sentinel payload.",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              stdout: { type: "string", required: true },
              stderr: { type: "string" },
              result: { type: "json" },
            },
          },
          render: renderText,
        },
        timeoutMs: TOOL_TIMEOUT_MS,
        execute: async (args, exec) => {
          const script = str(args.script, "");
          const result = await withWarmupRetry(() =>
            runEgoScript(ctx.subprocess, script, exec, cfg)
          );
          if (!result.ok) throw new Error(result.error);
          const parsed = parseSentinel(result.stdout);
          return {
            ok: true,
            stdout: result.stdout,
            stderr: result.stderr,
            result: parsed ?? null,
          };
        },
        presentCall: () => ({
          card: "generic",
          title: "ego_cli",
          kind: "other",
          rawInput: null,
        }),
      });
      return def;
    })()
  );
}

// ── ego_help: built-in tool / category index ───────────────────────────────
/** Register ego_help / ego_doctor / ego_script. */
function registerHelpAndDoctor(ctx, cfg, reg) {
  reg(
    defineTool({
      name: "ego_captcha",
      description:
        "Check the current page for a human-verification (CAPTCHA) challenge — reCAPTCHA / hCaptcha / Cloudflare / Turnstile — and return { detected, kind }. If detected=true, ALERT THE USER that they must complete the verification in the 'ego lite - agent' browser window (it is the same live session shown in the watch panel), then continue after they have.",
      parameters: {
        space: { type: "string", description: "Task-space name or numeric id; defaults to the configured defaultSpace." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            detected: { type: "boolean", required: true },
            kind: { oneOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        render: renderText,
      },
      timeoutMs: 15_000,
      execute: async (args, exec) =>
        withEgoLock(async () => {
          const result = await withWarmupRetry(() =>
            runEgoScript(
              ctx.subprocess,
              humanCheckScript(str(args.space, cfg.defaultSpace)),
              { signal: exec?.signal },
              cfg
            )
          );
          if (!result.ok)
            return { ok: false, detected: false, kind: null, error: result.error };
          const p = parseSentinel(result.stdout) || {};
          return {
            ok: true,
            detected: !!p.humanCheck?.detected,
            kind: p.humanCheck?.kind ?? null,
          };
        }),
      presentCall: () => ({ card: "generic", title: "ego_captcha", kind: "other", rawInput: null }),
    })
  );
  reg(
    defineTool({
      name: "ego_help",
      description:
        "Query the built-in ego-browser tool guide. `topic` may be a category (overview/tools/navigate/observe/input/keyboard-mouse/form/wait/network/login/script/doctor) or a specific tool name (e.g. ego_click). Returns the matching usage notes. Call this when unsure which eyebrow tool to use.",
      parameters: {
        topic: {
          type: "string",
          description:
            "Category or tool name to look up; omitted/all returns the overview index.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            topic: { type: "string", required: true },
            text: { type: "string", required: true },
          },
        },
        render: renderText,
      },
      timeoutMs: 10_000,
      execute: async (args) => {
        const q = str(args.topic, "").trim().toLowerCase();
        const key = Object.prototype.hasOwnProperty.call(EGO_HELP_INDEX, q) ? q : "";
        const text = key
          ? EGO_HELP_INDEX[key]
          : (q
              ? `未找到 topic "${q}"。可用: ` +
                Object.keys(EGO_HELP_INDEX)
                  .filter((k) => k !== "overview")
                  .join(", ") +
                "\n\noverview: " +
                EGO_HELP_INDEX.overview
              : EGO_HELP_INDEX.overview);
        return { ok: true, topic: q || "overview", text };
      },
      presentCall: () => ({ card: "generic", title: "ego_help", kind: "other", rawInput: null }),
    })
  );
  reg(
    defineTool({
      name: "ego_doctor",
      description:
        "Preflight the ego-browser environment: vendored runtime present, Chrome/Edge/Brave candidates, state dir, CDP/browser.json, ego-cast worker, task spaces. Run first when the browser fails to start (update, reboot, port conflict) or before a long session.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, report: { type: "string", required: true } },
        },
        render: renderText,
      },
      timeoutMs: 25_000,
      execute: async () => {
        const lines = [];
        // vendored runtime
        lines.push(`egoBin: ${cfg.egoBin}`);
        try { lines.push(`egoBin exists: ${existsSync(cfg.egoBin)}`); } catch { lines.push("egoBin exists: n/a"); }
        // Chrome candidates
        const chrome = findChromeBinary();
        const configured = cfg.chromePath;
        if (configured) {
          lines.push(`browser binary: ${configured} (from settings)`);
        } else {
          lines.push(`browser binary: ${chrome || "(none found — set chromePath in settings, or set EGO_LINUX_CHROME, or install Chrome/Edge/Brave)"}`);
        }
        // state dir + runtime state
        const isWin = process.platform === "win32";
        const e = process.env;
        const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
        const stateDir =
          e.EGO_LINUX_STATE_DIR ||
          (isWin
            ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux"
            : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
        lines.push(`state dir: ${stateDir} (exists: ${existsSync(stateDir)})`);
        const bjson = `${stateDir}/browser.json`;
        let browserReport = "browser.json: (none — agent browser not running)";
        if (existsSync(bjson)) {
          try {
            const { readFile } = await import("node:fs/promises");
            const b = JSON.parse(await readFile(bjson, "utf8"));
            const alive = b.pid ? await (async () => { try { process.kill(b.pid, 0); return true; } catch (x) { return x?.code === "EPERM"; } })() : false;
            browserReport = `browser.json: port=${b.port} pid=${b.pid} alive=${alive} headless=${b.headless}`;
          } catch (err) {
            browserReport = `browser.json: unreadable (${err?.message})`;
          }
        }
        lines.push(browserReport);
        // task spaces
        const tjson = `${stateDir}/task-spaces.json`;
        if (existsSync(tjson)) {
          try {
            const { readFile } = await import("node:fs/promises");
            const t = JSON.parse(await readFile(tjson, "utf8"));
            lines.push(`task spaces: ${(t.spaces || []).length}`);
          } catch {}
        }
        lines.push("headless override: " + (e.EGO_LINUX_HEADLESS ? "yes (" + e.EGO_LINUX_HEADLESS + ")" : "no"));
        lines.push("npm/node: " + process.version);
        return { ok: true, report: lines.join("\n") };
      },
      presentCall: () => ({ card: "generic", title: "ego_doctor", kind: "other", rawInput: null }),
    })
  );
  reg(
    (() => {
      const def = defineTool({
        name: "ego_script",
        description:
          "Run an arbitrary `ego-browser nodejs` heredoc script in ONE invocation (same runtime/API as ego_cli: page/…locator/browser/taskSpaces/site/fetch/cdp preloaded), and return structured {ok, stdout, stderr, result, durationMs, timedOut}. Use for a full multi-step browser task as a single script.",
        parameters: {
          script: {
            type: "string",
            required: true,
            description:
              "Full JS script body; end with console.log(JSON.stringify(...)) for a parseable sentinel payload.",
          },
          timeoutMs: { type: "integer", description: "Per-run timeout in ms (default plugin grace)." },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              stdout: { type: "string", required: true },
              stderr: { type: "string" },
              result: { type: "json" },
              durationMs: { type: "integer" },
              timedOut: { type: "boolean" },
              error: { type: "string" },
            },
          },
          render: renderText,
        },
        timeoutMs: TOOL_TIMEOUT_MS,
        execute: async (args, exec) => {
          const script = str(args.script, "");
          // Honor the documented per-run timeout override (integer ms). Falls
          // back to the plugin's default grace when absent/invalid.
          const timeoutMs =
            typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
              ? args.timeoutMs
              : undefined;
          const start = Date.now();
          const result = await withWarmupRetry(() =>
            runEgoScript(ctx.subprocess, script, exec, cfg, timeoutMs)
          );
          const durationMs = Date.now() - start;
          if (!result.ok)
            return { ok: false, stdout: result.stdout, stderr: result.stderr, durationMs, timedOut: false, error: result.error };
          const parsed = parseSentinel(result.stdout);
          return {
            ok: true,
            stdout: result.stdout,
            stderr: result.stderr,
            result: parsed ?? null,
            durationMs,
            timedOut: false,
          };
        },
        presentCall: () => ({ card: "generic", title: "ego_script", kind: "other", rawInput: null }),
      });
      return def;
    })()
  );
}
