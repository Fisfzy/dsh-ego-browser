import { describe, it, expect } from "vitest";
import { shouldReapBrowser } from "../src/index.ts";

describe("idle browser reaper (issue #47)", () => {
  const now = 1_000_000_000_000;

  it("is off when idleTimeoutMin is 0", () => {
    expect(shouldReapBrowser(now, now - 999_999_999, 0)).toBe(false);
  });

  it("never reaps when no ego_* call has ever happened", () => {
    expect(shouldReapBrowser(now, 0, 30)).toBe(false);
  });

  it("reaps only after the full idle window", () => {
    const last = now - 31 * 60_000;
    expect(shouldReapBrowser(now, last, 30)).toBe(true);
    const fresh = now - 29 * 60_000;
    expect(shouldReapBrowser(now, fresh, 30)).toBe(false);
  });

  it("handles boundary exactly at the threshold", () => {
    const last = now - 30 * 60_000;
    expect(shouldReapBrowser(now, last, 30)).toBe(false); // not strictly past
    expect(shouldReapBrowser(now, last - 1, 30)).toBe(true);
  });

  it("rejects invalid inputs defensively", () => {
    expect(shouldReapBrowser(now, now - 999_999_999, -5)).toBe(false);
    expect(shouldReapBrowser(now, Number.NaN, 30)).toBe(false);
  });
});
