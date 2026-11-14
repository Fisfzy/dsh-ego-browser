import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("issue #99-#104 regressions", () => {
  it("#99 mutes implicit window activation unless explicitly raised", async () => {
    const transport = await read("runtime/ego-linux/src/transport.mjs");
    expect(transport).toContain("RAISE_METHODS");
    expect(transport).toContain("EGO_LINUX_RAISE_WINDOW");
    expect(transport).toContain("raisingAllowed()");
    expect(transport).toContain("background: true");
    expect(transport).toContain("Emulation.setFocusEmulationEnabled");
    const cli = await read("runtime/ego-linux/bin/ego-browser.mjs");
    expect(cli).toContain('process.env.EGO_LINUX_RAISE_WINDOW = "1"');
  });

  it("#100 routes API and SSE through the deployment base", async () => {
    const client = await read("src/client/index.ts");
    expect(client).toContain("egoRouteBase");
    expect(client).toContain("fetchEgo(");
    expect(client).toContain("new EventSource(egoRoute('/api/ego/stream'))");
    expect(client).not.toContain("fetch('/api/ego/");
  });

  it("#101 live frame fills the panel instead of 50vh", async () => {
    const client = await read("src/client/index.ts");
    expect(client).not.toContain("max-height: 50vh");
    expect(client).toContain(".dsh-ego-side-liveimg {\n  width: 100%; height: 100%;");
  });

  it("#102 screenshot delivery is explicit opt-in", async () => {
    const index = await read("src/index.ts");
    expect(index).toContain("if (args.deliver !== true || typeof file !== 'string'");
  });

  it("#103 active target prefers a real page over list[0]", async () => {
    const worker = await read("src/worker/ego-cast-worker.ts");
    expect(worker).toContain("const real = pages.find((entry) => entry.url !== 'about:blank'");
    expect(worker).toContain("return real?.id || pages[0]?.id || remembered || null");
  });

  it("#104 dismisses native dialogs and lists opener tabs", async () => {
    const runtime = await read("runtime/ego-browser/dist/out/index.js");
    expect(runtime).toContain('rawCdp("Page.handleJavaScriptDialog", { accept: false }, sessionId)');
    const tabs = await read("runtime/ego-linux/src/tabs.mjs");
    expect(tabs).toContain("scope.targetIds.has(target.openerId)");
  });
});
