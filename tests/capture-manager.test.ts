import { describe, it, expect } from "vitest";
import { CaptureManager } from "../src/worker/capture-manager.ts";

describe("CaptureManager", () => {
  it("keeps leases alive across background timer throttling", async () => {
    const now = 1000;
    const manager = new CaptureManager({ backendFactories: {}, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, now: () => now, leaseTtlMs: 120000 });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    expect(manager.leases.get("one")!.expiresAt).toBe(now + 120000);
    await manager.dispose();
  });

  it("runs one backend and increments generation on target switch", async () => {
    const events: [string, string, number][] = [];
    const factory = ({ generation }: { generation: number }) => ({
      start: async ({ targetId }: { targetId: string }) => { events.push(["start", targetId, generation]); },
      stop: async (reason: string) => { events.push(["stop", reason, generation]); },
      updateConfig: async () => {},
    });
    const manager = new CaptureManager({ backendFactories: { cdp: factory }, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    await manager.switchWatch({ clientId: "one", targetId: "b" });
    expect(events.slice(0, 3)).toEqual([["start", "a", 1], ["stop", "backend-change", 1], ["start", "b", 2]]);
    expect(manager.status().generation).toBe(2);
    await manager.dispose();
  });

  it("falls back to CDP with a visible reason when FFmpeg is unavailable", async () => {
    const manager = new CaptureManager({ backendFactories: { cdp: () => ({ start: async () => {}, stop: async () => {}, updateConfig: async () => {} }) }, getConfig: () => ({ captureBackend: "ffmpeg" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", backend: "ffmpeg", targetId: "a" });
    expect(manager.status().backend).toBe("cdp");
    expect(manager.status().code).toBe("ffmpeg-fallback-cdp");
    expect(manager.status().message).toMatch(/FFmpeg unavailable/);
    await manager.dispose();
  });

  it("does not claim a successful fallback when CDP also fails", async () => {
    const failing = (message: string) => () => ({ start: async () => { throw new Error(message); }, stop: async () => {}, dispose: async () => {} });
    const manager = new CaptureManager({ backendFactories: { ffmpeg: failing("ffmpeg failed"), cdp: failing("cdp failed") }, getConfig: () => ({ captureBackend: "ffmpeg" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", backend: "ffmpeg", targetId: "a" });
    expect(manager.status().state).toBe("failed");
    expect(manager.status().message).toBe("cdp failed");
    expect(manager.status().code).not.toBe("ffmpeg-fallback-cdp");
    await manager.dispose();
  });

  it("publishes the configured backend while capture is idle", async () => {
    let configured = "cdp";
    const manager = new CaptureManager({ backendFactories: {}, getConfig: () => ({ captureBackend: configured }), onStatus: () => {}, leaseTtlMs: 60000 });
    configured = "ffmpeg";
    await manager.updateConfig();
    expect(manager.status().backend).toBe("ffmpeg");
    expect(manager.status().state).toBe("idle");
    await manager.dispose();
  });

  it("retries a failed backend for an existing lease", async () => {
    let attempts = 0;
    const factory = () => ({
      start: async () => { attempts += 1; if (attempts === 1) throw new Error("transient"); },
      stop: async () => {}, dispose: async () => {}, updateConfig: async () => {},
    });
    const manager = new CaptureManager({ backendFactories: { ffmpeg: factory }, getConfig: () => ({ captureBackend: "ffmpeg" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    expect(manager.status().state).toBe("failed");
    await manager.startWatch({ clientId: "one", targetId: "a" });
    expect(attempts).toBe(2);
    expect(manager.backend).toBeTruthy();
    await manager.dispose();
  });

  it("renews an existing lease without stealing the shared target", async () => {
    const starts: string[] = [];
    const factory = () => ({ start: async ({ targetId }: { targetId: string }) => { starts.push(targetId); }, stop: async () => {}, updateConfig: async () => {} });
    const manager = new CaptureManager({ backendFactories: { cdp: factory }, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    await manager.startWatch({ clientId: "two", targetId: "b" });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    expect(starts).toEqual(["a", "b"]);
    await manager.dispose();
  });

  it("serializes overlapping activations", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const factory = ({ generation }: { generation: number }) => ({
      start: async ({ targetId }: { targetId: string }) => { events.push(`start-${targetId}`); if (generation === 1) await firstGate; events.push(`finish-${targetId}`); },
      stop: async () => { events.push(`stop-${generation}`); }, updateConfig: async () => {},
    });
    const manager = new CaptureManager({ backendFactories: { cdp: factory }, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, leaseTtlMs: 60000 });
    const first = manager.startWatch({ clientId: "one", targetId: "a" });
    const second = manager.startWatch({ clientId: "two", targetId: "b" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["start-a"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["start-a", "finish-a", "stop-1", "start-b", "finish-b"]);
    await manager.dispose();
  });

  it("ignores late status from an obsolete backend and cleans failed starts", async () => {
    const statusCallbacks: ((status: any) => void)[] = [];
    let disposed = 0;
    let attempt = 0;
    const factory = ({ onStatus }: { onStatus: (status: any) => void }) => {
      statusCallbacks.push(onStatus);
      attempt += 1;
      return {
        start: async () => { if (attempt === 1) { const error = new Error("boom") as Error & { code: string }; error.code = "probe-failed"; throw error; } },
        stop: async () => {}, dispose: async () => { disposed += 1; }, updateConfig: async () => {},
      };
    };
    const manager = new CaptureManager({ backendFactories: { cdp: factory }, getConfig: () => ({ captureBackend: "cdp" }), onStatus: () => {}, leaseTtlMs: 60000 });
    await manager.startWatch({ clientId: "one", targetId: "a" });
    expect(disposed).toBe(1);
    expect(manager.status().code).toBe("probe-failed");
    await manager.switchWatch({ clientId: "one", targetId: "b" });
    expect(manager.status().code).toBe(null);
    statusCallbacks[0]({ backend: "cdp", state: "failed", message: "late" });
    expect(manager.status().targetId).toBe("b");
    expect(manager.status().message).not.toBe("late");
    await manager.dispose();
  });
});
