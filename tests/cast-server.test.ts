import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { createServer, request, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { proxyPost, proxyWorkerStream } from "../src/cast-server.ts";

describe("cast server worker proxy", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      for await (const _chunk of req) {}
      const payload = JSON.stringify({ ok: false, code: "capture-target-stale" });
      res.writeHead(409, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("preserves the worker HTTP status and JSON error", async () => {
    const result = await proxyPost(port, "/api/input", { targetId: "missing" });
    expect(result!.status).toBe(409);
    expect((result!.body as { code?: string }).code).toBe("capture-target-stale");
  });
});

describe("proxyWorkerStream with a worker that appears later", () => {
  let worker: Server;
  let host: Server;
  let workerPort = 0;
  let dispose: () => void = () => {};

  beforeAll(async () => {
    worker = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(":ok\n\n");
      res.write('event: spaces\ndata: [{"targetId":"late"}]\n\n');
    });
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    workerPort = (worker.address() as { port: number }).port;

    let attempts = 0;
    host = createServer((_req: IncomingMessage, res: ServerResponse) => {
      dispose = proxyWorkerStream(-1, res, "/api/stream", async () => {
        attempts += 1;
        return attempts >= 2 ? workerPort : null;
      }, 30);
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    dispose();
    worker.closeAllConnections?.();
    host.closeAllConnections?.();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await new Promise<void>((resolve) => host.close(() => resolve()));
  });

  it("upgrades the quiet stream once the worker exists (panel opened before the browser)", async () => {
    const hostPort = (host.address() as { port: number }).port;
    const text = await new Promise<string>((resolve, reject) => {
      let received = "";
      const client = request({ host: "127.0.0.1", port: hostPort, path: "/", method: "GET" }, (res: IncomingMessage) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/event-stream");
        res.on("data", (chunk: Buffer) => {
          received += chunk.toString();
          if (received.includes('"targetId":"late"')) {
            client.destroy();
            resolve(received);
          }
        });
        res.on("error", reject);
      });
      client.on("error", reject);
      client.end();
      setTimeout(() => reject(new Error("late worker never attached: " + received)), 1500);
    });
    expect(text).toContain("event: spaces");
  });
});

describe("proxyWorkerStream without a live worker", () => {
  let server: Server;

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps the SSE connection open and quiet instead of throwing on the -1 port sentinel", async () => {
    let dispose: () => void = () => {};
    server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      dispose = proxyWorkerStream(-1, res, "/api/stream");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      let text = "";
      const client = request({ host: "127.0.0.1", port, path: "/", method: "GET" }, (res: IncomingMessage) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/event-stream");
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("error", reject);
        // A quiet stream must stay open: after the initial comment frame no
        // further bytes arrive and the response must not end on its own.
        setTimeout(() => {
          expect(text).toBe(":ok\n\n");
          expect(res.destroyed).toBe(false);
          client.destroy();
          resolve();
        }, 200);
      });
      client.on("error", reject);
      client.end();
    });
    dispose();
  });
});
