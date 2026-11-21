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

function makeReq(body: unknown, options: { auth?: boolean; url?: string } = {}) {
  const text = JSON.stringify(body);
  return {
    method: "POST",
    url: options.url ?? "/ego/api/set",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3080",
      ...(options.auth === false ? {} : { cookie: "dsh-auth-test=1" }),
    },
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
    async set(patch: Record<string, unknown>, options: { auth?: boolean } = {}) {
      const res = makeRes();
      await handler!(makeReq({ patch }, options), res);
      return res;
    },
    async invoke(method: "get" | "set", body: unknown, options: { auth?: boolean } = {}) {
      const res = makeRes();
      await handler!(makeReq(body, { ...options, url: `/ego/api/${method}` }), res);
      return res;
    },
  };
}

describe("ego-browser settings gateway — auth and local-only keys", () => {
  it("rejects unauthenticated get and set requests", async () => {
    const g = mountGateway({});
    const get = await g.invoke("get", {}, { auth: false });
    expect(get.statusCode).toBe(401);
    expect((get.body() as { error?: { code?: string } }).error?.code).toBe("unauthorized");
    const set = await g.set({ idleTimeoutMin: 30 }, { auth: false });
    expect(set.statusCode).toBe(401);
    expect(g.captured).toEqual([]);
  });

  it("rejects executable/launch keys from the HTTP settings surface", async () => {
    const g = mountGateway({});
    for (const patch of [
      { chromePath: "/tmp/evil" },
      { ffmpegPath: "/tmp/evil" },
      { chromeArgs: "--load-extension=/tmp/evil" },
      { egoCliArgs: "--sdk-path=/tmp/evil" },
    ]) {
      const res = await g.set(patch);
      expect(res.statusCode).toBe(403);
      expect((res.body() as { error?: { code?: string } }).error?.code).toBe("local-config-only");
    }
    expect(g.captured).toEqual([]);
  });
});

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

describe("ego-browser settings gateway — useMockKeychain (#93)", () => {
  // Same contract as above: a switch missing from the allow-list would look
  // saved in the card while nothing persists.
  it("persists the macOS cookie fix switch through /ego/api/set", async () => {
    const g = mountGateway({ useMockKeychain: false });
    const res = await g.set({ useMockKeychain: true });
    expect(g.captured).toEqual([{ useMockKeychain: true }]);
    const body = res.body() as { ok: boolean; value: { config: { useMockKeychain: boolean } } };
    expect(body.ok).toBe(true);
    expect(body.value.config.useMockKeychain).toBe(true);
  });

  it("drops a non-scalar value instead of persisting junk", async () => {
    const g = mountGateway({});
    await g.set({ useMockKeychain: ["nope"] });
    expect(g.captured).toEqual([]);
    expect(g.cfg.useMockKeychain).toBeUndefined();
  });
});

