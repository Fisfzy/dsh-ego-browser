import { describe, it, expect } from "vitest";
import { createActiveSpaceTracker } from "../src/index.ts";

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
});
