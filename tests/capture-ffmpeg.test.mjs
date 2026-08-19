import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { assertCaptureSupport, codecFromAvcInit, selectEncoder } from "../bin/capture-ffmpeg.mjs";

function probeSpawn(calls, working) {
  return (_path, argv) => {
    const child = new EventEmitter();
    child.kill = () => {};
    const encoder = argv[argv.indexOf("-c:v") + 1];
    calls.push(encoder);
    queueMicrotask(() => child.emit("exit", encoder === working ? 0 : 1));
    return child;
  };
}

function outputSpawn(output, code = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(output));
      child.emit("exit", code);
    });
    return child;
  };
}

describe("FFmpeg encoder probing", () => {
  it("uses a real probe result and falls back to software", async () => {
    const calls = [];
    const selected = await selectEncoder("ffmpeg", "auto", probeSpawn(calls, "libx264"));
    assert.equal(selected, "libx264");
    assert.equal(calls.at(-1), "libx264");
  });

  it("reports an unavailable explicit encoder", async () => {
    await assert.rejects(selectEncoder("ffmpeg", "h264_nvenc", probeSpawn([], "none")), (error) => error.code === "ffmpeg-encoder-unavailable");
  });

  it("uses Media Foundation hardware encoding first on Windows", async () => {
    const calls = [];
    const selected = await selectEncoder("ffmpeg", "auto", (path, argv) => {
      const child = new EventEmitter();
      child.kill = () => {};
      calls.push(argv);
      queueMicrotask(() => child.emit("exit", argv.includes("h264_mf") ? 0 : 1));
      return child;
    }, {
      source: { sourceType: "window-hwnd", hwnd: "123", captureWidth: 1264, captureHeight: 805 },
      fps: 30,
      maxWidth: 1280,
    }, "win32");
    assert.equal(selected, "h264_mf");
    assert.ok(calls[0].includes("-hw_encoding"));
    assert.ok(calls[0].some((arg) => arg.includes("gfxcapture=hwnd=123")));
  });

  it("rejects Windows FFmpeg builds without gfxcapture", async () => {
    await assert.doesNotReject(assertCaptureSupport("ffmpeg", "win32", outputSpawn("Filter gfxcapture\n")));
    await assert.rejects(
      assertCaptureSupport("ffmpeg", "win32", outputSpawn("Unknown filter 'gfxcapture'.")),
      (error) => error.code === "ffmpeg-gfxcapture-unavailable",
    );
  });

  it("derives the MSE codec from avcC", () => {
    const init = Buffer.concat([Buffer.from("xxxxavcC", "ascii"), Buffer.from([1, 0x64, 0, 0x28])]);
    assert.equal(codecFromAvcInit(init), "avc1.640028");
  });
});
