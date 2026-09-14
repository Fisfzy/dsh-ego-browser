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
