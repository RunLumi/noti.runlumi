/**
 * Alert state machine (docs/specs/13-observability.md F200) and its `alert_state` persistence.
 *
 *   quiet -> breached N times  FIRE      one notification; dedupe key `<alert>:<since>` names the incident
 *   firing, still breached     nothing   until the re-notify cadence elapses, then RENOTIFY (same key)
 *   firing -> clear M times    RESOLVE   one notification; the row stays as `resolved`
 *
 * `decideAlert` is pure. A signal that could not be read (`breached === null`) changes nothing. An alert
 * with `confirmTicks > 1` must breach that many evaluations in a row before it fires, so one false reading
 * never notifies anyone, and it must be clear `resolveTicks` evaluations in a row before RESOLVED is sent,
 * so a signal that flaps around its threshold does not produce a FIRING/RESOLVED pair every few minutes.
 * The dedupe key is stable for the whole incident, so a receiver can collapse repeats; a new incident gets
 * a new one.
 *
 * A notice a sink refused is remembered on the row (`unsent`, `retryAt`, `notifyFailures`) by the engine,
 * which re-sends THAT kind later (a FIRING stays a FIRING), at most `MAX_NOTIFY_FAILURES` times.
 */
export type AlertStatus = 'firing' | 'resolved';
export type NoticeKind = 'firing' | 'renotify' | 'resolved';

export interface AlertRow {
  readonly alertId: string;
  readonly state: AlertStatus;
  /** When the alert entered this state (epoch ms). */
  readonly since: number;
  /** Last time a notification was (considered) delivered, epoch ms. */
  readonly lastNotified: number | null;
  readonly dedupeKey: string;
  readonly lastValue: number | null;
  /** Consecutive breached evaluations (0 when clear). */
  readonly breaches: number;
  /** Consecutive clear evaluations while firing (0 otherwise). */
  readonly clears: number;
  /** A notice no sink accepted yet, and when to try again. */
  readonly unsent: NoticeKind | null;
  readonly retryAt: number | null;
  readonly notifyFailures: number;
}

export type AlertAction = 'none' | 'fire' | 'renotify' | 'resolve';

export interface AlertDecision {
  readonly action: AlertAction;
  readonly next: AlertRow | null;
}

export function dedupeKeyFor(id: string, sinceMs: number): string {
  return `${id}:${sinceMs}`;
}

export interface AlertInput {
  readonly id: string;
  /** `null` = the signal could not be read: change nothing. */
  readonly breached: boolean | null;
  readonly value: number | null;
  readonly nowMs: number;
  readonly renotifyMs: number;
  readonly confirmTicks: number;
  readonly resolveTicks: number;
}

const NOTHING_UNSENT = { unsent: null, retryAt: null, notifyFailures: 0 } as const;

export function decideAlert(prev: AlertRow | null, input: AlertInput): AlertDecision {
  const { id, breached, value, nowMs, renotifyMs, confirmTicks, resolveTicks } = input;
  if (breached === null) return { action: 'none', next: prev };
  const firing = prev?.state === 'firing';

  if (breached) {
    if (firing && prev) {
      const due = prev.lastNotified === null || nowMs - prev.lastNotified >= renotifyMs;
      if (due) {
        return {
          action: 'renotify',
          next: { ...prev, lastNotified: nowMs, lastValue: value, clears: 0, ...NOTHING_UNSENT },
        };
      }
      // A quiet tick writes nothing, unless a clear streak must be reset.
      return { action: 'none', next: prev.clears > 0 ? { ...prev, clears: 0 } : prev };
    }
    const breaches = (prev?.breaches ?? 0) + 1;
    if (breaches >= confirmTicks) {
      return {
        action: 'fire',
        next: {
          alertId: id,
          state: 'firing',
          since: nowMs,
          lastNotified: nowMs,
          dedupeKey: dedupeKeyFor(id, nowMs),
          lastValue: value,
          breaches,
          clears: 0,
          ...NOTHING_UNSENT,
        },
      };
    }
    return {
      action: 'none',
      next: {
        alertId: id,
        state: 'resolved',
        since: prev?.since ?? nowMs,
        lastNotified: prev?.lastNotified ?? null,
        dedupeKey: prev?.dedupeKey ?? '',
        lastValue: value,
        breaches,
        clears: 0,
        unsent: prev?.unsent ?? null,
        retryAt: prev?.retryAt ?? null,
        notifyFailures: prev?.notifyFailures ?? 0,
      },
    };
  }

  if (firing && prev) {
    const clears = prev.clears + 1;
    if (clears >= resolveTicks) {
      return {
        action: 'resolve',
        next: {
          ...prev,
          state: 'resolved',
          since: nowMs,
          lastNotified: nowMs,
          lastValue: value,
          breaches: 0,
          clears: 0,
          ...NOTHING_UNSENT,
        },
      };
    }
    return { action: 'none', next: { ...prev, clears, lastValue: value } };
  }
  if (prev && prev.breaches > 0) return { action: 'none', next: { ...prev, breaches: 0 } };
  return { action: 'none', next: prev };
}

type Db = Pick<D1Database, 'prepare'>;

interface StoredRow {
  alert_id: string;
  state: string;
  since: number;
  last_notified: number | null;
  dedupe_key: string;
  last_value: number | null;
  breaches: number;
  clears: number;
  unsent: string | null;
  retry_at: number | null;
  notify_failures: number;
}

const NOTICES: ReadonlySet<string> = new Set(['firing', 'renotify', 'resolved']);

export const LOAD_ALERTS_SQL = `SELECT alert_id, state, since, last_notified, dedupe_key, last_value, breaches,
  clears, unsent, retry_at, notify_failures FROM alert_state`;

export async function loadAlertStates(db: Db): Promise<ReadonlyMap<string, AlertRow>> {
  const rows = await db.prepare(LOAD_ALERTS_SQL).all<StoredRow>();
  return new Map(
    rows.results.map((r) => [
      r.alert_id,
      {
        alertId: r.alert_id,
        state: r.state === 'firing' ? 'firing' : 'resolved',
        since: r.since,
        lastNotified: r.last_notified,
        dedupeKey: r.dedupe_key,
        lastValue: r.last_value,
        breaches: r.breaches,
        clears: r.clears,
        unsent: r.unsent !== null && NOTICES.has(r.unsent) ? (r.unsent as NoticeKind) : null,
        retryAt: r.retry_at,
        notifyFailures: r.notify_failures,
      } satisfies AlertRow,
    ]),
  );
}

export async function saveAlertState(db: Db, row: AlertRow, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_state(alert_id,state,since,last_notified,dedupe_key,last_value,breaches,clears,
         unsent,retry_at,notify_failures,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
       ON CONFLICT(alert_id) DO UPDATE SET state=excluded.state, since=excluded.since,
         last_notified=excluded.last_notified, dedupe_key=excluded.dedupe_key,
         last_value=excluded.last_value, breaches=excluded.breaches, clears=excluded.clears,
         unsent=excluded.unsent, retry_at=excluded.retry_at, notify_failures=excluded.notify_failures,
         updated_at=excluded.updated_at`,
    )
    .bind(
      row.alertId,
      row.state,
      row.since,
      row.lastNotified,
      row.dedupeKey,
      row.lastValue,
      row.breaches,
      row.clears,
      row.unsent,
      row.retryAt,
      row.notifyFailures,
      nowMs,
    )
    .run();
}
