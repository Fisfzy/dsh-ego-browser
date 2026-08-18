import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createActiveSpaceTracker } from "../lib/index.js";

describe("active ego task space", () => {
  it("routes omitted-space calls to the most recently opened space", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "open bilibili" }, { ok: true, id: 45, name: "open bilibili" });
    assert.equal(tracker.current(), 45);
  });

  it("tracks explicit selection and resets after closing the active space", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.selected("research");
    assert.equal(tracker.current(), "research");
    tracker.closed("research", true);
    assert.equal(tracker.current(), "dsh-agent");
  });

  it("resets an ID-backed active space when closed by its name", () => {
    const tracker = createActiveSpaceTracker("dsh-agent");
    tracker.opened({ name: "task" }, { ok: true, id: 45, name: "task" });
    tracker.closed("task", true);
    assert.equal(tracker.current(), "dsh-agent");
  });
});
