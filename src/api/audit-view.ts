/**
 * Audit log read model: pure parsing and mapping for `src/api/audit.ts`.
 *
 * Stored `metadata_json` is never returned as it is. Each action has an allow-list of keys
 * and types; anything else (an unknown key, a wrong type, an action from a newer release) is
 * dropped, and every value is length-bounded and stripped of control and bidi characters.
 * `ip` and `user_agent` are stored for incident response but are not part of this view.
 */
import { AUDIT_ACTIONS, type AuditAction } from '../audit/actions';
import { decodeCursor, parseBound } from './delivery-view';

export const AUDIT_DEFAULT_PAGE = 25;
export const AUDIT_MAX_PAGE = 100;

export type SummaryValue = string | number | boolean | readonly string[];
export interface SummaryItem {
  readonly key: string;
  readonly value: SummaryValue;
}

type Kind = 'string' | 'number' | 'boolean' | 'list';

const NONE = {} as const;

/** The only metadata keys each action may surface, with the type each must have. */
export const SUMMARY_FIELDS: Readonly<Record<AuditAction, Readonly<Record<string, Kind>>>> = {
  'integration.create': {
    repo: 'string',
    sourceId: 'string',
    destination: 'string',
    destinationHost: 'string',
    eventTypes: 'list',
    signed: 'boolean',
    filters: 'list',
    noise: 'list',
  },
  'integration.update': {
    fields: 'list',
    enabled: 'boolean',
    eventTypes: 'list',
    repo: 'string',
    filters: 'list',
    noise: 'list',
  },
  'integration.delete': { repo: 'string', destination: 'string' },
  'integration.credentials.rotate': {
    destinationHost: 'string',
    signed: 'boolean',
    clearedQuarantine: 'boolean',
  },
  'integration.credentials.revoke': { destinationHost: 'string', reason: 'string' },
  'integration.auto_pause': {
    destination: 'string',
    providerStatus: 'number',
    reason: 'string',
    providerCode: 'string',
  },
  'integration.test': { deliveryId: 'string' },
  'source.create': { kind: 'string', authMode: 'string', livemode: 'boolean' },
  'source.update': { fields: 'list', enabled: 'boolean' },
  'source.delete': { integrationsDeleted: 'number' },
  'source.secret.rotate': { kind: 'string', authMode: 'string', downgrade: 'boolean' },
  'source.credentials.revoke': { kind: 'string', reason: 'string' },
  'delivery.replay': { replayDeliveryId: 'string' },
  'access.denied': { capability: 'string', reason: 'string', role: 'string' },
  'github.installation.bind': { account: 'string', selection: 'string', repositories: 'number' },
  'github.installation.bind_refused': { reason: 'string' },
  'github.installation.lifecycle': {
    action: 'string',
    account: 'string',
    selection: 'string',
    added: 'list',
    removed: 'list',
  },
  'github.repository.out_of_scope': NONE,
  'workspace.export': NONE,
  'workspace.deletion.request': { purgeAfter: 'string', disabledIntegrations: 'number' },
  'workspace.deletion.cancel': { restoredIntegrations: 'number' },
  'workspace.purged': NONE,
  'account.export': NONE,
  'account.delete': NONE,
  // Platform-level (no workspace), so it never appears in a workspace's audit view.
  'key.destroy': NONE,
};

export const MAX_TEXT = 120;
export const MAX_LIST_ITEMS = 10;

/** C0/C1 controls, line and paragraph separators, zero-width and bidi override/isolate marks. */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb], // interlinear annotation
  [0xe0000, 0xe007f], // tag characters
];

const isUnsafe = (code: number) => UNSAFE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);

/** Plain text that cannot reorder or hide what follows it, cut to `max` characters. */
export function safeText(value: string, max: number = MAX_TEXT): string {
  const clean = Array.from(value)
    .filter((ch) => !isUnsafe(ch.codePointAt(0) ?? 0))
    .join('');
  // By code point, so a cut never splits a surrogate pair.
  const points = Array.from(clean);
  return points.length > max ? `${points.slice(0, max - 1).join('')}\u2026` : clean;
}

function coerce(kind: Kind, value: unknown): SummaryValue | undefined {
  switch (kind) {
    case 'string':
      return typeof value === 'string' ? safeText(value) : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'list':
      return Array.isArray(value)
        ? value
            .filter((v): v is string => typeof v === 'string')
            .slice(0, MAX_LIST_ITEMS)
            .map((v) => safeText(v, 80))
        : undefined;
  }
}

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** The allow-listed, bounded facts of one event. Malformed JSON or an unknown action gives none. */
export function summarise(action: string, metadataJson: string): readonly SummaryItem[] {
  if (!isAuditAction(action)) return [];
  const allowed = SUMMARY_FIELDS[action];
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  return Object.entries(allowed).flatMap(([key, kind]) => {
    if (!Object.hasOwn(record, key)) return [];
    const value = coerce(kind, record[key]);
    return value === undefined ? [] : [{ key, value }];
  });
}

export type AuditActor =
  | { readonly kind: 'member'; readonly name: string }
  | { readonly kind: 'system' }
  /** A person who did something here and has since left (or whose membership is gone). */
  | { readonly kind: 'former' }
  /** Someone who never belonged here: an outsider whose refused request was recorded. */
  | { readonly kind: 'other' };

export interface AuditRowRecord {
  id: string;
  action: string;
  subject_type: string;
  subject_id: string | null;
  outcome: string;
  metadata_json: string;
  created_at: string;
  actor_id: string | null;
  /** Present only when the actor is a CURRENT member of this workspace. */
  actor_name: string | null;
  actor_is_member: number | null;
}

export interface AuditEventView {
  readonly id: string;
  readonly createdAt: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly outcome: 'success' | 'denied';
  readonly actor: AuditActor;
  readonly summary: readonly SummaryItem[];
}

/**
 * Name only, and only for a current member of this workspace. A person who left, or an
 * outsider whose probe was recorded here, is "other": their name and email belong to no
 * one in this workspace.
 */
function actorOf(row: AuditRowRecord): AuditActor {
  if (row.actor_id === null) return { kind: 'system' };
  if (row.actor_is_member === 1 && row.actor_name)
    return { kind: 'member', name: safeText(row.actor_name, 80) };
  // A successful action can only have been taken by someone who was a member then; a refused
  // request from a non-member is an outsider. Neither is named.
  return row.outcome === 'denied' ? { kind: 'other' } : { kind: 'former' };
}

export function toAuditView(row: AuditRowRecord): AuditEventView {
  const at = new Date(`${row.created_at.replace(' ', 'T')}Z`);
  return {
    id: row.id,
    createdAt: Number.isNaN(at.getTime()) ? row.created_at : at.toISOString(),
    action: row.action,
    subjectType: row.subject_type,
    subjectId: row.subject_id === null ? null : safeText(row.subject_id),
    outcome: row.outcome === 'denied' ? 'denied' : 'success',
    actor: actorOf(row),
    summary: summarise(row.action, row.metadata_json),
  };
}

export interface AuditFilters {
  readonly action: AuditAction | null;
  readonly outcome: 'success' | 'denied' | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly cursor: { readonly updatedAt: string; readonly id: string } | null;
  readonly limit: number;
}

export type AuditFilterResult =
  | { readonly ok: true; readonly value: AuditFilters }
  | { readonly ok: false; readonly fields: readonly { field: string; message: string }[] };

export function parseAuditFilters(query: (name: string) => string | undefined): AuditFilterResult {
  const fields: { field: string; message: string }[] = [];
  const action = query('action');
  const outcome = query('outcome');
  const from = query('from');
  const to = query('to');
  const cursor = query('cursor');
  const limit = query('limit');

  if (action && !isAuditAction(action)) fields.push({ field: 'action', message: 'Unknown action.' });
  if (outcome && outcome !== 'success' && outcome !== 'denied')
    fields.push({ field: 'outcome', message: 'Use success or denied.' });
  const lower = from ? parseBound(from, 'start') : null;
  if (from && lower === null) fields.push({ field: 'from', message: 'Use a date like 2026-10-13.' });
  const upper = to ? parseBound(to, 'end') : null;
  if (to && upper === null) fields.push({ field: 'to', message: 'Use a date like 2026-10-13.' });
  const parsedCursor = cursor ? decodeCursor(cursor) : null;
  if (cursor && !parsedCursor) fields.push({ field: 'cursor', message: 'Invalid cursor.' });
  const size = limit === undefined || limit === '' ? AUDIT_DEFAULT_PAGE : Number(limit);
  if (!Number.isInteger(size) || size < 1)
    fields.push({ field: 'limit', message: 'Use a whole number from 1.' });
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      action: action && isAuditAction(action) ? action : null,
      outcome: outcome === 'success' || outcome === 'denied' ? outcome : null,
      from: lower,
      to: upper,
      cursor: parsedCursor,
      limit: Math.min(size, AUDIT_MAX_PAGE),
    },
  };
}

export function buildAuditQuery(
  orgId: string,
  f: AuditFilters,
): { readonly sql: string; readonly values: readonly (string | number)[] } {
  const where = ['e.organization_id = ?'];
  const values: (string | number)[] = [orgId];
  if (f.action) {
    where.push('e.action = ?');
    values.push(f.action);
  }
  if (f.outcome) {
    where.push('e.outcome = ?');
    values.push(f.outcome);
  }
  if (f.from) {
    where.push('e.created_at >= ?');
    values.push(f.from);
  }
  if (f.to) {
    where.push('e.created_at <= ?');
    values.push(f.to);
  }
  if (f.cursor) {
    where.push('(e.created_at < ? OR (e.created_at = ? AND e.id < ?))');
    values.push(f.cursor.updatedAt, f.cursor.updatedAt, f.cursor.id);
  }
  return {
    // The member join repeats the tenant predicate: a name is read only for someone who
    // belongs to THIS workspace now. `ip`, `user_agent` and the actor's email are not selected.
    sql: `SELECT e.id, e.action, e.subject_type, e.subject_id, e.outcome, e.metadata_json, e.created_at,
            e.actor_id, u.name AS actor_name, (m.id IS NOT NULL) AS actor_is_member
          FROM audit_events e
          LEFT JOIN member m ON m.user_id = e.actor_id AND m.organization_id = e.organization_id
          LEFT JOIN "user" u ON u.id = m.user_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    values: [...values, f.limit + 1],
  };
}
