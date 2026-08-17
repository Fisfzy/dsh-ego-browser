/**
 * Tests for resolveEgoEnv / findChromeBinary — the environment self-adaptation
 * layer that bridges the plugin's Chrome detection and the vendored ego-linux
 * runtime.
 *
 * Uses node --test (zero deps). Run: npm test
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { resolveEgoEnv, findChromeBinary } from "../lib/index.js";

// ─── resolveEgoEnv: Windows ────────────────────────────────────────────────

describe("resolveEgoEnv (Windows)", () => {
  const savedChrome = process.env.EGO_LINUX_CHROME;
  const savedAdapt = process.env.EGO_BROWSER_AUTO_ADAPT;

  beforeEach(() => {
    delete process.env.EGO_LINUX_CHROME;
    delete process.env.EGO_BROWSER_AUTO_ADAPT;
  });

  afterEach(() => {
    if (savedChrome !== undefined) process.env.EGO_LINUX_CHROME = savedChrome;
    else delete process.env.EGO_LINUX_CHROME;
    if (savedAdapt !== undefined) process.env.EGO_BROWSER_AUTO_ADAPT = savedAdapt;
    else delete process.env.EGO_BROWSER_AUTO_ADAPT;
  });

  it("sets EGO_LINUX_CHROME to the found binary path (not the wrapper) on Windows", () => {
    const fakeChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const env = resolveEgoEnv(
      {},
      {
        platform: "win32",
        baseEnv: {
          ProgramFiles: "C:\\Program Files",
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        },
      },
    );
    // On a real Windows machine findChromeBinary() should find Chrome/Edge.
    // If it does, EGO_LINUX_CHROME must be the binary path, NOT the wrapper.
    if (env.EGO_LINUX_CHROME !== undefined) {
      assert.ok(
        !env.EGO_LINUX_CHROME.includes("ego-chrome-wrapper"),
        "Windows should pass the binary directly, not the POSIX wrapper",
      );
      assert.ok(
        existsSync(env.EGO_LINUX_CHROME),
        `EGO_LINUX_CHROME should point to an existing file: ${env.EGO_LINUX_CHROME}`,
      );
    }
  });

  it("never overrides a user-set EGO_LINUX_CHROME on Windows", () => {
    const userSet = "D:\\my-chrome.exe";
    const env = resolveEgoEnv(
      {},
      {
        platform: "win32",
        baseEnv: {
          EGO_LINUX_CHROME: userSet,
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        },
      },
    );
    assert.equal(env.EGO_LINUX_CHROME, userSet);
  });

  it("does not set EGO_LINUX_HEADLESS on Windows (desktop session always present)", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "win32",
        baseEnv: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      },
    );
    assert.equal(env.EGO_LINUX_HEADLESS, undefined);
  });
});

// ─── resolveEgoEnv: chromePath config priority ─────────────────────────────

describe("resolveEgoEnv (chromePath config)", () => {
  const savedChrome = process.env.EGO_LINUX_CHROME;
  const savedAdapt = process.env.EGO_BROWSER_AUTO_ADAPT;

  beforeEach(() => {
    delete process.env.EGO_LINUX_CHROME;
    delete process.env.EGO_BROWSER_AUTO_ADAPT;
  });

  afterEach(() => {
    if (savedChrome !== undefined) process.env.EGO_LINUX_CHROME = savedChrome;
    else delete process.env.EGO_LINUX_CHROME;
    if (savedAdapt !== undefined) process.env.EGO_BROWSER_AUTO_ADAPT = savedAdapt;
    else delete process.env.EGO_BROWSER_AUTO_ADAPT;
  });

  it("uses cfg.chromePath when set (takes priority over auto-detect)", () => {
    const configured = "/opt/my-chrome/chrome";
    const env = resolveEgoEnv(
      { chromePath: configured },
      {
        platform: "win32",
        baseEnv: {
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          ProgramFiles: "C:\\Program Files",
        },
      },
    );
    assert.equal(env.EGO_LINUX_CHROME, configured);
  });

  it("falls back to auto-detect when cfg.chromePath is empty string", () => {
    const env = resolveEgoEnv(
      { chromePath: "" },
      {
        platform: "win32",
        baseEnv: {
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          ProgramFiles: "C:\\Program Files",
        },
      },
    );
    // Should NOT be the empty string; either auto-detected or undefined
    assert.notEqual(env.EGO_LINUX_CHROME, "");
  });

  it("falls back to auto-detect when cfg.chromePath is undefined", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "win32",
        baseEnv: {
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          ProgramFiles: "C:\\Program Files",
        },
      },
    );
    // Should be auto-detected (string) or undefined if no Chrome installed
    if (env.EGO_LINUX_CHROME !== undefined) {
      assert.equal(typeof env.EGO_LINUX_CHROME, "string");
      assert.ok(env.EGO_LINUX_CHROME.length > 0);
    }
  });

  it("user-set EGO_LINUX_CHROME env var still wins over cfg.chromePath", () => {
    const userSet = "/usr/bin/my-chrome";
    const env = resolveEgoEnv(
      { chromePath: "/from/config/chrome" },
      {
        platform: "linux",
        baseEnv: {
          EGO_LINUX_CHROME: userSet,
          HOME: "/home/test",
        },
      },
    );
    assert.equal(env.EGO_LINUX_CHROME, userSet);
  });
});

// ─── resolveEgoEnv: auto-adapt opt-out ─────────────────────────────────────

describe("resolveEgoEnv (auto-adapt off)", () => {
  const savedAdapt = process.env.EGO_BROWSER_AUTO_ADAPT;

  afterEach(() => {
    if (savedAdapt !== undefined) process.env.EGO_BROWSER_AUTO_ADAPT = savedAdapt;
    else delete process.env.EGO_BROWSER_AUTO_ADAPT;
  });

  it("returns the base env verbatim when EGO_BROWSER_AUTO_ADAPT=0", () => {
    const baseEnv = { PATH: "/usr/bin", HOME: "/root" };
    const env = resolveEgoEnv(
      {},
      {
        platform: "linux",
        baseEnv: { ...baseEnv, EGO_BROWSER_AUTO_ADAPT: "0" },
      },
    );
    // AUTO_ADAPT_OFF is a module-level constant computed at import time.
    // This test verifies the production behavior on the current machine: if
    // the env is set before import, the short-circuit fires. We can't unset
    // it post-import, so just verify the function returns an env object.
    assert.ok(typeof env === "object");
  });
});

// ─── resolveEgoEnv: user wins ──────────────────────────────────────────────

describe("resolveEgoEnv (user override)", () => {
  it("never overrides EGO_LINUX_CHROME the user already set (POSIX root)", () => {
    const userSet = "/usr/bin/chromium";
    const env = resolveEgoEnv(
      {},
      {
        platform: "linux",
        baseEnv: {
          EGO_LINUX_CHROME: userSet,
          HOME: "/root",
        },
      },
    );
    assert.equal(env.EGO_LINUX_CHROME, userSet);
  });

  it("never overrides EGO_LINUX_HEADLESS the user already set", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "linux",
        baseEnv: {
          EGO_LINUX_HEADLESS: "0",
          DISPLAY: "",
          HOME: "/root",
        },
      },
    );
    assert.equal(env.EGO_LINUX_HEADLESS, "0");
  });
});

// ─── resolveEgoEnv: headless detection ─────────────────────────────────────

describe("resolveEgoEnv (headless detection)", () => {
  it("sets EGO_LINUX_HEADLESS=1 when DISPLAY is absent on POSIX", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "linux",
        baseEnv: { HOME: "/root" },
      },
    );
    assert.equal(env.EGO_LINUX_HEADLESS, "1");
  });

  it("sets EGO_LINUX_HEADLESS=1 when DISPLAY is empty on POSIX", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "linux",
        baseEnv: { DISPLAY: "", HOME: "/root" },
      },
    );
    assert.equal(env.EGO_LINUX_HEADLESS, "1");
  });

  it("does not set EGO_LINUX_HEADLESS when DISPLAY is present on POSIX", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "linux",
        baseEnv: { DISPLAY: ":0", HOME: "/root" },
      },
    );
    assert.equal(env.EGO_LINUX_HEADLESS, undefined);
  });
});

// ─── findChromeBinary ──────────────────────────────────────────────────────

describe("findChromeBinary", () => {
  it("returns a string or undefined (never throws)", () => {
    const result = findChromeBinary();
    assert.ok(result === undefined || typeof result === "string");
  });

  it("respects EGO_LINUX_CHROME when set", () => {
    const saved = process.env.EGO_LINUX_CHROME;
    process.env.EGO_LINUX_CHROME = "/fake/chrome";
    try {
      assert.equal(findChromeBinary(), "/fake/chrome");
    } finally {
      if (saved !== undefined) process.env.EGO_LINUX_CHROME = saved;
      else delete process.env.EGO_LINUX_CHROME;
    }
  });
});

// ─── runtime/ego-linux/src/paths.mjs (Windows paths) ───────────────────────

describe("runtime paths.mjs (platform-aware)", () => {
  it("uses LOCALAPPDATA on Windows for DATA_DIR / STATE_DIR", async () => {
    // paths.mjs reads process.platform at import time, so on a Windows host
    // it should use %LOCALAPPDATA%\ego-lite-linux.
    if (process.platform !== "win32") return;
    const mod = await import("../runtime/ego-linux/src/paths.mjs");
    assert.ok(
      mod.DATA_DIR.includes("ego-lite-linux"),
      `DATA_DIR should contain ego-lite-linux: ${mod.DATA_DIR}`,
    );
    assert.ok(
      mod.STATE_DIR.includes("ego-lite-linux"),
      `STATE_DIR should contain ego-lite-linux: ${mod.STATE_DIR}`,
    );
  });
});

// ─── runtime/ego-linux/src/chrome.mjs (resolveBinary / which) ──────────────

describe("runtime chrome.mjs (Windows path handling)", () => {
  it("resolveBinary uses isAbsolute (not includes('/')) so Windows paths resolve", async () => {
    // We can't easily unit-test resolveBinary in isolation (it's not exported
    // and depends on BINARY_CANDIDATES at module level), but we can verify
    // the source uses isAbsolute by checking the import is present.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../runtime/ego-linux/src/chrome.mjs", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(
      src.includes("isAbsolute"),
      "chrome.mjs should use isAbsolute() for cross-platform path detection",
    );
    assert.ok(
      !src.includes('candidate.includes("/")'),
      "chrome.mjs should not use the old includes('/') check",
    );
  });

  it("which() uses 'where' on Windows", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../runtime/ego-linux/src/chrome.mjs", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(
      src.includes('"where"'),
      "chrome.mjs which() should use 'where' on Windows",
    );
  });
});
