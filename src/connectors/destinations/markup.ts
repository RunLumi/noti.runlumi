import type { MarkupDialect } from './types';

/**
 * Escaping and length-fitting for untrusted text (F94/F95).
 *
 * Text is handled as a list of *atoms*: the smallest units that may not be split. An escaped
 * grapheme (`&` → `&amp;`) is one atom, and a whole link is one atom, so truncation can
 * never cut through a surrogate pair, a combining sequence, an escape entity or a link.
 * Lengths are UTF-16 code units, which is never less than a provider's character count.
 */

export const ELLIPSIS = '…';
export const MAX_LINK_URL_LENGTH = 2000;

export interface Fitted {
  readonly text: string;
  readonly truncated: boolean;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * C0/C1 controls (except newline and tab) and bidi overrides are dropped: they have no
 * legitimate place in a notification and bidi overrides can disguise a link or a name.
 */
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(STRIP, '');
}

export function graphemes(text: string): readonly string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/**
 * Slack documents exactly three control characters to escape in `mrkdwn`.
 * https://docs.slack.dev/messaging/formatting-message-text#escaping
 */
const SLACK_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Lark card markdown and Teams Adaptive Card markdown do not document an escape syntax we
 * could verify, so the characters that create markup with security impact are *neutralised*
 * to their fullwidth forms instead of escaped. `<`/`>` would otherwise allow Lark tags such
 * as `<at id=all></at>`; `[`/`]` would allow a disguised link label. Emphasis characters are
 * left alone: their worst case is cosmetic.
 * UNVERIFIED: whether Lark card markdown honours backslash or HTML-entity escapes; check
 * open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text.
 */
const NEUTRALISE: Readonly<Record<string, string>> = { '<': '＜', '>': '＞', '[': '［', ']': '］' };

const TEAMS_NEUTRALISE: Readonly<Record<string, string>> = { '[': '［', ']': '］' };

const DIALECT_ESCAPES: { readonly [D in MarkupDialect]: Readonly<Record<string, string>> } = {
  slack_mrkdwn: SLACK_ESCAPES,
  lark_md: NEUTRALISE,
  // Teams only creates a mention from an `<at>` tag paired with an `msteams.entities` entry,
  // which we never emit, so angle brackets are inert there.
  adaptive_card_md: TEAMS_NEUTRALISE,
  plain: {},
};

/**
 * Escape every code point of a grapheme cluster, not the cluster as a whole: `<` followed by
 * a combining mark, ZWJ or variation selector is one cluster but still a `<` to the provider.
 */
function escapeGrapheme(dialect: MarkupDialect, g: string): string {
  const table = DIALECT_ESCAPES[dialect];
  let out = '';
  for (const cp of g) out += Object.hasOwn(table, cp) ? (table[cp] ?? cp) : cp;
  return out;
}

/** Escaped atoms for untrusted text in the given dialect. */
export function textAtoms(raw: string, dialect: MarkupDialect): readonly string[] {
  return graphemes(sanitizeText(raw)).map((g) => escapeGrapheme(dialect, g));
}

export function escapeText(raw: string, dialect: MarkupDialect): string {
  return textAtoms(raw, dialect).join('');
}

/**
 * Join atoms, cutting at an atom boundary and appending a visible ellipsis when the total
 * would exceed `maxChars` (F94: truncation is never silent).
 */
export function fitAtoms(atoms: readonly string[], maxChars: number): Fitted {
  const total = atoms.reduce((n, a) => n + a.length, 0);
  if (total <= maxChars) return { text: atoms.join(''), truncated: false };
  if (maxChars < ELLIPSIS.length) return { text: '', truncated: true };
  const budget = maxChars - ELLIPSIS.length;
  const kept: string[] = [];
  let used = 0;
  for (const atom of atoms) {
    if (used + atom.length > budget) break;
    kept.push(atom);
    used += atom.length;
  }
  return { text: kept.join('').trimEnd() + ELLIPSIS, truncated: true };
}

export function fitText(raw: string, dialect: MarkupDialect, maxChars: number): Fitted {
  return fitAtoms(textAtoms(raw, dialect), maxChars);
}

/**
 * A link URL is placed in a payload only if it is a well-formed https URL within the length
 * cap (F94). The serialised form is returned so the caller never re-uses the raw string.
 */
export function safeLinkUrl(raw: string | undefined): string | undefined {
  if (!raw || raw.length > MAX_LINK_URL_LENGTH) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return url.href.length > MAX_LINK_URL_LENGTH ? undefined : url.href;
  } catch {
    return undefined;
  }
}

/**
 * Characters that would terminate a link's URL part in each dialect, percent-encoded.
 * UNVERIFIED: Slack decodes `&amp;` inside `<url|label>` the same way it does in text (its
 * own message payloads carry `&amp;` in link URLs); confirm with a real query-string link.
 */
function encodeLinkUrl(url: string, dialect: MarkupDialect): string {
  if (dialect === 'slack_mrkdwn') return url.replace(/\|/g, '%7C').replace(/&/g, '&amp;');
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
}

/** A complete link as a single, indivisible atom. `url` must come from `safeLinkUrl`. */
export function linkAtom(url: string, label: string, dialect: MarkupDialect): string {
  const text = escapeText(label, dialect);
  switch (dialect) {
    case 'slack_mrkdwn':
      return `<${encodeLinkUrl(url, dialect)}|${text}>`;
    case 'lark_md':
    case 'adaptive_card_md':
      return `[${text}](${encodeLinkUrl(url, dialect)})`;
    case 'plain':
      return url;
  }
}
