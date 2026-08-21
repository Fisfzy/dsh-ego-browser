import z from "@deepseek-ai/schemastery";

const backend = z.union(["auto", "cdp", "ffmpeg"]);
const profile = z.union(["low", "balanced", "high"]);
const encoder = z.union([
  "auto", "software", "h264_mf", "h264_nvenc", "h264_qsv", "h264_amf",
  "h264_videotoolbox", "h264_vaapi",
]);

// Defaults live in resolveConfig so a persisted legacy value is not hidden by
// a schema default before the one-release migration runs.
export const Config = z.object({
  chromePath: z.string().description("Path to Chrome/Chromium. Empty = auto-detect."),
  captureBackend: backend.description("Capture backend: auto, cdp, or ffmpeg."),
  streamProfile: profile.description("Capture quality profile."),
  cdpFps: z.number().min(5).max(30).step(1).description("CDP preview FPS."),
  cdpQuality: z.number().min(1).max(100).step(1).description("CDP JPEG quality."),
  cdpMaxWidth: z.number().min(320).max(1920).step(40).description("CDP frame max width."),
  cdpBackstopIntervalMs: z.number().min(1000).max(10000).step(100).description("CDP recovery screenshot interval."),
  ffmpegFps: z.number().min(5).max(30).step(1).description("FFmpeg video FPS."),
  ffmpegMaxWidth: z.number().min(320).max(1920).step(40).description("FFmpeg video max width."),
  ffmpegBitrateKbps: z.number().min(500).max(20000).step(250).description("FFmpeg target video bitrate in kbps."),
  ffmpegEncoder: encoder.description("FFmpeg H.264 encoder."),
  ffmpegPath: z.string().description("Custom FFmpeg path. Empty = detect PATH or managed install."),
  githubMirror: z.string().description("HTTPS base replacing https://github.com for managed downloads."),
  // User-defined extra CLI args. Shell-like tokenize; mutually-exclusive
  // control flags are stripped (see EGO_CLI_BLOCKED / CHROME_BLOCKED below).
  egoCliArgs: z.string().description("Extra args appended to `ego-browser nodejs` argv. Takes effect on the next ego_* call."),
  chromeArgs: z.string().description("Extra args appended to the Chrome launch argv. Takes effect on the next browser cold start (the browser is a singleton)."),
  // Deprecated read-compatible keys. The settings UI only writes canonical keys.
  castFpsCap: z.number().min(0).max(60).step(1),
  screencastQuality: z.number().min(1).max(100).step(1),
  screencastMaxWidth: z.number().min(320).max(1920).step(40),
  backstopIntervalMs: z.number().min(200).max(10000).step(100),
});

// ── user-defined extra CLI args ─────────────────────────────────────────────
/**
 * Flags the user must NOT put in `egoCliArgs`: these ego-browser subcommands
 * exit before the heredoc runs (--status/--stop/--help/...) or steal the
 * browser window (--open), so appending them would break every ego_* tool.
 * `--headless` is managed by EGO_LINUX_HEADLESS; `--sdk-path` is allowed.
 */
export const EGO_CLI_BLOCKED = new Set([
  "--status",
  "--stop",
  "--open",
  "--spaces",
  "--spaces-daemon",
  "--prune-spaces",
  "--import-chrome-profile",
  "--install-desktop-entry",
  "--help",
  "-h",
]);

/**
 * Flags the user must NOT put in `chromeArgs`: these are managed by the
 * launcher / EGO_LINUX_PROXY and overriding them would break CDP control,
 * profile isolation, or the proxy bypass list. `--proxy-server` should go
 * through EGO_LINUX_PROXY (which also sets the bypass list).
 */
export const CHROME_BLOCKED = new Set([
  "--user-data-dir",
  "--remote-debugging-port",
  "--remote-allow-origins",
  "--headless",
  "--no-startup-window",
  "--proxy-server",
  "--proxy-bypass-list",
]);

/**
 * Shell-like tokenizer for user-supplied arg strings. Handles single/double
 * quotes and backslash escapes; bare whitespace separates tokens. Returns []
 * for empty/whitespace-only input. Used for both `egoCliArgs` and `chromeArgs`
 * (mirrored in runtime/ego-linux/src/chrome.mjs for the Chrome side, since the
 * runtime must not import from lib/).
 */
export function tokenizeArgs(input) {
  if (typeof input !== "string") return [];
  const out = [];
  let cur = "";
  let i = 0;
  let quote = null;
  while (i < input.length) {
    const c = input[i];
    if (quote) {
      if (c === "\\") {
        const next = input[i + 1];
        if (next !== undefined) {
          cur += next;
          i += 2;
          continue;
        }
      } else if (c === quote) {
        quote = null;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "\\") {
      const next = input[i + 1];
      if (next !== undefined) {
        cur += next;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur !== "") out.push(cur);
  return out;
}

/**
 * Split a raw arg string into tokens, dropping any token (and, for `--flag
 * value` pairs, its value) that appears in `blocked`. A "blocked" token with a
 * `=` attached (e.g. `--headless=new`) is also dropped. Returns the surviving
 * tokens. Exposed for tests and for the runtime to mirror.
 */
export function filterArgs(raw, blocked) {
  const tokens = tokenizeArgs(raw);
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const key = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
    if (blocked.has(key)) {
      // Drop a bare `--flag value` pair when the flag is blocklisted and the
      // next token does not itself look like a flag (i.e. it is the value).
      if (!tok.includes("=") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i += 1;
      }
      continue;
    }
    kept.push(tok);
  }
  return kept;
}

const finiteIn = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;

export function resolveConfig(config = {}) {
  const legacyFps = finiteIn(config.castFpsCap, 0, 60)
    ? (config.castFpsCap === 0 ? 20 : Math.max(5, Math.min(30, config.castFpsCap)))
    : 20;
  const selectedProfile = oneOf(config.streamProfile, ["low", "balanced", "high"], "balanced");
  const profileDefaults = selectedProfile === "low"
    ? { fps: 15, width: 960, bitrateKbps: 2000 }
    : selectedProfile === "high"
      ? { fps: 30, width: 1600, bitrateKbps: 8000 }
      : { fps: 20, width: 1280, bitrateKbps: 4000 };
  return {
    chromePath: typeof config.chromePath === "string" ? config.chromePath : "",
    captureBackend: oneOf(config.captureBackend, ["auto", "cdp", "ffmpeg"], "auto"),
    streamProfile: selectedProfile,
    cdpFps: finiteIn(config.cdpFps, 5, 30) ? config.cdpFps : legacyFps,
    cdpQuality: finiteIn(config.cdpQuality, 1, 100) ? config.cdpQuality : (finiteIn(config.screencastQuality, 1, 100) ? config.screencastQuality : 55),
    cdpMaxWidth: finiteIn(config.cdpMaxWidth, 320, 1920) ? config.cdpMaxWidth : (finiteIn(config.screencastMaxWidth, 320, 1920) ? config.screencastMaxWidth : 960),
    cdpBackstopIntervalMs: finiteIn(config.cdpBackstopIntervalMs, 1000, 10000) ? config.cdpBackstopIntervalMs : (finiteIn(config.backstopIntervalMs, 200, 10000) ? Math.max(1000, config.backstopIntervalMs) : 3000),
    ffmpegFps: finiteIn(config.ffmpegFps, 5, 30) ? config.ffmpegFps : profileDefaults.fps,
    ffmpegMaxWidth: finiteIn(config.ffmpegMaxWidth, 320, 1920) ? config.ffmpegMaxWidth : profileDefaults.width,
    ffmpegBitrateKbps: finiteIn(config.ffmpegBitrateKbps, 500, 20000) ? config.ffmpegBitrateKbps : profileDefaults.bitrateKbps,
    ffmpegEncoder: oneOf(config.ffmpegEncoder, ["auto", "software", "h264_mf", "h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "h264_vaapi"], "auto"),
    ffmpegPath: typeof config.ffmpegPath === "string" ? config.ffmpegPath : "",
    githubMirror: typeof config.githubMirror === "string" ? config.githubMirror : "",
    // User-defined extra args: stored raw (string), filtered at the call site
    // so a saved value is not silently mutated by a later blocklist change.
    egoCliArgs: typeof config.egoCliArgs === "string" ? config.egoCliArgs : "",
    chromeArgs: typeof config.chromeArgs === "string" ? config.chromeArgs : "",
  };
}
