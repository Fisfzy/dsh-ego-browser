import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CdpCaptureBackend } from "../bin/capture-cdp.mjs";

class FakeCdp {
  constructor() { this.handlers = new Map(); this.calls = []; }
  on(method, handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method); }
  async call(method, params, sessionId) { this.calls.push({ method, params, sessionId }); return {}; }
  emit(method, params, sessionId) { this.handlers.get(method)?.(params, sessionId); }
}

describe("CDP capture backend", () => {
  it("ACKs with the frame id while routing on the flattened target session", async () => {
    const cdp = new FakeCdp();
    const session = { targetId: "target-1", sessionId: "target-session", viewportW: 800, viewportH: 600 };
    const sessions = { ensure: async () => session, get: () => session, updateViewport: async () => session };
    const frames = [];
    const backend = new CdpCaptureBackend({ cdp, sessions, getConfig: () => ({ cdpFps: 20, cdpQuality: 55, cdpMaxWidth: 960, cdpBackstopIntervalMs: 10000 }), onStatus: () => {}, onJpegFrame: (frame) => frames.push(frame) });
    await backend.start({ targetId: "target-1" });
    cdp.emit("Page.screencastFrame", { sessionId: 42, data: "jpeg", metadata: { visibleViewportWidth: 800, visibleViewportHeight: 600 } }, "target-session");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(cdp.calls.some((call) => call.method === "Page.screencastFrameAck" && call.params.sessionId === 42 && call.sessionId === "target-session"));
    assert.equal(frames.at(-1).data, "jpeg");
    await backend.stop();
  });

  it("stops the old target before starting a switched target", async () => {
    const cdp = new FakeCdp();
    const sessions = { ensure: async (targetId) => ({ targetId, sessionId: `session-${targetId}` }), get: () => null, updateViewport: async () => ({}) };
    const backend = new CdpCaptureBackend({ cdp, sessions, getConfig: () => ({ cdpFps: 20, cdpQuality: 55, cdpMaxWidth: 960, cdpBackstopIntervalMs: 10000 }), onStatus: () => {}, onJpegFrame: () => {} });
    await backend.start({ targetId: "a" });
    await backend.switchTarget({ targetId: "b" });
    assert.deepEqual(cdp.calls.filter((call) => call.method.includes("Screencast")).map((call) => [call.method, call.sessionId]), [["Page.startScreencast", "session-a"], ["Page.stopScreencast", "session-a"], ["Page.startScreencast", "session-b"]]);
    await backend.stop();
  });
});
