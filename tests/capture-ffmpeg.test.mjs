import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { codecFromAvcInit, selectEncoder } from "../bin/capture-ffmpeg.mjs";

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

  it("derives the MSE codec from avcC", () => {
    const init = Buffer.concat([Buffer.from("xxxxavcC", "ascii"), Buffer.from([1, 0x64, 0, 0x28])]);
    assert.equal(codecFromAvcInit(init), "avc1.640028");
  });
});
