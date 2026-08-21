import { describe, it, expect } from "vitest";
import { Mp4FragmentParser } from "../src/worker/mp4-fragments.ts";

function box(type: string, payload = ""): Buffer {
  const body = Buffer.from(payload);
  const result = Buffer.alloc(8 + body.length);
  result.writeUInt32BE(result.length, 0); result.write(type, 4, 4, "ascii"); body.copy(result, 8);
  return result;
}

describe("fragmented MP4 parser", () => {
  it("reassembles arbitrary stdout chunks", () => {
    const init: Buffer[] = [], fragments: Buffer[] = [];
    const parser = new Mp4FragmentParser({ onInit: (value: Buffer) => init.push(value), onFragment: (value: Buffer) => fragments.push(value) });
    const stream = Buffer.concat([box("ftyp", "a"), box("moov", "b"), box("moof", "c"), box("mdat", "d")]);
    for (let i = 0; i < stream.length; i += 3) parser.push(stream.subarray(i, i + 3));
    parser.end();
    expect(init.length).toBe(1); expect(fragments.length).toBe(1);
    expect(init[0].toString("hex")).toBe(Buffer.concat([box("ftyp", "a"), box("moov", "b")]).toString("hex"));
  });

  it("rejects invalid and truncated boxes", () => {
    const parser = new Mp4FragmentParser({ onInit: () => {}, onFragment: () => {} });
    expect(() => parser.push(Buffer.from([0, 0, 0, 4, 102, 116, 121, 112]))).toThrow(/invalid MP4 box size/);
    const truncated = new Mp4FragmentParser({ onInit: () => {}, onFragment: () => {} });
    truncated.push(box("ftyp").subarray(0, 7));
    expect(() => truncated.end()).toThrow(/truncated MP4 stream/);
  });
});
