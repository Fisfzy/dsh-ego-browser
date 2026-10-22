/**
 * Tests for the `--serve` resident transport (issue #56).
 *
 * Two layers, deliberately separated:
 *
 *  - UNIT: source-level guards for the per-call isolation helpers. These run
 *    everywhere with no browser, because they are the part most likely to be
 *    refactored and whose failure is SILENT (a restore that misses a property
 *    leaves a poisoned global behind and nothing throws).
 *  - INTEGRATION: the real stdio protocol against a spawned `--serve` process.
 *    Skipped when no browser is reachable, since the shim cannot boot without one.
 *
 * The isolation tests exist because a resident process gives up the guarantee a
 * fresh process gets for free. The failure mode they prevent is subtle:
 * `Object.entries(globalThis)` sees only 15 of 135 own globals on this Node —
 * every built-in (`Object`, `Function`, `Promise`, `Error`, …) is
 * non-enumerable — so an entries-based snapshot silently fails to restore
 * exactly the properties a script is most likely to poison.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(
  new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url),
);

/**
 * Absolute path to a usable browser, or undefined.
 *
 * The plugin's own `resolveEgoEnv` computes this for every real spawn; a test
 * that drives the CLI directly has to do it itself, because the runtime's
 * resolver uses POSIX `which` and cannot find a Windows install on its own.
 */
function findBrowser(): string | undefined {
  const configured = (process.env.EGO_LINUX_CHROME ?? "").trim();
  if (configured !== "") return existsSync(configured) ? configured : undefined;

  const candidates: string[] = [];
  if (process.platform === "win32") {
    const locals = [process.env.LOCALAPPDATA ?? ""];
    const pfs = [
      process.env.ProgramFiles ?? "C:\\Program Files",
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    ];
    for (const base of [...pfs, ...locals]) {
      if (base === "") continue;
      candidates.push(
        base + "\\Google\\Chrome\\Application\\chrome.exe",
        base + "\\Microsoft\\Edge\\Application\\msedge.exe",
        base + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      );
    }
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  }
  return candidates.find((candidate) => existsSync(candidate));
}

interface Frame {
  id: string | null;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

// ─── the guards that must not silently fail ──────────────────────────────

describe("serve isolation guards (source-level)", () => {
  const readCli = () => readFile(CLI, "utf8");

  it("snapshots with getOwnPropertyNames, not Object.entries", async () => {
    const src = await readCli();
    // The bug this pins: Object.entries misses the 120 non-enumerable built-ins.
    expect(src.includes("Object.getOwnPropertyNames(globalThis)")).toBe(true);
    expect(src.includes("Object.entries(globalThis)")).toBe(false);
  });

  it("captures descriptors, so overwrites and accessors are restorable", async () => {
    const src = await readCli();
    expect(src.includes("Object.getOwnPropertyDescriptor")).toBe(true);
    expect(src.includes("Object.defineProperty")).toBe(true);
  });

  it("writes protocol lines through process.stdout.write, never console.log", async () => {
    const src = await readCli();
    // console.log is re-pointed at the run sink by executionContext() and stays
    // that way; a protocol line written with it is swallowed or leaks into a
    // script stdout.
    expect(src.includes("process.stdout.write")).toBe(true);
    const serveBody = src.slice(src.indexOf("async function serve("));
    expect(serveBody.includes("console.log(")).toBe(false);
  });

  it("restores globals in a finally, so a throwing script cannot skip it", async () => {
    const src = await readCli();
    const serveBody = src.slice(src.indexOf("async function serve("));
    const finallyIdx = serveBody.indexOf("} finally {");
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(serveBody.slice(finallyIdx).includes("restoreGlobals(snapshot)")).toBe(true);
  });

  it("keeps the sentinel out of the frame (verbatim streams only)", async () => {
    const src = await readCli();
    const serveBody = src.slice(src.indexOf("async function serve("));
    // The sentinel belongs to the script the caller generates. Stamping it here
    // would force this layer to re-implement last-wins and would let
    // sentinel-shaped script output be mistaken for the response.
    expect(serveBody.includes("SENTINEL")).toBe(false);
    expect(serveBody.includes("@@DSH_RESULT@@")).toBe(false);
  });
});

// ─── the real protocol, against a real process ───────────────────────────

/** Drive a `--serve` child: write requests, collect frames. */
function driveServe(
  codes: string[],
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<{ frames: Frame[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "--serve"], {
      cwd: process.cwd(),
      env: { ...process.env, EGO_LINUX_CHROME: browserPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const collect = (): Frame[] =>
      stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Frame);

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.kill();
      resolve({ frames: collect(), stderr });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      child.kill();
      reject(new Error("serve did not answer in time; stderr: " + stderr.slice(0, 400)));
    }, timeoutMs);

    // Resolve as soon as every request has been answered; exit alone is racy
    // because the child may still be flushing.
    const poll = setInterval(() => { if (collect().length >= codes.length) done(); }, 250);
    child.on("exit", done);

    for (const [index, code] of codes.entries()) {
      child.stdin.write(JSON.stringify({ id: String(index + 1), code }) + "\n");
    }
    child.stdin.end();
  });
}

/**
 * Resolved once: the integration tests cannot boot the shim without a browser,
 * and a Linux box with no display would need Xvfb the runtime does not manage
 * here. Skipping is honest; pretending to run and timing out is not.
 */
const browserPath = findBrowser();
const hasBrowser = browserPath !== undefined
  && !(process.platform === "linux" && (process.env.DISPLAY ?? "").trim() === "" && process.env.EGO_LINUX_HEADLESS !== "1");

describe.skipIf(!hasBrowser)("serve protocol", () => {
  it("answers one frame per request, in order, carrying verbatim stdout", async () => {
    const { frames } = await driveServe([
      'console.log("@@DSH_RESULT@@" + JSON.stringify({ ok: true, n: 1 }))',
      'console.log("@@DSH_RESULT@@" + JSON.stringify({ ok: true, n: 2 }))',
    ]);

    expect(frames.length).toBe(2);
    expect(frames.map((f) => f.id)).toEqual(["1", "2"]);
    expect(frames.every((f) => f.ok)).toBe(true);
    expect(frames[0].stdout).toContain('@@DSH_RESULT@@{"ok":true,"n":1}');
    expect(frames[1].stdout).toContain('@@DSH_RESULT@@{"ok":true,"n":2}');
  }, 240_000);

  it("reports a throwing script as ok:false without breaking the stream", async () => {
    const { frames } = await driveServe([
      'throw new Error("boom")',
      'console.log("still alive")',
    ]);

    expect(frames.length).toBe(2);
    expect(frames[0].ok).toBe(false);
    expect(frames[0].error).toContain("boom");
    // The critical property: a failed request does not wedge the loop.
    expect(frames[1].ok).toBe(true);
    expect(frames[1].stdout).toContain("still alive");
  }, 240_000);

  it("does not leak a global a script added", async () => {
    const { frames } = await driveServe([
      'globalThis.LEAK_PROBE = "leaked"; console.log("set")',
      'console.log("typeof=" + typeof globalThis.LEAK_PROBE)',
    ]);

    expect(frames[1].stdout).toContain("typeof=undefined");
  }, 240_000);

  it("keeps a non-writable built-in intact across requests", async () => {
    const { frames } = await driveServe([
      'console.log("baseline=" + globalThis.Math.PI)',
      'console.log("still=" + globalThis.Math.PI)',
    ]);

    expect(frames[0].stdout).toContain("baseline=3.141592653589793");
    expect(frames[1].stdout).toContain("still=3.141592653589793");
  }, 240_000);

  it("restores a whole object a script replaced", async () => {
    const { frames } = await driveServe([
      'globalThis.Math = { fake: true }; console.log("replaced")',
      'console.log("pi=" + globalThis.Math.PI)',
    ]);

    // If restore missed it, the second call would throw on Math.PI.
    expect(frames[1].ok).toBe(true);
    expect(frames[1].stdout).toContain("pi=3.141592653589793");
  }, 240_000);

  it("keeps the harness surface alive across requests", async () => {
    const { frames } = await driveServe([
      'console.log("ego=" + (typeof globalThis.ego !== "undefined"))',
      'console.log("page=" + (typeof globalThis.page !== "undefined"))',
    ]);

    // restoreGlobals runs after every call and would delete the harness bridge
    // if the serve loop did not re-assert it.
    expect(frames[0].stdout).toContain("ego=true");
    expect(frames[1].stdout).toContain("page=true");
  }, 240_000);

  it("does not mistake sentinel-shaped script output for the response", async () => {
    // A script that merely PRINTS the sentinel is not a response: the frame
    // carries it as data, so last-wins on the blob is unchanged.
    const decoy = 'console.log("@@DSH_RESULT@@{\\"ok\\":false,\\"decoy\\":true}");';
    const real = 'console.log("@@DSH_RESULT@@{\\"ok\\":true,\\"real\\":true}")';
    const { frames } = await driveServe([decoy + " " + real]);

    expect(frames[0].ok).toBe(true);
    const stdout = frames[0].stdout ?? "";
    expect(stdout).toContain("decoy");
    expect(stdout.indexOf("decoy")).toBeLessThan(stdout.indexOf("real"));
  }, 240_000);

  it("answers a malformed line with an error frame instead of dying", async () => {
    const child = spawn(process.execPath, [CLI, "--serve"], {
      cwd: process.cwd(),
      env: { ...process.env, EGO_LINUX_CHROME: browserPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });

    child.stdin.write("this is not json\n");
    child.stdin.write(JSON.stringify({ id: "after", code: 'console.log("alive")' }) + "\n");

    const frames = await new Promise<Frame[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("malformed-line test timed out; stderr: " + stderr.slice(0, 300)));
      }, 180_000);
      const poll = setInterval(() => {
        const lines = stdout.split("\n").filter((l) => l.trim() !== "");
        if (lines.length >= 2) {
          clearInterval(poll);
          clearTimeout(timer);
          child.kill();
          resolve(lines.map((l) => JSON.parse(l) as Frame));
        }
      }, 250);
    });

    expect(frames.length).toBe(2);
    expect(frames[0].ok).toBe(false);
    expect(frames[0].error).toContain("malformed");
    // Proof the loop survived: the next request still got an answer.
    expect(frames[1].id).toBe("after");
    expect(frames[1].ok).toBe(true);
  }, 240_000);
});
