import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json")) as { name: string; version: string };
const manifest = JSON.parse(read("dsh-plugin.json")) as { id: string; version: string };
const changelog = read("CHANGELOG.md");

/**
 * `package.json` and `dsh-plugin.json` carry the version independently, and a
 * release that bumps only the first ships a package whose manifest lies about
 * itself. That happened at 0.8.4 and again at 0.8.6, so the pair is pinned here
 * rather than left to the release checklist.
 */
describe("release manifests agree", () => {
  it("pins the same version in package.json and dsh-plugin.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("keeps a semver release version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("documents the current version in the changelog", () => {
    expect(changelog).toContain(`## [${pkg.version}]`);
  });

  it("names the plugin consistently across the manifests", () => {
    expect(manifest.id).toBe(pkg.name);
  });
});
