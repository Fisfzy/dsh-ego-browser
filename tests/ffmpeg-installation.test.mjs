import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { FfmpegInstallationManager, downloadFile } from "../lib/ffmpeg-installation.js";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fakeSpawn(handler) {
  return (command, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      const result = handler(command, argv);
      child.stdout.end(result.stdout || "");
      child.stderr.end(result.stderr || "");
      child.emit("exit", result.code ?? 0);
    });
    return child;
  };
}

describe("FFmpeg installation manager", () => {
  it("prefers a compatible system binary after an invalid custom path", async () => {
    const spawn = fakeSpawn((command, argv) => {
      if (command === "bad-custom") return { code: 1 };
      if (argv[0] === "-version") return { stdout: "ffmpeg version system\n" };
      if (argv.includes("filter=gfxcapture")) return { stdout: "Filter gfxcapture\n" };
      return { code: argv.includes("h264_mf") ? 0 : 1 };
    });
    const manager = new FfmpegInstallationManager({ platform: "win32", arch: "x64", getConfig: () => ({ ffmpegPath: "bad-custom" }), spawn });
    const status = await manager.check();
    assert.equal(status.source, "system");
    assert.equal(status.path, "ffmpeg");
    assert.equal(status.canSelectFfmpeg, true);
    assert.equal(status.candidates[0].usable, false);
  });

  it("downloads, verifies, installs, and selects a managed gzip build", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-ffmpeg-test-")); roots.push(root);
    const binary = Buffer.from("fake-ffmpeg-binary");
    const archive = gzipSync(binary);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const spawn = fakeSpawn((command, argv) => {
      if (command === "ffmpeg") return { code: 1 };
      if (argv[0] === "-version") return { stdout: "ffmpeg version managed\n" };
      if (argv.includes("-devices")) return { stdout: "D  avfoundation\n" };
      return { code: argv.includes("h264_videotoolbox") ? 0 : 1 };
    });
    const manager = new FfmpegInstallationManager({
      platform: "darwin", arch: "x64", cacheRoot: root, getConfig: () => ({ ffmpegPath: "", githubMirror: "" }), spawn,
      fetchImpl: async () => new Response(archive, { status: 200, headers: { "content-length": String(archive.length) } }),
    });
    manager.manifest = { provider: "test", buildId: "pinned", archiveType: "gzip", size: archive.length, url: "https://downloads.invalid/ffmpeg.gz", sha256, executableName: "ffmpeg" };
    const status = await manager.install();
    assert.equal(status.source, "managed");
    assert.equal(status.canSelectFfmpeg, true);
    assert.deepEqual(await readFile(manager.managedPath()), binary);
  });

  it("rejects a checksum mismatch without publishing an install", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-ffmpeg-test-")); roots.push(root);
    const manager = new FfmpegInstallationManager({ platform: "darwin", arch: "x64", cacheRoot: root, fetchImpl: async () => new Response(Buffer.from("bad"), { status: 200 }) });
    manager.manifest = { provider: "test", buildId: "pinned", archiveType: "gzip", size: 3, url: "https://downloads.invalid/ffmpeg.gz", sha256: "0".repeat(64), executableName: "ffmpeg" };
    await assert.rejects(() => manager.install(), { code: "ffmpeg-checksum-mismatch" });
    assert.equal(manager.status().state, "failed");
  });
});

describe("FFmpeg downloader", () => {
  it("reports progress and returns the streamed SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-ffmpeg-test-")); roots.push(root);
    const data = Buffer.from("download-body");
    const progress = [];
    const digest = await downloadFile("https://downloads.invalid/file", join(root, "file"), {
      fetchImpl: async () => new Response(data, { status: 200, headers: { "content-length": String(data.length) } }),
      onProgress: (value) => progress.push(value),
    });
    assert.equal(digest, createHash("sha256").update(data).digest("hex"));
    assert.equal(progress.at(-1).percent, 100);
  });
});
