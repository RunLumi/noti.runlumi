/**
 * Branch glob matching (docs/specs/10-routing-and-filtering.md F127).
 *
 * Exactly two wildcards: `*` (any run of characters inside one path segment, so not `/`) and
 * `**` (any run, including `/`). A backslash escapes a literal `*` or `\`. Nothing else is
 * special, and characters that look special in other glob dialects (`? [ ] { }`, a leading
 * `!`, `+`) are rejected at write time so nobody believes they work.
 *
 * No RegExp is ever built from user input. A pattern compiles to a token list and matching is
 * a dynamic-programming walk, O(tokens x input) with both bounded by the caps below, so a
 * hostile pattern or branch name cannot cause catastrophic backtracking.
 */
export const GLOB_PATTERN_MAX = 128;
export const GLOB_INPUT_MAX = 255;
/** Wildcards per pattern. A pattern with many is almost certainly a mistake. */
export const GLOB_WILDCARDS_MAX = 8;

export type GlobToken =
  { readonly kind: 'lit'; readonly ch: string } | { readonly kind: 'star' } | { readonly kind: 'dstar' };

export type CompiledGlob = readonly GlobToken[];

export type GlobCompile =
  { readonly ok: true; readonly glob: CompiledGlob } | { readonly ok: false; readonly message: string };

// C0/C1 controls and bidi overrides/isolates. Written as escapes on purpose.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const UNSUPPORTED = new Set(['?', '[', ']', '{', '}', '+']);

/** Case-insensitive, NFC-normalised form used for every identity-like comparison (F124). */
export function fold(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

export function compileGlob(pattern: string): GlobCompile {
  if (pattern.length === 0) return { ok: false, message: 'A pattern cannot be empty.' };
  if (pattern.length > GLOB_PATTERN_MAX)
    return { ok: false, message: `A pattern can be at most ${GLOB_PATTERN_MAX} characters.` };
  if (CONTROL_CHARS.test(pattern))
    return { ok: false, message: 'A pattern cannot contain control characters.' };
  if (pattern.startsWith('!'))
    return { ok: false, message: 'Negated patterns are not supported; use the "ignore" list instead.' };
  const folded = fold(pattern);
  const tokens: GlobToken[] = [];
  let wildcards = 0;
  for (let i = 0; i < folded.length; i++) {
    const ch = folded.charAt(i);
    if (ch === '\\') {
      const next = folded.charAt(i + 1);
      if (next !== '*' && next !== '\\')
        return { ok: false, message: 'A backslash can only escape * or \\.' };
      tokens.push({ kind: 'lit', ch: next });
      i++;
    } else if (ch === '*') {
      let run = 1;
      while (folded.charAt(i + run) === '*') run++;
      if (run > 2) return { ok: false, message: 'Use * or **, not longer runs of stars.' };
      tokens.push({ kind: run === 2 ? 'dstar' : 'star' });
      wildcards++;
      i += run - 1;
    } else if (UNSUPPORTED.has(ch)) {
      return { ok: false, message: 'Only * and ** are supported as wildcards.' };
    } else {
      tokens.push({ kind: 'lit', ch });
    }
  }
  if (wildcards > GLOB_WILDCARDS_MAX)
    return { ok: false, message: `A pattern can have at most ${GLOB_WILDCARDS_MAX} wildcards.` };
  return { ok: true, glob: tokens };
}

/**
 * Match one value. `undefined` means "cannot be compared": the value is longer than the cap,
 * and a truncated comparison could match something it should not (F124).
 */
export function globMatches(glob: CompiledGlob, value: string): boolean | undefined {
  if (value.length > GLOB_INPUT_MAX) return undefined;
  const s = fold(value);
  const n = s.length;
  let row = new Uint8Array(n + 1);
  row[0] = 1;
  for (const token of glob) {
    const next = new Uint8Array(n + 1);
    if (token.kind === 'lit') {
      for (let j = 1; j <= n; j++) next[j] = row[j - 1] === 1 && s.charAt(j - 1) === token.ch ? 1 : 0;
    } else {
      const crossesSlash = token.kind === 'dstar';
      next[0] = row[0] ?? 0;
      for (let j = 1; j <= n; j++) {
        const extend = next[j - 1] === 1 && (crossesSlash || s.charAt(j - 1) !== '/');
        next[j] = row[j] === 1 || extend ? 1 : 0;
      }
    }
    row = next;
  }
  return row[n] === 1;
}
