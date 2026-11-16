import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("watch-panel polling budget", () => {
  it("does not poll executor/login health or renew watch leases from the client", async () => {
    const client = await read("src/client/index.ts");
    expect(client).not.toContain("window.setInterval(load, 15000)");
    expect(client).not.toContain("window.setInterval(load, 8000)");
    expect(client).not.toContain("window.setInterval(function () {\n\t\t\t\tif (self.visible && self.watchTargetId)");
    expect(client).toContain("/api/ego/login-extension/health?peek=1");
    expect(client).toContain("window.setInterval(load, 2000)");
  });

  it("lets the open SSE stream renew watch leases in the worker", async () => {
    const worker = await read("src/worker/ego-cast-worker.ts");
    expect(worker).toContain("watchLeaseKeepAlive");
    expect(worker).toContain("manager.touchAll()");
    const manager = await read("src/worker/capture-manager.ts");
    expect(manager).toContain("touchAll(): void");
  });

  it("peeks login health without starting the bridge", async () => {
    const mod = await import("../src/login-extension.ts");
    const before = mod.peekLoginExtensionHealth();
    expect(before.ok).toBe(true);
    expect(typeof before.port).toBe("number");
  });
});
