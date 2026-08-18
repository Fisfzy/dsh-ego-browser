import { spawn as nodeSpawn } from "node:child_process";

export function runFfmpegProbe(path, argv, { spawn = nodeSpawn, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let child; let output = ""; let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, output }); };
    try { child = spawn(path, argv, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve({ ok: false, output }); return; }
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {}; finish(false); }, timeoutMs);
  });
}

export async function probeFfmpeg(path, { platform = process.platform, env = process.env, spawn = nodeSpawn, requestedEncoder = "auto" } = {}) {
  const versionResult = await runFfmpegProbe(path, ["-version"], { spawn });
  if (!versionResult.ok) throw codedError("ffmpeg-not-executable", `FFmpeg is not executable: ${path}`);
  const version = versionResult.output.split(/\r?\n/, 1)[0] || "FFmpeg";
  if (platform === "win32") {
    const support = await runFfmpegProbe(path, ["-hide_banner", "-h", "filter=gfxcapture"], { spawn });
    if (!support.ok || !/Filter gfxcapture\b/.test(support.output)) throw codedError("ffmpeg-gfxcapture-unavailable", "FFmpeg does not support Windows gfxcapture");
  } else if (platform === "darwin") {
    const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn });
    if (!devices.ok || !/avfoundation/i.test(devices.output)) throw codedError("ffmpeg-capture-input-unavailable", "FFmpeg does not support avfoundation capture");
  } else if (platform === "linux") {
    if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) throw codedError("ffmpeg-platform-unsupported", "Wayland capture is not supported");
    const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn });
    if (!devices.ok || !/x11grab/i.test(devices.output)) throw codedError("ffmpeg-capture-input-unavailable", "FFmpeg does not support x11grab capture");
  }
  const automatic = platform === "win32" ? ["h264_mf", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"]
    : platform === "darwin" ? ["h264_videotoolbox", "libx264"] : ["h264_nvenc", "h264_vaapi", "h264_qsv", "libx264"];
  const encoders = requestedEncoder === "auto" ? automatic : [requestedEncoder === "software" ? "libx264" : requestedEncoder];
  for (const encoder of encoders) {
    const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=64x64:rate=1", "-frames:v", "1", "-c:v", encoder, "-f", "null", "-"];
    if ((await runFfmpegProbe(path, args, { spawn, timeoutMs: 5000 })).ok) return { version, encoder };
  }
  throw codedError("ffmpeg-encoder-unavailable", "FFmpeg has no usable H.264 encoder");
}

function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
