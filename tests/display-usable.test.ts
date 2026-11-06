import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error runtime chrome.mjs is plain ESM without a .d.ts
import { __test } from "../runtime/ego-linux/src/chrome.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ego-display-test-"));
  await mkdir(join(dir, "x11"), { recursive: true });
  return {
    dir,
    x11: join(dir, "x11"),
    socket: async (num: number) => writeFile(join(dir, "x11", `X${num}`), ""),
    lock: async (num: number, pid: number) => writeFile(join(dir, `.X${num}-lock`), String(pid)),
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

describe("X display liveness (#91)", () => {
  it("rejects a socket left behind by a dead X server", async () => {
    const f = await fixture();
    try {
      await f.socket(99);
      await f.lock(99, 2147483647);
      expect(await __test.displayUsable(":99", f.x11, f.dir)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("accepts a socket whose lock pid is alive", async () => {
    const f = await fixture();
    try {
      await f.socket(99);
      await f.lock(99, process.pid);
      expect(await __test.displayUsable(":99", f.x11, f.dir)).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps the old behavior when the socket has no lock file", async () => {
    const f = await fixture();
    try {
      await f.socket(99);
      expect(await __test.displayUsable(":99", f.x11, f.dir)).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("rejects a missing socket", async () => {
    const f = await fixture();
    try {
      expect(await __test.displayUsable(":99", f.x11, f.dir)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("reuses a display whose stale socket is dead instead of drifting", async () => {
    const f = await fixture();
    try {
      await f.socket(99);
      await f.lock(99, 2147483647);
      expect(await __test.pickFreeDisplayNumber(f.x11, f.dir)).toBe(99);
    } finally {
      await f.cleanup();
    }
  });

  it("skips a display whose lock pid is alive", async () => {
    const f = await fixture();
    try {
      await f.socket(99);
      await f.lock(99, process.pid);
      expect(await __test.pickFreeDisplayNumber(f.x11, f.dir)).toBe(98);
    } finally {
      await f.cleanup();
    }
  });
});

describe("platform browser install candidates (#95)", () => {
  it("includes macOS .app bundles / Windows Program Files paths", () => {
    const candidates: string[] = __test.installPathCandidates();
    if (process.platform === "darwin") {
      expect(candidates.some((p) => p.endsWith("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))).toBe(true);
      expect(candidates.some((p) => p.endsWith("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"))).toBe(true);
    } else if (process.platform === "win32") {
      expect(candidates.some((p) => /chrome\.exe$/i.test(p))).toBe(true);
      expect(candidates.some((p) => /msedge\.exe$/i.test(p))).toBe(true);
    }
  });
});
