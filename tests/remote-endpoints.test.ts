import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { EgoRemoteGateway, EGO_REMOTE_NAMESPACE, normalizeWatchRequest } from "../src/remote.ts";

// ── Remote endpoints (src/remote.ts) ───────────────────────────────────────
//
// The watch panel reads its host state through `connection.rpc`, so three things
// have to stay true or the panel silently loses that state:
//   1. the endpoints are actually MARKED — the host gateway claims endpoints
//      from these markers, and an unclaimed endpoint is simply not dispatched;
//   2. the lease wire field keeps its name — SRC descriptors parse parameter
//      names out of the method source, so a bundler rename breaks the contract;
//   3. the client no longer polls the plugin routes this replaced.

/** Endpoint names the host gateway will claim for this service. */
const MARKED = remoteMethods(Object.create(EgoRemoteGateway.prototype) as object)
  .map((marker) => marker.exportName ?? marker.method)
  .sort();

describe("remote endpoints", () => {
  it("marks exactly status + watch on the egoBrowser namespace", () => {
    expect(EGO_REMOTE_NAMESPACE).toBe("egoBrowser");
    expect(MARKED).toEqual(["status", "watch"]);
  });

  it("keeps the lease parameter name the wire contract depends on", () => {
    const markers = remoteMethods(Object.create(EgoRemoteGateway.prototype) as object);
    // Both endpoints are unary: a stream marker would need the mux carrier.
    expect(markers.every((marker) => marker.mode === undefined)).toBe(true);
    const bundlePath = fileURLToPath(new URL("../lib/index.js", import.meta.url));
    if (!existsSync(bundlePath)) return;
    const bundle = readFileSync(bundlePath, "utf8");
    // No decorator syntax may survive the bundle (it is a SyntaxError at load)
    // and the parameter must not have been renamed by the bundler.
    expect(bundle).not.toMatch(/^\s*@Remote\(/m);
    expect(bundle).toContain("watch(egoWatchRequest) {");
  });

  it("validates lease actions and omits absent fields", () => {
    expect(normalizeWatchRequest({ action: "stop", clientId: "c1" })).toEqual({ action: "stop", clientId: "c1" });
    expect(normalizeWatchRequest({ action: "switch", targetId: "tab-1", maxWidth: 1280 }))
      .toEqual({ action: "switch", targetId: "tab-1", maxWidth: 1280 });
    // JSON has no undefined: an absent or empty field must never cross the wire.
    expect(normalizeWatchRequest({ action: "start", clientId: "", maxWidth: 0 })).toEqual({ action: "start" });
    expect(() => normalizeWatchRequest({ action: "poll" })).toThrow(/watch action/);
    expect(() => normalizeWatchRequest(undefined)).toThrow(/watch action/);
  });
});

describe("panel host channel", () => {
  const client = readFileSync(fileURLToPath(new URL("../src/client/index.ts", import.meta.url)), "utf8");

  it("calls the Remote endpoints instead of the removed plugin routes", () => {
    expect(client).toContain("EGO_REMOTE_NAMESPACE");
    for (const gone of [
      "/api/ego/executor",
      "/api/ego/login-extension/health",
      "/api/ego/watch/start",
      "/api/ego/watch/switch",
      "/api/ego/watch/stop",
      "/api/ego/watch/status",
    ]) {
      expect(client, gone).not.toContain(gone);
    }
  });

  it("carries no polling timer for host state", () => {
    // The removed loops were `setInterval(load, 15000 | 8000)`.
    expect(client).not.toMatch(/setInterval\(load/);
  });
});
