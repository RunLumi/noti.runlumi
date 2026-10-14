/**
 * What an "updated" audit row says changed (docs/specs/02-identity-tenancy.md F222, ADR 0028).
 *
 * Only a closed set of non-secret fields has a before value: whether it is on, which repository it
 * watches, which updates it subscribes to. A webhook URL, a signing secret, a filter body or a name is
 * NEVER diffed: those carry credentials or free text, and the log records only that they changed (the
 * `fields` list) and, for filters and noise controls, the ids. The writer computes the diff from the
 * row it just read, so the log never stores a second copy of the full old record.
 *
 * Metadata can only hold primitives and string arrays (`AuditMetadata`), so a list is stored as what
 * was added and what was removed, each bounded, instead of two whole lists. The reader rebuilds a
 * change from the same keys (`src/api/audit-view.ts`), so the two cannot drift: both use `DIFF_KEYS`.
 */
/** The metadata shape of `audit.ts`, restated so this module stays free of the Worker's types. */
type AuditMetadata = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

/** The metadata keys a diff uses; the reader allow-lists exactly these. */
export const DIFF_KEYS = {
  previousEnabled: 'previousEnabled',
  previousRepo: 'previousRepo',
  eventTypesAdded: 'eventTypesAdded',
  eventTypesRemoved: 'eventTypesRemoved',
} as const;

/** Each side of a list diff is cut to this many entries (the reader cuts at the same bound). */
export const MAX_DIFF_LIST = 10;

export interface DiffState {
  readonly enabled?: boolean;
  readonly repo?: string;
  readonly eventTypes?: readonly string[];
}

function delta(before: readonly string[], after: readonly string[]) {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: after.filter((v, i) => !was.has(v) && after.indexOf(v) === i),
    removed: before.filter((v, i) => !now.has(v) && before.indexOf(v) === i),
  };
}

/**
 * The diff metadata for the fields `after` sets. A field `after` leaves out was not part of the change
 * and gets no entry. A field set to the value it already had gets none either: nothing changed.
 */
export function diffMetadata(before: DiffState, after: DiffState): AuditMetadata {
  const out: Record<string, string | boolean | readonly string[]> = {};
  if (after.enabled !== undefined && before.enabled !== undefined && after.enabled !== before.enabled)
    out[DIFF_KEYS.previousEnabled] = before.enabled;
  if (after.repo !== undefined && before.repo !== undefined && after.repo !== before.repo)
    out[DIFF_KEYS.previousRepo] = before.repo;
  if (after.eventTypes !== undefined && before.eventTypes !== undefined) {
    const { added, removed } = delta(before.eventTypes, after.eventTypes);
    if (added.length > 0) out[DIFF_KEYS.eventTypesAdded] = added.slice(0, MAX_DIFF_LIST);
    if (removed.length > 0) out[DIFF_KEYS.eventTypesRemoved] = removed.slice(0, MAX_DIFF_LIST);
  }
  return out;
}
