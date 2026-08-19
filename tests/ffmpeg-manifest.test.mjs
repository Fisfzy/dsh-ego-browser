import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { platformManifest, rewriteGithubUrl } from "../lib/ffmpeg-manifest.js";

describe("managed FFmpeg manifest", () => {
  it("selects pinned platform builds", () => {
    const windows = platformManifest("win32", "x64");
    assert.equal(windows.buildId, "autobuild-2026-08-17-13-05");
    assert.match(windows.url, /releases\/download\/autobuild-2026-08-17-13-05\//);
    assert.match(windows.sha256, /^[a-f0-9]{64}$/);
    assert.equal(platformManifest("freebsd", "x64"), null);
  });

  it("replaces only the GitHub origin with an HTTPS mirror", () => {
    const source = "https://github.com/BtbN/FFmpeg-Builds/releases/download/tag/file.zip";
    assert.equal(rewriteGithubUrl(source, "https://gh-proxy.com/github.com/"), "https://gh-proxy.com/github.com/BtbN/FFmpeg-Builds/releases/download/tag/file.zip");
    assert.equal(rewriteGithubUrl(source, "https://ghm.xyz"), "https://ghm.xyz/BtbN/FFmpeg-Builds/releases/download/tag/file.zip");
    assert.equal(rewriteGithubUrl("https://evermeet.cx/ffmpeg/a.zip", "https://ghm.xyz"), "https://evermeet.cx/ffmpeg/a.zip");
    assert.throws(() => rewriteGithubUrl(source, "http://mirror.invalid"), { code: "ffmpeg-mirror-invalid" });
    assert.throws(() => rewriteGithubUrl(source, "https://user:pass@mirror.invalid"), { code: "ffmpeg-mirror-invalid" });
  });
});
