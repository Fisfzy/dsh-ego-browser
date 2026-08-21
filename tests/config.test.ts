import { describe, it, expect } from "vitest";
import { resolveConfig, tokenizeArgs, filterArgs, EGO_CLI_BLOCKED, CHROME_BLOCKED } from "../src/config.ts";

describe("dual capture config", () => {
  it("returns canonical defaults", () => {
    expect(resolveConfig({})).toEqual({
      chromePath: "", captureBackend: "auto", streamProfile: "balanced",
      cdpFps: 20, cdpQuality: 55, cdpMaxWidth: 960, cdpBackstopIntervalMs: 3000,
      ffmpegFps: 20, ffmpegMaxWidth: 1280, ffmpegBitrateKbps: 4000, ffmpegEncoder: "auto", ffmpegPath: "", githubMirror: "",
      egoCliArgs: "", chromeArgs: "",
    });
  });

  it("migrates legacy CDP fields and lets canonical fields win", () => {
    expect(resolveConfig({ castFpsCap: 60, screencastQuality: 70, screencastMaxWidth: 1200, backstopIntervalMs: 5000 })).toEqual({
      chromePath: "", captureBackend: "auto", streamProfile: "balanced",
      cdpFps: 30, cdpQuality: 70, cdpMaxWidth: 1200, cdpBackstopIntervalMs: 5000,
      ffmpegFps: 20, ffmpegMaxWidth: 1280, ffmpegBitrateKbps: 4000, ffmpegEncoder: "auto", ffmpegPath: "", githubMirror: "",
      egoCliArgs: "", chromeArgs: "",
    });
    expect(resolveConfig({ cdpFps: 15, castFpsCap: 30 }).cdpFps).toBe(15);
  });

  it("falls back for invalid enums and numbers", () => {
    const config = resolveConfig({ captureBackend: "bad", cdpFps: 99, ffmpegEncoder: "bad" } as any);
    expect(config.captureBackend).toBe("auto");
    expect(config.cdpFps).toBe(20);
    expect(config.ffmpegEncoder).toBe("auto");
  });

  it("applies stream profiles unless advanced FFmpeg fields override them", () => {
    expect(resolveConfig({ streamProfile: "low" }).ffmpegFps).toBe(15);
    expect(resolveConfig({ streamProfile: "high" }).ffmpegMaxWidth).toBe(1600);
    expect(resolveConfig({ streamProfile: "low" }).ffmpegBitrateKbps).toBe(2000);
    expect(resolveConfig({ streamProfile: "high" }).ffmpegBitrateKbps).toBe(8000);
    expect(resolveConfig({ streamProfile: "high", ffmpegBitrateKbps: 6000 }).ffmpegBitrateKbps).toBe(6000);
    expect(resolveConfig({ streamProfile: "high", ffmpegFps: 12 }).ffmpegFps).toBe(12);
    expect(resolveConfig({ backstopIntervalMs: 200 }).cdpBackstopIntervalMs).toBe(1000);
  });
});

// ── user-defined extra CLI args (egoCliArgs / chromeArgs) ───────────────────

describe("user-defined extra CLI args", () => {
  it("resolveConfig defaults egoCliArgs / chromeArgs to empty strings", () => {
    const c = resolveConfig({});
    expect(c.egoCliArgs).toBe("");
    expect(c.chromeArgs).toBe("");
  });

  it("resolveConfig passes through non-string as empty string", () => {
    const c = resolveConfig({ egoCliArgs: 123, chromeArgs: null } as any);
    expect(c.egoCliArgs).toBe("");
    expect(c.chromeArgs).toBe("");
  });

  it("resolveConfig preserves the raw string (filtering happens at call site)", () => {
    const c = resolveConfig({ egoCliArgs: "--status --sdk-path /x", chromeArgs: "--headless --proxy-server=bad" });
    // Stored raw; blocklist is applied by filterArgs at spawn time so a saved
    // value is not silently mutated by a later blocklist change.
    expect(c.egoCliArgs).toBe("--status --sdk-path /x");
    expect(c.chromeArgs).toBe("--headless --proxy-server=bad");
  });
});

describe("tokenizeArgs", () => {
  it("returns [] for empty / whitespace-only input", () => {
    expect(tokenizeArgs("")).toEqual([]);
    expect(tokenizeArgs("   ")).toEqual([]);
    expect(tokenizeArgs("\t\n")).toEqual([]);
    expect(tokenizeArgs(undefined)).toEqual([]);
    expect(tokenizeArgs(null)).toEqual([]);
  });

  it("splits on bare whitespace", () => {
    expect(tokenizeArgs("--a --b c")).toEqual(["--a", "--b", "c"]);
  });

  it("preserves quoted tokens as single args", () => {
    expect(tokenizeArgs('"--a value" --b')).toEqual(["--a value", "--b"]);
    expect(tokenizeArgs("'path with spaces' --b")).toEqual(["path with spaces", "--b"]);
  });

  it("handles backslash escapes", () => {
    expect(tokenizeArgs('a\\ b c')).toEqual(["a b", "c"]);
    expect(tokenizeArgs('"a\\"b"')).toEqual(['a"b']);
  });

  it("keeps = attached to its flag", () => {
    expect(tokenizeArgs("--proxy-server=http://host:7890 --x")).toEqual(["--proxy-server=http://host:7890", "--x"]);
  });
});

describe("filterArgs", () => {
  it("drops blocked bare flags and their value when value is non-flag", () => {
    // --status is blocked and would exit before the heredoc; drop it.
    const out = filterArgs("--status --sdk-path /x", EGO_CLI_BLOCKED);
    expect(out).toEqual(["--sdk-path", "/x"]);
  });

  it("drops blocked =-form flags without consuming a value", () => {
    const out = filterArgs("--headless=new --keep-me", CHROME_BLOCKED);
    expect(out).toEqual(["--keep-me"]);
  });

  it("does not drop a value that happens to start with - after a blocked bare flag", () => {
    // --headless is blocked; next token starts with -, so it is NOT its value.
    const out = filterArgs("--headless --other", CHROME_BLOCKED);
    expect(out).toEqual(["--other"]);
  });

  it("drops --proxy-server and its value (use EGO_LINUX_PROXY instead)", () => {
    const out = filterArgs("--proxy-server=http://x --keep", CHROME_BLOCKED);
    expect(out).toEqual(["--keep"]);
  });

  it("drops a bare --proxy-server plus its separate value", () => {
    const out = filterArgs("--proxy-server http://x --keep", CHROME_BLOCKED);
    expect(out).toEqual(["--keep"]);
  });

  it("preserves allowed args verbatim (order + quoting collapsed by tokenizer)", () => {
    const out = filterArgs("--disable-features=Translate --window-size=800,600", CHROME_BLOCKED);
    expect(out).toEqual(["--disable-features=Translate", "--window-size=800,600"]);
  });

  it("returns [] when all args are blocked", () => {
    expect(filterArgs("--status --stop --help", EGO_CLI_BLOCKED)).toEqual([]);
  });
});
