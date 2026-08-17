import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Mp4FragmentParser } from "../bin/mp4-fragments.mjs";

function box(type, payload = "") {
  const body = Buffer.from(payload);
  const result = Buffer.alloc(8 + body.length);
  result.writeUInt32BE(result.length, 0); result.write(type, 4, 4, "ascii"); body.copy(result, 8);
  return result;
}

describe("fragmented MP4 parser", () => {
  it("reassembles arbitrary stdout chunks", () => {
    const init = [], fragments = [];
    const parser = new Mp4FragmentParser({ onInit: (value) => init.push(value), onFragment: (value) => fragments.push(value) });
    const stream = Buffer.concat([box("ftyp", "a"), box("moov", "b"), box("moof", "c"), box("mdat", "d")]);
    for (let i = 0; i < stream.length; i += 3) parser.push(stream.subarray(i, i + 3));
    parser.end();
    assert.equal(init.length, 1); assert.equal(fragments.length, 1);
    assert.equal(init[0].toString("hex"), Buffer.concat([box("ftyp", "a"), box("moov", "b")]).toString("hex"));
  });

  it("rejects invalid and truncated boxes", () => {
    const parser = new Mp4FragmentParser({ onInit: () => {}, onFragment: () => {} });
    assert.throws(() => parser.push(Buffer.from([0, 0, 0, 4, 102, 116, 121, 112])), /invalid MP4 box size/);
    const truncated = new Mp4FragmentParser({ onInit: () => {}, onFragment: () => {} });
    truncated.push(box("ftyp").subarray(0, 7));
    assert.throws(() => truncated.end(), /truncated MP4 stream/);
  });
});
