/** Remove escape sequences before controls, preserving printable layout spaces. */
function terminalText(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
}
/** Compact a scalar locator or detail into a single terminal-safe line. */
export function sanitizeText(value: string): string {
  return terminalText(value).replace(/\s+/g, ' ').trim()
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function graphemeWidth(value: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) return 2
  let width = 0
  for (const char of value) {
    if (/\p{Mark}|\p{Cf}/u.test(char)) continue
    const cp = char.codePointAt(0)!
    width += cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)) ? 2 : 1
  }
  return width
}
export function displayWidth(text: string): number {
  return [...segmenter.segment(terminalText(text))].reduce((sum, part) => sum + graphemeWidth(part.segment), 0)
}
/** Truncate without splitting combining sequences, emoji or terminal-wide cells. */
export function truncateCells(text: string, maxCells: number): string {
  const clean = terminalText(text)
  const limit = Math.max(0, Math.floor(maxCells))
  if (!limit) return ''
  if (displayWidth(clean) <= limit) return clean
  let result = '', cells = 0
  for (const part of segmenter.segment(clean)) {
    const width = graphemeWidth(part.segment)
    if (cells + width > limit - 1) break
    cells += width
    result += part.segment
  }
  return result + '…'
}
