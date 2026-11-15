import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordTrajectory, redactTrajectoryArgs } from "../src/trajectory.ts";

let dir: string | undefined;
const previous = process.env.EGO_TRAJECTORY_DIR;

afterEach(async () => {
  if (previous === undefined) delete process.env.EGO_TRAJECTORY_DIR;
  else process.env.EGO_TRAJECTORY_DIR = previous;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function makeDir() {
  dir = await mkdtemp(join(tmpdir(), "ego-trajectory-"));
  process.env.EGO_TRAJECTORY_DIR = dir;
  return dir;
}

describe("tool trajectory recording", () => {
  it("writes one JSONL row with tool/result metadata", async () => {
    const d = await makeDir();
    expect(recordTrajectory(true, false, "session:1", {
      tool: "ego_click",
      args: { selector: "#go", space: "default" },
      value: { ok: true, actionSent: true, page: { url: "https://example.com" } },
      durationMs: 42,
    })).toBe(true);
    const file = join(d, "session_1.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row.tool).toBe("ego_click");
    expect(row.ok).toBe(true);
    expect(row.actionSent).toBe(true);
    expect(row.url).toBe("https://example.com");
    expect(row.durationMs).toBe(42);
  });

  it("redacts fill/key text unless recordText is enabled", async () => {
    expect(redactTrajectoryArgs("ego_fill", { selector: "#q", value: "secret" }, false)).toEqual({
      selector: "#q",
      value: "<redacted>",
    });
    expect(redactTrajectoryArgs("ego_key", { text: "secret" }, false)).toEqual({ text: "<redacted>" });
    expect(redactTrajectoryArgs("ego_fill", { value: "secret" }, true)).toEqual({ value: "secret" });
  });

  it("writes nothing when disabled", async () => {
    const d = await makeDir();
    expect(recordTrajectory(false, false, "s", {
      tool: "ego_click", args: {}, value: { ok: true }, durationMs: 1,
    })).toBe(false);
    await expect(readdir(d)).resolves.toEqual([]);
  });
});
