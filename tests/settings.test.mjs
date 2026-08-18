import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installEgoBrowserSettings } from "../lib/settings.js";

describe("ego-browser settings bridge", () => {
  it("shares one registered scope across plugin fibers", () => {
    const value = { captureBackend: "ffmpeg", ffmpegPath: "C:\\ffmpeg.exe" };
    const watchers = new Set();
    let registrations = 0;
    const scope = {
      get: () => value,
      watch: (callback) => { watchers.add(callback); return () => watchers.delete(callback); },
    };
    const settings = {
      register: () => { registrations += 1; if (registrations > 1) throw new Error('settings namespace "ego-browser" is already registered'); return scope; },
    };
    const context = (service) => ({
      fiber: { state: 0 },
      inject: (_names, callback) => callback({ settings: service, effect: (factory) => factory() }),
      logger: () => ({ warn: () => {} }),
    });

    const first = installEgoBrowserSettings(context(settings), {});
    const second = installEgoBrowserSettings(context({ ...settings }), {});

    assert.equal(registrations, 1);
    assert.equal(first.source().captureBackend, "ffmpeg");
    assert.equal(second.source().ffmpegPath, "C:\\ffmpeg.exe");
    assert.equal(watchers.size, 2);
  });
});
