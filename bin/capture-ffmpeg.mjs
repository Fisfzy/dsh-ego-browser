import { spawn as nodeSpawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { Mp4FragmentParser } from "./mp4-fragments.mjs";
import { buildCaptureInput, buildEncoderArgs, resolveCaptureSource } from "./capture-platform.mjs";

function runProbe(path, argv, spawn, timeoutMs, captureOutput = false) {
  return new Promise((resolve) => {
    let child;
    let output = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output });
    };
    try {
      child = spawn(path, argv, {
        shell: false,
        windowsHide: true,
        stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
      });
    } catch {
      resolve({ ok: false, output });
      return;
    }
    if (captureOutput) {
      child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    }
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {}; finish(false); }, timeoutMs);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

export async function resolveFfmpegPath(configuredPath = "", spawn = nodeSpawn) {
  const candidates = configuredPath ? [configuredPath] : ["ffmpeg"];
  for (const candidate of candidates) {
    try {
      if (candidate !== "ffmpeg") await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const probe = await runProbe(candidate, ["-version"], spawn, 3000);
      if (probe.ok) return candidate;
    } catch {}
  }
  const error = new Error(configuredPath ? `FFmpeg is not executable: ${configuredPath}` : "No usable FFmpeg executable was resolved");
  error.code = configuredPath ? "ffmpeg-not-executable" : "ffmpeg-not-installed";
  throw error;
}

export async function assertCaptureSupport(path, platform = process.platform, spawn = nodeSpawn) {
  if (platform !== "win32") return;
  const result = await runProbe(path, ["-hide_banner", "-h", "filter=gfxcapture"], spawn, 3000, true);
  if (!result.ok || !/Filter gfxcapture\b/.test(result.output)) {
    const error = new Error("This FFmpeg build does not support Windows gfxcapture; configure a current FFmpeg build instead of desktop capture");
    error.code = "ffmpeg-gfxcapture-unavailable";
    throw error;
  }
}

export async function selectEncoder(path, requested, spawn = nodeSpawn, capture = null, platform = process.platform) {
  if (requested === "software") return "libx264";
  const candidates = requested !== "auto" ? [requested] : platform === "win32"
    ? ["h264_mf", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"]
    : process.platform === "darwin" ? ["h264_videotoolbox", "libx264"] : ["h264_nvenc", "h264_vaapi", "h264_qsv", "libx264"];
  for (const encoder of candidates) {
    const encoderArgs = encoder === "h264_mf"
      ? ["-c:v", encoder, "-hw_encoding", "1", "-scenario", "display_remoting"]
      : ["-c:v", encoder];
    const inputArgs = platform === "win32" && capture?.source
      ? buildCaptureInput({ source: capture.source, fps: capture.fps, maxWidth: capture.maxWidth, encoder })
      : ["-f", "lavfi", "-i", "color=size=64x64:rate=1"];
    const probe = await runProbe(path, ["-hide_banner", "-loglevel", "error", ...inputArgs, "-frames:v", "1", ...encoderArgs, "-f", "null", "-"], spawn, 2000);
    if (probe.ok) return encoder;
  }
  const error = new Error(`FFmpeg encoder is unavailable: ${requested}`);
  error.code = "ffmpeg-encoder-unavailable";
  throw error;
}

export function codecFromAvcInit(buffer) {
  const index = Buffer.from(buffer).indexOf(Buffer.from("avcC"));
  if (index < 0 || index + 8 > buffer.length) return "avc1.42E01E";
  return `avc1.${[buffer[index + 5], buffer[index + 6], buffer[index + 7]].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export class FfmpegCaptureBackend {
  constructor({ sessions, browserPid, getConfig, generation, onStatus, onVideoInit, onVideoChunk, onVideoEnd, spawn = nodeSpawn, sourceResolver = resolveCaptureSource, pathResolver = resolveFfmpegPath, supportProbe = assertCaptureSupport }) {
    this.sessions = sessions;
    this.browserPid = browserPid;
    this.getConfig = getConfig;
    this.generation = generation;
    this.onStatus = onStatus;
    this.onVideoInit = onVideoInit;
    this.onVideoChunk = onVideoChunk;
    this.onVideoEnd = onVideoEnd;
    this.spawn = spawn;
    this.sourceResolver = sourceResolver;
    this.pathResolver = pathResolver;
    this.supportProbe = supportProbe;
    this.child = null;
    this.stopping = null;
    this.termination = null;
    this.offDestroyed = sessions.onDestroyed?.((targetId) => {
      if (this.targetId !== targetId) return;
      this.onStatus({ backend: "ffmpeg", state: "failed", targetId, code: "capture-target-destroyed", message: "The watched target was closed" });
      this.stop("target-destroyed").catch(() => {});
    });
    this.stderr = Buffer.alloc(0);
  }

  async start({ targetId }) {
    this.targetId = targetId;
    const config = this.getConfig();
    this.onStatus({ backend: "ffmpeg", state: "starting", targetId, message: "Resolving FFmpeg binary" });
    const [path, source] = await Promise.all([
      this.pathResolver(config.ffmpegResolvedPath || config.ffmpegPath),
      this.sourceResolver({ sessions: this.sessions, targetId, browserPid: this.browserPid }),
    ]);
    await this.supportProbe(path);
    this.onStatus({ backend: "ffmpeg", state: "starting", targetId, message: "Probing H.264 encoder" });
    const encoder = await selectEncoder(path, config.ffmpegEncoder, this.spawn, {
      source, fps: config.ffmpegFps, maxWidth: config.ffmpegMaxWidth,
    });
    this.onStatus({ backend: "ffmpeg", state: "starting", targetId, message: `Starting capture with ${encoder}` });
    const argv = ["-hide_banner", "-loglevel", "warning", ...buildCaptureInput({ source, fps: config.ffmpegFps, maxWidth: config.ffmpegMaxWidth, encoder }), ...buildEncoderArgs({ encoder, fps: config.ffmpegFps, maxWidth: config.ffmpegMaxWidth, bitrateKbps: config.ffmpegBitrateKbps, source })];
    const child = this.spawn(path, argv, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let initialized = false;
    const parser = new Mp4FragmentParser({
      onInit: (buffer) => {
        if (this.child !== child) return;
        initialized = true;
        const mime = `video/mp4; codecs="${codecFromAvcInit(buffer)}"`;
        this.onVideoInit({ targetId, mime, width: source.contentWidthCss, height: source.contentHeightCss, generation: this.generation, buffer });
        this.onStatus({ backend: "ffmpeg", state: "streaming", targetId, encoder, mime, code: null, message: null });
      },
      onFragment: (buffer) => {
        if (this.child === child) this.onVideoChunk({ generation: this.generation, buffer });
      },
    });
    child.stdout.on("data", (chunk) => {
      try { parser.push(chunk); }
      catch (error) { this.#fail(child, targetId, "video-stream-corrupt", error); }
    });
    child.stdout.once("end", () => {
      try { parser.end(); }
      catch (error) { if (this.child === child) this.#fail(child, targetId, "video-stream-corrupt", error); }
    });
    child.stderr.on("data", (chunk) => {
      this.stderr = Buffer.concat([this.stderr, Buffer.from(chunk)]).subarray(-65536);
    });
    child.once("error", (error) => this.#fail(child, targetId, "ffmpeg-not-executable", error));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.onVideoEnd({ generation: this.generation });
      this.onStatus({ backend: "ffmpeg", state: "failed", targetId, code: "ffmpeg-capture-failed", message: this.stderr.toString("utf8") || `FFmpeg exited unexpectedly (${code ?? signal})` });
    });
    await new Promise((resolve, reject) => {
      const finish = (callback, value) => { clearTimeout(timer); clearInterval(check); callback(value); };
      const timer = setTimeout(() => finish(reject, new Error("FFmpeg did not produce an MP4 init segment within 8 seconds")), 8000);
      const check = setInterval(() => {
        if (initialized) finish(resolve);
        else if (this.child !== child) finish(reject, new Error("FFmpeg exited before the MP4 init segment"));
      }, 20);
    }).catch(async (error) => { await this.stop("startup-failed"); throw error; });
  }

  async switchTarget({ targetId }) {
    await this.stop("target-switch");
    await this.start({ targetId });
  }

  async updateConfig() {}

  async stop(reason = "stopped") {
    if (this.termination) return this.termination;
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.termination = (async () => {
      this.stopping = child;
      try { child.stdin.write("q\n"); } catch {}
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      if (child.exitCode === null) {
        try { child.kill("SIGTERM"); } catch {}
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch {}
        await new Promise((resolve) => child.once("exit", resolve));
      }
      this.stopping = null;
      this.onVideoEnd({ generation: this.generation, reason });
    })();
    try { await this.termination; }
    finally { this.termination = null; }
  }

  status() {
    return { backend: "ffmpeg", state: this.child ? "streaming" : "idle", generation: this.generation };
  }

  #fail(child, targetId, code, error) {
    if (this.child !== child) return;
    this.onStatus({ backend: "ffmpeg", state: "failed", targetId, code, message: error.message });
    this.stop(code).catch(() => {})
  }

  dispose() {
    this.offDestroyed?.();
    this.offDestroyed = null;
  }
}
