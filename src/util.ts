/**
 * src/util.ts — shared small helpers (sentinel / type coercion / JSON helpers).
 *
 * Factored out of index.ts for reuse by other modules. No ctx/cfg dependency,
 * no side effects.
 */
export const SENTINEL = '@@DSH_RESULT@@'

export const j = (v: unknown): string => JSON.stringify(v)

export const str = <T extends string | number>(v: unknown, fallback: T): string | T =>
  typeof v === 'string' && v !== '' ? v : fallback

export const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback

/** Inline helper making arbitrary helper results JSON-safe for the payload. */
export const SAFE_FN =
  'function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n'

export interface CollectReaderLike {
  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
}

/** Read an entire subprocess reader's buffered output. */
export function readAll(reader: CollectReaderLike | undefined | null): string {
  if (!reader) return ''
  return reader.readFrom(0).text
}
