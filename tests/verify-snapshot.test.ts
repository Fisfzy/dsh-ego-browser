import { describe, it, expect } from "vitest";
import { VERIFY_EVAL_SOURCE, verifyScript } from "../src/index.ts";
import { SnapshotCache } from "../src/snapshot-diff.ts";
import { classifyEgoFailure } from "../src/errors.ts";

function evaluate(predicates: unknown[], doc: Record<string, unknown>, href = "https://example.com/a") {
  const win = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
  const fn = new Function("document", "location", "window", `return ${VERIFY_EVAL_SOURCE}`)(doc, { href }, win);
  return fn(predicates) as Array<{ ok: boolean; observed?: string; reason?: string }>;
}

function el(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: true,
    textContent: "Hello world",
    innerText: "Hello world",
    value: "hello",
    getAttribute: () => "hello",
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    ...overrides,
  };
}

describe("ego_verify script", () => {
  it("builds a polling script with all predicates", () => {
    const script = verifyScript({
      predicates: [{ kind: "selector", selector: "#ok" }, { kind: "text", selector: "h1", contains: "Hello" }],
      timeoutMs: 5000,
      stableSamples: 2,
      pollMs: 200,
      space: "default",
    });
    expect(script).toContain("verdict");
    expect(script).toContain("page.evaluate");
    expect(script).toContain('#ok');
    expect(script).toContain("__streak >= 2");
  });

  it("rejects malformed predicates before touching the page", () => {
    const script = verifyScript({
      predicates: [{ kind: "count", selector: "" } as never],
      timeoutMs: 5000,
      stableSamples: 2,
      pollMs: 200,
      space: "default",
    });
    expect(script).toContain("ok: false");
    expect(script).toContain("requires selector");
    expect(script).not.toContain("page.evaluate");
  });

  it("matches visible text, values and counts in one evaluation", () => {
    const doc = {
      querySelectorAll: (selector: string) => selector === "#items" ? [el(), el()] : selector === "#h" ? [el()] : [],
    };
    const results = evaluate([
      { kind: "text", selector: "#h", contains: "Hello" },
      { kind: "value", selector: "#h", equals: "hello" },
      { kind: "count", selector: "#items", min: 2, max: 2 },
      { kind: "selector", selector: "#missing" },
    ], doc);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]?.reason).toBe("no matching element");
  });

  it("matches URL substrings and globs", () => {
    const doc = { querySelectorAll: () => [] };
    const results = evaluate([
      { kind: "url", url: "example.com" },
      { kind: "url", url: "https://example.com/*" },
      { kind: "url", url: "https://other.test" },
    ], doc);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
  });
});

describe("snapshot generations", () => {
  it("advances the id on a full snapshot and preserves it on a diff", () => {
    const cache = new SnapshotCache(4);
    const first = cache.observe("s:space:full_page", "tree-a", { diff: false });
    expect(first.snapshotId).toMatch(/^s[0-9a-f]{8}$/);
    const second = cache.observe("s:space:full_page", "tree-b", { diff: true });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(cache.currentId("s:space:full_page")).toBe(first.snapshotId);
    const third = cache.observe("s:space:full_page", "tree-c", { diff: false });
    expect(third.snapshotId).not.toBe(first.snapshotId);
    expect(cache.currentId("s:space:full_page")).toBe(third.snapshotId);
  });

  it("classifies an old ref as STALE_REF before the action is sent", () => {
    const failure = classifyEgoFailure("ego_click", "stale snapshot: expected s00000001, current s00000002");
    expect(failure.code).toBe("STALE_REF");
    expect(failure.actionSent).toBe(false);
    expect(failure.retry).toBe("reobserve");
  });
});
