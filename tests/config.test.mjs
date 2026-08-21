import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, tokenizeArgs, filterArgs, EGO_CLI_BLOCKED, CHROME_BLOCKED } from "../lib/config.js";

describe("dual capture config", () => {
  it("returns canonical defaults", () => {
    assert.deepEqual(resolveConfig({}), {
      chromePath: "", captureBackend: "auto", streamProfile: "balanced",
      cdpFps: 20, cdpQuality: 55, cdpMaxWidth: 960, cdpBackstopIntervalMs: 3000,
      ffmpegFps: 20, ffmpegMaxWidth: 1280, ffmpegBitrateKbps: 4000, ffmpegEncoder: "auto", ffmpegPath: "", githubMirror: "",
      egoCliArgs: "", chromeArgs: "",
    });
  });

  it("migrates legacy CDP fields and lets canonical fields win", () => {
    assert.deepEqual(resolveConfig({ castFpsCap: 60, screencastQuality: 70, screencastMaxWidth: 1200, backstopIntervalMs: 5000 }), {
      chromePath: "", captureBackend: "auto", streamProfile: "balanced",
      cdpFps: 30, cdpQuality: 70, cdpMaxWidth: 1200, cdpBackstopIntervalMs: 5000,
      ffmpegFps: 20, ffmpegMaxWidth: 1280, ffmpegBitrateKbps: 4000, ffmpegEncoder: "auto", ffmpegPath: "", githubMirror: "",
      egoCliArgs: "", chromeArgs: "",
    });
    assert.equal(resolveConfig({ cdpFps: 15, castFpsCap: 30 }).cdpFps, 15);
  });

  it("falls back for invalid enums and numbers", () => {
    const config = resolveConfig({ captureBackend: "bad", cdpFps: 99, ffmpegEncoder: "bad" });
    assert.equal(config.captureBackend, "auto");
    assert.equal(config.cdpFps, 20);
    assert.equal(config.ffmpegEncoder, "auto");
  });

  it("applies stream profiles unless advanced FFmpeg fields override them", () => {
    assert.equal(resolveConfig({ streamProfile: "low" }).ffmpegFps, 15);
    assert.equal(resolveConfig({ streamProfile: "high" }).ffmpegMaxWidth, 1600);
    assert.equal(resolveConfig({ streamProfile: "low" }).ffmpegBitrateKbps, 2000);
    assert.equal(resolveConfig({ streamProfile: "high" }).ffmpegBitrateKbps, 8000);
    assert.equal(resolveConfig({ streamProfile: "high", ffmpegBitrateKbps: 6000 }).ffmpegBitrateKbps, 6000);
    assert.equal(resolveConfig({ streamProfile: "high", ffmpegFps: 12 }).ffmpegFps, 12);
    assert.equal(resolveConfig({ backstopIntervalMs: 200 }).cdpBackstopIntervalMs, 1000);
  });
});

// ── user-defined extra CLI args (egoCliArgs / chromeArgs) ───────────────────

describe("user-defined extra CLI args", () => {
  it("resolveConfig defaults egoCliArgs / chromeArgs to empty strings", () => {
    const c = resolveConfig({});
    assert.equal(c.egoCliArgs, "");
    assert.equal(c.chromeArgs, "");
  });

  it("resolveConfig passes through non-string as empty string", () => {
    const c = resolveConfig({ egoCliArgs: 123, chromeArgs: null });
    assert.equal(c.egoCliArgs, "");
    assert.equal(c.chromeArgs, "");
  });

  it("resolveConfig preserves the raw string (filtering happens at call site)", () => {
    const c = resolveConfig({ egoCliArgs: "--status --sdk-path /x", chromeArgs: "--headless --proxy-server=bad" });
    // Stored raw; blocklist is applied by filterArgs at spawn time so a saved
    // value is not silently mutated by a later blocklist change.
    assert.equal(c.egoCliArgs, "--status --sdk-path /x");
    assert.equal(c.chromeArgs, "--headless --proxy-server=bad");
  });
});

describe("tokenizeArgs", () => {
  it("returns [] for empty / whitespace-only input", () => {
    assert.deepEqual(tokenizeArgs(""), []);
    assert.deepEqual(tokenizeArgs("   "), []);
    assert.deepEqual(tokenizeArgs("\t\n"), []);
    assert.deepEqual(tokenizeArgs(undefined), []);
    assert.deepEqual(tokenizeArgs(null), []);
  });

  it("splits on bare whitespace", () => {
    assert.deepEqual(tokenizeArgs("--a --b c"), ["--a", "--b", "c"]);
  });

  it("preserves quoted tokens as single args", () => {
    assert.deepEqual(tokenizeArgs('"--a value" --b'), ["--a value", "--b"]);
    assert.deepEqual(tokenizeArgs("'path with spaces' --b"), ["path with spaces", "--b"]);
  });

  it("handles backslash escapes", () => {
    assert.deepEqual(tokenizeArgs('a\\ b c'), ["a b", "c"]);
    assert.deepEqual(tokenizeArgs('"a\\"b"'), ['a"b']);
  });

  it("keeps = attached to its flag", () => {
    assert.deepEqual(tokenizeArgs("--proxy-server=http://host:7890 --x"), ["--proxy-server=http://host:7890", "--x"]);
  });
});

describe("filterArgs", () => {
  it("drops blocked bare flags and their value when value is non-flag", () => {
    // --status is blocked and would exit before the heredoc; drop it.
    const out = filterArgs("--status --sdk-path /x", EGO_CLI_BLOCKED);
    assert.deepEqual(out, ["--sdk-path", "/x"]);
  });

  it("drops blocked =-form flags without consuming a value", () => {
    const out = filterArgs("--headless=new --keep-me", CHROME_BLOCKED);
    assert.deepEqual(out, ["--keep-me"]);
  });

  it("does not drop a value that happens to start with - after a blocked bare flag", () => {
    // --headless is blocked; next token starts with -, so it is NOT its value.
    const out = filterArgs("--headless --other", CHROME_BLOCKED);
    assert.deepEqual(out, ["--other"]);
  });

  it("drops --proxy-server and its value (use EGO_LINUX_PROXY instead)", () => {
    const out = filterArgs("--proxy-server=http://x --keep", CHROME_BLOCKED);
    assert.deepEqual(out, ["--keep"]);
  });

  it("drops a bare --proxy-server plus its separate value", () => {
    const out = filterArgs("--proxy-server http://x --keep", CHROME_BLOCKED);
    assert.deepEqual(out, ["--keep"]);
  });

  it("preserves allowed args verbatim (order + quoting collapsed by tokenizer)", () => {
    const out = filterArgs("--disable-features=Translate --window-size=800,600", CHROME_BLOCKED);
    assert.deepEqual(out, ["--disable-features=Translate", "--window-size=800,600"]);
  });

  it("returns [] when all args are blocked", () => {
    assert.deepEqual(filterArgs("--status --stop --help", EGO_CLI_BLOCKED), []);
  });
});
