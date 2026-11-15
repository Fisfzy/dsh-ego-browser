import { describe, it, expect } from "vitest";
import { parseSnapshotContinuation, sliceSnapshotText } from "../src/snapshot-diff.ts";

const TREE = [
  'heading1 "Search"',
  '  form',
  '    textbox "Query" [ref=12, loc=css:#q]',
  '    button "Go" [ref=13, loc=testid:go]',
  '  list',
  '    listitem "Alpha" [ref=20]',
  '    listitem "Beta" [ref=21]',
].join("\n");

describe("snapshot slice/continuation", () => {
  it("crops a ref subtree by indentation", () => {
    const result = sliceSnapshotText(TREE, { subtreeRef: 12, maxChars: 1000 });
    expect(result.error).toBeUndefined();
    expect(result.text).toContain('[ref=12,');
    expect(result.text).not.toContain('[ref=20]');
    expect(result.text).not.toContain('button "Go"');
  });

  it("truncates by maxChars and resumes without repeating", () => {
    const first = sliceSnapshotText(TREE, { maxChars: 80 });
    expect(first.truncated).toBe(true);
    expect(first.text.length).toBeLessThanOrEqual(80);
    const token = `s1234abcd:${first.nextOffset}`;
    const parsed = parseSnapshotContinuation(token);
    expect(parsed).toEqual({ snapshotId: "s1234abcd", offset: first.nextOffset });
    const second = sliceSnapshotText(TREE, { maxChars: 80, offset: parsed!.offset });
    expect(first.text + second.text).toBe(TREE.slice(0, first.nextOffset! + second.text.length));
    expect(second.text).not.toBe("");
  });

  it("rejects a missing subtree ref and an out-of-range continuation", () => {
    expect(sliceSnapshotText(TREE, { subtreeRef: 999 }).error).toContain("not found");
    expect(sliceSnapshotText(TREE, { offset: TREE.length + 1 }).error).toContain("past the end");
  });

  it("rejects malformed continuation tokens", () => {
    expect(parseSnapshotContinuation("not-a-token")).toBeNull();
    expect(parseSnapshotContinuation("s1234abcd:-1")).toBeNull();
  });
});
