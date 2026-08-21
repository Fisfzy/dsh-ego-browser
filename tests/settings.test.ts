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
