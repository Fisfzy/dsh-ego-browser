import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { assertCaptureSupport, codecFromAvcInit, selectEncoder, type SpawnFn } from "../src/worker/capture-ffmpeg.ts";
import type { CaptureSource } from "../src/worker/capture-platform.ts";

type FakeChild = EventEmitter & { kill: () => void; stdout?: EventEmitter; stderr?: EventEmitter };

function probeSpawn(calls: string[], working: string): SpawnFn {
  return ((_path: string, argv: readonly string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.kill = () => {};
    const encoder = argv[argv.indexOf("-c:v") + 1];
    calls.push(encoder as string);
    queueMicrotask(() => child.emit("exit", encoder === working ? 0 : 1));
    return child;
  }) as unknown as SpawnFn;
}

function outputSpawn(output: string, code = 0): SpawnFn {
  return ((_path: string, _argv: readonly string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout!.emit("data", Buffer.from(output));
      child.emit("exit", code);
    });
    return child;
  }) as unknown as SpawnFn;
}

describe("FFmpeg encoder probing", () => {
  it("uses a real probe result and falls back to software", async () => {
    const calls: string[] = [];
    const selected = await selectEncoder("ffmpeg", "auto", probeSpawn(calls, "libx264"));
    expect(selected).toBe("libx264");
    expect(calls.at(-1)).toBe("libx264");
  });

  it("reports an unavailable explicit encoder", async () => {
    await expect(selectEncoder("ffmpeg", "h264_nvenc", probeSpawn([], "none"))).rejects.toThrow(expect.objectContaining({ code: "ffmpeg-encoder-unavailable" }));
  });

  it("uses Media Foundation hardware encoding first on Windows", async () => {
    const calls: string[][] = [];
    const selected = await selectEncoder("ffmpeg", "auto", ((path: string, argv: readonly string[]) => {
      const child = new EventEmitter() as FakeChild;
      child.kill = () => {};
      calls.push([...argv]);
      queueMicrotask(() => child.emit("exit", argv.includes("h264_mf") ? 0 : 1));
      return child;
    }) as unknown as SpawnFn, {
      source: { sourceType: "window-hwnd", hwnd: "123", captureWidth: 1264, captureHeight: 805 } as unknown as CaptureSource,
      fps: 30,
      maxWidth: 1280,
    }, "win32");
    expect(selected).toBe("h264_mf");
    expect(calls[0].includes("-hw_encoding")).toBeTruthy();
    expect(calls[0].some((arg) => arg.includes("gfxcapture=hwnd=123"))).toBeTruthy();
  });

  it("rejects Windows FFmpeg builds without gfxcapture", async () => {
    await assertCaptureSupport("ffmpeg", "win32", outputSpawn("Filter gfxcapture\n"));
    await expect(assertCaptureSupport("ffmpeg", "win32", outputSpawn("Unknown filter 'gfxcapture'."))).rejects.toThrow(expect.objectContaining({ code: "ffmpeg-gfxcapture-unavailable" }));
  });

  it("derives the MSE codec from avcC", () => {
    const init = Buffer.concat([Buffer.from("xxxxavcC", "ascii"), Buffer.from([1, 0x64, 0, 0x28])]);
    expect(codecFromAvcInit(init)).toBe("avc1.640028");
  });
});
