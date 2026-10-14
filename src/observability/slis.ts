/**
 * Delivery SLIs computed from the D1 ledger (docs/specs/13-observability.md F197, F198).
 *
 * Everything here is an exact figure over rows that exist in `deliveries` and
 * `notification_outbox` for ONE workspace and ONE window; nothing is estimated, sampled or
 * invented. Rules inherited from the spec:
 *  - an SLI with no data is `null`, never 0 and never 1 (an empty window is "no data");
 *  - every ratio carries its numerator, denominator and definition;
 *  - Teams `accepted` is reported as accepted, never folded into "delivered" (F100, F197);
 *  - no average is published as a latency figure; percentiles are exact nearest-rank;
 *  - SLIs we cannot measure from recorded columns are listed in `notMeasurable` with the
 *    reason, rather than guessed.
 *
 * Timestamp reality (migration 0009): `deliveries.created_at` is a SQLite text timestamp
 * with one-second resolution (and NULL on rows written before 0009); `first_attempt_at`,
 * `last_attempt_at`, `claimed_at` and `next_attempt_at` are epoch milliseconds. There is no
 * `sent_at`: the end-to-end figure is `last_attempt_at` (the attempt that reached the
 * terminal state) minus `created_at`, so it carries up to one second of resolution error.
 *
 * User-requested test notifications (`is_test = 1`, ADR 0018) are excluded from every ratio,
 * count, latency, error breakdown and backlog age here: they measure a person's click, not the
 * service, and stall detection ignores them too. The server's in-flight guard bounds how many can
 * exist per integration.
 *
 * Every ratio is a cohort by creation time: rows CREATED inside the window, counted by their
 * CURRENT state (a row created before the window that finishes inside it is not counted).
 * Every statement is scoped by `organization_id` (F24).
 */
import { sqliteTimestamp } from '../delivery/claim';
import { normalizeDeliveryState, type DeliveryState } from '../delivery/state';

type Db = Pick<D1Database, 'prepare'>;

export const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOP_ERROR_CODES = 10;

/** Parse `?window=` (`<n>h` or `<n>d`) into milliseconds, bounded to 1 hour .. 30 days. */
export function parseWindow(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_WINDOW_MS;
  const m = /^([1-9]\d{0,3})([hd])$/.exec(raw);
  if (!m) return null;
  const ms = Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000);
  return ms >= MIN_WINDOW_MS && ms <= MAX_WINDOW_MS ? ms : null;
}

export interface Ratio {
  /** `null` means no data in the window: not 0 and not 1. */
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}

export interface LatencySummary {
  /** Rows with both timestamps present and a non-negative difference. */
  readonly samples: number;
  /** Terminal rows left out because a timestamp was missing (pre-0009 rows). */
  readonly excluded: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  /** The text timestamp has one-second resolution; this is stated, not hidden. */
  readonly resolutionMs: 1000;
}

export type OutcomeKind = 'delivered' | 'accepted';

export interface DestinationSli {
  readonly destination: string;
  /** What a success means for this destination: Teams Workflows only ever reaches `accepted`. */
  readonly outcomeKind: OutcomeKind;
  readonly total: number;
  readonly sent: number;
  readonly accepted: number;
  readonly deadLettered: number;
  readonly successRatio: Ratio;
}

export interface NotMeasurable {
  readonly sli: string;
  readonly reason: string;
}

export interface ObservabilitySummary {
  readonly provenance: 'exact';
  readonly generatedAtMs: number;
  readonly window: { readonly sinceMs: number; readonly untilMs: number };
  readonly deliveries: { readonly total: number; readonly byState: Readonly<Record<DeliveryState, number>> };
  readonly successRatio: Ratio & { readonly definition: string };
  readonly retryRate: Ratio & { readonly definition: string };
  readonly deadLetter: {
    readonly count: number;
    readonly byErrorCode: readonly { readonly code: string; readonly count: number }[];
  };
  readonly latency: { readonly endToEnd: LatencySummary; readonly queueDelay: LatencySummary };
  /** Current backlog ages (not windowed). Age, not depth, is the alerting signal (F198). */
  readonly backlog: {
    readonly oldestPendingAgeMs: number | null;
    readonly oldestClaimedAgeMs: number | null;
    readonly oldestRetryOverdueMs: number | null;
    /** Over DUE outbox rows only (`not_before` empty or past): a parked retry is waiting by design. */
    readonly oldestOutboxPendingAgeMs: number | null;
  };
  /**
   * Provider-source events dropped by the per-source flood limit (GitLab absorbs instead of
   * answering 429). `total` is the lifetime counter across the workspace's sources;
   * `sourcesInWindow` counts sources that dropped something inside the window.
   */
  readonly ingressDropped: { readonly total: number; readonly sourcesInWindow: number };
  readonly byDestination: readonly DestinationSli[];
  /**
   * F185/F171: repeats we recorded instead of dropping (`suppressed` rows: provider redeliveries) and
   * deliveries that were retried after an unconfirmed attempt and so MAY have reached the destination
   * twice. `possibleDuplicates` is an upper bound on duplicates we cannot detect, not a count of them.
   * Test notifications are excluded.
   */
  readonly duplicates: {
    readonly suppressed: number;
    readonly rate: Ratio;
    readonly possibleDuplicates: number;
  };
  /**
   * F183/F187, current (not windowed): integrations whose breaker is open or half-open and integrations
   * the destination asked to be left alone, plus attempts deferred in the window. Tests never count.
   */
  readonly destinationHealth: {
    readonly open: number;
    readonly halfOpen: number;
    readonly paced: number;
    readonly deferredAttempts: number;
  };
  readonly notMeasurable: readonly NotMeasurable[];
}

/** SLIs the ledger cannot support yet, with the missing data named. Never filled with a guess. */
export const NOT_MEASURABLE: readonly NotMeasurable[] = [
  {
    sli: 'acceptance_rate',
    reason: 'No events table or ingress counter exists; rejected ingress requests are not recorded (F197).',
  },
  {
    sli: 'routing_rate',
    reason: 'No events table exists, so events producing no delivery are not recorded.',
  },
  {
    sli: 'ack_latency',
    reason: 'Request received to 202 sent is not timestamped at ingress (F198).',
  },
  {
    sli: 'attempt_latency',
    reason:
      'Each attempt records its start and end in delivery_attempts, but no aggregate is computed from them yet; the claim-to-outcome span also includes the lookup of the stored destination.',
  },
  {
    sli: 'unmapped_provider_errors',
    reason: 'The adapters flag unmapped responses per attempt but the flag is not persisted in the ledger.',
  },
  { sli: 'end_user_received', reason: 'Not observable: the destination is not ours to instrument (F197).' },
];

/** Epoch ms of `created_at` (one-second resolution), usable inside SQL. */
const CREATED_MS = "(CAST(strftime('%s', created_at) AS INTEGER) * 1000)";

const ZERO_STATES: Readonly<Record<DeliveryState, number>> = {
  pending: 0,
  claimed: 0,
  sent: 0,
  accepted: 0,
  retrying: 0,
  dead_lettered: 0,
  suppressed: 0,
};

const SUCCESS_DEFINITION =
  'Cohort by creation time: rows created inside the window, by their current state. (sent + accepted) / (sent + accepted + dead_lettered). `accepted` means the provider accepted the request ' +
  'but cannot confirm delivery (Teams Workflows); it is counted as success here and reported separately per destination.';
const RETRY_DEFINITION =
  'Cohort by creation time: rows created inside the window. Deliveries with more than one recorded attempt / deliveries with at least one recorded attempt.';

interface StateRow {
  readonly state: string;
  readonly n: number;
}

function foldStates(rows: readonly StateRow[]): Record<DeliveryState, number> {
  const out: Record<DeliveryState, number> = { ...ZERO_STATES };
  for (const r of rows) {
    const s = normalizeDeliveryState(r.state);
    out[s] += r.n;
  }
  return out;
}

function terminalDenominator(s: Readonly<Record<DeliveryState, number>>): number {
  return s.sent + s.accepted + s.dead_lettered;
}

/**
 * One statement per latency summary: the sample count, both percentiles and the terminal
 * row count are read in a single SELECT, so they describe the same snapshot (no count/fetch
 * race between statements). Nearest rank: the value at 0-based index
 * `ceil(p * n) - 1`, written with integer arithmetic as `(n * pct + 99) / 100 - 1`.
 * Uses `deliveries_org_created` (0013) for the workspace and window.
 * ?1 organization_id · ?2 text cutoff
 */
function latencySql(valueSql: string): string {
  const pct = (q: number): string =>
    `(SELECT v FROM s ORDER BY v LIMIT 1 OFFSET (SELECT MAX(0, (COUNT(*) * ${q} + 99) / 100 - 1) FROM s))`;
  return `WITH s AS (
    SELECT ${valueSql} AS v FROM deliveries
    WHERE organization_id=?1 AND created_at>=?2 AND is_test=0 AND state IN ('sent','accepted')
      AND ${valueSql} IS NOT NULL AND ${valueSql} >= 0)
  SELECT (SELECT COUNT(*) FROM s) AS samples,
         ${pct(50)} AS p50,
         ${pct(95)} AS p95,
         (SELECT COUNT(*) FROM deliveries
            WHERE organization_id=?1 AND created_at>=?2 AND is_test=0 AND state IN ('sent','accepted')) AS terminal`;
}

async function latency(db: Db, valueSql: string, org: string, since: string): Promise<LatencySummary> {
  const row = await db
    .prepare(latencySql(valueSql))
    .bind(org, since)
    .first<{ samples: number; p50: number | null; p95: number | null; terminal: number }>();
  const samples = row?.samples ?? 0;
  return {
    samples,
    excluded: (row?.terminal ?? 0) - samples,
    p50Ms: row?.p50 ?? null,
    p95Ms: row?.p95 ?? null,
    resolutionMs: 1000,
  };
}

const END_TO_END_SQL = `(last_attempt_at - ${CREATED_MS})`;
const QUEUE_DELAY_SQL = `(first_attempt_at - ${CREATED_MS})`;

async function destinationBreakdown(db: Db, org: string, since: string): Promise<DestinationSli[]> {
  const rows = await db
    .prepare(
      `SELECT COALESCE(i.destination,'unknown') AS destination, d.state AS state, COUNT(*) AS n
       FROM deliveries d LEFT JOIN integrations i ON i.id=d.integration_id AND i.organization_id=d.organization_id
       WHERE d.organization_id=?1 AND d.created_at>=?2 AND d.is_test=0
       GROUP BY COALESCE(i.destination,'unknown'), d.state`,
    )
    .bind(org, since)
    .all<StateRow & { destination: string }>();
  const grouped = new Map<string, StateRow[]>();
  for (const r of rows.results) grouped.set(r.destination, [...(grouped.get(r.destination) ?? []), r]);
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([destination, list]) => {
      const s = foldStates(list);
      const total = Object.values(s).reduce((a, b) => a + b, 0);
      return {
        destination,
        outcomeKind: destination === 'teams' ? 'accepted' : 'delivered',
        total,
        sent: s.sent,
        accepted: s.accepted,
        deadLettered: s.dead_lettered,
        successRatio: ratio(s.sent + s.accepted, terminalDenominator(s)),
      };
    });
}

async function duplicates(
  db: Db,
  org: string,
  since: string,
  byState: Readonly<Record<DeliveryState, number>>,
): Promise<ObservabilitySummary['duplicates']> {
  const possible = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM deliveries WHERE organization_id=?1 AND created_at>=?2 AND is_test=0 AND possible_duplicate=1',
    )
    .bind(org, since)
    .first<{ n: number }>();
  const total = Object.values(byState).reduce((a, b) => a + b, 0);
  return {
    suppressed: byState.suppressed,
    rate: ratio(byState.suppressed, total),
    possibleDuplicates: possible?.n ?? 0,
  };
}

async function destinationHealth(
  db: Db,
  org: string,
  sinceMs: number,
  nowMs: number,
): Promise<ObservabilitySummary['destinationHealth']> {
  const [health, deferred] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(SUM(state='open'),0) AS open, COALESCE(SUM(state='half_open'),0) AS half_open,
                COALESCE(SUM(COALESCE(paused_until,0) > ?2),0) AS paced
         FROM destination_health WHERE organization_id=?1`,
      )
      .bind(org, nowMs)
      .first<{ open: number; half_open: number; paced: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM delivery_attempts WHERE organization_id=?1 AND started_at>=?2 AND outcome='deferred'",
      )
      .bind(org, sinceMs)
      .first<{ n: number }>(),
  ]);
  return {
    open: health?.open ?? 0,
    halfOpen: health?.half_open ?? 0,
    paced: health?.paced ?? 0,
    deferredAttempts: deferred?.n ?? 0,
  };
}

async function backlog(db: Db, org: string, nowMs: number): Promise<ObservabilitySummary['backlog']> {
  const d = await db
    .prepare(
      `SELECT
         MIN(CASE WHEN state='pending' THEN ${CREATED_MS} END) AS pending_at,
         MIN(CASE WHEN state='claimed' THEN claimed_at END) AS claimed_at,
         MIN(CASE WHEN state='retrying' AND next_attempt_at<=?2 THEN next_attempt_at END) AS retry_at
       FROM deliveries WHERE organization_id=?1 AND is_test=0 AND state IN ('pending','claimed','retrying')`,
    )
    .bind(org, nowMs)
    .first<{ pending_at: number | null; claimed_at: number | null; retry_at: number | null }>();
  const o = await db
    .prepare(
      `SELECT MIN(CAST(strftime('%s', created_at) AS INTEGER) * 1000) AS at
       FROM notification_outbox
       WHERE organization_id=?1 AND state='pending' AND (not_before IS NULL OR not_before<=?2)
         AND NOT EXISTS (SELECT 1 FROM deliveries t WHERE t.id=notification_outbox.id AND t.is_test=1)`,
    )
    .bind(org, nowMs)
    .first<{ at: number | null }>();
  const age = (at: number | null | undefined): number | null =>
    typeof at === 'number' ? Math.max(0, nowMs - at) : null;
  return {
    oldestPendingAgeMs: age(d?.pending_at),
    oldestClaimedAgeMs: age(d?.claimed_at),
    oldestRetryOverdueMs: age(d?.retry_at),
    oldestOutboxPendingAgeMs: age(o?.at),
  };
}

/** Compute the workspace summary for `[nowMs - windowMs, nowMs]`. */
export async function computeSummary(
  db: Db,
  organizationId: string,
  windowMs: number,
  nowMs: number = Date.now(),
): Promise<ObservabilitySummary> {
  const since = sqliteTimestamp(nowMs - windowMs);
  const [states, retry, codes, endToEnd, queueDelay, byDestination, pending, dropped] = await Promise.all([
    db
      .prepare(
        'SELECT state, COUNT(*) AS n FROM deliveries WHERE organization_id=?1 AND created_at>=?2 AND is_test=0 GROUP BY state',
      )
      .bind(organizationId, since)
      .all<StateRow>(),
    db
      .prepare(
        `SELECT SUM(CASE WHEN attempts>=1 THEN 1 ELSE 0 END) AS attempted,
                SUM(CASE WHEN attempts>1 THEN 1 ELSE 0 END) AS retried
         FROM deliveries WHERE organization_id=?1 AND created_at>=?2 AND is_test=0`,
      )
      .bind(organizationId, since)
      .first<{ attempted: number | null; retried: number | null }>(),
    db
      .prepare(
        `SELECT COALESCE(last_error_code,'unknown') AS code, COUNT(*) AS n FROM deliveries
         WHERE organization_id=?1 AND created_at>=?2 AND is_test=0 AND state IN ('dead_lettered','failed')
         GROUP BY COALESCE(last_error_code,'unknown') ORDER BY n DESC, code LIMIT ?3`,
      )
      .bind(organizationId, since, TOP_ERROR_CODES)
      .all<{ code: string; n: number }>(),
    latency(db, END_TO_END_SQL, organizationId, since),
    latency(db, QUEUE_DELAY_SQL, organizationId, since),
    destinationBreakdown(db, organizationId, since),
    backlog(db, organizationId, nowMs),
    db
      .prepare(
        `SELECT COALESCE(SUM(dropped_events),0) AS total,
                COALESCE(SUM(CASE WHEN last_dropped_at>=?2 THEN 1 ELSE 0 END),0) AS recent
         FROM sources WHERE organization_id=?1`,
      )
      .bind(organizationId, since)
      .first<{ total: number; recent: number }>(),
  ]);
  const byState = foldStates(states.results);
  const total = Object.values(byState).reduce((a, b) => a + b, 0);
  return {
    provenance: 'exact',
    generatedAtMs: nowMs,
    window: { sinceMs: nowMs - windowMs, untilMs: nowMs },
    deliveries: { total, byState },
    successRatio: {
      ...ratio(byState.sent + byState.accepted, terminalDenominator(byState)),
      definition: SUCCESS_DEFINITION,
    },
    retryRate: { ...ratio(retry?.retried ?? 0, retry?.attempted ?? 0), definition: RETRY_DEFINITION },
    deadLetter: {
      count: byState.dead_lettered,
      byErrorCode: codes.results.map((r) => ({ code: r.code, count: r.n })),
    },
    latency: { endToEnd, queueDelay },
    backlog: pending,
    ingressDropped: { total: dropped?.total ?? 0, sourcesInWindow: dropped?.recent ?? 0 },
    byDestination,
    duplicates: await duplicates(db, organizationId, since, byState),
    destinationHealth: await destinationHealth(db, organizationId, nowMs - windowMs, nowMs),
    notMeasurable: NOT_MEASURABLE,
  };
}
