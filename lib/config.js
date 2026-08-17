import z from "schemastery";

const backend = z.union(["auto", "cdp", "ffmpeg"]);
const profile = z.union(["low", "balanced", "high"]);
const encoder = z.union([
  "auto", "software", "h264_nvenc", "h264_qsv", "h264_amf",
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
  ffmpegEncoder: encoder.description("FFmpeg H.264 encoder."),
  ffmpegPath: z.string().description("Custom FFmpeg path. Empty = bundled binary."),
  // Deprecated read-compatible keys. The settings UI only writes canonical keys.
  castFpsCap: z.number().min(0).max(60).step(1),
  screencastQuality: z.number().min(1).max(100).step(1),
  screencastMaxWidth: z.number().min(320).max(1920).step(40),
  backstopIntervalMs: z.number().min(200).max(10000).step(100),
});

const finiteIn = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;

export function resolveConfig(config = {}) {
  const legacyFps = finiteIn(config.castFpsCap, 0, 60)
    ? (config.castFpsCap === 0 ? 20 : Math.max(5, Math.min(30, config.castFpsCap)))
    : 20;
  const selectedProfile = oneOf(config.streamProfile, ["low", "balanced", "high"], "balanced");
  const profileDefaults = selectedProfile === "low" ? { fps: 15, width: 960 } : selectedProfile === "high" ? { fps: 30, width: 1600 } : { fps: 20, width: 1280 };
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
    ffmpegEncoder: oneOf(config.ffmpegEncoder, ["auto", "software", "h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "h264_vaapi"], "auto"),
    ffmpegPath: typeof config.ffmpegPath === "string" ? config.ffmpegPath : "",
  };
}
