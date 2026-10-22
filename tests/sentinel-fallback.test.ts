import { describe, it, expect } from "vitest";

import { parseSentinelOrLastJson } from "../src/index.ts";

/**
 * #71: a script that succeeded but printed plain JSON (no sentinel) used to be
 * reported as a hard failure. The rescue path accepts the last parseable JSON
 * line and marks it, while the sentinel remains the primary contract.
 */
describe("parseSentinelOrLastJson (#71)", () => {
  it("prefers the sentinel payload over a later plain JSON line", () => {
    const result = parseSentinelOrLastJson(
      'noise\n@@DSH_RESULT@@{"ok":true,"a":1}\nplain {"x":2}\n',
    );
    expect(result).toEqual({ value: { ok: true, a: 1 }, fallback: false });
  });

  it("falls back to the last JSON line when the sentinel is missing", () => {
    const result = parseSentinelOrLastJson('hello\n{"title":"Example Domain"}\n');
    expect(result?.fallback).toBe(true);
    expect(result?.value).toEqual({ title: "Example Domain" });
  });

  it("takes the LAST parseable JSON line when several appear", () => {
    const result = parseSentinelOrLastJson('{"a":1}\nnot json\n{"b":2}\n');
    expect(result?.value).toEqual({ b: 2 });
  });

  it("returns undefined when no line parses as JSON", () => {
    expect(parseSentinelOrLastJson("just text\n")).toBeUndefined();
  });
});
