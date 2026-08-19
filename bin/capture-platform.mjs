import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export function buildCaptureInput({ platform = process.platform, env = process.env, source, fps, maxWidth, encoder }) {
  if (platform === "win32") {
    if (source.sourceType !== "window-hwnd" || !source.hwnd) {
      const error = new Error("Windows FFmpeg capture requires a Chrome window handle");
      error.code = "ffmpeg-window-hwnd-missing";
      throw error;
    }
    const outputWidth = Math.max(2, Math.floor(Math.min(maxWidth, source.captureWidth) / 2) * 2);
    const outputHeight = Math.max(2, Math.floor((source.captureHeight * outputWidth / source.captureWidth) / 2) * 2);
    const options = [
      `hwnd=${source.hwnd}`,
      `max_framerate=${fps}`,
      "capture_cursor=false",
      "capture_border=false",
      "display_border=false",
      `crop_left=${source.cropLeft || 0}`,
      `crop_top=${source.cropTop || 0}`,
      `crop_right=${source.cropRight || 0}`,
      `crop_bottom=${source.cropBottom || 0}`,
      `width=${outputWidth}`,
      `height=${outputHeight}`,
      "resize_mode=scale_aspect",
    ];
    const filters = [`gfxcapture=${options.join(":")}`, `fps=${fps}`, `setpts=N/(${fps}*TB)`];
    if (encoder === "libx264") filters.push("hwdownload", "format=bgra", "format=yuv420p");
    return ["-filter_complex", filters.join(",")];
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

export function buildEncoderArgs({ encoder, fps, maxWidth, bitrateKbps = 4000, source, platform = process.platform }) {
  const maxrateKbps = Math.round(bitrateKbps * 1.25);
  const bufsizeKbps = bitrateKbps * 2;
  const rateArgs = ["-b:v", `${bitrateKbps}k`, "-maxrate", `${maxrateKbps}k`, "-bufsize", `${bufsizeKbps}k`];
  if (platform === "win32" && source?.sourceType === "window-hwnd") {
    const common = ["-an", "-g", String(fps), "-bf", "0", ...rateArgs];
    if (encoder === "h264_mf") {
      common.push("-c:v", encoder, "-hw_encoding", "1", "-scenario", "display_remoting", "-rate_control", "ld_vbr");
    } else if (encoder === "libx264") {
      common.push("-c:v", encoder, "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p");
    } else {
      common.push("-c:v", encoder);
    }
    return [...common, "-movflags", "empty_moov+default_base_moof+frag_keyframe+skip_trailer", "-frag_duration", "100000", "-f", "mp4", "pipe:1"];
  }
  const filters = [];
  if (platform === "darwin" && source) filters.push(`crop=${source.captureWidth}:${source.captureHeight}:${source.captureX}:${source.captureY}`);
  filters.push(`scale='min(${maxWidth},iw)':-2`);
  const common = ["-an", "-vf", filters.join(","), "-pix_fmt", "yuv420p", "-g", String(fps), "-keyint_min", String(fps), "-sc_threshold", "0", "-bf", "0", "-profile:v", "baseline", ...rateArgs];
  if (encoder === "libx264") common.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency");
  else common.push("-c:v", encoder);
  return [...common, "-movflags", "empty_moov+default_base_moof+frag_keyframe", "-frag_duration", "500000", "-f", "mp4", "pipe:1"];
}

export function selectWindowCandidate(windows, bounds, targetTitle = "") {
  const candidates = windows.filter((window) => window.hwnd && window.width > 0 && window.height > 0);
  if (candidates.length === 0) return null;
  const normalizedTitle = targetTitle.trim().toLocaleLowerCase();
  const ranked = candidates.map((window) => {
    const geometryScore = bounds
      ? Math.abs(window.x - bounds.left) + Math.abs(window.y - bounds.top)
        + Math.abs(window.width - bounds.width) + Math.abs(window.height - bounds.height)
      : 0;
    return { window, geometryScore };
  }).sort((a, b) => a.geometryScore - b.geometryScore);
  const closest = ranked.filter((entry) => entry.geometryScore <= ranked[0].geometryScore + 8);
  if (normalizedTitle) {
    const titleMatch = closest.find(({ window }) => String(window.title || "").toLocaleLowerCase().includes(normalizedTitle));
    if (titleMatch) return titleMatch.window;
  }
  return ranked[0].window;
}

export async function enumerateWindowsForPid(browserPid, run = execFile) {
  if (!Number.isInteger(browserPid) || browserPid <= 0) return [];
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EgoWindowProbe {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not [EgoWindowProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][EgoWindowProbe]::SetProcessDPIAware() }
$items = [System.Collections.Generic.List[object]]::new()
[void][EgoWindowProbe]::EnumWindows({
  param($hwnd, $lParam)
  $ownerPid = 0
  [void][EgoWindowProbe]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
  if ($ownerPid -eq ${browserPid} -and [EgoWindowProbe]::IsWindowVisible($hwnd)) {
    $rect = [EgoWindowProbe+RECT]::new()
    $client = [EgoWindowProbe+RECT]::new()
    $title = [Text.StringBuilder]::new(2048)
    [void][EgoWindowProbe]::GetWindowRect($hwnd, [ref]$rect)
    [void][EgoWindowProbe]::GetClientRect($hwnd, [ref]$client)
    [void][EgoWindowProbe]::GetWindowText($hwnd, $title, $title.Capacity)
    $items.Add([pscustomobject]@{
      hwnd = $hwnd.ToInt64()
      title = $title.ToString()
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
      clientWidth = $client.Right - $client.Left
      clientHeight = $client.Bottom - $client.Top
      minimized = [EgoWindowProbe]::IsIconic($hwnd)
    })
  }
  return $true
}, [IntPtr]::Zero)
ConvertTo-Json -Compress -InputObject @($items)
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function resolveCaptureSource({ sessions, targetId, browserPid, platform = process.platform, windowEnumerator = enumerateWindowsForPid }) {
  const result = await sessions.call(targetId, "Runtime.evaluate", {
    expression: "({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,devicePixelRatio,title:document.title})",
    returnByValue: true,
  });
  const value = result.result?.value || {};
  if (![value.screenX, value.screenY, value.outerWidth, value.outerHeight, value.innerWidth, value.innerHeight].every(Number.isFinite)) {
    const error = new Error("Browser window geometry is unavailable");
    error.code = "ffmpeg-capture-source-missing";
    throw error;
  }
  const dpr = Number(value.devicePixelRatio) || 1;
  if (platform === "win32") {
    let bounds = null;
    try {
      const window = await sessions.cdp.call("Browser.getWindowForTarget", { targetId });
      bounds = (await sessions.cdp.call("Browser.getWindowBounds", { windowId: window.windowId })).bounds || window.bounds || null;
    } catch {}
    const windows = await windowEnumerator(browserPid);
    const selected = selectWindowCandidate(windows, bounds, value.title || "");
    if (!selected) {
      const error = new Error(`Chrome window not found for browser PID ${browserPid || "unknown"}`);
      error.code = "ffmpeg-window-not-found";
      throw error;
    }
    const targetTitle = String(value.title || "").trim().toLocaleLowerCase();
    const windowTitle = String(selected.title || "").toLocaleLowerCase();
    if (targetTitle && !windowTitle.includes(targetTitle)) {
      const error = new Error("The requested target is not the visible tab in its Chrome window");
      error.code = "ffmpeg-target-not-visible";
      throw error;
    }
    if (selected.minimized) {
      const error = new Error("The target Chrome window is minimized");
      error.code = "capture-source-not-visible";
      throw error;
    }
    const contentWidth = Math.max(2, Math.round(Number(value.innerWidth) * dpr));
    const contentHeight = Math.max(2, Math.round(Number(value.innerHeight) * dpr));
    const clientWidth = Number(selected.clientWidth) || contentWidth;
    const clientHeight = Number(selected.clientHeight) || contentHeight;
    const cropLeft = Math.max(0, Math.floor((clientWidth - contentWidth) / 2));
    const cropRight = Math.max(0, clientWidth - contentWidth - cropLeft);
    const cropTop = Math.max(0, clientHeight - contentHeight);
    return {
      sourceType: "window-hwnd",
      hwnd: String(selected.hwnd),
      captureX: 0,
      captureY: 0,
      captureWidth: contentWidth,
      captureHeight: contentHeight,
      cropLeft,
      cropTop,
      cropRight,
      cropBottom: 0,
      contentWidthCss: Number(value.innerWidth),
      contentHeightCss: Number(value.innerHeight),
      scaleFactor: dpr,
      minimized: !!selected.minimized,
    };
  }
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
