import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { asArrayArg, asStringArray, parseJsonArg } from "../src/util.ts";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const extensionSource = await readFile(new URL("../src/login-extension.ts", import.meta.url), "utf8");
const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

describe("JSON tool arguments (#90)", () => {
  it("parses the string form DSH hands to type:'json' parameters", () => {
    expect(parseJsonArg('["google.com","bilibili.com"]')).toEqual(["google.com", "bilibili.com"]);
    expect(parseJsonArg('{"value":"2"}')).toEqual({ value: "2" });
    expect(parseJsonArg("plain text")).toBe("plain text");
    expect(parseJsonArg("")).toBeUndefined();
    expect(parseJsonArg(undefined)).toBeUndefined();
  });

  it("normalizes domains from JSON, arrays and comma-separated strings", () => {
    expect(asStringArray('["google.com","bilibili.com"]')).toEqual(["google.com", "bilibili.com"]);
    expect(asStringArray(["google.com", " bilibili.com "])).toEqual(["google.com", "bilibili.com"]);
    expect(asStringArray("google.com,bilibili.com")).toEqual(["google.com", "bilibili.com"]);
    expect(asStringArray('"google.com"')).toEqual(["google.com"]);
    expect(asStringArray("")).toBeUndefined();
  });

  it("normalizes generic arrays", () => {
    expect(asArrayArg('["a", "c"]')).toEqual(["a", "c"]);
    expect(asArrayArg("a")).toEqual(["a"]);
  });

  it("uses the normalizers for domains, select values, drag points and CDP params", () => {
    expect(source).toMatch(/asStringArray\(args\.domains\)/);
    expect(source).toMatch(/parseJsonArg\(args\.value\)/);
    expect(source).toMatch(/parseJsonArg\(args\.points\)/);
    expect(source).toMatch(/parseJsonArg\(args\.params\)/);
  });

  it("reads all cookies when no domain list is supplied", () => {
    expect(background).toMatch(/chrome\.cookies\.getAll\(\{\}\)/);
    expect(background).toMatch(/domains\.length === 0/);
  });

  it("reports zero cookies instead of silently succeeding", () => {
    expect(source).toMatch(/warning: \{ type: 'string' \}/);
    expect(extensionSource).toMatch(/returned 0 cookies/);
  });
});
