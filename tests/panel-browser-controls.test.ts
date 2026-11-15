import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("side-panel browser controls", () => {
  it("registers the new-window and history routes", async () => {
    const server = await read("src/cast-server.ts");
    expect(server).toContain("EGO_OPEN_WINDOW_ROUTE");
    expect(server).toContain("EGO_HISTORY_ROUTE");
    expect(server).toContain("openPanelWindow");
    const worker = await read("src/worker/ego-cast-worker.ts");
    expect(worker).toContain("navigationHistory");
    expect(worker).toContain("Page.navigateToHistoryEntry");
  });

  it("renders a right-edge plus, address bar and history buttons", async () => {
    const client = await read("src/client/index.ts");
    expect(client).toContain("dsh-ego-side-newtab");
    expect(client).toContain("dsh-ego-side-address");
    expect(client).toContain("historyAction('back')");
    expect(client).toContain("historyAction('forward')");
    expect(client).toContain("/api/ego/open-window");
  });

  it("uses browserContext + newWindow in the vendored runtime", async () => {
    const tabs = await read("runtime/ego-linux/src/tabs.mjs");
    expect(tabs).toContain("options.newWindow ? { newWindow: true }");
    const shim = await read("runtime/ego-linux/src/shim.mjs");
    expect(shim).toContain("createWindow:");
    expect(shim).toContain("EGO_LINUX_RAISE_WINDOW");
  });
});
