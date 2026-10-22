import { describe, it, expect } from "vitest";

/**
 * #67 — orphan-tab reaping. The reaper must eventually close page targets that
 * belong to no space (crash-restored pages, hand-opened tabs) without closing
 * one the moment it appears: the selector is two-phase and grace-bound.
 */
async function loadSelector() {
  const url = new URL("../runtime/ego-linux/src/task-spaces.mjs", import.meta.url).href;
  const mod = await import(url);
  return mod.selectOrphans as (
    live: Map<string, { url?: string }>,
    spaces: Array<{ targetIds?: string[] }>,
    seenAt: Record<string, number>,
    now: number,
    graceMs: number,
  ) => { orphans: string[]; next: Record<string, number> };
}

describe("selectOrphans (#67)", () => {
  it("never selects targets a space claims", async () => {
    const selectOrphans = await loadSelector();
    const live = new Map([
      ["a", { url: "https://example.com" }],
      ["b", { url: "https://example.org" }],
    ]);
    const result = selectOrphans(live, [{ targetIds: ["a", "b"] }], {}, 1_000_000, 120_000);
    expect(result.orphans).toEqual([]);
    expect(result.next).toEqual({});
  });

  it("remembers a fresh orphan but does not close it yet", async () => {
    const selectOrphans = await loadSelector();
    const live = new Map([["x", { url: "https://restored.example" }]]);
    const result = selectOrphans(live, [], {}, 1_000_000, 120_000);
    expect(result.orphans).toEqual([]);
    expect(result.next).toEqual({ x: 1_000_000 });
  });

  it("closes an orphan that stayed orphaned past the grace period", async () => {
    const selectOrphans = await loadSelector();
    const live = new Map([["x", { url: "https://restored.example" }]]);
    const seen = { x: 1_000_000 };
    const result = selectOrphans(live, [], seen, 1_120_000, 120_000);
    expect(result.orphans).toEqual(["x"]);
    expect(result.next).toEqual({ x: 1_000_000 });
  });

  it("drops remembered ids that are gone from the live target list", async () => {
    const selectOrphans = await loadSelector();
    const result = selectOrphans(new Map(), [], { gone: 1 }, 2_000_000, 120_000);
    expect(result.next).toEqual({});
  });

  it("never treats about:blank or chrome:// pages as orphans", async () => {
    const selectOrphans = await loadSelector();
    const live = new Map([
      ["blank", { url: "about:blank" }],
      ["ui", { url: "chrome://settings" }],
      ["news", { url: "chrome://newtab" }],
    ]);
    const result = selectOrphans(live, [], { blank: 1, ui: 1, news: 1 }, 9_999_999, 120_000);
    expect(result.orphans).toEqual([]);
    expect(result.next).toEqual({});
  });
});
