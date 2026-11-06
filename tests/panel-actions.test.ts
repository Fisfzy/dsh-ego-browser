import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const client = await readFile(new URL("../src/client/index.ts", import.meta.url), "utf8");
const cast = await readFile(new URL("../src/cast-server.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/worker/ego-cast-worker.ts", import.meta.url), "utf8");
const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

describe("panel refresh / URL / maximize controls (#94)", () => {
  it("routes navigate requests through the host and worker", () => {
    expect(cast).toMatch(/EGO_NAVIGATE_ROUTE = '\/api\/ego\/navigate'/);
    expect(cast).toMatch(/proxyPost\(port, '\/api\/navigate', body\)/);
    expect(worker).toMatch(/url\.pathname === '\/api\/navigate'/);
    expect(worker).toMatch(/'Page\.reload'/);
    expect(worker).toMatch(/'Page\.navigate'/);
  });

  it("supports maximizing the real browser window", () => {
    expect(worker).toMatch(/body\.maximize === true/);
    expect(worker).toMatch(/windowState: 'maximized'/);
    expect(cast).toMatch(/maximize \? \{ maximize: true \}/);
  });

  it("wires the buttons and labels in the panel", () => {
    expect(client).toMatch(/openUrlInPanel/);
    expect(client).toMatch(/panelNavigate\('', true\)/);
    expect(client).toMatch(/maximizeWindow/);
    expect(client).toMatch(/refreshPage: '刷新'/);
    expect(client).toMatch(/maximizeWindow: '最大化'/);
    expect(cast).toMatch(/EGO_NAVIGATE_ROUTE/);
  });

  it("does not activate an already-active tab (Windows focus regression, #96)", () => {
    expect(index).toMatch(/__real\.active !== true/);
  });

  it("hides the cursor for screenshots by default (#96)", () => {
    expect(index).toMatch(/hideCursor/);
    expect(index).toMatch(/ego\.hideCursor/);
    expect(index).toMatch(/ego\.showCursor/);
    expect(index).toMatch(/await new Promise\(r => setTimeout\(r, 60\)\)/);
  });
});
