import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/client/index.ts", import.meta.url), "utf8");

describe("watch panel input and capture status", () => {
  it("provides a local keyboard proxy for the sidebar watch view", () => {
    expect(source).toMatch(/function createKeyboardProxy\(send\)/);
    expect(source).toMatch(/compositionend/);
    expect(source).toMatch(/send\([^,]+, 'insertText'/);
    // Floating FAB/overlay was removed in 0.9.3; only the sidebar tab remains.
    expect((source.match(/keyboardProxy\.focusAt\(e,/g) || []).length).toBe(1);
  });

  it("uses the canonical browser-window glyph for the panel header and sidebar entry", () => {
    expect(source).toMatch(/const ICON_AGENT_BROWSER = `<svg width="16" height="16" viewBox="0 0 16 16"/);
    expect(source).toMatch(/__html: ICON_AGENT_BROWSER/);
    expect(source).not.toMatch(/ICON_GLOBE/);
    // String form (panel header) + React EgoWatchIcon (sidebar) share geometry.
    expect((source.match(/M1\.4 5\.9h13\.2/g) || []).length).toBe(2);
    expect((source.match(/M8\.2 7\.0L12\.6 10\.6/g) || []).length).toBe(2);
  });

  it("does not gate control input on stream state or default missing status to CDP", () => {
    expect(source).not.toMatch(/status\.backend \|\| 'cdp'/);
    expect(source).not.toMatch(/targetValid[^\n]+streamState !== 'streaming'/);
  });

  it("keeps the FFmpeg option disabled until installation is ready", () => {
    expect(source).toMatch(/disabled: !ffmpegStatus\.canSelectFfmpeg/);
    expect(source).toMatch(/ffmpeg-install/);
    expect(source).toMatch(/githubMirror/);
  });
});
