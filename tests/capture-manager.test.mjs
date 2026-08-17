import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CaptureManager } from "../bin/capture-manager.mjs";

describe("CaptureManager", () => {
  it("runs one backend and increments generation on target switch", async () => {
    const events = [];
    const factory = ({ generation }) => ({
      start: async ({ targetId }) => events.push(["start", targetId, generation]),
      stop: async (reason) => events.push(["stop", reason, generation]),
      updateConfig: async () => {},
    });
    const manager = new CaptureManager({ backendFactories: { cdp: factory }, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    await manager.switchWatch({ clientId: "one", targetId: "b" });
    assert.deepEqual(events.slice(0, 3), [["start", "a", 1], ["stop", "backend-change", 1], ["start", "b", 2]]);
    assert.equal(manager.status().generation, 2);
    await manager.dispose();
  });

  it("does not silently replace an explicit unavailable backend", async () => {
    const manager = new CaptureManager({ backendFactories: { cdp: () => ({ start: async () => {}, stop: async () => {}, updateConfig: async () => {} }) }, getConfig: () => ({ captureBackend: "ffmpeg" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", backend: "ffmpeg", targetId: "a" });
    assert.equal(manager.status().backend, "ffmpeg");
    assert.equal(manager.status().state, "failed");
    await manager.dispose();
  });

  it("renews an existing lease without stealing the shared target", async () => {
    const starts = [];
    const factory = () => ({ start: async ({ targetId }) => starts.push(targetId), stop: async () => {}, updateConfig: async () => {} });
    const manager = new CaptureManager({ backendFactories: { cdp: factory }, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    await manager.startWatch({ clientId: "two", targetId: "b" });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    assert.deepEqual(starts, ["a", "b"]);
    await manager.dispose();
  });

  it("serializes overlapping activations", async () => {
    const events = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const factory = ({ generation }) => ({
      start: async ({ targetId }) => { events.push(`start-${targetId}`); if (generation === 1) await firstGate; events.push(`finish-${targetId}`); },
      stop: async () => events.push(`stop-${generation}`), updateConfig: async () => {},
    });
    const manager = new CaptureManager({ backendFactories: { cdp: factory }, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, leaseTtlMs: 60000 });
    const first = manager.startWatch({ clientId: "one", targetId: "a" });
    const second = manager.startWatch({ clientId: "two", targetId: "b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(events, ["start-a"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["start-a", "finish-a", "stop-1", "start-b", "finish-b"]);
    await manager.dispose();
  });

  it("ignores late status from an obsolete backend and cleans failed starts", async () => {
    const statusCallbacks = [];
    let disposed = 0;
    let attempt = 0;
    const factory = ({ onStatus }) => {
      statusCallbacks.push(onStatus);
      attempt += 1;
      return {
        start: async () => { if (attempt === 1) throw new Error("boom"); },
        stop: async () => {}, dispose: async () => { disposed += 1; }, updateConfig: async () => {},
      };
    };
    const manager = new CaptureManager({ backendFactories: { cdp: factory }, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    assert.equal(disposed, 1);
    await manager.switchWatch({ clientId: "one", targetId: "b" });
    statusCallbacks[0]({ backend: "cdp", state: "failed", message: "late" });
    assert.equal(manager.status().targetId, "b");
    assert.notEqual(manager.status().message, "late");
    await manager.dispose();
  });
});
