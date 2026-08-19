import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCaptureInput, buildEncoderArgs, resolveCaptureSource, selectWindowCandidate } from "../bin/capture-platform.mjs";

const source = { captureX: 10, captureY: 20, captureWidth: 800, captureHeight: 600 };
const windowSource = { sourceType: "window-hwnd", hwnd: "12345", captureWidth: 1264, captureHeight: 805, cropTop: 87 };

describe("FFmpeg argv generation", () => {
  it("uses gfxcapture HWND on Windows and argv values on X11", () => {
    const windowsArgs = buildCaptureInput({ platform: "win32", source: windowSource, fps: 30, maxWidth: 1280, encoder: "h264_mf" });
    assert.equal(windowsArgs[0], "-filter_complex");
    assert.match(windowsArgs[1], /gfxcapture=hwnd=12345/);
    assert.match(windowsArgs[1], /crop_top=87/);
    assert.match(windowsArgs[1], /fps=30,setpts=N\/\(30\*TB\)/);
    assert.doesNotMatch(windowsArgs[1], /desktop/);
    assert.ok(buildCaptureInput({ platform: "linux", env: { DISPLAY: ":9" }, source, fps: 15 }).includes(":9+10,20"));
  });

  it("downloads D3D11 frames only for software encoding", () => {
    const hardware = buildCaptureInput({ platform: "win32", source: windowSource, fps: 30, maxWidth: 960, encoder: "h264_mf" })[1];
    const software = buildCaptureInput({ platform: "win32", source: windowSource, fps: 30, maxWidth: 960, encoder: "libx264" })[1];
    assert.doesNotMatch(hardware, /hwdownload/);
    assert.match(software, /hwdownload,format=bgra,format=yuv420p/);
  });

  it("reports unsupported bundled Wayland capture", () => {
    assert.throws(() => buildCaptureInput({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" }, source, fps: 20 }), (error) => error.code === "unsupported-ffmpeg-pipewire");
  });

  it("builds low-latency fragmented MP4 encoder args", () => {
    const args = buildEncoderArgs({ encoder: "libx264", fps: 20, maxWidth: 1280 });
    assert.ok(args.includes("zerolatency")); assert.ok(args.includes("empty_moov+default_base_moof+frag_keyframe")); assert.equal(args.at(-1), "pipe:1");
  });

  it("builds the Windows Media Foundation low-latency output", () => {
    const args = buildEncoderArgs({ encoder: "h264_mf", fps: 30, maxWidth: 1280, bitrateKbps: 4000, source: windowSource, platform: "win32" });
    assert.ok(args.includes("-hw_encoding"));
    assert.ok(args.includes("display_remoting"));
    assert.ok(args.includes("empty_moov+default_base_moof+frag_keyframe+skip_trailer"));
    assert.equal(args[args.indexOf("-frag_duration") + 1], "100000");
    assert.equal(args[args.indexOf("-b:v") + 1], "4000k");
    assert.equal(args[args.indexOf("-maxrate") + 1], "5000k");
    assert.equal(args[args.indexOf("-bufsize") + 1], "8000k");
  });

  it("matches a target to the Chrome HWND by title and bounds", () => {
    const windows = [
      { hwnd: 1, title: "Other - Google Chrome", x: 0, y: 0, width: 1280, height: 900 },
      { hwnd: 2, title: "Target page - Google Chrome", x: 400, y: 100, width: 1280, height: 900 },
    ];
    assert.equal(selectWindowCandidate(windows, { left: 395, top: 99, width: 1280, height: 900 }, "Target page").hwnd, 2);
  });

  it("keeps exact CDP geometry authoritative over a distant title match", () => {
    const windows = [
      { hwnd: 1, title: "Visible page - Google Chrome", x: 395, y: 99, width: 1280, height: 900 },
      { hwnd: 2, title: "Target page - Google Chrome", x: 1800, y: 400, width: 1000, height: 700 },
    ];
    assert.equal(selectWindowCandidate(windows, { left: 395, top: 99, width: 1280, height: 900 }, "Target page").hwnd, 1);
  });

  it("rejects a background tab instead of streaming the visible tab", async () => {
    const sessions = {
      call: async () => ({ result: { value: { screenX: 0, screenY: 0, outerWidth: 1280, outerHeight: 900, innerWidth: 1264, innerHeight: 805, devicePixelRatio: 1, title: "Requested tab" } } }),
      cdp: { call: async (method) => method === "Browser.getWindowForTarget" ? { windowId: 7 } : { bounds: { left: 10, top: 10, width: 1280, height: 900 } } },
    };
    await assert.rejects(
      resolveCaptureSource({
        sessions, targetId: "target", browserPid: 42, platform: "win32",
        windowEnumerator: async () => [{ hwnd: 9, title: "Visible tab - Google Chrome", x: 10, y: 10, width: 1280, height: 900, clientWidth: 1264, clientHeight: 892 }],
      }),
      (error) => error.code === "ffmpeg-target-not-visible",
    );
  });
});
