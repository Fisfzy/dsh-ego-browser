import { describe, it, expect } from "vitest";
import { installEgoBrowserSettings } from "../src/settings.ts";

describe("ego-browser settings bridge", () => {
  it("shares one registered scope across plugin fibers", () => {
    const value = { captureBackend: "ffmpeg", ffmpegPath: "C:\\ffmpeg.exe" };
    const watchers = new Set<(value: unknown) => void>();
    let registrations = 0;
    const scope = {
      get: () => value,
      watch: (callback: (value: unknown) => void) => { watchers.add(callback); return () => watchers.delete(callback); },
    };
    const settings = {
      register: () => { registrations += 1; if (registrations > 1) throw new Error('settings namespace "ego-browser" is already registered'); return scope; },
    };
    const context = (service: typeof settings): any => ({
      fiber: { state: 0 },
      inject: (_names: string[], callback: (services: { settings: typeof settings; effect: (factory: () => unknown) => unknown }) => unknown) => callback({ settings: service, effect: (factory: () => unknown) => factory() }),
      logger: () => ({ warn: () => {} }),
    });

    const first = installEgoBrowserSettings(context(settings), {});
    const second = installEgoBrowserSettings(context({ ...settings }), {});

    expect(registrations).toBe(1);
    expect(first.source().captureBackend).toBe("ffmpeg");
    expect(second.source().ffmpegPath).toBe("C:\\ffmpeg.exe");
    expect(watchers.size).toBe(2);
  });
});

describe("ego-browser settings bridge — DSH 0.1.7 forms service (no register)", () => {
  /** Context whose settings service exposes no register, plus a capture of the host event subscription. */
  function bench() {
    const updates = new Set<(ns: string, revision: number) => void>()
    const bound: string[] = []
    let liveValue: Record<string, unknown> = { cdpFps: 20 };
    const context = {
      fiber: { state: 0 },
      inject: (_names: string[], callback: (services: unknown) => unknown) => callback({
        settings: { update: async () => {} }, // no register — the 0.1.7 shape
        on: (name: string, cb: (ns: string, revision: number) => void) => {
          bound.push(name);
          if (name !== "settings/document-updated") return undefined;
          updates.add(cb);
          return () => { updates.delete(cb); };
        },
        effect: (factory: () => unknown) => factory(),
      }),
    };
    return {
      context,
      updates,
      bound,
      setLive: (value: Record<string, unknown>) => { liveValue = value; },
      live: () => liveValue,
    };
  }

  it("notifies onChange when the host reports a document update for this namespace", () => {
    const b = bench();
    const bridge = installEgoBrowserSettings(b.context as never, { cdpFps: 20 }, b.live);
    const seen: number[] = [];
    bridge.onChange(() => seen.push(seen.length + 1));

    expect(b.bound).toContain("settings/document-updated");
    b.setLive({ cdpFps: 30 });
    for (const cb of [...b.updates]) cb("ego-browser", 1);

    expect(seen).toHaveLength(1);
    // The live source is read at notify time, so consumers push the new value.
    expect(bridge.source().cdpFps).toBe(30);
  });

  it("ignores other namespaces and stops listening on teardown", () => {
    const b = bench();
    const bridge = installEgoBrowserSettings(b.context as never, {}, b.live);
    let notified = 0;
    bridge.onChange(() => { notified += 1; });

    for (const cb of [...b.updates]) cb("some-other-plugin", 1);
    expect(notified).toBe(0);

    for (const cb of [...b.updates]) cb("ego-browser", 2);
    expect(notified).toBe(1);

    // The effect disposer registered at install time owns the unsubscription.
    for (const cb of [...b.updates]) cb("ego-browser", 3);
    expect(notified).toBe(2);
    expect(b.updates.size).toBe(1);
  });
});
