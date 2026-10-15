/**
 * Destination circuit breaker and outbound pacing — docs/specs/12-delivery-reliability.md F183, F187
 * (and the reaction half of F178/F179).
 *
 * Scope, decided and stated: one row per `(workspace, integration)` in `destination_health`. The
 * spec keys the breaker per `(connection, destination_host)`; an integration is exactly one stored
 * webhook on one host, so the integration key is that pair, and it keeps one workspace's failures from
 * ever opening another workspace's breaker (tenant isolation is non-negotiable here).
 *
 * NOT built: a budget shared by every workspace that posts to the same provider account (F187's
 * "per provider account, not per connection"). The consumer cannot know which provider account a
 * stored webhook belongs to, and a global counter would let one tenant slow another's delivery. What
 * exists is per-integration pacing driven by what the destination itself says (rate-limit headers and
 * `Retry-After`), which keeps one tenant's burst from running its OWN integration into a rate limit.
 *
 * Breaker (closed → open → half-open):
 * - closed: sends proceed; each breaker-class failure (`destination_unavailable`,
 *   `destination_timeout`) counts; any answer from the destination that is not such a failure
 *   resets the count. {@link BREAKER_FAILURE_THRESHOLD} consecutive failures open it.
 * - open: until `open_until` the consumer does not call the destination. The delivery goes back to
 *   `retrying` without spending an attempt (nothing is dead-lettered by an open breaker) and the
 *   attempt log shows a `deferred` row with reason `circuit_open`.
 * - half-open: after `open_until` ONE consumer wins the probe (a conditional UPDATE) and sends. A
 *   response that is not a breaker-class failure closes it; a failure reopens it.
 * - It never disables an integration (F183). It is shown on the integration and on each delivery.
 *
 * Test notifications (`is_test`) never read or change this state: a person pressing "send a test"
 * must reach the destination, and a test is not evidence about real traffic (ADR 0018).
 *
 * D1 is the only shared state, so there is no in-memory cache to be wrong after a cold start: a
 * cold start reads the row. All statements carry the tenant predicate.
 */
import type { HeaderReader } from '../connectors/destinations';
import type { ErrorCode } from '../platform/errors';
import type { DeliveryRef } from './ledger';

/** F183: consecutive breaker-class failures that open the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 5;
/** F183: how long it stays open before one probe is allowed. */
export const BREAKER_OPEN_MS = 5 * 60_000;
/** A probe that never reports back (its consumer died) frees the slot after this. */
export const PROBE_LEASE_MS = 60_000;
/** How long a delivery waits when another consumer holds the probe. */
export const PROBE_WAIT_MS = 30_000;
/**
 * Ceiling for a pacing hold derived from rate-limit HEADERS. A 429's own `Retry-After` is honoured up to an
 * hour (the same ceiling as the retry policy, F178): a provider that says "come back in 30 minutes" is
 * obeyed, whereas a bare "remaining: 0" header carries no such promise, so it is capped at five minutes.
 */
export const MAX_PACE_MS = 5 * 60_000;
/**
 * A delivery held back (breaker open or paced) for longer than this since it last made a real attempt is
 * dead-lettered with `circuit_open_timeout` instead of waiting for weeks behind a permanently broken
 * destination. It stays replayable. Engineering judgment: one day matches the first Tier 2 retry rung.
 */
export const MAX_DEFERRED_MS = 24 * 3_600_000;
/** `x-ratelimit-remaining: 0` with no reset information: leave the destination alone this long. */
export const DEFAULT_PACE_MS = 1_000;

export const HEALTH_STATES = ['closed', 'open', 'half_open'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/** Codes that say "the destination is unhealthy". Everything else is an answer from a live endpoint. */
const BREAKER_CODES: ReadonlySet<ErrorCode> = new Set(['destination_unavailable', 'destination_timeout']);

export type HealthEffect = 'success' | 'failure' | 'neutral';

/**
 * What an attempt says about the destination's health.
 * - delivered/accepted, or a failure that is an answer (4xx, rate limit, revoked): `success`;
 * - a breaker-class failure: `failure`;
 * - our own fault (`internal_error`, a render or config problem before any request): `neutral`.
 */
export function effectOf(
  outcome: { readonly kind: string; readonly code?: ErrorCode },
  statusClass: string,
): HealthEffect {
  if (outcome.kind !== 'failed') return 'success';
  if (outcome.code !== undefined && BREAKER_CODES.has(outcome.code)) return 'failure';
  return statusClass === 'none' ? 'neutral' : 'success';
}

function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * How long the destination asked to be left alone, in ms, or null. Read only from rate-limit headers a
 * provider documents (`x-ratelimit-remaining`, `-reset-after`, `-reset`) and from the already-parsed
 * `Retry-After` of a 429. Hard-coded provider limits are not used (F187: parse headers, don't
 * hard-code).
 */
export function paceFromResponse(
  headers: HeaderReader | null,
  retryAfterMs: number | undefined,
  rateLimited: boolean,
  nowMs: number,
): number | null {
  if (rateLimited && retryAfterMs !== undefined) return Math.min(retryAfterMs, 60 * 60_000);
  if (!headers) return null;
  const remaining = parseNumber(headers.get('x-ratelimit-remaining'));
  if (remaining !== 0) return null;
  const resetAfter = parseNumber(headers.get('x-ratelimit-reset-after'));
  if (resetAfter !== null) return Math.min(MAX_PACE_MS, Math.max(1, Math.ceil(resetAfter * 1000)));
  const resetAt = parseNumber(headers.get('x-ratelimit-reset'));
  // Epoch seconds. A value that looks like a duration (small) is read as seconds from now.
  if (resetAt !== null) {
    const ms = resetAt > 1e9 ? resetAt * 1000 - nowMs : resetAt * 1000;
    return Math.min(MAX_PACE_MS, Math.max(1, Math.ceil(ms)));
  }
  const retryAfter = parseNumber(headers.get('retry-after'));
  if (retryAfter !== null) return Math.min(MAX_PACE_MS, Math.max(1, Math.ceil(retryAfter * 1000)));
  return DEFAULT_PACE_MS;
}

interface StoredHealth {
  state: string;
  consecutive_failures: number;
  opened_at: number | null;
  open_until: number | null;
  probe_until: number | null;
  paused_until: number | null;
  opened_count: number;
  last_failure_at: number | null;
  last_failure_code: string | null;
  last_success_at: number | null;
  destination_host: string | null;
}

const SELECT_HEALTH = `SELECT state,consecutive_failures,opened_at,open_until,probe_until,paused_until,opened_count,
  last_failure_at,last_failure_code,last_success_at,destination_host
  FROM destination_health WHERE organization_id=?1 AND integration_id=?2`;

export type GateReason = 'circuit_open' | 'destination_paced' | 'platform_paused';

export type Gate =
  | {
      readonly action: 'proceed';
      /** This send is the half-open probe. */
      readonly probe: boolean;
      /** A health row exists, so the outcome must be recorded even on success. */
      readonly known: boolean;
    }
  | { readonly action: 'defer'; readonly untilMs: number; readonly reason: GateReason };

/**
 * Whether a consumer may call the destination now. At most one consumer wins the half-open probe:
 * the claim is one conditional UPDATE … RETURNING, so two racing consumers cannot both probe.
 */
export async function gateAttempt(
  db: D1Database,
  ref: Pick<DeliveryRef, 'organizationId' | 'integrationId'>,
  nowMs: number,
): Promise<Gate> {
  const row = await db
    .prepare(SELECT_HEALTH)
    .bind(ref.organizationId, ref.integrationId)
    .first<StoredHealth>();
  if (!row) return { action: 'proceed', probe: false, known: false };

  const pausedUntil = row.paused_until ?? 0;
  const openUntil = row.state === 'open' ? (row.open_until ?? 0) : 0;
  const waitUntil = Math.max(pausedUntil, openUntil);
  // A late SUCCESS closes the breaker (healthStatement): an attempt that began before it opened and
  // finished after is evidence the destination is alive, so closing on it is intended.
  if (waitUntil > nowMs) {
    return {
      action: 'defer',
      untilMs: waitUntil,
      reason: openUntil >= pausedUntil && openUntil > nowMs ? 'circuit_open' : 'destination_paced',
    };
  }
  if (row.state === 'closed') return { action: 'proceed', probe: false, known: true };

  // open and due, or half-open: one consumer may probe. A half-open probe whose lease ran out
  // (its consumer died) can be taken over.
  const won = await db
    .prepare(
      `UPDATE destination_health SET state='half_open', probe_until=?3, updated_at=?4
       WHERE organization_id=?1 AND integration_id=?2
         AND ((state='open' AND COALESCE(open_until,0) <= ?4)
           OR (state='half_open' AND COALESCE(probe_until,0) <= ?4))
       RETURNING integration_id`,
    )
    .bind(ref.organizationId, ref.integrationId, nowMs + PROBE_LEASE_MS, nowMs)
    .all();
  if (won.results.length === 1) return { action: 'proceed', probe: true, known: true };
  return { action: 'defer', untilMs: nowMs + PROBE_WAIT_MS, reason: 'circuit_open' };
}

export interface HealthUpdate {
  readonly effect: HealthEffect;
  readonly nowMs: number;
  /** Breaker-class code, recorded on a `failure`. */
  readonly code: ErrorCode | null;
  /** Pacing hold in ms, or null. */
  readonly paceMs: number | null;
}

const HOST = `(SELECT destination_host FROM integrations WHERE id=?2 AND organization_id=?1)`;

/**
 * `becomes open` for a failure: from half-open always, from closed once the count reaches the
 * threshold. An already-open row (an attempt that began before it opened) is left as it is.
 */
const OPENS = `(state='half_open' OR (state='closed' AND consecutive_failures + 1 >= ?5))`;

/**
 * Statement recording one attempt's effect. Place it after the ledger write and the attempt row: it
 * only runs when the previous statement changed a row, so a lost claim touches nothing.
 * Returns null when nothing needs recording (a healthy destination with no pacing request).
 */
export function healthStatement(
  db: D1Database,
  ref: Pick<DeliveryRef, 'organizationId' | 'integrationId'>,
  u: HealthUpdate,
  known: boolean,
): D1PreparedStatement | null {
  const pacedUntil = u.paceMs !== null && u.paceMs > 0 ? u.nowMs + u.paceMs : 0;
  const org = ref.organizationId;
  const integration = ref.integrationId;
  if (u.effect === 'failure') {
    return db
      .prepare(
        `INSERT INTO destination_health(organization_id,integration_id,destination_host,state,consecutive_failures,
           last_failure_at,last_failure_code,paused_until,updated_at)
         SELECT ?1,?2,${HOST},'closed',1,?3,?4,?6,?3 WHERE changes() = 1
         ON CONFLICT(organization_id,integration_id) DO UPDATE SET
           opened_at = CASE WHEN ${OPENS} THEN ?3 ELSE opened_at END,
           open_until = CASE WHEN ${OPENS} THEN ?3 + ${BREAKER_OPEN_MS} ELSE open_until END,
           opened_count = opened_count + CASE WHEN ${OPENS} THEN 1 ELSE 0 END,
           state = CASE WHEN ${OPENS} THEN 'open' ELSE state END,
           probe_until = CASE WHEN ${OPENS} THEN NULL ELSE probe_until END,
           consecutive_failures = consecutive_failures + 1,
           last_failure_at = ?3, last_failure_code = ?4,
           paused_until = MAX(COALESCE(paused_until,0), ?6),
           destination_host = COALESCE(destination_host, excluded.destination_host),
           updated_at = ?3`,
      )
      .bind(org, integration, u.nowMs, u.code, BREAKER_FAILURE_THRESHOLD, pacedUntil);
  }
  if (!known && pacedUntil === 0) return null;
  if (u.effect === 'success') {
    return db
      .prepare(
        `INSERT INTO destination_health(organization_id,integration_id,destination_host,state,consecutive_failures,
           last_success_at,paused_until,updated_at)
         SELECT ?1,?2,${HOST},'closed',0,?3,?6,?3 WHERE changes() = 1
         ON CONFLICT(organization_id,integration_id) DO UPDATE SET
           state='closed', consecutive_failures=0, open_until=NULL, probe_until=NULL,
           last_success_at=?3, paused_until = MAX(COALESCE(paused_until,0), ?6),
           destination_host = COALESCE(destination_host, excluded.destination_host),
           updated_at=?3`,
      )
      .bind(org, integration, u.nowMs, null, null, pacedUntil);
  }
  // neutral: not evidence about the destination. A half-open probe that proved nothing is released
  // so the next consumer may probe at once.
  return db
    .prepare(
      `INSERT INTO destination_health(organization_id,integration_id,destination_host,state,consecutive_failures,
         paused_until,updated_at)
       SELECT ?1,?2,${HOST},'closed',0,?6,?3 WHERE changes() = 1
       ON CONFLICT(organization_id,integration_id) DO UPDATE SET
         open_until = CASE WHEN state='half_open' THEN ?3 ELSE open_until END,
         state = CASE WHEN state='half_open' THEN 'open' ELSE state END,
         probe_until = CASE WHEN state='half_open' THEN NULL ELSE probe_until END,
         paused_until = MAX(COALESCE(paused_until,0), ?6),
         updated_at=?3`,
    )
    .bind(org, integration, u.nowMs, null, null, pacedUntil);
}

export interface DestinationHealthView {
  readonly state: HealthState;
  /** True while the breaker is holding deliveries back (open or half-open). */
  readonly paused: boolean;
  readonly consecutiveFailures: number;
  /** When the next probe is allowed, ISO; null when closed. */
  readonly retryAt: string | null;
  /** The destination asked to be left alone until this instant (rate limit), ISO. */
  readonly pacedUntil: string | null;
  readonly lastFailureCode: string | null;
  readonly lastFailureAt: string | null;
  readonly timesOpened: number;
}

type HealthColumns = {
  health_state: string | null;
  health_failures: number | null;
  health_open_until: number | null;
  health_paused_until: number | null;
  health_last_failure_code: string | null;
  health_last_failure_at: number | null;
  health_opened_count: number | null;
};

const HEALTH_SELECT = `integration_id, state AS health_state, consecutive_failures AS health_failures,
  open_until AS health_open_until, paused_until AS health_paused_until,
  last_failure_code AS health_last_failure_code, last_failure_at AS health_last_failure_at,
  opened_count AS health_opened_count`;

/** Rows to show per workspace; the integration list is itself bounded (200). */
const HEALTH_LIST_LIMIT = 500;

/**
 * Health of this workspace's integrations (tenant-scoped), by integration id. An integration with
 * no row has never failed, been rate limited or paced, and reads as healthy (`null`).
 */
export async function loadHealth(
  db: D1Database,
  organizationId: string,
  nowMs: number,
  integrationId?: string,
): Promise<Map<string, DestinationHealthView>> {
  const rows = integrationId
    ? await db
        .prepare(
          `SELECT ${HEALTH_SELECT} FROM destination_health WHERE organization_id=?1 AND integration_id=?2`,
        )
        .bind(organizationId, integrationId)
        .all<HealthColumns & { integration_id: string }>()
    : await db
        .prepare(`SELECT ${HEALTH_SELECT} FROM destination_health WHERE organization_id=?1 LIMIT ?2`)
        .bind(organizationId, HEALTH_LIST_LIMIT)
        .all<HealthColumns & { integration_id: string }>();
  const out = new Map<string, DestinationHealthView>();
  for (const r of rows.results) {
    const view = toHealthView(r, nowMs);
    if (view) out.set(r.integration_id, view);
  }
  return out;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Pure read model. `null` when the integration has never had a failure or a pacing hold recorded. */
export function toHealthView(row: Partial<HealthColumns>, nowMs: number): DestinationHealthView | null {
  if (row.health_state === null || row.health_state === undefined) return null;
  const state: HealthState =
    row.health_state === 'open' || row.health_state === 'half_open' ? row.health_state : 'closed';
  const paused = state !== 'closed';
  const pacedUntil = row.health_paused_until ?? 0;
  return {
    state,
    paused,
    consecutiveFailures: row.health_failures ?? 0,
    retryAt: paused ? iso(row.health_open_until ?? nowMs) : null,
    pacedUntil: pacedUntil > nowMs ? iso(pacedUntil) : null,
    lastFailureCode: row.health_last_failure_code ?? null,
    lastFailureAt: iso(row.health_last_failure_at ?? null),
    timesOpened: row.health_opened_count ?? 0,
  };
}

/** Housekeeping: rows of closed, quiet destinations (or deleted integrations) are dropped after this. */
export const HEALTH_RETENTION_MS = 30 * 24 * 3_600_000;
