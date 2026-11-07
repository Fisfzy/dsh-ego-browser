import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { castStatePath, knownWorkerState } from "../src/worker-client.ts";

const previous = process.env.EGO_LINUX_STATE_DIR;

afterEach(() => {
  if (previous === undefined) delete process.env.EGO_LINUX_STATE_DIR;
  else process.env.EGO_LINUX_STATE_DIR = previous;
});

describe("cast worker state path (#97)", () => {
  it("uses EGO_LINUX_STATE_DIR directly, matching the worker", () => {
    process.env.EGO_LINUX_STATE_DIR = join(tmpdir(), "ego-custom-state");
    expect(castStatePath()).toBe(join(tmpdir(), "ego-custom-state", "ego-cast.json"));
  });

  it("reads ego-cast.json from the custom state dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ego-cast-state-"));
    try {
      await writeFile(join(dir, "ego-cast.json"), JSON.stringify({ port: 45678, pid: 1234 }));
      process.env.EGO_LINUX_STATE_DIR = dir;
      await expect(knownWorkerState()).resolves.toEqual({ port: 45678, pid: 1234 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
