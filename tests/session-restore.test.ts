import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #67: a stop recorded as a crash leaves `<profile>/Default/Sessions/` behind,
 * and the next cold start resurrects every old tab. stopBrowser() now drops
 * that directory; this pins the helper's contract on a real directory tree.
 */
async function loadHelper() {
  // Dynamic file-URL import: the vendored runtime is plain ESM and not part of
  // the TS program, so a static import would need allowJs.
  const url = new URL("../runtime/ego-linux/src/chrome.mjs", import.meta.url).href;
  const mod = await import(url);
  return mod.clearSessionRestore as (profileDir: string) => Promise<void>;
}

describe("clearSessionRestore (#67)", () => {
  it("removes Default/Sessions recursively and leaves the rest of the profile", async () => {
    const clearSessionRestore = await loadHelper();
    const root = await mkdtemp(join(tmpdir(), "ego-sessions-"));
    const sessions = join(root, "Default", "Sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "Session_1337"), "restore-me");
    await writeFile(join(sessions, "Tabs_1337"), "tab-list");
    await mkdir(join(root, "Default", "Network"), { recursive: true });
    await writeFile(join(root, "Default", "Network", "Cookies"), "keep");

    await clearSessionRestore(root);

    await expect(stat(sessions)).rejects.toThrow();
    expect(await readFile(join(root, "Default", "Network", "Cookies"), "utf8")).toBe("keep");
  });

  it("is a no-op when the profile has no Sessions directory", async () => {
    const clearSessionRestore = await loadHelper();
    const root = await mkdtemp(join(tmpdir(), "ego-sessions-"));
    await expect(clearSessionRestore(root)).resolves.toBeUndefined();
  });
});
