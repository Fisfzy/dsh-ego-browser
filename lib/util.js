/**
 * lib/util.js — 共享小工具（哨兵 / 类型转换 / JSON 助手）
 *
 * 从 lib/index.js 拆出，供其它模块复用。不依赖 ctx/cfg，无副作用。
 */
export const SENTINEL = "@@DSH_RESULT@@";

export const j = (v) => JSON.stringify(v);

export const str = (v, fallback) =>
  typeof v === "string" && v !== "" ? v : fallback;

export const num = (v, fallback) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);

/** Inline helper making arbitrary helper results JSON-safe for the payload. */
export const SAFE_FN =
  "function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n";

/** Read an entire subprocess reader's buffered output. */
export function readAll(reader) {
  if (!reader) return "";
  return reader.readFrom(0).text;
}
