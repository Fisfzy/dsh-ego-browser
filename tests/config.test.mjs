import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../lib/config.js";

describe("dual capture config", () => {
  it("returns canonical defaults", () => {
    assert.deepEqual(resolveConfig({}), {
      chromePath: "", captureBackend: "auto", streamProfile: "balanced",
      cdpFps: 20, cdpQuality: 55, cdpMaxWidth: 960, cdpBackstopIntervalMs: 3000,
      ffmpegFps: 20, ffmpegMaxWidth: 1280, ffmpegEncoder: "auto", ffmpegPath: "",
    });
  });

  it("migrates legacy CDP fields and lets canonical fields win", () => {
    assert.deepEqual(resolveConfig({ castFpsCap: 60, screencastQuality: 70, screencastMaxWidth: 1200, backstopIntervalMs: 5000 }), {
      chromePath: "", captureBackend: "auto", streamProfile: "balanced",
      cdpFps: 30, cdpQuality: 70, cdpMaxWidth: 1200, cdpBackstopIntervalMs: 5000,
      ffmpegFps: 20, ffmpegMaxWidth: 1280, ffmpegEncoder: "auto", ffmpegPath: "",
    });
    assert.equal(resolveConfig({ cdpFps: 15, castFpsCap: 30 }).cdpFps, 15);
  });

  it("falls back for invalid enums and numbers", () => {
    const config = resolveConfig({ captureBackend: "bad", cdpFps: 99, ffmpegEncoder: "bad" });
    assert.equal(config.captureBackend, "auto");
    assert.equal(config.cdpFps, 20);
    assert.equal(config.ffmpegEncoder, "auto");
  });

  it("applies stream profiles unless advanced FFmpeg fields override them", () => {
    assert.equal(resolveConfig({ streamProfile: "low" }).ffmpegFps, 15);
    assert.equal(resolveConfig({ streamProfile: "high" }).ffmpegMaxWidth, 1600);
    assert.equal(resolveConfig({ streamProfile: "high", ffmpegFps: 12 }).ffmpegFps, 12);
    assert.equal(resolveConfig({ backstopIntervalMs: 200 }).cdpBackstopIntervalMs, 1000);
  });
});
