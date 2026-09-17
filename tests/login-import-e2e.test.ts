// Zero-risk e2e for login-import (issue #46): instead of touching real user
// profiles, we build a SYNTHETIC throwaway source profile — boot the genuine
// browser binary against it once, seed cookies over CDP (the browser itself
// ABE-encrypts them for that profile), close it, then run the real import
// pipeline against it via opts.browserOverride.
//
//   EGO_E2E=1        → dryRun + domain-filter phases
//   EGO_E2E_WRITE=1  → additionally write into the LIVE ego agent browser,
//                      assert via its CDP, then clean the test cookies out.
//
// Run: EGO_E2E=1 pnpm vitest run tests/login-import-e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn as cpSpawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importLoginCookies,
  detectSystemBrowsers,
  resolveEgoStateDir,
  parseDevToolsActivePort,
  type SystemBrowser,
} from "../src/login-import.ts";

const e2e = process.env.EGO_E2E === "1";
const stateDir = resolveEgoStateDir();
const egoRunning = existsSync(join(stateDir, "browser.json"));
const doWrite = e2e && process.env.EGO_E2E_WRITE === "1" && egoRunning;

const SEED_COOKIES = [
  { name: "import_test_a", value: "alpha-123", domain: ".import-test-a.example", path: "/", secure: false, httpOnly: false, expires: 2000000000 },
  { name: "import_test_b", value: "beta-456", domain: ".import-test-b.example", path: "/", secure: false, httpOnly: true, expires: 2000000000 },
];

/** Minimal CDP caller over the native WebSocket. */
async function cdpConnect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws failed")), { once: true });
  });
  let id = 0;
  const pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  ws.addEventListener("message", (ev: MessageEvent) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, unknown>; error?: { message?: string } }>((res) => {
      const i = ++id;
      pending.set(i, res as never);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { call, close: () => ws.close() };
}

async function bootHeadless(exePath: string, userDataDir: string, extraArgs: string[] = []) {
  const child = cpSpawn(exePath, [
    "--headless=new",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    ...extraArgs,
    "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(userDataDir, "DevToolsActivePort");
  let port: number | null = null;
  for (let i = 0; i < 60 && port === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { port = parseDevToolsActivePort(readFileSync(portFile, "utf8")); } catch { /* not yet */ }
  }
  if (port === null) throw new Error("no DevTools port from synthetic instance");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const cdp = await cdpConnect(version.webSocketDebuggerUrl);
  const close = async () => {
    try { await cdp.call("Browser.close"); } catch { /* ignore */ }
    cdp.close();
    await new Promise((r) => setTimeout(r, 1000));
  };
  return { child, cdp, close, port };
}

let hostBrowser: SystemBrowser | null = null;

beforeAll(() => {
  if (!e2e) return;
  const real = detectSystemBrowsers();
  if (real.length === 0) throw new Error("no system browser to act as the synthetic host");
  hostBrowser = real[0];
});

/**
 * Each test gets its OWN freshly seeded throwaway profile. Sharing one across
 * tests was flaky: a second headless boot on the same profile can refuse the
 * DevTools port while the previous instance's singleton (keyed on the
 * RESOLVED path) is still draining.
 */
async function makeSeededProfile(): Promise<{ browser: SystemBrowser; dir: string; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "ego-e2e-synthetic-"));
  const { cdp, close } = await bootHeadless(hostBrowser!.exePath, dir);
  await cdp.call("Storage.setCookies", { cookies: SEED_COOKIES });
  await close();
  const cleanup = async () => {
    for (let i = 0; i < 6; i++) {
      try { rmSync(dir, { recursive: true, force: true }); return } catch { await new Promise((r) => setTimeout(r, 1200)) }
    }
  };
  return { browser: { id: hostBrowser!.id, label: `${hostBrowser!.label} (synthetic)`, exePath: hostBrowser!.exePath, userDataDir: dir }, dir, cleanup };
}

describe("login-import e2e (synthetic source profile)", () => {
  it.skipIf(!e2e)("dryRun reads the seeded cookies via the genuine binary", async () => {
    const { browser, cleanup } = await makeSeededProfile();
    try {
      const report = await importLoginCookies(
        { browserOverride: browser, dryRun: true, timeoutMs: 25_000 },
        { subprocess: { spawn: spawnShim } },
      );
      expect(report.error).toBeUndefined();
      expect(report.ok).toBe(true);
      expect(report.totalRead).toBeGreaterThanOrEqual(SEED_COOKIES.length);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it.skipIf(!e2e)("domain filter selects only matching cookies", async () => {
    const { browser, cleanup } = await makeSeededProfile();
    try {
      const report = await importLoginCookies(
        { browserOverride: browser, domains: ["import-test-a.example"], dryRun: true, timeoutMs: 25_000 },
        { subprocess: { spawn: spawnShim } },
      );
      if (!report.ok) console.log("[e2e] filter report:", JSON.stringify(report));
      expect(report.ok).toBe(true);
      expect(report.matched).toBe(1);
      expect(report.domains).toEqual([{ domain: ".import-test-a.example", cookies: 1 }]);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it.skipIf(!e2e)("backup insurance snapshots the source store", async () => {
    const { browser, cleanup } = await makeSeededProfile();
    try {
      await importLoginCookies(
        { browserOverride: browser, dryRun: true, timeoutMs: 25_000 },
        { subprocess: { spawn: spawnShim } },
      );
      expect(existsSync(join(stateDir, "login-import-backups"))).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it.skipIf(!doWrite)("WRITE: seeded cookies land in the ego browser and are verifiable via its CDP", async () => {
    const { browser, cleanup } = await makeSeededProfile();
    try {
      const report = await importLoginCookies(
        { browserOverride: browser, dryRun: false, timeoutMs: 25_000 },
        { subprocess: { spawn: spawnShim } },
      );
      expect(report.error).toBeUndefined();
      expect(report.ok).toBe(true);
      expect(report.written).toBeGreaterThanOrEqual(SEED_COOKIES.length);

      // Verify through the ego browser's own cookie store, then clean up.
      const bj = JSON.parse(readFileSync(join(stateDir, "browser.json"), "utf8"));
      const version = await (await fetch(`http://127.0.0.1:${bj.port}/json/version`)).json() as { webSocketDebuggerUrl: string };
      const cdp = await cdpConnect(version.webSocketDebuggerUrl);
      try {
        const got = await cdp.call("Storage.getCookies");
        const names = new Set(((got.result?.cookies as { name: string }[]) || []).map((c) => c.name));
        expect(names.has("import_test_a")).toBe(true);
        expect(names.has("import_test_b")).toBe(true);
        await cdp.call("Storage.deleteCookies", { name: "import_test_a", domain: ".import-test-a.example" });
        await cdp.call("Storage.deleteCookies", { name: "import_test_b", domain: ".import-test-b.example" });
      } finally {
        cdp.close();
      }
    } finally {
      await cleanup();
    }
  }, 120_000);

  // REAL source browser (the machine's daily Chrome/Edge): gated behind
  // EGO_E2E_REAL=1. closeSource:true gracefully closes the user's browser —
  // only run this with the machine owner's consent. Writes into the live ego
  // browser (requires EGO_E2E_WRITE=1 too) so the transfer is verifiable.
  const doReal = e2e && process.env.EGO_E2E_REAL === "1";
  const realDomains = (process.env.EGO_E2E_REAL_DOMAINS || "bilibili.com").split(",").map((s) => s.trim()).filter(Boolean);
  it.skipIf(!doReal)("REAL: import from the machine's daily browser (closeSource)", async () => {
    const probe = await importLoginCookies(
      { source: (process.env.EGO_E2E_SOURCE as never) || "chrome", domains: realDomains, dryRun: true, closeSource: true, timeoutMs: 30_000 },
      { subprocess: { spawn: spawnShim } },
    );
    console.log("[real] probe:", JSON.stringify({ ok: probe.ok, matched: probe.matched, totalRead: probe.totalRead, closedSource: probe.closedSource, error: probe.error, domains: probe.domains }));
    expect(probe.error).toBeUndefined();
    expect(probe.ok).toBe(true);

    if (!doWrite) return;
    const report = await importLoginCookies(
      { source: (process.env.EGO_E2E_SOURCE as never) || "chrome", domains: realDomains, dryRun: false, closeSource: true, timeoutMs: 30_000 },
      { subprocess: { spawn: spawnShim } },
    );
    console.log("[real] write:", JSON.stringify({ ok: report.ok, written: report.written, matched: report.matched, error: report.error }));
    expect(report.ok).toBe(true);
  }, 180_000);
});

/** SpawnLike shim over node:child_process (mirrors ctx.subprocess semantics). */
function spawnShim(spec: { argv: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }) {
  const child = cpSpawn(spec.argv[0] as string, spec.argv.slice(1) as string[], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: "ignore",
  });
  return {
    done: new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (exitCode, signal) => resolve({ exitCode, signal: signal as NodeJS.Signals | null }));
      child.on("error", () => resolve({ exitCode: null, signal: null }));
    }),
  };
}

// Keep execFileSync referenced for future kill-fallbacks without lint noise.
void execFileSync;
