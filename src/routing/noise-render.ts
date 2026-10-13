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

/** Items listed in a group notification, and entries listed in a digest. */
export const GROUP_LIST_MAX = 5;
export const DIGEST_LIST_MAX = 10;
const TITLE_CHARS = 90;
const URL_CHARS = 140;

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
 * one notification: the newest update's fields, a count, and a capped list that says "and N more".
 * Requires at least two items; a single item is delivered as itself, unchanged.
 */
export function renderGroup(items: readonly HeldItem[]): CombinedFields {
  const ordered = newestFirst(items);
  const newest = ordered[0];
  if (!newest || ordered.length < 2) throw new Error('renderGroup needs at least two items');
  const shown = ordered.slice(0, GROUP_LIST_MAX);
  const lines = [
    `${ordered.length} updates combined, newest first:`,
    ...shown.map((i) => withUrl(label(i), i)),
    ...(ordered.length > shown.length ? [`…and ${ordered.length - shown.length} more not shown.`] : []),
  ];
  return {
    title: `${clip(newest.title, 200)} · ${ordered.length} updates`,
    url: newest.url,
    ...(newest.repo ? { repo: newest.repo } : {}),
    ...(newest.actor ? { actor: newest.actor } : {}),
    status: worstStatus(ordered),
    eventType: newest.eventType,
    summary: lines.join('\n').slice(0, COMBINED_SUMMARY_MAX_CHARS),
    count: ordered.length,
  };
}

/**
 * Everything held for one integration, as one digest: failures first, then newest first, with
 * entries of the same group key collapsed into one line with a count. The list is capped, and
 * both the entry cap and the character budget are reported in the text ("and 12 more items not
 * shown"), so a large digest never hides that it is partial (F145).
 */
export function renderDigest(items: readonly HeldItem[], cause: 'quiet_hours' | 'digest'): CombinedFields {
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
  const heading =
    cause === 'quiet_hours'
      ? `${total} ${plural(total, 'update', 'updates')} held during quiet hours:`
      : `${total} ${plural(total, 'update', 'updates')} since the last summary:`;
  const lines = [heading];
  let used = heading.length;
  let listedItems = 0;
  for (const bucket of entries.slice(0, DIGEST_LIST_MAX)) {
    const newest = bucket[0];
    if (!newest) continue;
    const count = bucket.length;
    const line = withUrl(`${label(newest)}${count > 1 ? ` (×${count})` : ''}`, newest);
    // Leave room for the closing "not shown" line.
    if (used + line.length + 1 > COMBINED_SUMMARY_MAX_CHARS - 60) break;
    lines.push(line);
    used += line.length + 1;
    listedItems += count;
  }
  if (listedItems < total)
    lines.push(`…and ${total - listedItems} more ${plural(total - listedItems, 'item', 'items')} not shown.`);

  const repos = new Set(items.map((i) => i.repo).filter((r) => r.length > 0));
  const [onlyRepo] = repos.size === 1 ? [...repos] : [];
  return {
    title:
      cause === 'quiet_hours'
        ? `${total} ${plural(total, 'update', 'updates')} while you were away`
        : `Summary: ${total} ${plural(total, 'update', 'updates')}`,
    url: '',
    ...(onlyRepo ? { repo: onlyRepo } : {}),
    status: worstStatus(items),
    eventType: 'noti.digest',
    summary: lines.join('\n').slice(0, COMBINED_SUMMARY_MAX_CHARS),
    count: Math.min(total, COMBINED_COUNT_MAX),
  };
}
