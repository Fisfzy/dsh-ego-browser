import { describe, it, expect } from "vitest";
import { platformManifest, rewriteGithubUrl } from "../src/ffmpeg-manifest.ts";

describe("managed FFmpeg manifest", () => {
  it("selects pinned platform builds", () => {
    const windows = platformManifest("win32", "x64");
    expect(windows!.buildId).toBe("autobuild-2026-08-17-13-05");
    expect(windows!.url).toMatch(/releases\/download\/autobuild-2026-08-17-13-05\//);
    expect(windows!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(platformManifest("freebsd", "x64")).toBe(null);
  });

  it("replaces only the GitHub origin with an HTTPS mirror", () => {
    const source = "https://github.com/BtbN/FFmpeg-Builds/releases/download/tag/file.zip";
    expect(rewriteGithubUrl(source, "https://gh-proxy.com/github.com/")).toBe("https://gh-proxy.com/github.com/BtbN/FFmpeg-Builds/releases/download/tag/file.zip");
    expect(rewriteGithubUrl(source, "https://ghm.xyz")).toBe("https://ghm.xyz/BtbN/FFmpeg-Builds/releases/download/tag/file.zip");
    expect(rewriteGithubUrl("https://evermeet.cx/ffmpeg/a.zip", "https://ghm.xyz")).toBe("https://evermeet.cx/ffmpeg/a.zip");
    expect(() => rewriteGithubUrl(source, "http://mirror.invalid")).toThrow(expect.objectContaining({ code: "ffmpeg-mirror-invalid" }));
    expect(() => rewriteGithubUrl(source, "https://user:pass@mirror.invalid")).toThrow(expect.objectContaining({ code: "ffmpeg-mirror-invalid" }));
  });
});
