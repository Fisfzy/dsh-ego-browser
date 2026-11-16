import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("watch-panel polling budget", () => {
  it("does not renew watch leases from a client timer", async () => {
    const client = await read("src/client/index.ts");
    expect(client).not.toContain("window.setInterval(function () {\n\t\t\t\tif (self.visible && self.watchTargetId)");
    expect(client).toContain("The worker renews watch leases while the SSE stream is open");
  });

  it("lets the open SSE stream renew watch leases in the worker", async () => {
    const worker = await read("src/worker/ego-cast-worker.ts");
    expect(worker).toContain("watchLeaseKeepAlive");
    expect(worker).toContain("manager.touchAll()");
    const manager = await read("src/worker/capture-manager.ts");
    expect(manager).toContain("touchAll(): void");
  });

  it("does not carry a host-state polling timer", async () => {
    const client = await read("src/client/index.ts");
    expect(client).not.toMatch(/setInterval\(load/);
  });
});
