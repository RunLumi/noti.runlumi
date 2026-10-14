/**
 * Text hygiene shared by every mapper and by the canonical validator (spec 04 F41, F48).
 * Every string that reaches a notification came from a third party; these rules decide what
 * counts as unsafe to show: C0/C1 controls, line and paragraph separators, bidirectional
 * overrides and isolates, Unicode noncharacters and unpaired surrogates.
 */

/** Code points that can make text display as something it is not. Tab and newline are opt-in. */
export function isUnsafeCodePoint(cp: number, allowNewlines = false): boolean {
  if (allowNewlines && (cp === 0x09 || cp === 0x0a)) return false;
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    // Unpaired surrogates (a well-formed pair is one code point above 0xffff when iterated).
    (cp >= 0xd800 && cp <= 0xdfff) ||
    // Noncharacters: U+FDD0..U+FDEF and the last two code points of every plane.
    (cp >= 0xfdd0 && cp <= 0xfdef) ||
    (cp & 0xfffe) === 0xfffe
  );
}

/** True when `text` holds any code point {@link isUnsafeCodePoint} rejects. */
export function hasUnsafeText(text: string, allowNewlines = false): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isUnsafeCodePoint(cp, allowNewlines)) return true;
  }
  return false;
}

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair behind. */
export function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** One line of display text: unsafe code points become spaces, whitespace collapses, cut with an ellipsis. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    out += cp !== undefined && isUnsafeCodePoint(cp) ? ' ' : ch;
  }
  const text = out.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${cutAt(text, max - 1).trimEnd()}…` : text;
}
