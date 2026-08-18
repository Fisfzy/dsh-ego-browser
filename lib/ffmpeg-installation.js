import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { spawn as nodeSpawn } from "node:child_process";
import { platformManifest, rewriteGithubUrl } from "./ffmpeg-manifest.js";
import { probeFfmpeg } from "../bin/ffmpeg-probe.mjs";

export function defaultFfmpegCacheRoot(home = homedir()) {
  return join(home, ".dsh", "cache", "ego-browser", "ffmpeg");
}

const SHARED_MANAGERS_KEY = Symbol.for("@dsh-external/ego-browser.ffmpeg-installation-managers");
const sharedManagers = globalThis[SHARED_MANAGERS_KEY] || (globalThis[SHARED_MANAGERS_KEY] = new Map());

export function getSharedFfmpegInstallationManager(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const cacheRoot = options.cacheRoot || defaultFfmpegCacheRoot();
  const key = `${platform}:${arch}:${cacheRoot}`;
  if (!sharedManagers.has(key)) sharedManagers.set(key, new FfmpegInstallationManager({ ...options, platform, arch, cacheRoot }));
  return sharedManagers.get(key);
}

export class FfmpegInstallationManager {
  constructor({ getConfig = () => ({}), platform = process.platform, arch = process.arch, env = process.env, cacheRoot = defaultFfmpegCacheRoot(), fetchImpl = globalThis.fetch, spawn = nodeSpawn } = {}) {
    this.getConfig = getConfig;
    this.platform = platform;
    this.arch = arch;
    this.env = env;
    this.cacheRoot = cacheRoot;
    this.fetch = fetchImpl;
    this.spawn = spawn;
    this.manifest = platformManifest(platform, arch);
    this.installPromise = null;
    this.checkPromise = null;
    this.checkKey = null;
    this.statusValue = this.#baseStatus();
  }

  #baseStatus() {
    const unsupported = this.platform === "linux" && (this.env.XDG_SESSION_TYPE === "wayland" || this.env.WAYLAND_DISPLAY);
    return {
      state: unsupported ? "unsupported" : "missing", source: null, path: null, version: null, encoder: null,
      progress: null, canDownload: !unsupported && !!this.manifest, canSelectFfmpeg: false,
      updateAvailable: false, reason: unsupported ? "Wayland capture is not supported" : null, candidates: [],
      platform: this.platform, arch: this.arch, buildId: this.manifest?.buildId || null,
    };
  }

  status() { return structuredClone(this.statusValue); }

  managedPath() {
    if (!this.manifest) return null;
    return join(this.cacheRoot, `${this.platform}-${this.arch}`, this.manifest.buildId, this.manifest.executableName);
  }

  async check({ configuredPath, requestedEncoder = "auto" } = {}) {
    if (this.installPromise) return this.status();
    const key = JSON.stringify([configuredPath ?? "", requestedEncoder]);
    if (this.checkPromise) {
      if (this.checkKey === key) return this.checkPromise;
      await this.checkPromise.catch(() => {});
    }
    if (this.statusValue.state === "unsupported") return this.status();
    this.checkKey = key;
    const promise = this.#check(configuredPath, requestedEncoder).finally(() => {
      if (this.checkPromise === promise) { this.checkPromise = null; this.checkKey = null; }
    });
    this.checkPromise = promise;
    return this.checkPromise;
  }

  async #check(configuredPath, requestedEncoder = "auto") {
    this.#set({ state: "checking", reason: null, progress: null, canSelectFfmpeg: false });
    const custom = configuredPath ?? this.getConfig().ffmpegPath ?? "";
    const candidates = [];
    if (custom) candidates.push({ source: "custom", path: custom });
    candidates.push({ source: "system", path: "ffmpeg" });
    const managed = this.managedPath();
    if (managed) candidates.push({ source: "managed", path: managed });
    const results = [];
    for (const candidate of candidates) {
      try {
        const probe = await probeFfmpeg(candidate.path, { platform: this.platform, env: this.env, spawn: this.spawn, requestedEncoder });
        results.push({ ...candidate, usable: true, version: probe.version, encoder: probe.encoder });
        this.#set({
          state: "ready", source: candidate.source, path: candidate.path, version: probe.version, encoder: probe.encoder,
          canSelectFfmpeg: true, canDownload: !!this.manifest, reason: null, candidates: results,
          updateAvailable: candidate.source === "managed" && !normalize(candidate.path).includes(normalize(this.manifest?.buildId || "")),
        });
        return this.status();
      } catch (error) {
        results.push({ ...candidate, usable: false, code: error.code || "ffmpeg-unavailable", reason: error.message });
      }
    }
    this.#set({ ...this.#baseStatus(), state: "missing", candidates: results, reason: results[0]?.reason || "No compatible FFmpeg installation was found" });
    return this.status();
  }

  async resolvedPath() {
    const status = this.statusValue.state === "ready" ? this.status() : await this.check();
    return status.canSelectFfmpeg ? status.path : null;
  }

  install({ githubMirror, configuredPath, requestedEncoder = "auto" } = {}) {
    if (this.installPromise) return this.installPromise;
    if (!this.manifest) return Promise.reject(codedError("ffmpeg-platform-unsupported", `No managed FFmpeg build for ${this.platform}-${this.arch}`));
    this.installPromise = this.#install(githubMirror ?? this.getConfig().githubMirror ?? "", configuredPath ?? this.getConfig().ffmpegPath ?? "", requestedEncoder)
      .finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  startInstall(options = {}) {
    void this.install(options).catch(() => {});
    return this.status();
  }

  async #install(githubMirror, configuredPath, requestedEncoder) {
    const manifest = this.manifest;
    const platformRoot = join(this.cacheRoot, `${this.platform}-${this.arch}`);
    const tempRoot = join(platformRoot, `.install-${randomUUID()}`);
    const archivePath = join(tempRoot, `archive.${manifest.archiveType === "gzip" ? "gz" : "pkg"}`);
    const extractedPath = join(tempRoot, manifest.executableName);
    const finalRoot = join(platformRoot, manifest.buildId);
    const finalPath = join(finalRoot, manifest.executableName);
    let releaseLock = null;
    let backup = null;
    let published = false;
    try {
      await mkdir(platformRoot, { recursive: true });
      releaseLock = await acquireInstallLock(platformRoot);
      await cleanupInterruptedInstalls(platformRoot);
      if (manifest.archiveType === "tar") await ensureTarAvailable(this.spawn);
      await mkdir(tempRoot, { recursive: true });
      const url = rewriteGithubUrl(manifest.url, githubMirror);
      this.#set({ state: "downloading", reason: null, progress: { receivedBytes: 0, totalBytes: manifest.size, percent: 0 }, canSelectFfmpeg: false });
      const digest = await downloadFile(url, archivePath, {
        fetchImpl: this.fetch, expectedSize: manifest.size,
        onProgress: (progress) => this.#set({ state: "downloading", progress }),
      });
      this.#set({ state: "verifying", progress: null });
      if (digest !== manifest.sha256) throw codedError("ffmpeg-checksum-mismatch", "Downloaded FFmpeg archive failed SHA-256 verification");
      this.#set({ state: "extracting" });
      if (manifest.archiveType === "gzip") {
        await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(extractedPath, { mode: 0o755 }));
      } else {
        await extractWithTar(archivePath, tempRoot, extractedPath, manifest.archiveExecutable, this.spawn);
      }
      if (this.platform !== "win32") await chmod(extractedPath, 0o755);
      if (this.platform === "darwin") await prepareMacExecutable(extractedPath, this.arch, this.spawn);
      this.#set({ state: "probing" });
      const probe = await probeFfmpeg(extractedPath, { platform: this.platform, env: this.env, spawn: this.spawn, requestedEncoder });
      const executableSha256 = await hashFile(extractedPath);
      await writeFile(join(tempRoot, "install.json"), JSON.stringify({
        provider: manifest.provider, buildId: manifest.buildId, archiveSha256: manifest.sha256,
        executableSha256, installedAt: new Date().toISOString(), version: probe.version, encoder: probe.encoder,
      }, null, 2));
      await rm(archivePath, { force: true });
      backup = `${finalRoot}.old-${randomUUID()}`;
      let hadExisting = false;
      try { await rename(finalRoot, backup); hadExisting = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      await mkdir(dirname(finalRoot), { recursive: true });
      await rename(tempRoot, finalRoot);
      published = true;
      await access(finalPath, this.platform === "win32" ? constants.F_OK : constants.X_OK);
      if (hadExisting) await rm(backup, { recursive: true, force: true });
      backup = null;
      return await this.#check(configuredPath, requestedEncoder);
    } catch (error) {
      if (published) await rm(finalRoot, { recursive: true, force: true }).catch(() => {});
      if (backup) await rename(backup, finalRoot).catch(() => {});
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      this.#set({ state: "failed", reason: error.message, progress: null, canSelectFfmpeg: false, canDownload: true });
      throw error;
    } finally {
      await releaseLock?.();
    }
  }

  #set(patch) { this.statusValue = { ...this.statusValue, ...patch }; }
}

async function acquireInstallLock(platformRoot) {
  const lockPath = join(platformRoot, ".install.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
      return async () => {
        await handle.close().catch(() => {});
        const owner = await import("node:fs/promises").then((fs) => fs.readFile(lockPath, "utf8")).then(JSON.parse).catch(() => null);
        if (owner?.token === token) await rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await import("node:fs/promises").then((fs) => fs.readFile(lockPath, "utf8")).then(JSON.parse).catch(() => null);
      if (!owner?.pid || !isProcessAlive(owner.pid)) { await rm(lockPath, { force: true }); continue; }
      throw codedError("ffmpeg-install-busy", "Another FFmpeg installation is already running");
    }
  }
  throw codedError("ffmpeg-install-busy", "Another FFmpeg installation is already running");
}

function isProcessAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function cleanupInterruptedInstalls(platformRoot) {
  const entries = await readdir(platformRoot, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(".install-")).map((entry) => rm(join(platformRoot, entry.name), { recursive: true, force: true })));
}

export async function downloadFile(url, target, { fetchImpl = globalThis.fetch, expectedSize = null, onProgress = () => {}, maxBytes = 250 * 1024 * 1024 } = {}) {
  let current = url;
  let response;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertSafeDownloadUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try { response = await fetchImpl(current, { redirect: "manual", signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw codedError("ffmpeg-download-failed", "FFmpeg download redirect omitted Location");
    current = new URL(location, current).toString();
    await response.body?.cancel().catch(() => {});
    if (!current.startsWith("https://")) throw codedError("ffmpeg-download-failed", "FFmpeg download refused a non-HTTPS redirect");
    if (redirects === 5) throw codedError("ffmpeg-download-failed", "Too many FFmpeg download redirects");
  }
  if (!response?.ok || !response.body) throw codedError("ffmpeg-download-failed", `FFmpeg download failed with HTTP ${response?.status || 0}`);
  const declared = Number(response.headers.get("content-length")) || expectedSize || null;
  const hash = createHash("sha256");
  const file = await import("node:fs/promises").then((fs) => fs.open(target, "w"));
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await readChunk(reader, 30000);
      if (done) break;
      const buffer = Buffer.from(value);
      received += buffer.length;
      if (received > maxBytes) throw codedError("ffmpeg-download-failed", "FFmpeg archive exceeds the allowed size");
      hash.update(buffer);
      await file.write(buffer);
      onProgress({ receivedBytes: received, totalBytes: declared, percent: declared ? Math.min(100, Math.round(received * 100 / declared)) : null });
    }
  } finally { await reader.cancel().catch(() => {}); await file.close(); }
  return hash.digest("hex");
}

async function ensureTarAvailable(spawn) {
  try { await runCommand("tar", ["--version"], spawn, 5000); }
  catch { throw codedError("ffmpeg-extractor-unavailable", "The managed FFmpeg archive requires the system tar extractor"); }
}

function assertSafeDownloadUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || isPrivateIp(host)) {
    throw codedError("ffmpeg-download-failed", "FFmpeg downloads require a public HTTPS destination");
  }
}

function isPrivateIp(host) {
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (family === 6) return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  return false;
}

async function extractWithTar(archivePath, tempRoot, destination, matcher, spawn) {
  const listing = await runCommand("tar", ["-tf", archivePath], spawn, 15000);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  const matches = entries.filter((entry) => safeArchiveEntry(entry) && matcher.test(entry));
  if (matches.length !== 1) throw codedError("ffmpeg-executable-missing", `Expected one FFmpeg executable in archive, found ${matches.length}`);
  const entry = matches[0];
  await runCommand("tar", ["-xf", archivePath, "-C", tempRoot, entry], spawn, 60000);
  const extracted = resolve(tempRoot, normalize(entry));
  if (!extracted.startsWith(resolve(tempRoot) + sep)) throw codedError("ffmpeg-archive-unsafe", "FFmpeg archive path escaped the install directory");
  await copyFile(extracted, destination);
}

function safeArchiveEntry(entry) {
  const value = entry.replaceAll("\\", "/");
  return value !== "" && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").includes("..");
}

async function prepareMacExecutable(path, arch, spawn) {
  await runCommand("xattr", ["-d", "com.apple.quarantine", path], spawn, 5000).catch(() => {});
  if (arch === "arm64") await runCommand("codesign", ["--force", "--sign", "-", path], spawn, 15000).catch(() => {});
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function readChunk(reader, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(codedError("ffmpeg-download-timeout", "FFmpeg download stalled")), timeoutMs);
    reader.read().then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function runCommand(command, argv, spawn, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => code === 0 ? finish(resolvePromise, { stdout, stderr }) : finish(reject, codedError("ffmpeg-archive-invalid", stderr || `${command} exited with ${code}`)));
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {}; finish(reject, codedError("ffmpeg-archive-invalid", `${command} timed out`)); }, timeoutMs);
  });
}

function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
