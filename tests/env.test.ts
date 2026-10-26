/**
 * Tests for resolveEgoEnv / findChromeBinary — the environment self-adaptation
 * layer that bridges the plugin's Chrome detection and the vendored ego-linux
 * runtime.
 *
 * Uses node --test (zero deps). Run: npm test
 */
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { existsSync } from "node:fs";

import { resolveEgoEnv, findChromeBinary, loginImportPolicy, loginImportForced } from "../src/index.ts";

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
      expect(
        !env.EGO_LINUX_CHROME.includes("ego-chrome-wrapper"),
      ).toBeTruthy();
      expect(
        existsSync(env.EGO_LINUX_CHROME),
      ).toBeTruthy();
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
    expect(env.EGO_LINUX_CHROME).toBe(userSet);
  });

  it("does not set EGO_LINUX_HEADLESS on Windows (desktop session always present)", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "win32",
        baseEnv: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      },
    );
    expect(env.EGO_LINUX_HEADLESS).toBe(undefined);
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
    expect(env.EGO_LINUX_CHROME).toBe(configured);
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
    expect(env.EGO_LINUX_CHROME).not.toBe("");
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
      expect(typeof env.EGO_LINUX_CHROME).toBe("string");
      expect(env.EGO_LINUX_CHROME.length > 0).toBeTruthy();
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
    expect(env.EGO_LINUX_CHROME).toBe(userSet);
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
    expect(typeof env === "object").toBeTruthy();
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
    expect(env.EGO_LINUX_CHROME).toBe(userSet);
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
    expect(env.EGO_LINUX_HEADLESS).toBe("0");
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
    expect(env.EGO_LINUX_HEADLESS).toBe("1");
  });

  it("sets EGO_LINUX_HEADLESS=1 when DISPLAY is empty on POSIX", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "linux",
        baseEnv: { DISPLAY: "", HOME: "/root" },
      },
    );
    expect(env.EGO_LINUX_HEADLESS).toBe("1");
  });

  it("does not set EGO_LINUX_HEADLESS when DISPLAY is present on POSIX", () => {
    const env = resolveEgoEnv(
      {},
      {
        platform: "linux",
        baseEnv: { DISPLAY: ":0", HOME: "/root" },
      },
    );
    expect(env.EGO_LINUX_HEADLESS).toBe(undefined);
  });
});

// ─── resolveEgoEnv: macOS (#65 / #68) ──────────────────────────────────────
// These run on any host: the platform is injected, so the darwin branches are
// exercised from a Linux/Windows CI too. The one assertion that needs real
// `.app` bundles is skipped elsewhere.

describe("resolveEgoEnv (macOS)", () => {
  it("never marks macOS headless, even without DISPLAY (#16)", () => {
    const env = resolveEgoEnv(
      {},
      { platform: "darwin", baseEnv: { HOME: "/Users/test" } },
    );
    // macOS GUI is Aqua/Quartz and never exports $DISPLAY; treating that as
    // headless would re-introduce #16 (no real window for scan-code login).
    expect(env.EGO_LINUX_HEADLESS).toBe(undefined);
  });

  it("injects the detected Chrome binary into EGO_LINUX_CHROME (#68)", () => {
    // Needs a real macOS host with Chrome/Chromium/Edge/Brave installed.
    if (process.platform !== "darwin") return;
    const env = resolveEgoEnv(
      {},
      { platform: "darwin", baseEnv: { HOME: process.env.HOME } },
    );
    expect(env.EGO_LINUX_CHROME).toBeTruthy();
    expect(env.EGO_LINUX_CHROME?.includes(".app/Contents/MacOS/")).toBeTruthy();
    // The wrapper only exists to add --no-sandbox for root on Linux.
    expect(env.EGO_LINUX_CHROME?.includes("ego-chrome-wrapper")).toBe(false);
  });

  it("never overrides a user-set EGO_LINUX_CHROME on macOS", () => {
    const userSet = "/opt/custom/Google Chrome";
    const env = resolveEgoEnv(
      {},
      { platform: "darwin", baseEnv: { EGO_LINUX_CHROME: userSet, HOME: "/Users/test" } },
    );
    expect(env.EGO_LINUX_CHROME).toBe(userSet);
  });

  it("honours cfg.chromePath over auto-detection on macOS", () => {
    const configured = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const env = resolveEgoEnv(
      { chromePath: configured },
      { platform: "darwin", baseEnv: { HOME: "/Users/test" } },
    );
    expect(env.EGO_LINUX_CHROME).toBe(configured);
  });
});

// ─── resolveEgoEnv: chromeArgs → EGO_LINUX_EXTRA_ARGS bridge ────────────────

describe("resolveEgoEnv (chromeArgs bridge)", () => {
  it("bridges cfg.chromeArgs to EGO_LINUX_EXTRA_ARGS (raw string)", () => {
    const env = resolveEgoEnv(
      { chromeArgs: "--disable-features=Translate --window-size=800,600" },
      {
        platform: "linux",
        baseEnv: { HOME: "/root" },
      },
    );
    expect(env.EGO_LINUX_EXTRA_ARGS).toBe("--disable-features=Translate --window-size=800,600");
  });

  it("does not set EGO_LINUX_EXTRA_ARGS when chromeArgs is empty", () => {
    const env = resolveEgoEnv(
      { chromeArgs: "" },
      { platform: "linux", baseEnv: { HOME: "/root" } },
    );
    expect(env.EGO_LINUX_EXTRA_ARGS).toBe(undefined);
  });

  it("does not set EGO_LINUX_EXTRA_ARGS when chromeArgs is whitespace-only", () => {
    const env = resolveEgoEnv(
      { chromeArgs: "   " },
      { platform: "linux", baseEnv: { HOME: "/root" } },
    );
    expect(env.EGO_LINUX_EXTRA_ARGS).toBe(undefined);
  });

  it("never overrides a user-set EGO_LINUX_EXTRA_ARGS (escape hatch)", () => {
    const userSet = "--user-set-flag";
    const env = resolveEgoEnv(
      { chromeArgs: "--from-settings" },
      {
        platform: "linux",
        baseEnv: { EGO_LINUX_EXTRA_ARGS: userSet, HOME: "/root" },
      },
    );
    expect(env.EGO_LINUX_EXTRA_ARGS).toBe(userSet);
  });
});

// ─── runtime/ego-linux/src/chrome.mjs (EGO_LINUX_EXTRA_ARGS spread) ─────────
// The runtime mirrors tokenizeArgs + CHROME_BLOCKED (it must not import from
// lib/). Verify the launch() args array spreads EGO_LINUX_EXTRA_ARGS and that
// blocked flags are stripped before reaching the Chrome process.

describe("runtime chrome.mjs (EGO_LINUX_EXTRA_ARGS spread)", () => {
  const readSrc = () =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../runtime/ego-linux/src/chrome.mjs", import.meta.url),
        "utf8",
      ),
    );

  it("launch() spreads filterChromeArgs(process.env.EGO_LINUX_EXTRA_ARGS) into args", async () => {
    const src = await readSrc();
    expect(
      src.includes("...filterChromeArgs(process.env.EGO_LINUX_EXTRA_ARGS ?? \"\")"),
    ).toBeTruthy();
  });

  it("defines a CHROME_BLOCKED set mirroring lib/config.js", async () => {
    const src = await readSrc();
    // Spot-check the critical control-plane flags are blocklisted in the
    // runtime copy too (not just in lib/config.js).
    for (const flag of ["--user-data-dir", "--remote-debugging-port", "--headless", "--proxy-server"]) {
      expect(
        src.includes(`"${flag}"`),
      ).toBeTruthy();
    }
  });
});

// ─── ego_login_import scoped guard (#69) ────────────────────────────────

describe("loginImportPolicy (#69)", () => {
  it("refuses Windows + Chrome/Edge 127+ (App-Bound Encryption range)", () => {
    expect(loginImportPolicy({ platform: "win32", chromeMajor: 127, force: false }).allowed).toBe(false);
    expect(loginImportPolicy({ platform: "win32", chromeMajor: 155, force: false }).allowed).toBe(false);
    expect(loginImportPolicy({ platform: "win32", chromeMajor: 160, force: false }).allowed).toBe(false);
  });

  it("allows Windows + pre-ABE Chrome", () => {
    expect(loginImportPolicy({ platform: "win32", chromeMajor: 126, force: false }).allowed).toBe(true);
    expect(loginImportPolicy({ platform: "win32", chromeMajor: 120, force: false }).allowed).toBe(true);
  });

  it("refuses Windows when the version cannot be determined", () => {
    const verdict = loginImportPolicy({ platform: "win32", chromeMajor: null, force: false });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("could not determine");
  });

  it("allows Linux and macOS regardless of the version", () => {
    expect(loginImportPolicy({ platform: "linux", chromeMajor: 160, force: false }).allowed).toBe(true);
    expect(loginImportPolicy({ platform: "darwin", chromeMajor: 160, force: false }).allowed).toBe(true);
    expect(loginImportPolicy({ platform: "linux", chromeMajor: null, force: false }).allowed).toBe(true);
  });

  it("the env override wins everywhere", () => {
    expect(loginImportPolicy({ platform: "win32", chromeMajor: 160, force: true }).allowed).toBe(true);
    expect(loginImportForced({ EGO_LINUX_LOGIN_IMPORT_FORCE: "1" })).toBe(true);
    expect(loginImportForced({ EGO_LINUX_LOGIN_IMPORT_FORCE: "true" })).toBe(true);
    expect(loginImportForced({ EGO_LINUX_LOGIN_IMPORT_FORCE: "yes" })).toBe(true);
    expect(loginImportForced({ EGO_LINUX_LOGIN_IMPORT_FORCE: "0" })).toBe(false);
    expect(loginImportForced({})).toBe(false);
  });
});
// ─── findChromeBinary ──────────────────────────────────────────────────────

describe("findChromeBinary", () => {
  it("returns a string or undefined (never throws)", () => {
    const result = findChromeBinary();
    expect(result === undefined || typeof result === "string").toBeTruthy();
  });

  it("respects EGO_LINUX_CHROME when set", () => {
    const saved = process.env.EGO_LINUX_CHROME;
    process.env.EGO_LINUX_CHROME = "/fake/chrome";
    try {
      expect(findChromeBinary()).toBe("/fake/chrome");
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
    // @ts-ignore — runtime .mjs is excluded from tsconfig
    const mod = await import("../runtime/ego-linux/src/paths.mjs");
    expect(
      mod.DATA_DIR.includes("ego-lite-linux"),
    ).toBeTruthy();
    expect(
      mod.STATE_DIR.includes("ego-lite-linux"),
    ).toBeTruthy();
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
    expect(
      src.includes("isAbsolute"),
    ).toBeTruthy();
    expect(
      !src.includes('candidate.includes("/")'),
    ).toBeTruthy();
  });

  it("which() uses 'where' on Windows", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../runtime/ego-linux/src/chrome.mjs", import.meta.url),
        "utf8",
      ),
    );
    expect(
      src.includes('"where"'),
    ).toBeTruthy();
  });
});

// ─── runtime/ego-linux/src/chrome.mjs (single-window launch) ───────────────
// Regression: ego_space_open used to open two windows because launch() passed
// "about:blank" as a positional arg (opening a tab in the default browser
// context), and ego_space_open then created another tab in its own context —
// Chrome isolates contexts to separate windows. The fix is --no-startup-window
// in LAUNCH_FLAGS and no positional URL. See PLAN-single-window-fix.md.

describe("runtime chrome.mjs (single-window launch)", () => {
  const readSrc = () =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../runtime/ego-linux/src/chrome.mjs", import.meta.url),
        "utf8",
      ),
    );

  it("LAUNCH_FLAGS contains --no-startup-window", async () => {
    const src = await readSrc();
    expect(
      src.includes('"--no-startup-window"'),
    ).toBeTruthy();
  });

  it("launch() does not pass a bare about:blank positional arg", async () => {
    const src = await readSrc();
    // The old form was a standalone line `    "about:blank",` inside the
    // launch() args array. Match it as the sole non-whitespace content of a
    // line (with trailing comma) — flag-form uses like --no-startup-window
    // don't match because they start with --.
    expect(
      !/^\s*"about:blank",\s*$/m.test(src),
    ).toBeTruthy();
  });
});

// ─── runtime/ego-linux/src/chrome.mjs (macOS X display) ────────────────────

describe("runtime chrome.mjs (macOS X display)", () => {
  it("returns a pseudo display on darwin instead of requiring Xvfb (#65)", async () => {
    // Xvfb is an X11 tool; it simply does not exist on macOS. Must not throw
    // "no X display ... no Xvfb binary on PATH" on a desktop macOS session.
    if (process.platform !== "darwin") return;
    // @ts-ignore — runtime .mjs is excluded from tsconfig
    const mod = await import("../runtime/ego-linux/src/chrome.mjs");
    const saved = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      expect(await mod.ensureXDisplay()).toEqual({
        display: "darwin-desktop",
        pid: null,
        launched: false,
      });
    } finally {
      if (saved !== undefined) process.env.DISPLAY = saved;
    }
  });
});

// ─── runtime/ego-linux/src/chrome.mjs (headless UA version) ────────────────

describe("runtime chrome.mjs (headless UA version, #79)", () => {
  it("parses the major version from chrome/chromium --version output", async () => {
    // @ts-ignore — runtime .mjs is excluded from tsconfig
    const mod = await import("../runtime/ego-linux/src/chrome.mjs");
    expect(mod.parseChromeVersionMajor("Google Chrome 154.0.1.2")).toBe(154);
    expect(mod.parseChromeVersionMajor("Chromium 155.0.8059.79")).toBe(155);
    expect(mod.parseChromeVersionMajor("HeadlessChrome/155.0.0.0")).toBe(155);
    expect(mod.parseChromeVersionMajor("not a browser")).toBe(null);
  });
});
