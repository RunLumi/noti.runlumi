import { COMBINED_COUNT_MAX, COMBINED_SUMMARY_MAX_CHARS, type DeliveryMessage } from '../env';

/**
 * Pure rendering of a released group or digest into the canonical display fields the delivery
 * path already carries (docs/adr/0016, F143, F145). The destination adapters do the escaping and
 * fitting like for any other notification; this module only decides WHAT is listed and says,
 * in the text itself, how much was left out.
 *
 * Outcome is conveyed by a text marker as well as by `status`, never by colour alone.
 */

export interface HeldItem {
  readonly id: string;
  readonly holdReason: 'quiet_hours' | 'digest' | 'grouped';
  readonly groupKey: string;
  readonly heldAt: number;
  readonly eventType: string;
  readonly title: string;
  readonly url: string;
  readonly repo: string;
  readonly actor: string;
  readonly status: 'success' | 'failure' | 'warning' | 'info';
  readonly summary: string;
  readonly resolved: boolean;
}

export type CombinedFields = Pick<
  DeliveryMessage,
  'title' | 'url' | 'repo' | 'actor' | 'status' | 'eventType' | 'summary' | 'count'
>;

/** Items listed in a group notification, and entries listed in a digest message. */
export const GROUP_LIST_MAX = 5;
export const DIGEST_LIST_MAX = 10;
/** Continuation digests: at most this many messages for one release; the rest is stated, not kept. */
export const DIGEST_MAX_PARTS = 3;
const TITLE_CHARS = 90;
const URL_CHARS = 140;
/** Room kept for the closing "not shown" or "continued" line, so truncation can never cut it. */
const RESERVE = 110;
const BUDGET = COMBINED_SUMMARY_MAX_CHARS - RESERVE;

const MARKER: Readonly<Record<HeldItem['status'], string>> = {
  failure: '✗',
  warning: '!',
  info: '•',
  success: '✓',
};
const SEVERITY: Readonly<Record<HeldItem['status'], number>> = {
  failure: 3,
  warning: 2,
  info: 1,
  success: 0,
};

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/** Newest first; ties broken by id so the order is total and stable. */
function newestFirst(items: readonly HeldItem[]): HeldItem[] {
  return [...items].sort((a, b) => b.heldAt - a.heldAt || (a.id < b.id ? 1 : -1));
}

export function worstStatus(items: readonly HeldItem[]): HeldItem['status'] {
  return items.reduce<HeldItem['status']>(
    (worst, i) => (SEVERITY[i.status] > SEVERITY[worst] ? i.status : worst),
    'success',
  );
}

function label(item: HeldItem): string {
  const where = item.repo ? `${item.repo}: ` : '';
  const done = item.resolved ? ' (resolved)' : '';
  return `${MARKER[item.status]} ${where}${clip(item.title, TITLE_CHARS)}${done}`;
}

function withUrl(line: string, item: HeldItem): string {
  return item.url && item.url.length <= URL_CHARS ? `${line}\n   ${item.url}` : line;
}

function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}

/**
 * Several updates with one group key (same event type, repository and subject), combined into
 * one notification: the newest update's fields, a count, and a capped list. The list is cut by
 * entry count AND by character budget, and the closing "and N more not shown" line is computed
 * from what was actually listed and always fits (a reserve is kept for it).
 * Requires at least two items; a single item is delivered as itself, unchanged.
 */
export function renderGroup(items: readonly HeldItem[]): CombinedFields {
  const ordered = newestFirst(items);
  const newest = ordered[0];
  if (!newest || ordered.length < 2) throw new Error('renderGroup needs at least two items');
  const heading = `${ordered.length} updates combined, newest first:`;
  const lines = [heading];
  let used = heading.length;
  let listed = 0;
  for (const item of ordered.slice(0, GROUP_LIST_MAX)) {
    const line = withUrl(label(item), item);
    if (used + line.length + 1 > BUDGET) break;
    lines.push(line);
    used += line.length + 1;
    listed++;
  }
  if (listed < ordered.length) lines.push(`…and ${ordered.length - listed} more not shown.`);
  return {
    title: `${clip(newest.title, 200)} · ${ordered.length} updates`,
    url: newest.url,
    ...(newest.repo ? { repo: newest.repo } : {}),
    ...(newest.actor ? { actor: newest.actor } : {}),
    status: worstStatus(ordered),
    eventType: newest.eventType,
    summary: lines.join('\n'),
    count: ordered.length,
  };
}

export interface DigestPart extends CombinedFields {
  /** Group keys of the entries listed in this part. */
  readonly groupKeys: readonly string[];
  /** Rows this part stands for; the last part also stands for entries that did not fit at all. */
  readonly rows: number;
  /** Rows this part lists (collapsed entries count all their rows). */
  readonly listedItems: number;
  /** Rows no part lists; non-zero only on the last part. */
  readonly notShown: number;
}

/**
 * Everything held for one integration as a digest: failures first, then newest first, entries of
 * the same group key collapsed into one line with a count. When it does not fit one message it is
 * SPLIT into up to {@link DIGEST_MAX_PARTS} messages ("part 1 of 2"); only what does not fit even
 * then is left out, and the last message says how many items that is and that their details are
 * not kept (F145). Listed items plus the "not shown" count always equal the rows.
 */
export function renderDigestParts(
  items: readonly HeldItem[],
  cause: 'quiet_hours' | 'digest',
  maxParts: number = DIGEST_MAX_PARTS,
): DigestPart[] {
  if (items.length === 0) throw new Error('renderDigest needs at least one item');
  const byKey = new Map<string, HeldItem[]>();
  for (const item of newestFirst(items)) {
    const bucket = byKey.get(item.groupKey);
    if (bucket) bucket.push(item);
    else byKey.set(item.groupKey, [item]);
  }
  const entries = [...byKey.values()].sort((a, b) => {
    const worse = SEVERITY[worstStatus(b)] - SEVERITY[worstStatus(a)];
    return worse !== 0 ? worse : (b[0]?.heldAt ?? 0) - (a[0]?.heldAt ?? 0);
  });
  const total = items.length;

  // Split the entries into parts first: greedy by entry cap and character budget.
  const chunks: { lines: string[]; keys: string[]; rows: number }[] = [];
  let cursor = 0;
  while (cursor < entries.length && chunks.length < maxParts) {
    const chunk = { lines: [] as string[], keys: [] as string[], rows: 0 };
    let used = 100;
    while (cursor < entries.length && chunk.keys.length < DIGEST_LIST_MAX) {
      const bucket = entries[cursor];
      const newest = bucket?.[0];
      if (!bucket || !newest) break;
      const line = withUrl(`${label(newest)}${bucket.length > 1 ? ` (×${bucket.length})` : ''}`, newest);
      if (used + line.length + 1 > BUDGET) break;
      chunk.lines.push(line);
      chunk.keys.push(newest.groupKey);
      chunk.rows += bucket.length;
      used += line.length + 1;
      cursor++;
    }
    if (chunk.keys.length === 0) break;
    chunks.push(chunk);
  }
  const notShown = total - chunks.reduce((n, c) => n + c.rows, 0);

  const repos = new Set(items.map((i) => i.repo).filter((r) => r.length > 0));
  const [onlyRepo] = repos.size === 1 ? [...repos] : [];
  const status = worstStatus(items);
  const parts = chunks.length;
  return chunks.map((chunk, index) => {
    const last = index === parts - 1;
    const part = parts > 1 ? ` (part ${index + 1} of ${parts})` : '';
    const heading =
      (cause === 'quiet_hours'
        ? `${total} ${plural(total, 'update', 'updates')} held during quiet hours`
        : `${total} ${plural(total, 'update', 'updates')} since the last summary`) + `${part}:`;
    const lines = [heading, ...chunk.lines];
    if (!last) lines.push('Continued in the next message.');
    else if (notShown > 0)
      lines.push(
        `…and ${notShown} more ${plural(notShown, 'item', 'items')} not shown. Their details are not kept.`,
      );
    const rows = chunk.rows + (last ? notShown : 0);
    return {
      title:
        (cause === 'quiet_hours'
          ? `${total} ${plural(total, 'update', 'updates')} while you were away`
          : `Summary: ${total} ${plural(total, 'update', 'updates')}`) + part,
      url: '',
      ...(onlyRepo ? { repo: onlyRepo } : {}),
      status,
      eventType: 'noti.digest',
      summary: lines.join('\n'),
      count: Math.min(Math.max(rows, 1), COMBINED_COUNT_MAX),
      groupKeys: chunk.keys,
      rows,
      listedItems: chunk.rows,
      notShown: last ? notShown : 0,
    };
  });
}

/** The first (usually only) digest message; see {@link renderDigestParts}. */
export function renderDigest(items: readonly HeldItem[], cause: 'quiet_hours' | 'digest'): CombinedFields {
  const [first] = renderDigestParts(items, cause, 1);
  if (!first) throw new Error('renderDigest needs at least one item');
  return first;
}
