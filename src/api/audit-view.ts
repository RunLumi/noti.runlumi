/**
 * Audit log read model: pure parsing and mapping for `src/api/audit.ts`.
 *
 * Stored `metadata_json` is never returned as it is. Each action has an allow-list of keys
 * and types; anything else (an unknown key, a wrong type, an action from a newer release) is
 * dropped, and every value is length-bounded and stripped of control and bidi characters.
 * `ip` and `user_agent` are stored for incident response but are not part of this view.
 */
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, type AuditAction } from '../audit/actions';
import { DIFF_KEYS, MAX_DIFF_LIST } from '../audit/diff';
import { sanitiseCorrelationId } from '../platform/correlation-id';
import { decodeCursor, parseBound } from './delivery-view';

export const AUDIT_DEFAULT_PAGE = 25;
export const AUDIT_MAX_PAGE = 100;
/** The total is counted up to this many matches; past it the answer is "at least this many". */
export const AUDIT_TOTAL_CAP = 10_000;
/** With no `from` filter the total covers this many recent days (a bounded range seek, never a scan). */
export const AUDIT_TOTAL_WINDOW_DAYS = 90;

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
  'delivery.bulk_replay': {
    phase: 'string',
    requested: 'number',
    replayed: 'number',
    alreadyInFlight: 'number',
    refused: 'number',
    remaining: 'number',
    integrationId: 'string',
    from: 'string',
    to: 'string',
  },
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
  'github.webhook.refused': { reason: 'string' },
  'workspace.export': NONE,
  'workspace.deletion.request': { purgeAfter: 'string', disabledIntegrations: 'number' },
  'workspace.deletion.cancel': { restoredIntegrations: 'number' },
  'workspace.purged': NONE,
  'account.export': NONE,
  'account.delete': NONE,
  // Platform-level (no workspace), so it never appears in a workspace's audit view.
  'key.destroy': NONE,
  // The invitee's address is a third party's data and is never recorded.
  'member.invite': { role: 'string' },
  'member.invite.accept': { role: 'string' },
  'member.invite.reject': NONE,
  'member.invite.cancel': { role: 'string' },
  'member.role.change': { role: 'string', previousRole: 'string' },
  'member.remove': { role: 'string', self: 'boolean' },
  // Session events have no workspace (a session belongs to a person), so they are in the person's own
  // account export, not a workspace's audit view.
  'session.revoke': NONE,
  'session.revoke_others': { revoked: 'number' },
  'session.revoke_all': { revoked: 'number', reason: 'string' },
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

/**
 * One field an update changed, rebuilt from the diff keys the writer stored (`src/audit/diff.ts`). Only a
 * closed set of non-secret fields has one; everything else stays in the plain "changed" list.
 */
export type FieldChange =
  | {
      readonly field: 'enabled' | 'repo';
      readonly kind: 'value';
      readonly before: string | boolean;
      readonly after: string | boolean;
    }
  | {
      readonly field: 'eventTypes';
      readonly kind: 'list';
      readonly added: readonly string[];
      readonly removed: readonly string[];
    };

const DIFF_ACTIONS: ReadonlySet<string> = new Set(['integration.update', 'source.update']);

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .slice(0, MAX_DIFF_LIST)
        .map((v) => safeText(v, 80))
    : [];
}

/**
 * The before and after of the fields an update changed. A change is shown only when BOTH sides are
 * known and well typed: a row written before this existed, a malformed value or an unknown action gives
 * none, never a guess. The after value is the one the row already recorded (`enabled`, `repo`).
 */
export function changesOf(action: string, metadataJson: string): readonly FieldChange[] {
  if (!DIFF_ACTIONS.has(action)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const m = parsed as Record<string, unknown>;
  const own = (key: string): unknown => (Object.hasOwn(m, key) ? m[key] : undefined);
  const out: FieldChange[] = [];
  const before = own(DIFF_KEYS.previousEnabled);
  const after = own('enabled');
  if (typeof before === 'boolean' && typeof after === 'boolean' && before !== after)
    out.push({ field: 'enabled', kind: 'value', before, after });
  const previousRepo = own(DIFF_KEYS.previousRepo);
  const repo = own('repo');
  if (action === 'integration.update' && typeof previousRepo === 'string' && typeof repo === 'string')
    out.push({ field: 'repo', kind: 'value', before: safeText(previousRepo), after: safeText(repo) });
  if (action === 'integration.update') {
    const added = stringList(own(DIFF_KEYS.eventTypesAdded));
    const removed = stringList(own(DIFF_KEYS.eventTypesRemoved));
    if (added.length > 0 || removed.length > 0)
      out.push({ field: 'eventTypes', kind: 'list', added, removed });
  }
  return out;
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
  /** Read back so the route can refuse a row that is not this workspace's, whatever the query did. */
  organization_id: string | null;
  correlation_id: string | null;
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
  /** The request this change was made in; null for rows written before it was recorded or by a job. */
  readonly correlationId: string | null;
  /** Before and after of the non-secret fields an update changed; empty when none were recorded. */
  readonly changes: readonly FieldChange[];
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
    correlationId: sanitiseCorrelationId(row.correlation_id),
    changes: changesOf(row.action, row.metadata_json),
  };
}

export interface AuditFilters {
  readonly action: AuditAction | null;
  readonly outcome: 'success' | 'denied' | null;
  /**
   * A CURRENT member's user id, or `system` for events no person took. Anyone else (an outsider whose
   * probe was recorded here, a former member) matches nothing, so the filter cannot be used to ask
   * whether a given user id ever touched this workspace.
   */
  readonly actor: string | null;
  /** The id of the thing the event is about (an integration, a source, a delivery, a capability). */
  readonly target: string | null;
  readonly targetType: (typeof AUDIT_SUBJECT_TYPES)[number] | null;
  /** The request id of one request, as quoted from an error body or a delivery. */
  readonly correlationId: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly cursor: { readonly updatedAt: string; readonly id: string } | null;
  readonly limit: number;
}

export type AuditFilterResult =
  | { readonly ok: true; readonly value: AuditFilters }
  | { readonly ok: false; readonly fields: readonly { field: string; message: string }[] };

/** Opaque ids: letters, numbers, `_` and `-`, as Better Auth and our own ids are. */
const ACTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Printable text, no controls: a subject id can be `owner/repo` or a capability like `delivery.replay`. */
const validTarget = (value: string): boolean =>
  value.length >= 1 &&
  value.length <= 200 &&
  Array.from(value).every((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });
/**
 * The filter value for "events no person took". It starts with `~`, which no user id can (ids are letters,
 * numbers, `_` and `-`), so it can never collide with a member whose id happens to be `system`.
 */
export const SYSTEM_ACTOR = '~system';

const isSubjectType = (v: string): v is (typeof AUDIT_SUBJECT_TYPES)[number] =>
  (AUDIT_SUBJECT_TYPES as readonly string[]).includes(v);

export function parseAuditFilters(query: (name: string) => string | undefined): AuditFilterResult {
  const fields: { field: string; message: string }[] = [];
  const action = query('action');
  const outcome = query('outcome');
  const actor = query('actor');
  const target = query('target');
  const targetType = query('targetType');
  const correlationId = query('correlationId');
  const from = query('from');
  const to = query('to');
  const cursor = query('cursor');
  const limit = query('limit');

  if (action && !isAuditAction(action)) fields.push({ field: 'action', message: 'Unknown action.' });
  if (outcome && outcome !== 'success' && outcome !== 'denied')
    fields.push({ field: 'outcome', message: 'Use success or denied.' });
  if (actor && actor !== SYSTEM_ACTOR && !ACTOR_ID.test(actor))
    fields.push({ field: 'actor', message: 'Not a valid member id.' });
  if (target && !validTarget(target)) fields.push({ field: 'target', message: 'Not a valid id.' });
  if (targetType && !isSubjectType(targetType))
    fields.push({ field: 'targetType', message: 'Unknown kind of thing.' });
  const correlation = correlationId ? sanitiseCorrelationId(correlationId) : null;
  if (correlationId && correlation === null)
    fields.push({ field: 'correlationId', message: 'Not a valid request id.' });
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
      actor: actor || null,
      target: target || null,
      targetType: targetType && isSubjectType(targetType) ? targetType : null,
      correlationId: correlation,
      from: lower,
      to: upper,
      cursor: parsedCursor,
      limit: Math.min(size, AUDIT_MAX_PAGE),
    },
  };
}

type Built = { readonly sql: string; readonly values: readonly (string | number)[] };

/**
 * The shared narrowing terms, each an `AND ...` clause with `?` placeholders only (no value is ever
 * written into the SQL). EVERY query below starts with `e.organization_id = ?`, and these only narrow
 * inside it; the cursor is the only term left out of the count. `values[0]` is the workspace.
 */
function whereOf(orgId: string, f: AuditFilters, withCursor: boolean) {
  // The tenant comparison is written out in each query below; these are the optional narrowing terms.
  const where: string[] = [];
  const values: (string | number)[] = [orgId];
  if (f.action) {
    where.push('e.action = ?');
    values.push(f.action);
  }
  if (f.outcome) {
    where.push('e.outcome = ?');
    values.push(f.outcome);
  }
  if (f.actor === SYSTEM_ACTOR) {
    where.push('e.actor_id IS NULL');
  } else if (f.actor) {
    // A person who belongs to THIS workspace now; the membership lookup repeats the tenant predicate.
    where.push(
      'e.actor_id = ? AND EXISTS (SELECT 1 FROM member m WHERE m.user_id = e.actor_id AND m.organization_id = e.organization_id)',
    );
    values.push(f.actor);
  }
  if (f.target) {
    where.push('e.subject_id = ?');
    values.push(f.target);
  }
  if (f.targetType) {
    where.push('e.subject_type = ?');
    values.push(f.targetType);
  }
  if (f.correlationId) {
    where.push('e.correlation_id = ?');
    values.push(f.correlationId);
  }
  if (f.from) {
    where.push('e.created_at >= ?');
    values.push(f.from);
  }
  if (f.to) {
    where.push('e.created_at <= ?');
    values.push(f.to);
  }
  if (withCursor && f.cursor) {
    where.push('(e.created_at < ? OR (e.created_at = ? AND e.id < ?))');
    values.push(f.cursor.updatedAt, f.cursor.updatedAt, f.cursor.id);
  }
  return { terms: where, values };
}

export function buildAuditQuery(orgId: string, f: AuditFilters): Built {
  const { terms, values } = whereOf(orgId, f, true);
  const filters = terms.map((t) => ` AND ${t}`).join('');
  return {
    // The member join repeats the tenant predicate: a name is read only for someone who
    // belongs to THIS workspace now. `ip`, `user_agent` and the actor's email are not selected.
    sql: `SELECT e.id, e.organization_id, e.action, e.subject_type, e.subject_id, e.outcome, e.metadata_json, e.created_at,
            e.correlation_id, e.actor_id, u.name AS actor_name, (m.id IS NOT NULL) AS actor_is_member
          FROM audit_events e
          LEFT JOIN member m ON m.user_id = e.actor_id AND m.organization_id = e.organization_id
          LEFT JOIN "user" u ON u.id = m.user_id
          WHERE e.organization_id = ?${filters}
          ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    values: [...values, f.limit + 1],
  };
}

/**
 * How many events match, ignoring the page cursor, counted up to {@link AUDIT_TOTAL_CAP} so a workspace
 * with a long log cannot make the first page scan it all. The inner `LIMIT` is what bounds the work.
 */
export function buildAuditCountQuery(
  orgId: string,
  f: AuditFilters,
  nowMs: number = Date.now(),
): Built & { readonly since: string | null } {
  // Without a `from`, only the last AUDIT_TOTAL_WINDOW_DAYS days are counted, so the count is always a
  // range seek on (organization_id, created_at) and never a scan of the whole log. `since` says so.
  const since = f.from ? null : sqliteTime(nowMs - AUDIT_TOTAL_WINDOW_DAYS * 86_400_000);
  const { terms, values } = whereOf(orgId, since ? { ...f, from: since } : f, false);
  const filters = terms.map((t) => ` AND ${t}`).join('');
  return {
    sql: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM audit_events e WHERE e.organization_id = ?${filters} LIMIT ?)`,
    values: [...values, AUDIT_TOTAL_CAP + 1],
    since,
  };
}

/** `YYYY-MM-DD HH:MM:SS` UTC, the format `created_at` is stored in. */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
