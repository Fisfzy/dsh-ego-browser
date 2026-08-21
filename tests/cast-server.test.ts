import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { proxyPost } from "../src/cast-server.ts";

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
