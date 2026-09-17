import { describe, it, expect } from "vitest";
import { createActiveSpaceTracker, runWithStaleSpaceRetry } from "../src/index.ts";

describe("active ego task space", () => {
  it("routes omitted-space calls to the most recently opened space", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "open bilibili" }, { ok: true, id: 45, name: "open bilibili" });
    expect(tracker.current()).toBe(45);
  });

  it("tracks explicit selection and resets after closing the active space", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.selected("research");
    expect(tracker.current()).toBe("research");
    tracker.closed("research", true);
    expect(tracker.current()).toBe("dsh-agent");
  });

  it("resets an ID-backed active space when closed by its name", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 45, name: "task" });
    tracker.closed("task", true);
    expect(tracker.current()).toBe("dsh-agent");
  });

  it("resetToName drops a stale numeric id back to the remembered name", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 45, name: "task" });
    expect(tracker.current()).toBe(45);
    tracker.resetToName();
    expect(tracker.current()).toBe("task");
  });

  it("resetToName falls back to the default space when no name is known", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.selected(7);
    tracker.resetToName();
    expect(tracker.current()).toBe("dsh-agent");
  });
});

// ── stale-space retry (browser restart wipes the runtime's space table) ────

function fakeSubprocess(behavior: Array<{ exitCode: number | null; stdout?: string; stderr?: string }>) {
  let calls = 0;
  const mk = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) });
  return {
    spawn() {
      const b = behavior[Math.min(calls++, behavior.length - 1)];
      return {
        done: Promise.resolve({ exitCode: b.exitCode, signal: null }),
        collected: { stdout: mk(b.stdout ?? ""), stderr: mk(b.stderr ?? "") },
      };
    },
    get calls() { return calls; },
  };
}

const fakeCfg = (tracker: ReturnType<typeof createActiveSpaceTracker>) => ({
  egoBin: "x", egoCliArgs: "", graceMs: 5000, maxOutputBytes: 4096,
  configuredDefaultSpace: "dsh-agent", spaceTracker: tracker,
  get defaultSpace() { return tracker.current() },
}) as never;

const fakeCtx = (subprocess: unknown) => ({ subprocess }) as never;
const fakeExec = {} as never;

describe("runWithStaleSpaceRetry", () => {
  it("retries once with the space NAME after a stale numeric id failure", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 3, name: "task" });
    const subprocess = fakeSubprocess([
      { exitCode: 1, stderr: "Error: task space not found: 3" },
      { exitCode: 0, stdout: "@@DSH_RESULT@@{\"ok\":true}" },
    ]);
    const built: string[] = [];
    const result = await runWithStaleSpaceRetry(fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => {
      built.push(String(tracker.current()));
      return "script";
    });
    expect(result.ok).toBe(true);
    expect(subprocess.calls).toBe(2);
    expect(built).toEqual(["3", "task"]); // first attempt used the stale id, retry used the name
    expect(tracker.current()).toBe("task");
  });

  it("does not retry unrelated failures", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 3, name: "task" });
    const subprocess = fakeSubprocess([{ exitCode: 1, stderr: "some other error" }]);
    const result = await runWithStaleSpaceRetry(fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => "script");
    expect(result.ok).toBe(false);
    expect(subprocess.calls).toBe(1);
    expect(tracker.current()).toBe(3);
  });

  it("does not retry a stale-NAME failure (space genuinely gone)", async () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    const subprocess = fakeSubprocess([{ exitCode: 1, stderr: "Error: task space not found: research" }]);
    const result = await runWithStaleSpaceRetry(fakeCtx(subprocess), fakeCfg(tracker), fakeExec, () => "script");
    expect(result.ok).toBe(false);
    expect(subprocess.calls).toBe(1);
  });
});
