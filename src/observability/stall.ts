/**
 * Stall detection (docs/specs/13-observability.md F200 `outbox_stalled`, `consumer_lag`;
 * F198: backlog AGE is the signal, depth is not).
 *
 * Inputs come from D1 only (never from logs, F196). Each cron tick counts rows that are
 * past a threshold; `decideStall` turns the counts plus the previous state into at most one
 * log line, so a persistent stall warns on entry and then once per re-notify interval,
 * and recovery logs once. State lives in `ops_state` (migration 0016).
 *
 * Counts are platform-wide and carry no tenant ids, payloads or URLs. This is DETECTION written to logs.
 * The `outbox_stall` alert (src/observability/alerts) reads the same counts and announces to the sinks.
 * The two state machines are NOT merged on purpose (ADR 0024): this one logs a `warn` line that existing
 * runbooks and log searches key on, with its own state key in `ops_state`; the engine adds confirm and
 * clear hysteresis, sinks and retries. Merging would change the log contract for no new signal.
 */
import { DELIVERY_CLAIM_LEASE_MS } from '../delivery/ledger';
import { sqliteTimestamp } from '../delivery/claim';
import type { Bindings } from '../env';
import { log } from '../platform/log';

/** F200 `outbox_stalled`: a pending outbox row older than five minutes. */
export const OUTBOX_STALL_MS = 5 * 60_000;
/** A claimed delivery still held two leases after the claim: the sweep should have released it. */
export const CLAIM_STALL_MS = 2 * DELIVERY_CLAIM_LEASE_MS;
/** A retry that has been due for this long was never redispatched. */
export const RETRY_OVERDUE_MS = 15 * 60_000;
/** While a stall persists, repeat the warning at most this often. */
export const RENOTIFY_MS = 60 * 60_000;

export const STALL_STATE_KEY = 'stall_detector';

export interface StallCounts {
  readonly outboxPending: number;
  readonly claimedStale: number;
  readonly retryOverdue: number;
}

export interface StallState {
  readonly firing: boolean;
  readonly since: number | null;
  readonly notifiedAt: number | null;
}

export const QUIET: StallState = { firing: false, since: null, notifiedAt: null };

export type StallAction = 'none' | 'raise' | 'renotify' | 'recover';

export interface StallDecision {
  readonly action: StallAction;
  readonly next: StallState;
}

export function isStalled(c: StallCounts): boolean {
  return c.outboxPending > 0 || c.claimedStale > 0 || c.retryOverdue > 0;
}

/** Pure transition: log on entry, at the re-notify interval, and on recovery; otherwise stay quiet. */
export function decideStall(counts: StallCounts, prev: StallState, nowMs: number): StallDecision {
  if (!isStalled(counts)) {
    return { action: prev.firing ? 'recover' : 'none', next: QUIET };
  }
  if (!prev.firing) return { action: 'raise', next: { firing: true, since: nowMs, notifiedAt: nowMs } };
  const due = prev.notifiedAt === null || nowMs - prev.notifiedAt >= RENOTIFY_MS;
  return {
    action: due ? 'renotify' : 'none',
    next: { firing: true, since: prev.since ?? nowMs, notifiedAt: due ? nowMs : prev.notifiedAt },
  };
}

type Db = Pick<D1Database, 'prepare'>;

/** Each count is capped (a stall of thousands reads the same as one of a thousand) so the query stays cheap in an outage. */
export const STALL_COUNT_CAP = 1000;

/** ?1 outbox cutoff (text) · ?2 claim cutoff · ?3 due cutoff · ?4 retry cutoff · ?5 cap. */
export const STALL_SQL = `SELECT
  (SELECT COUNT(*) FROM (SELECT 1 FROM notification_outbox
     WHERE state='pending' AND created_at<=?1 AND (not_before IS NULL OR not_before<=?3)
       AND NOT EXISTS (SELECT 1 FROM deliveries t WHERE t.id=notification_outbox.id AND t.is_test=1)
     LIMIT ?5)) AS outbox_pending,
  (SELECT COUNT(*) FROM (SELECT 1 FROM deliveries WHERE state='claimed' AND is_test=0 AND claimed_at<=?2 LIMIT ?5)) AS claimed_stale,
  (SELECT COUNT(*) FROM (SELECT 1 FROM deliveries WHERE state='retrying' AND is_test=0 AND next_attempt_at<=?4 LIMIT ?5)) AS retry_overdue`;

export async function countStalls(db: Db, nowMs: number): Promise<StallCounts> {
  const row = await db
    .prepare(STALL_SQL)
    .bind(
      sqliteTimestamp(nowMs - OUTBOX_STALL_MS),
      nowMs - CLAIM_STALL_MS,
      nowMs - OUTBOX_STALL_MS,
      nowMs - RETRY_OVERDUE_MS,
      STALL_COUNT_CAP,
    )
    .first<{ outbox_pending: number; claimed_stale: number; retry_overdue: number }>();
  return {
    outboxPending: row?.outbox_pending ?? 0,
    claimedStale: row?.claimed_stale ?? 0,
    retryOverdue: row?.retry_overdue ?? 0,
  };
}

async function loadState(db: Db): Promise<StallState> {
  const row = await db
    .prepare('SELECT value FROM ops_state WHERE key=?1')
    .bind(STALL_STATE_KEY)
    .first<{ value: string }>();
  if (!row) return QUIET;
  try {
    const v = JSON.parse(row.value) as Partial<StallState>;
    return {
      firing: v.firing === true,
      since: typeof v.since === 'number' ? v.since : null,
      notifiedAt: typeof v.notifiedAt === 'number' ? v.notifiedAt : null,
    };
  } catch {
    return QUIET;
  }
}

async function saveState(db: Db, state: StallState, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .bind(STALL_STATE_KEY, JSON.stringify(state), nowMs)
    .run();
}

/** Cron hook. Returns the action taken (for tests); logs counts only. */
export async function detectStalls(
  env: Pick<Bindings, 'DB'>,
  nowMs: number = Date.now(),
  shared?: Promise<StallCounts>,
): Promise<StallAction> {
  // `shared` is the tick's one read, also handed to the alert engine (src/index.ts).
  const counts = await (shared ?? countStalls(env.DB, nowMs));
  const prev = await loadState(env.DB);
  const { action, next } = decideStall(counts, prev, nowMs);
  if (action === 'raise' || action === 'renotify') {
    log('warn', 'delivery_stall', {
      outbox_pending_over_threshold: counts.outboxPending,
      claimed_stale: counts.claimedStale,
      retry_overdue: counts.retryOverdue,
      firing_for_ms: prev.since === null ? 0 : nowMs - prev.since,
      renotify: action === 'renotify',
    });
  } else if (action === 'recover') {
    log('info', 'delivery_stall_recovered', { firing_for_ms: prev.since === null ? 0 : nowMs - prev.since });
  }
  // Skip the write when nothing changed, so a quiet system costs one read per tick.
  if (action !== 'none' || next.firing !== prev.firing) await saveState(env.DB, next, nowMs);
  return action;
}
