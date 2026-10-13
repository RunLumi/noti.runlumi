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
    readonly oldestOutboxPendingAgeMs: number | null;
  };
  readonly byDestination: readonly DestinationSli[];
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
    reason: 'Request received to 202 sent is not timestamped; there is no delivery_attempts table (F198).',
  },
  {
    sli: 'attempt_latency',
    reason: 'Outbound fetch duration is not recorded; only the attempt completion time is stored.',
  },
  {
    sli: 'unmapped_provider_errors',
    reason: 'The adapters flag unmapped responses per attempt but the flag is not persisted in the ledger.',
  },
  {
    sli: 'duplicate_rate',
    reason:
      'Only rows in state suppressed are visible; duplicates dropped at ingress (INSERT OR IGNORE) are not counted.',
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
  '(sent + accepted) / (sent + accepted + dead_lettered). `accepted` means the provider accepted the request ' +
  'but cannot confirm delivery (Teams Workflows); it is counted as success here and reported separately per destination.';
const RETRY_DEFINITION =
  'deliveries with more than one recorded attempt / deliveries with at least one recorded attempt.';

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

/** Nearest-rank percentile index (0-based) for `n` samples. */
export function nearestRankIndex(n: number, p: number): number {
  return Math.max(0, Math.ceil(p * n) - 1);
}

async function percentile(
  db: Db,
  valueSql: string,
  org: string,
  since: string,
  n: number,
  p: number,
): Promise<number | null> {
  if (n === 0) return null;
  const row = await db
    .prepare(
      `SELECT v FROM (SELECT ${valueSql} AS v FROM deliveries
         WHERE organization_id=?1 AND created_at>=?2 AND state IN ('sent','accepted')
           AND created_at IS NOT NULL AND ${valueSql} IS NOT NULL AND ${valueSql} >= 0)
       ORDER BY v LIMIT 1 OFFSET ?3`,
    )
    .bind(org, since, nearestRankIndex(n, p))
    .first<{ v: number }>();
  return row?.v ?? null;
}

async function latency(db: Db, valueSql: string, org: string, since: string): Promise<LatencySummary> {
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS terminal,
              SUM(CASE WHEN ${valueSql} IS NOT NULL AND ${valueSql} >= 0 THEN 1 ELSE 0 END) AS usable
       FROM deliveries WHERE organization_id=?1 AND created_at>=?2 AND state IN ('sent','accepted')`,
    )
    .bind(org, since)
    .first<{ terminal: number; usable: number | null }>();
  const samples = counts?.usable ?? 0;
  return {
    samples,
    excluded: (counts?.terminal ?? 0) - samples,
    p50Ms: await percentile(db, valueSql, org, since, samples, 0.5),
    p95Ms: await percentile(db, valueSql, org, since, samples, 0.95),
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
       WHERE d.organization_id=?1 AND d.created_at>=?2
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

async function backlog(db: Db, org: string, nowMs: number): Promise<ObservabilitySummary['backlog']> {
  const d = await db
    .prepare(
      `SELECT
         MIN(CASE WHEN state='pending' THEN ${CREATED_MS} END) AS pending_at,
         MIN(CASE WHEN state='claimed' THEN claimed_at END) AS claimed_at,
         MIN(CASE WHEN state='retrying' AND next_attempt_at<=?2 THEN next_attempt_at END) AS retry_at
       FROM deliveries WHERE organization_id=?1 AND state IN ('pending','claimed','retrying')`,
    )
    .bind(org, nowMs)
    .first<{ pending_at: number | null; claimed_at: number | null; retry_at: number | null }>();
  const o = await db
    .prepare(
      `SELECT MIN(CAST(strftime('%s', created_at) AS INTEGER) * 1000) AS at
       FROM notification_outbox WHERE organization_id=?1 AND state='pending'`,
    )
    .bind(org)
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
  const [states, retry, codes, endToEnd, queueDelay, byDestination, pending] = await Promise.all([
    db
      .prepare(
        'SELECT state, COUNT(*) AS n FROM deliveries WHERE organization_id=?1 AND created_at>=?2 GROUP BY state',
      )
      .bind(organizationId, since)
      .all<StateRow>(),
    db
      .prepare(
        `SELECT SUM(CASE WHEN attempts>=1 THEN 1 ELSE 0 END) AS attempted,
                SUM(CASE WHEN attempts>1 THEN 1 ELSE 0 END) AS retried
         FROM deliveries WHERE organization_id=?1 AND created_at>=?2`,
      )
      .bind(organizationId, since)
      .first<{ attempted: number | null; retried: number | null }>(),
    db
      .prepare(
        `SELECT COALESCE(last_error_code,'unknown') AS code, COUNT(*) AS n FROM deliveries
         WHERE organization_id=?1 AND created_at>=?2 AND state IN ('dead_lettered','failed')
         GROUP BY COALESCE(last_error_code,'unknown') ORDER BY n DESC, code LIMIT ?3`,
      )
      .bind(organizationId, since, TOP_ERROR_CODES)
      .all<{ code: string; n: number }>(),
    latency(db, END_TO_END_SQL, organizationId, since),
    latency(db, QUEUE_DELAY_SQL, organizationId, since),
    destinationBreakdown(db, organizationId, since),
    backlog(db, organizationId, nowMs),
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
    byDestination,
    notMeasurable: NOT_MEASURABLE,
  };
}
