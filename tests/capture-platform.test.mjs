import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCaptureInput, buildEncoderArgs } from "../bin/capture-platform.mjs";

const source = { captureX: 10, captureY: 20, captureWidth: 800, captureHeight: 600 };

describe("FFmpeg argv generation", () => {
  it("uses argv values without a shell on Windows and X11", () => {
    assert.deepEqual(buildCaptureInput({ platform: "win32", source, fps: 20 }).slice(0, 4), ["-f", "gdigrab", "-framerate", "20"]);
    assert.ok(buildCaptureInput({ platform: "linux", env: { DISPLAY: ":9" }, source, fps: 15 }).includes(":9+10,20"));
  });

  it("reports unsupported bundled Wayland capture", () => {
    assert.throws(() => buildCaptureInput({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" }, source, fps: 20 }), (error) => error.code === "unsupported-ffmpeg-pipewire");
  });

  it("builds low-latency fragmented MP4 encoder args", () => {
    const args = buildEncoderArgs({ encoder: "libx264", fps: 20, maxWidth: 1280 });
    assert.ok(args.includes("zerolatency")); assert.ok(args.includes("empty_moov+default_base_moof+frag_keyframe")); assert.equal(args.at(-1), "pipe:1");
  });
});
