import { describe, it, expect } from "vitest";
import { CdpCaptureBackend, TargetSessions } from "../src/worker/capture-cdp.ts";
import type { CdpClient } from "../src/worker/cdp-client.ts";

class FakeCdp {
  handlers: Map<string, (params: any, sessionId?: string) => void>;
  calls: { method: string; params: any; sessionId?: string }[];
  constructor() { this.handlers = new Map(); this.calls = []; }
  on(method: string, handler: (params: any, sessionId?: string) => void) { this.handlers.set(method, handler); return () => this.handlers.delete(method); }
  async call(method: string, params: any, sessionId?: string) { this.calls.push({ method, params, sessionId }); return {}; }
  emit(method: string, params: any, sessionId?: string) { this.handlers.get(method)?.(params, sessionId); }
}

describe("CDP capture backend", () => {
  it("dispatches text, control keys, and modifiers", async () => {
    const calls: { targetId: string; method: string; params: any }[] = [];
    const sessions = { call: async (targetId: string, method: string, params: any) => calls.push({ targetId, method, params }) } as unknown as TargetSessions;
    await TargetSessions.prototype.sendInput.call(sessions, "target", { type: "insertText", text: "中文" });
    await TargetSessions.prototype.sendInput.call(sessions, "target", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await TargetSessions.prototype.sendInput.call(sessions, "target", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    expect(calls.map((call) => call.method)).toEqual(["Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent"]);
    expect(calls[0].params.text).toBe("中文");
    expect(calls[1].params.modifiers).toBe(2);
    expect(calls[1].params.windowsVirtualKeyCode).toBe(65);
  });

  it("ACKs with the frame id while routing on the flattened target session", async () => {
    const cdp = new FakeCdp();
    const session = { targetId: "target-1", sessionId: "target-session", viewportW: 800, viewportH: 600 };
    const sessions = { ensure: async () => session, get: () => session, updateViewport: async () => session } as unknown as TargetSessions;
    const frames: { data: string }[] = [];
    const backend = new CdpCaptureBackend({ cdp: cdp as unknown as CdpClient, sessions, getConfig: () => ({ cdpFps: 20, cdpQuality: 55, cdpMaxWidth: 960, cdpBackstopIntervalMs: 10000 }), onStatus: () => {}, onJpegFrame: (frame: { data: string }) => frames.push(frame) });
    await backend.start({ targetId: "target-1" });
    cdp.emit("Page.screencastFrame", { sessionId: 42, data: "jpeg", metadata: { visibleViewportWidth: 800, visibleViewportHeight: 600 } }, "target-session");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(cdp.calls.some((call) => call.method === "Page.screencastFrameAck" && call.params.sessionId === 42 && call.sessionId === "target-session")).toBeTruthy();
    expect(frames.at(-1)!.data).toBe("jpeg");
    await backend.stop();
  });

  it("stops the old target before starting a switched target", async () => {
    const cdp = new FakeCdp();
    const sessions = { ensure: async (targetId: string) => ({ targetId, sessionId: `session-${targetId}` }), get: () => null, updateViewport: async () => ({}) } as unknown as TargetSessions;
    const backend = new CdpCaptureBackend({ cdp: cdp as unknown as CdpClient, sessions, getConfig: () => ({ cdpFps: 20, cdpQuality: 55, cdpMaxWidth: 960, cdpBackstopIntervalMs: 10000 }), onStatus: () => {}, onJpegFrame: () => {} });
    await backend.start({ targetId: "a" });
    await backend.switchTarget({ targetId: "b" });
    expect(cdp.calls.filter((call) => call.method.includes("Screencast")).map((call) => [call.method, call.sessionId])).toEqual([["Page.startScreencast", "session-a"], ["Page.stopScreencast", "session-a"], ["Page.startScreencast", "session-b"]]);
    await backend.stop();
  });
});
