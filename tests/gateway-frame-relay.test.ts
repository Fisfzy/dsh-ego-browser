import { describe, it, expect } from "vitest";
import { registerEgoBrowserGateway } from "../src/gateway.ts";

// ── settings gateway: the disableFrameRelay switch must be WRITABLE ─────────
//
// The settings card saves through POST /ego/api/set, whose allow-list drops
// unknown keys silently. A missing allow-list entry would make the new switch
// look saved while nothing persists — this pins that contract.

function makeRes() {
  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = String(v);
      return res;
    },
    setHeader(key: string, value: string) { res.headers[key.toLowerCase()] = String(value); return res; },
    write(chunk: unknown) { chunks.push(String(chunk)); return res; },
    end(chunk?: unknown) { if (chunk !== undefined) chunks.push(String(chunk)); return res; },
    on() { return res; },
    once() { return res; },
  };
  return Object.assign(res, { body: () => JSON.parse(chunks.join("") || "{}") as Record<string, unknown> });
}

function makeReq(body: unknown) {
  const text = JSON.stringify(body);
  return {
    method: "POST",
    url: "/ego/api/set",
    headers: { "content-type": "application/json", host: "127.0.0.1:3080" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(text, "utf8"); },
  };
}

/** Mount the gateway over a stubbed settings service + webServer. */
function mountGateway(initial: Record<string, unknown>) {
  const cfg: Record<string, unknown> = { ...initial };
  const captured: Record<string, unknown>[] = [];
  let handler: ((req: unknown, res: unknown) => unknown) | undefined;
  const server = { register(o: { path: string; handler: (req: unknown, res: unknown) => unknown }) { handler = o.handler; return () => {}; } };
  const settings = {
    register() { throw new Error("unused"); },
    async update(_ns: string, patch: Record<string, unknown>) {
      captured.push(patch);
      Object.assign(cfg, patch);
    },
  };
  const ctx = {
    get: (name: string) => (name === "webServer" ? server : undefined),
    effect: (fn: () => unknown) => fn(),
    inject: (_services: readonly string[], cb: (sctx: Record<string, unknown>) => unknown) => cb({ settings }),
  };
  const bridge = { source: () => cfg, onChange: () => () => {} };
  registerEgoBrowserGateway(ctx as never, bridge as never, null);
  return {
    cfg, captured,
    async set(patch: Record<string, unknown>) {
      const res = makeRes();
      await handler!(makeReq({ patch }), res);
      return res;
    },
  };
}

describe("ego-browser settings gateway — disableFrameRelay", () => {
  it("persists the switch through /ego/api/set", async () => {
    const g = mountGateway({ disableFrameRelay: false });
    const res = await g.set({ disableFrameRelay: true });
    expect(g.captured).toEqual([{ disableFrameRelay: true }]);
    const body = res.body() as { ok: boolean; value: { config: { disableFrameRelay: boolean } } };
    expect(body.ok).toBe(true);
    expect(body.value.config.disableFrameRelay).toBe(true);
  });

  it("accepts the boolean only (a junk value is not persisted)", async () => {
    const g = mountGateway({});
    await g.set({ disableFrameRelay: ["nope"] });
    expect(g.captured).toEqual([]);
    expect(g.cfg.disableFrameRelay).toBeUndefined();
  });

  it("does not regress the neighbouring switch (isolateSpaces still writable)", async () => {
    const g = mountGateway({});
    await g.set({ disableFrameRelay: true, isolateSpaces: true });
    expect(g.captured).toEqual([{ disableFrameRelay: true, isolateSpaces: true }]);
  });
});
