import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { validateEgoBinPath } from "../src/config.ts";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

describe("egoBin validation (#87)", () => {
  it("rejects Windows executables with an actionable reason", () => {
    for (const p of [
      "C:\\Program Files\\Citro Labs\\ego lite\\ego-browser.exe",
      "C:\\tools\\ego.cmd",
      "C:\\tools\\ego.bat",
    ]) {
      const result = validateEgoBinPath(p);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/Node-executable script/);
      expect(result.reason).toMatch(/ego-browser\.exe/);
    }
  });

  it("accepts Node scripts and extensionless bridge scripts", () => {
    for (const p of ["C:\\bridge\\ego-cli.mjs", "/opt/ego/bridge.js", "bridge.cjs", "/opt/ego/bridge"]) {
      expect(validateEgoBinPath(p)).toEqual({ ok: true });
    }
  });

  it("rejects an empty egoBin", () => {
    const result = validateEgoBinPath("");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it("wires the validator into tool execution and ego_doctor", () => {
    expect(source).toMatch(/validateEgoBinPath\(cfg\.egoBin\)/);
    expect(source).toMatch(/egoBin kind:/);
    expect(source).toMatch(/egoBin warning:/);
  });

  it("guards ego_tabs on runtime capabilities", () => {
    expect(source).toMatch(/runtime capability missing/);
    expect(source).toMatch(/noBrowser\('listTabs'\)/);
    expect(source).toMatch(/typeof ego\.createTab !== 'function'/);
    expect(source).toMatch(/noBrowser\('closeTab'\)/);
  });
});
