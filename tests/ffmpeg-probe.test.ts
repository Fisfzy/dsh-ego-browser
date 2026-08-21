import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { probeFfmpeg, type SpawnFn } from "../src/ffmpeg-probe.ts";

type FakeChild = EventEmitter & { kill: () => void; stdout: PassThrough; stderr: PassThrough };

function fakeSpawn(handler: (command: string, argv: readonly string[]) => { stdout?: string; stderr?: string; code?: number }): SpawnFn {
  return ((command: string, argv: readonly string[]) => {
    const child = new EventEmitter() as FakeChild;
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
  }) as unknown as SpawnFn;
}

describe("managed FFmpeg capability probe", () => {
  it("requires gfxcapture and selects a working Windows encoder", async () => {
    const spawn = fakeSpawn((_command: string, argv: readonly string[]) => {
      if (argv[0] === "-version") return { stdout: "ffmpeg version test\n" };
      if (argv.includes("filter=gfxcapture")) return { stdout: "Filter gfxcapture\n" };
      return { code: argv.includes("h264_mf") ? 0 : 1 };
    });
    expect(await probeFfmpeg("ffmpeg.exe", { platform: "win32", spawn })).toEqual({ version: "ffmpeg version test", encoder: "h264_mf" });
  });

  it("rejects Wayland before selecting an encoder", async () => {
    const spawn = fakeSpawn((_command: string, argv: readonly string[]) => argv[0] === "-version" ? { stdout: "ffmpeg version test\n" } : { stdout: "x11grab\n" });
    await expect(probeFfmpeg("ffmpeg", { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, spawn })).rejects.toThrow(expect.objectContaining({ code: "ffmpeg-platform-unsupported" }));
  });

  it("validates an explicitly requested encoder", async () => {
    const spawn = fakeSpawn((_command: string, argv: readonly string[]) => {
      if (argv[0] === "-version") return { stdout: "ffmpeg version test\n" };
      if (argv.includes("filter=gfxcapture")) return { stdout: "Filter gfxcapture\n" };
      return { code: 1 };
    });
    await expect(probeFfmpeg("ffmpeg.exe", { platform: "win32", spawn, requestedEncoder: "h264_mf" })).rejects.toThrow(expect.objectContaining({ code: "ffmpeg-encoder-unavailable" }));
  });
});
