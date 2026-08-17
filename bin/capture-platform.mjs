export function buildCaptureInput({ platform = process.platform, env = process.env, source, fps }) {
  if (platform === "win32") {
    return ["-f", "gdigrab", "-framerate", String(fps), "-offset_x", String(source.captureX), "-offset_y", String(source.captureY), "-video_size", `${source.captureWidth}x${source.captureHeight}`, "-i", "desktop"];
  }
  if (platform === "darwin") {
    return ["-f", "avfoundation", "-framerate", String(fps), "-i", `${source.displayIndex || 1}:none`];
  }
  if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) {
    const error = new Error("The bundled FFmpeg does not provide a guaranteed Wayland Portal capture input");
    error.code = "unsupported-ffmpeg-pipewire";
    throw error;
  }
  const display = env.DISPLAY || ":0";
  return ["-f", "x11grab", "-framerate", String(fps), "-video_size", `${source.captureWidth}x${source.captureHeight}`, "-i", `${display}+${source.captureX},${source.captureY}`];
}

export function buildEncoderArgs({ encoder, fps, maxWidth, source, platform = process.platform }) {
  const filters = [];
  if (platform === "darwin" && source) filters.push(`crop=${source.captureWidth}:${source.captureHeight}:${source.captureX}:${source.captureY}`);
  filters.push(`scale='min(${maxWidth},iw)':-2`);
  const common = ["-an", "-vf", filters.join(","), "-pix_fmt", "yuv420p", "-g", String(fps), "-keyint_min", String(fps), "-sc_threshold", "0", "-bf", "0", "-profile:v", "baseline"];
  if (encoder === "libx264") common.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "28");
  else common.push("-c:v", encoder);
  return [...common, "-movflags", "empty_moov+default_base_moof+frag_keyframe", "-frag_duration", "500000", "-f", "mp4", "pipe:1"];
}

export async function resolveCaptureSource({ sessions, targetId }) {
  const result = await sessions.call(targetId, "Runtime.evaluate", {
    expression: "({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,devicePixelRatio})",
    returnByValue: true,
  });
  const value = result.result?.value || {};
  if (![value.screenX, value.screenY, value.outerWidth, value.outerHeight, value.innerWidth, value.innerHeight].every(Number.isFinite)) {
    const error = new Error("Browser window geometry is unavailable");
    error.code = "ffmpeg-capture-source-missing";
    throw error;
  }
  const dpr = Number(value.devicePixelRatio) || 1;
  const chromeX = Math.max(0, (Number(value.outerWidth) - Number(value.innerWidth)) / 2);
  const chromeY = Math.max(0, Number(value.outerHeight) - Number(value.innerHeight) - chromeX);
  return {
    sourceType: "display-crop",
    captureX: Math.round((Number(value.screenX) + chromeX) * dpr),
    captureY: Math.round((Number(value.screenY) + chromeY) * dpr),
    captureWidth: Math.max(2, Math.round(Number(value.innerWidth) * dpr)),
    captureHeight: Math.max(2, Math.round(Number(value.innerHeight) * dpr)),
    contentWidthCss: Number(value.innerWidth),
    contentHeightCss: Number(value.innerHeight),
    scaleFactor: dpr,
  };
}
