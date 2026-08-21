import { afterEach, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { FfmpegInstallationManager, downloadFile } from "../src/ffmpeg-installation.ts";
import type { SpawnFn } from "../src/ffmpeg-probe.ts";
import type { FfmpegManifestEntry } from "../src/ffmpeg-manifest.ts";

type FakeChild = EventEmitter & { kill: () => void; stdout: PassThrough; stderr: PassThrough };

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fakeSpawn(handler: (command: string, argv: readonly string[]) => { stdout?: string; stderr?: string; code?: number }): SpawnFn {
  return ((command: string, argv: readonly string[]) => {
    const child = new EventEmitter() as FakeChild;
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
  }) as unknown as SpawnFn;
}

describe("FFmpeg installation manager", () => {
  it("prefers a compatible system binary after an invalid custom path", async () => {
    const spawn = fakeSpawn((command: string, argv: readonly string[]) => {
      if (command === "bad-custom") return { code: 1 };
      if (argv[0] === "-version") return { stdout: "ffmpeg version system\n" };
      if (argv.includes("filter=gfxcapture")) return { stdout: "Filter gfxcapture\n" };
      return { code: argv.includes("h264_mf") ? 0 : 1 };
    });
    const manager = new FfmpegInstallationManager({ platform: "win32", arch: "x64", getConfig: () => ({ ffmpegPath: "bad-custom" }), spawn });
    const status = await manager.check();
    expect(status.source).toBe("system");
    expect(status.path).toBe("ffmpeg");
    expect(status.canSelectFfmpeg).toBe(true);
    expect(status.candidates[0].usable).toBe(false);
  });

  it("downloads, verifies, installs, and selects a managed gzip build", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-ffmpeg-test-")); roots.push(root);
    const binary = Buffer.from("fake-ffmpeg-binary");
    const archive = gzipSync(binary);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const spawn = fakeSpawn((command: string, argv: readonly string[]) => {
      if (command === "ffmpeg") return { code: 1 };
      if (argv[0] === "-version") return { stdout: "ffmpeg version managed\n" };
      if (argv.includes("-devices")) return { stdout: "D  avfoundation\n" };
      return { code: argv.includes("h264_videotoolbox") ? 0 : 1 };
    });
    const manager = new FfmpegInstallationManager({
      platform: "darwin", arch: "x64", cacheRoot: root, getConfig: () => ({ ffmpegPath: "", githubMirror: "" }), spawn,
      fetchImpl: async () => new Response(archive, { status: 200, headers: { "content-length": String(archive.length) } }),
    });
    manager.manifest = { provider: "test", buildId: "pinned", archiveType: "gzip", size: archive.length, url: "https://downloads.invalid/ffmpeg.gz", sha256, executableName: "ffmpeg" } as unknown as FfmpegManifestEntry;
    const status = await manager.install();
    expect(status.source).toBe("managed");
    expect(status.canSelectFfmpeg).toBe(true);
    expect(await readFile(manager.managedPath()!)).toEqual(binary);
  });

  it("rejects a checksum mismatch without publishing an install", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-ffmpeg-test-")); roots.push(root);
    const manager = new FfmpegInstallationManager({ platform: "darwin", arch: "x64", cacheRoot: root, fetchImpl: async () => new Response(Buffer.from("bad"), { status: 200 }) });
    manager.manifest = { provider: "test", buildId: "pinned", archiveType: "gzip", size: 3, url: "https://downloads.invalid/ffmpeg.gz", sha256: "0".repeat(64), executableName: "ffmpeg" } as unknown as FfmpegManifestEntry;
    await expect(manager.install()).rejects.toThrow(expect.objectContaining({ code: "ffmpeg-checksum-mismatch" }));
    expect(manager.status().state).toBe("failed");
  });
});

describe("FFmpeg downloader", () => {
  it("reports progress and returns the streamed SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-ffmpeg-test-")); roots.push(root);
    const data = Buffer.from("download-body");
    const progress: { percent: number }[] = [];
    const digest = await downloadFile("https://downloads.invalid/file", join(root, "file"), {
      fetchImpl: async () => new Response(data, { status: 200, headers: { "content-length": String(data.length) } }),
      onProgress: (value) => progress.push({ percent: value.percent ?? 0 }),
    });
    expect(digest).toBe(createHash("sha256").update(data).digest("hex"));
    expect(progress.at(-1)!.percent).toBe(100);
  });
});
