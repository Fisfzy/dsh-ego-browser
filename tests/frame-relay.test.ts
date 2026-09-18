import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initCastServer, stopCastWorker, FRAME_RELAY_DISABLED } from "../src/cast-server.ts";
import { resolveConfig } from "../src/config.ts";

// ── frame-relay master switch (settings: disableFrameRelay) ─────────────────
//
// Contract under test:
//   • relay OFF → the host spawns NO ego-cast worker (so no CDP/WGC screencast
//                 capture and no ffmpeg pull can start) and every worker-backed
//                 route answers a plain JSON refusal instead of a live stream;
//   • relay ON  → behavior is unchanged (the worker is used, SSE is bridged);
//   • the switch is read LIVE: flipping it stops a running worker at once, and
//                 flipping it back makes the routes serve again — no restart.
//
// EGO_LINUX_STATE_DIR is redirected to a throwaway dir for the whole file, so
// the fake state file can never point the plugin at a real worker on this
// machine. The stand-in worker is a REAL child process (real pid → a real
// SIGTERM) running the few loopback endpoints the host touches.

const STATE_DIR = mkdtempSync(join(tmpdir(), "ego-frame-relay-"));
// castStatePath() appends the "ego-lite-linux" segment to EGO_LINUX_STATE_DIR.
const CAST_DIR = join(STATE_DIR, "ego-lite-linux");
const PREV_STATE_DIR = process.env.EGO_LINUX_STATE_DIR;
const WORKER_SCRIPT = fileURLToPath(new URL("./fixtures/fake-cast-worker.cjs", import.meta.url));

beforeAll(() => {
  mkdirSync(CAST_DIR, { recursive: true });
  process.env.EGO_LINUX_STATE_DIR = STATE_DIR;
});

afterAll(() => {
  if (PREV_STATE_DIR === undefined) delete process.env.EGO_LINUX_STATE_DIR;
  else process.env.EGO_LINUX_STATE_DIR = PREV_STATE_DIR;
  rmSync(STATE_DIR, { recursive: true, force: true });
});

function stateFilePath(): string {
  return join(CAST_DIR, "ego-cast.json");
}

function writeWorkerState(port: number, pid: number): void {
  writeFileSync(stateFilePath(), JSON.stringify({ port, pid }), "utf8");
}

interface FakeWorker { proc: ChildProcess; pid: number; port: number }

let workerSeq = 0;

/**
 * Start the stand-in worker. It binds an OS-chosen port and reports it through
 * a file, so the test never pre-allocates a port (which races with the other
 * listeners vitest runs in parallel).
 */
async function startFakeWorker(): Promise<FakeWorker> {
  const portFile = join(CAST_DIR, "worker-" + (++workerSeq) + ".port");
  rmSync(portFile, { force: true });
  const proc = spawn(process.execPath, [WORKER_SCRIPT, portFile], { stdio: "ignore" });
  const pid = proc.pid as number;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error("fake ego-cast worker exited with " + proc.exitCode);
    let port = 0;
    try { port = Number(readFileSync(portFile, "utf8")); } catch { port = 0; }
    if (Number.isInteger(port) && port > 0) {
      for (let i = 0; i < 40; i++) {
        try {
          const res = await fetch("http://127.0.0.1:" + port + "/api/health");
          if (res.ok) return { proc, pid, port };
        } catch { /* not up yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { proc.kill(); } catch { /* ignore */ }
  throw new Error("fake ego-cast worker did not start");
}

function killQuietly(worker: FakeWorker): void {
  try { if (worker.proc.exitCode === null && worker.proc.signalCode === null) worker.proc.kill(); } catch { /* ignore */ }
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

/** Fake node:http response recording the status/headers/body handlers wrote. */
function makeRes() {
  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    headers: {} as Record<string, string>,
    ended: false,
    on() { return res; },
    once() { return res; },
    removeListener() { return res; },
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      res.headersSent = true;
      if (headers) for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = String(v);
      return res;
    },
    setHeader(key: string, value: string) { res.headers[key.toLowerCase()] = String(value); return res; },
    write(chunk: unknown) { chunks.push(String(chunk)); return true; },
    end(chunk?: unknown) { if (chunk !== undefined) chunks.push(String(chunk)); res.ended = true; return res; },
  };
  return Object.assign(res, { body: () => chunks.join("") });
}

/** Request stub that satisfies the /api/ego trust fence. */
function makeReq(path: string, method = "GET") {
  return {
    method,
    url: path,
    headers: { cookie: "dsh-auth-test=1", host: "127.0.0.1:3080" },
    async *[Symbol.asyncIterator]() { /* empty body */ },
  };
}

type RouteHandler = (req: unknown, res: unknown) => unknown;

/** A live config bag: the tests mutate the switch the way the bridge does. */
type LiveConfig = { disableFrameRelay?: boolean } & Record<string, unknown>;

interface Harness {
  spawns: string[][];
  fire: () => void;
  invoke: (path: string, req?: unknown) => Promise<ReturnType<typeof makeRes>>;
}

/**
 * Mount initCastServer against a fake webServer/subprocess pair. The config
 * object is live (the plugin exposes it as a getter over the settings source),
 * so tests flip the switch the way the settings bridge does.
 */
function mount(
  cfg: object,
  opts: { openAgentWindow?: () => Promise<unknown>; loginImport?: (o: unknown) => Promise<unknown> } = {},
): Harness {
  const routes = new Map<string, RouteHandler>();
  const spawns: string[][] = [];
  const listeners = new Set<() => void>();
  const server = {
    register(o: { path: string; handler: RouteHandler }) {
      routes.set(o.path, o.handler);
      return () => routes.delete(o.path);
    },
  };
  const ctx = {
    get: (name: string) => (name === "webServer" ? server : undefined),
    effect: (fn: () => unknown) => fn(),
    subprocess: {
      // A spawn while the relay is OFF is a contract violation — fail loudly.
      spawn(spec: { argv: readonly string[] }) {
        spawns.push([...spec.argv]);
        throw new Error("subprocess.spawn must not be called while the frame relay is disabled");
      },
    },
    logger: Object.assign(() => undefined, { info() {}, warn() {}, error() {} }),
  };
  const live = cfg as LiveConfig;
  const bridge = {
    source: () => live,
    onChange(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
  };
  initCastServer(ctx as never, live as never, bridge as never, null, opts.openAgentWindow as never, opts.loginImport as never);
  return {
    spawns,
    fire: () => { for (const cb of [...listeners]) cb(); },
    async invoke(path: string, req: unknown = makeReq(path)) {
      const handler = routes.get(path);
      if (!handler) throw new Error("no route registered for " + path);
      const res = makeRes();
      await handler(req, res);
      return res;
    },
  };
}

function parseBody(res: ReturnType<typeof makeRes>): Record<string, unknown> {
  return JSON.parse(res.body()) as Record<string, unknown>;
}

/** Worker-backed routes the watch panel uses (GET/status lanes). */
const GATED_ROUTES = [
  "/api/ego/spaces",
  "/api/ego/stream",
  "/api/ego/health",
  "/api/ego/watch/status",
  "/api/ego/video/status",
  "/api/ego/video",
];
/** Worker-backed POST routes (watch leases + panel actions). */
const GATED_POST_ROUTES = [
  "/api/ego/input",
  "/api/ego/close",
  "/api/ego/flush",
  "/api/ego/watch/start",
  "/api/ego/watch/switch",
  "/api/ego/watch/stop",
];

describe("frame relay disabled", () => {
  it("refuses every worker-backed route with an explicit reason and no SSE", async () => {
    const h = mount(resolveConfig({ disableFrameRelay: true }));
    for (const path of GATED_ROUTES) {
      const res = await h.invoke(path);
      expect(res.statusCode, path).toBe(200);
      expect(res.headers["content-type"], path).toContain("application/json");
      const body = parseBody(res);
      expect(body.ok, path).toBe(false);
      expect(body.reason, path).toBe(FRAME_RELAY_DISABLED);
      expect(body.frameRelay, path).toBe(false);
      // A refusal is a complete, ended response — never a dangling stream.
      expect(res.ended, path).toBe(true);
      expect(res.headers["content-type"], path).not.toContain("text/event-stream");
    }
    for (const path of GATED_POST_ROUTES) {
      const res = await h.invoke(path, makeReq(path, "POST"));
      expect(parseBody(res).reason, path).toBe(FRAME_RELAY_DISABLED);
      expect(res.ended, path).toBe(true);
    }
  });

  it("never spawns the ego-cast worker (so no capture backend can start)", async () => {
    const h = mount(resolveConfig({ disableFrameRelay: true }));
    for (const path of GATED_ROUTES) await h.invoke(path);
    for (const path of GATED_POST_ROUTES) await h.invoke(path, makeReq(path, "POST"));
    // Flipping ANY setting while disabled must not spawn/push a worker either.
    h.fire();
    await h.invoke("/api/ego/spaces");
    expect(h.spawns).toEqual([]);
  });

  it("keeps the tab-list shape (and the sidebar auto-open counter) in the refusal", async () => {
    const h = mount(resolveConfig({ disableFrameRelay: true }));
    const body = parseBody(await h.invoke("/api/ego/spaces"));
    expect(body.spaces).toEqual([]);
    expect(typeof body.toolCallCount).toBe("number");
  });

  it("still enforces the trust fence (no cookie → 401, not a refusal)", async () => {
    const h = mount(resolveConfig({ disableFrameRelay: true }));
    const res = await h.invoke("/api/ego/spaces", { method: "GET", url: "/api/ego/spaces", headers: {}, async *[Symbol.asyncIterator]() {} });
    expect(res.statusCode).toBe(401);
  });

  it("leaves the non-relay routes working (raise / login-import are not frame paths)", async () => {
    let raised = 0;
    let imported = 0;
    const h = mount(resolveConfig({ disableFrameRelay: true }), {
      openAgentWindow: async () => { raised += 1; return { ok: true }; },
      loginImport: async () => { imported += 1; return { ok: true, imported: 3 }; },
    });
    expect(parseBody(await h.invoke("/api/ego/raise", makeReq("/api/ego/raise", "POST"))).ok).toBe(true);
    expect(parseBody(await h.invoke("/api/ego/login-import", makeReq("/api/ego/login-import", "POST"))).ok).toBe(true);
    expect([raised, imported]).toEqual([1, 1]);
  });
});

describe("frame relay enabled", () => {
  let worker: FakeWorker;
  const extraWorkers: FakeWorker[] = [];

  beforeAll(async () => {
    worker = await startFakeWorker();
    writeWorkerState(worker.port, worker.pid);
  });

  afterAll(() => {
    rmSync(stateFilePath(), { force: true });
    killQuietly(worker);
    for (const w of extraWorkers) killQuietly(w);
  });

  it("proxies the worker and bridges the SSE stream exactly as before", async () => {
    const h = mount(resolveConfig({}));
    const spaces = parseBody(await h.invoke("/api/ego/spaces"));
    expect(spaces.ok).toBe(true);
    expect(spaces.spaces).toEqual([{ targetId: "tab-1" }]);
    expect(spaces.frameRelay).toBe(true);

    const stream = await h.invoke("/api/ego/stream");
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    expect(stream.body()).toContain(":ok");

    const status = parseBody(await h.invoke("/api/ego/watch/status"));
    expect(status.frameRelay).toBe(true);
    // The live worker was found, so nothing was spawned.
    expect(h.spawns).toEqual([]);
  });

  it("stops the running worker the moment the switch is flipped off, and serves again when flipped back", async () => {
    const cfg = resolveConfig({}) as unknown as LiveConfig;
    const h = mount(cfg);
    expect(parseBody(await h.invoke("/api/ego/spaces")).ok).toBe(true);

    // Flip the live config the way the settings bridge does (src/index.ts
    // exposes disableFrameRelay as a getter over the settings source), then let
    // the plugin's onChange listener react.
    cfg.disableFrameRelay = true;
    h.fire();
    // The worker owns the screencast/ffmpeg capture, so it must be SIGTERMed…
    expect(await waitForExit(worker.proc, 5000)).toBe(true);
    // …and every relay route is refused from then on.
    expect(parseBody(await h.invoke("/api/ego/stream")).reason).toBe(FRAME_RELAY_DISABLED);
    expect(parseBody(await h.invoke("/api/ego/spaces")).ok).toBe(false);

    // Flip it back on: the routes serve a live worker again, no host restart.
    const revived = await startFakeWorker();
    extraWorkers.push(revived);
    writeWorkerState(revived.port, revived.pid);
    cfg.disableFrameRelay = false;
    h.fire();
    expect(parseBody(await h.invoke("/api/ego/spaces")).ok).toBe(true);
    expect(await waitForExit(revived.proc, 2000)).toBe(false);
  });
});

describe("stopCastWorker", () => {
  it("SIGTERMs a live worker recorded in ego-cast.json and reports false when none is live", async () => {
    const worker = await startFakeWorker();
    writeWorkerState(worker.port, worker.pid);
    expect(await stopCastWorker()).toBe(true);
    expect(await waitForExit(worker.proc, 5000)).toBe(true);
    rmSync(stateFilePath(), { force: true });
    expect(await stopCastWorker()).toBe(false);
  });
});
