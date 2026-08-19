import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

describe("watch panel input and capture status", () => {
  it("provides local keyboard proxies for floating and sidebar views", () => {
    assert.match(source, /function createKeyboardProxy\(send\)/);
    assert.match(source, /compositionend/);
    assert.match(source, /send\([^,]+, 'insertText'/);
    assert.equal((source.match(/keyboardProxy\.focusAt\(e,/g) || []).length, 2);
  });

  it("does not gate control input on stream state or default missing status to CDP", () => {
    assert.doesNotMatch(source, /status\.backend \|\| 'cdp'/);
    assert.doesNotMatch(source, /targetValid[^\n]+streamState !== 'streaming'/);
  });

  it("keeps the FFmpeg option disabled until installation is ready", () => {
    assert.match(source, /disabled: !ffmpegStatus\.canSelectFfmpeg/);
    assert.match(source, /ffmpeg-install/);
    assert.match(source, /githubMirror/);
  });
});
