import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { probeFfmpeg } from "../bin/ffmpeg-probe.mjs";

function fakeSpawn(handler) {
  return (command, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      const result = handler(command, argv);
      if (result.stdout) child.stdout.end(result.stdout); else child.stdout.end();
      if (result.stderr) child.stderr.end(result.stderr); else child.stderr.end();
      child.emit("exit", result.code ?? 0);
    });
    return child;
  };
}

describe("managed FFmpeg capability probe", () => {
  it("requires gfxcapture and selects a working Windows encoder", async () => {
    const spawn = fakeSpawn((_command, argv) => {
      if (argv[0] === "-version") return { stdout: "ffmpeg version test\n" };
      if (argv.includes("filter=gfxcapture")) return { stdout: "Filter gfxcapture\n" };
      return { code: argv.includes("h264_mf") ? 0 : 1 };
    });
    assert.deepEqual(await probeFfmpeg("ffmpeg.exe", { platform: "win32", spawn }), { version: "ffmpeg version test", encoder: "h264_mf" });
  });

  it("rejects Wayland before selecting an encoder", async () => {
    const spawn = fakeSpawn((_command, argv) => argv[0] === "-version" ? { stdout: "ffmpeg version test\n" } : { stdout: "x11grab\n" });
    await assert.rejects(() => probeFfmpeg("ffmpeg", { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, spawn }), { code: "ffmpeg-platform-unsupported" });
  });

  it("validates an explicitly requested encoder", async () => {
    const spawn = fakeSpawn((_command, argv) => {
      if (argv[0] === "-version") return { stdout: "ffmpeg version test\n" };
      if (argv.includes("filter=gfxcapture")) return { stdout: "Filter gfxcapture\n" };
      return { code: 1 };
    });
    await assert.rejects(() => probeFfmpeg("ffmpeg.exe", { platform: "win32", spawn, requestedEncoder: "h264_mf" }), { code: "ffmpeg-encoder-unavailable" });
  });
});
