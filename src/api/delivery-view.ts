/**
 * Delivery log read model — pure mapping and query-string parsing for `src/api/deliveries.ts`.
 *
 * A view never carries a payload body, a webhook URL or a secret: only ids, states, counts,
 * timestamps, a closed error code and the id of its user-facing message (F220/F224). The
 * copy itself lives in the dashboard's catalogue, looked up by that id; provider text is
 * never shown.
 */
import type { AttemptRecord } from '../delivery/attempt-types';
import { normalizeDeliveryState, type DeliveryState } from '../delivery/state';
import { errorSpec, toErrorCode, type ErrorCode } from '../platform/errors';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
const MAX_ID_LENGTH = 64;

export interface ListFilters {
  readonly state: DeliveryState | null;
  readonly integrationId: string | null;
  /** Inclusive lower bound on `updated_at`, in SQLite `YYYY-MM-DD HH:MM:SS` UTC. */
  readonly from: string | null;
  readonly to: string | null;
  readonly cursor: { readonly updatedAt: string; readonly id: string } | null;
  readonly limit: number;
}

export type FilterResult =
  | { readonly ok: true; readonly value: ListFilters }
  | { readonly ok: false; readonly fields: readonly { field: string; message: string }[] };

const STATES: readonly DeliveryState[] = [
  'pending',
  'claimed',
  'sent',
  'accepted',
  'retrying',
  'dead_lettered',
  'suppressed',
];

/** D1's `CURRENT_TIMESTAMP` format, which is what `updated_at` holds. */
export function toSqlTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-10-13` means the whole UTC day; a full ISO instant is taken as written. */
export function parseBound(raw: string, edge: 'start' | 'end'): string | null {
  const date = new Date(DATE_ONLY.test(raw) ? `${raw}T${edge === 'start' ? '00:00:00' : '23:59:59'}Z` : raw);
  return Number.isNaN(date.getTime()) ? null : toSqlTime(date);
}

export function encodeCursor(updatedAt: string, id: string): string {
  return btoa(JSON.stringify([updatedAt, id]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeCursor(raw: string): { updatedAt: string; id: string } | null {
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(padded));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      parsed[0].length <= 32 &&
      parsed[1].length <= 128
    )
      return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    // fall through: not a cursor we issued
  }
  return null;
}

export function parseListFilters(query: (name: string) => string | undefined): FilterResult {
  const fields: { field: string; message: string }[] = [];
  const state = query('state');
  const integrationId = query('integrationId');
  const from = query('from');
  const to = query('to');
  const cursor = query('cursor');
  const limit = query('limit');

  let parsedState: DeliveryState | null = null;
  if (state) {
    const found = STATES.find((s) => s === state);
    if (found) parsedState = found;
    else fields.push({ field: 'state', message: 'Unknown state.' });
  }
  if (integrationId && integrationId.length > MAX_ID_LENGTH)
    fields.push({ field: 'integrationId', message: 'Unknown integration.' });
  const lower = from ? parseBound(from, 'start') : null;
  if (from && lower === null) fields.push({ field: 'from', message: 'Use a date like 2026-10-13.' });
  const upper = to ? parseBound(to, 'end') : null;
  if (to && upper === null) fields.push({ field: 'to', message: 'Use a date like 2026-10-13.' });
  const parsedCursor = cursor ? decodeCursor(cursor) : null;
  if (cursor && !parsedCursor) fields.push({ field: 'cursor', message: 'Invalid cursor.' });
  const size = limit === undefined || limit === '' ? DEFAULT_PAGE_SIZE : Number(limit);
  if (!Number.isInteger(size) || size < 1)
    fields.push({ field: 'limit', message: 'Use a whole number from 1.' });

  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      state: parsedState,
      integrationId: integrationId || null,
      from: lower,
      to: upper,
      cursor: parsedCursor,
      limit: Math.min(size, MAX_PAGE_SIZE),
    },
  };
}

export interface DeliveryRowRecord {
  id: string;
  integration_id: string;
  state: string;
  attempts: number;
  last_error_code: string | null;
  replay_of: string | null;
  created_at: string | null;
  updated_at: string;
  first_attempt_at: number | null;
  last_attempt_at: number | null;
  next_attempt_at: number | null;
  dead_lettered_at: number | null;
  is_test: number | null;
  /** The diagnostic we minted for the last attempt; only `circuit_open` / `destination_paced` are shown. */
  last_error: string | null;
  possible_duplicate: number | null;
  suppressed_reason: string | null;
  duplicate_of: string | null;
  integration_name: string | null;
  integration_repo: string | null;
  integration_destination: string | null;
  integration_destination_host: string | null;
  integration_enabled: number | null;
  integration_quarantined_at: string | null;
  latest_replay_state: string | null;
  /** Held events this delivery carries (noise control); 0 for an ordinary delivery. */
  held_count: number | null;
  held_reason: string | null;
}

export interface DeliveryErrorView {
  readonly code: ErrorCode;
  /** Id in the dashboard's message catalogue; `null` means show the generic fallback. */
  readonly messageKey: string | null;
  readonly retryable: boolean;
  readonly userActionable: boolean;
}

/**
 * Whether a replay could actually be delivered: the consumer dead-letters a message whose
 * integration is gone, paused or has unreadable credentials, so we do not offer one.
 */
export type IntegrationStatus = 'available' | 'missing' | 'disabled' | 'quarantined';

export function integrationStatus(row: DeliveryRowRecord): IntegrationStatus {
  if (row.integration_name === null && row.integration_repo === null) return 'missing';
  if (row.integration_quarantined_at !== null) return 'quarantined';
  return row.integration_enabled === 1 ? 'available' : 'disabled';
}

export interface DeliveryView {
  readonly id: string;
  readonly integration: {
    readonly id: string;
    readonly name: string;
    readonly repo: string | null;
    readonly destination: string | null;
    readonly destinationHost: string | null;
  };
  /** False once the integration was deleted: history stays, the integration does not. */
  readonly integrationExists: boolean;
  /** Why a replay would not be delivered, or `available`. */
  readonly integrationStatus: IntegrationStatus;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly error: DeliveryErrorView | null;
  readonly createdAt: string | null;
  readonly updatedAt: string;
  readonly nextAttemptAt: string | null;
  readonly replayOf: string | null;
  /** A user-requested test notification (ADR 0018), not a real event. */
  readonly isTest: boolean;
  /** State of the most recent replay of this row, if one was requested. */
  readonly latestReplayState: DeliveryState | null;
  readonly canReplay: boolean;
  /**
   * Why this notification was delayed or combined, as a reason code (noise control, ADR 0016),
   * or null for an ordinary one. `groupedCount` is how many held updates it stands for.
   */
  readonly heldReason: 'quiet_hours' | 'digest' | 'grouped' | null;
  readonly groupedCount: number;
  /**
   * F185: an earlier attempt ended without the provider confirming it, then the send was retried, so
   * the destination MAY show this message more than once. Not "was duplicated": we cannot know.
   */
  readonly possibleDuplicate: boolean;
  /** A detected repeat that was not sent again (F185): why, and which delivery it repeats. */
  readonly suppression: {
    readonly reason: 'duplicate' | 'claim_conflict' | 'provider_idempotency';
    readonly duplicateOf: string | null;
  } | null;
  /**
   * Why a waiting delivery has not been sent yet although nothing failed this time (F183, F187): the
   * breaker is open because the destination kept failing, or the destination asked to be left alone.
   */
  readonly pausedReason: 'circuit_open' | 'destination_paced' | null;
}

/** SQLite `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`, UTC) to an ISO instant. */
export function sqlTimeToIso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function epochToIso(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : new Date(value).toISOString();
}

function errorView(code: string | null): DeliveryErrorView | null {
  if (!code) return null;
  const known = toErrorCode(code);
  const spec = errorSpec(known);
  return {
    code: known,
    messageKey: spec.messageKey,
    retryable: spec.retryable,
    userActionable: spec.userActionable,
  };
}

/**
 * The result of a TEST to a customer-chosen endpoint is shown as three buckets only
 * (reachable, unreachable, refused by the endpoint), never the HTTP status class: with a
 * tenant-chosen host, the class is an oracle for probing what answers where (ADR 0014, 0018).
 * Unreachable maps to `destination_unavailable`; every answer that is not a success maps to
 * `destination_unauthorized` ("refused the request").
 */
const UNREACHABLE: ReadonlySet<ErrorCode> = new Set([
  'destination_unavailable',
  'destination_timeout',
  'destination_url_rejected',
  'internal_error',
]);

function coarseTestError(code: string | null): DeliveryErrorView | null {
  if (!code) return null;
  return errorView(
    UNREACHABLE.has(toErrorCode(code)) ? 'destination_unavailable' : 'destination_unauthorized',
  );
}

const HELD_REASONS: ReadonlySet<string> = new Set(['quiet_hours', 'digest', 'grouped']);

export function toDeliveryView(row: DeliveryRowRecord, mayReplay: boolean): DeliveryView {
  const state = normalizeDeliveryState(row.state);
  const latest = row.latest_replay_state ? normalizeDeliveryState(row.latest_replay_state) : null;
  const status = integrationStatus(row);
  return {
    id: row.id,
    integration: {
      id: row.integration_id,
      name: row.integration_name ?? row.integration_repo ?? 'Deleted integration',
      repo: row.integration_repo,
      destination: row.integration_destination,
      destinationHost: row.integration_destination_host,
    },
    integrationExists: row.integration_name !== null || row.integration_repo !== null,
    integrationStatus: status,
    state,
    attempts: row.attempts,
    error:
      state === 'dead_lettered' || state === 'retrying'
        ? row.is_test === 1 && row.integration_destination === 'generic_webhook'
          ? coarseTestError(row.last_error_code)
          : errorView(row.last_error_code)
        : null,
    createdAt: sqlTimeToIso(row.created_at),
    updatedAt: sqlTimeToIso(row.updated_at) ?? row.updated_at,
    nextAttemptAt: state === 'retrying' ? epochToIso(row.next_attempt_at) : null,
    replayOf: row.replay_of,
    isTest: row.is_test === 1,
    latestReplayState: latest,
    // A replay that is still in flight or already succeeded makes another one pointless;
    // the server enforces the same rule, this only decides whether to offer the button.
    canReplay:
      mayReplay &&
      state === 'dead_lettered' &&
      status === 'available' &&
      (latest === null || latest === 'dead_lettered'),
    heldReason:
      row.held_reason !== null && HELD_REASONS.has(row.held_reason)
        ? (row.held_reason as 'quiet_hours' | 'digest' | 'grouped')
        : null,
    groupedCount: row.held_count ?? 0,
    possibleDuplicate: row.possible_duplicate === 1,
    suppression:
      state === 'suppressed' &&
      row.suppressed_reason !== null &&
      SUPPRESSION_REASONS.has(row.suppressed_reason)
        ? {
            reason: row.suppressed_reason as 'duplicate' | 'claim_conflict' | 'provider_idempotency',
            duplicateOf: row.duplicate_of,
          }
        : null,
    pausedReason:
      state === 'retrying' && (row.last_error === 'circuit_open' || row.last_error === 'destination_paced')
        ? row.last_error
        : null,
  };
}

const SUPPRESSION_REASONS: ReadonlySet<string> = new Set([
  'duplicate',
  'claim_conflict',
  'provider_idempotency',
]);

export interface AttemptView {
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Wall time of the attempt, ms; 0 for a deferral. */
  readonly durationMs: number;
  readonly outcome: AttemptRecord['outcome'];
  readonly error: DeliveryErrorView | null;
  /** A code we minted for this attempt (`provider_http_503`); never provider text. Null where hidden. */
  readonly detail: string | null;
  /** The status CLASS only (never the status code, a body or a header). `none` where hidden. */
  readonly statusClass: AttemptRecord['statusClass'];
  readonly retryAfterSeconds: number | null;
  readonly providerMessageId: string | null;
  readonly possibleDuplicate: boolean;
}

const DETAIL_PATTERN = /^[a-z0-9_]{1,80}$/;

/**
 * One attempt as the dashboard sees it. For a TEST sent to a customer-chosen endpoint the status
 * class and detail are hidden and the error is coarse, for the same reason `toDeliveryView` coarsens
 * it: the class of a tenant-chosen host's answer is an oracle for probing what answers where
 * (ADR 0014, 0018).
 */
export function toAttemptView(a: AttemptRecord, hideProviderDetail: boolean): AttemptView {
  return {
    attempt: a.attempt,
    startedAt: new Date(a.startedAtMs).toISOString(),
    finishedAt: new Date(a.finishedAtMs).toISOString(),
    durationMs: Math.max(0, a.finishedAtMs - a.startedAtMs),
    outcome: a.outcome,
    error: hideProviderDetail ? coarseTestError(a.errorCode) : errorView(a.errorCode),
    detail: !hideProviderDetail && a.reason !== null && DETAIL_PATTERN.test(a.reason) ? a.reason : null,
    statusClass: hideProviderDetail ? 'none' : a.statusClass,
    retryAfterSeconds: a.retryAfterMs === null ? null : Math.ceil(a.retryAfterMs / 1000),
    providerMessageId: a.providerMessageId,
    possibleDuplicate: a.possibleDuplicate,
  };
}

export interface TimelineEntry {
  readonly kind: 'created' | 'first_attempt' | 'last_attempt' | 'next_attempt' | 'dead_lettered';
  readonly at: string;
}

/**
 * The coarse timeline from the delivery row itself: created, first and latest attempt, the scheduled
 * next attempt and the dead-letter time. The per-attempt history (`delivery_attempts`, F184) is
 * returned beside it; rows written before migration 0025 have only this.
 */
export function deriveTimeline(row: DeliveryRowRecord): TimelineEntry[] {
  const state = normalizeDeliveryState(row.state);
  const candidates: [TimelineEntry['kind'], string | null][] = [
    ['created', sqlTimeToIso(row.created_at)],
    ['first_attempt', epochToIso(row.first_attempt_at)],
    [
      'last_attempt',
      row.attempts > 1 && row.last_attempt_at !== row.first_attempt_at
        ? epochToIso(row.last_attempt_at)
        : null,
    ],
    ['next_attempt', state === 'retrying' ? epochToIso(row.next_attempt_at) : null],
    ['dead_lettered', epochToIso(row.dead_lettered_at)],
  ];
  return candidates.flatMap(([kind, at]) => (at ? [{ kind, at }] : []));
}
