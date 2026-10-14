/**
 * Alert state machine (docs/specs/13-observability.md F200) and its `alert_state` persistence.
 *
 *   quiet -> breached N times  FIRE      one notification; dedupe key `<alert>:<since>` names the incident
 *   firing, still breached     nothing   until the re-notify cadence elapses, then RENOTIFY (same key)
 *   firing -> clear            RESOLVE   one notification; the row stays as `resolved`
 *
 * `decideAlert` is pure. A signal that could not be read (`breached === null`) changes nothing. An alert
 * with `confirmTicks > 1` must breach that many evaluations in a row before it fires, so one false reading
 * (every job is overdue for one tick after a maintenance window) never notifies anyone. The dedupe key is
 * stable for the whole incident, so a receiver can collapse repeats; a new incident gets a new one.
 */
export type AlertStatus = 'firing' | 'resolved';

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
}

export function decideAlert(prev: AlertRow | null, input: AlertInput): AlertDecision {
  const { id, breached, value, nowMs, renotifyMs, confirmTicks } = input;
  if (breached === null) return { action: 'none', next: prev };
  const firing = prev?.state === 'firing';

  if (breached) {
    if (firing && prev) {
      const due = prev.lastNotified === null || nowMs - prev.lastNotified >= renotifyMs;
      // A quiet tick writes nothing: the row is returned untouched, so a long incident costs no D1 writes.
      return due
        ? { action: 'renotify', next: { ...prev, lastNotified: nowMs, lastValue: value } }
        : { action: 'none', next: prev };
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
      },
    };
  }

  if (firing && prev) {
    return {
      action: 'resolve',
      next: { ...prev, state: 'resolved', since: nowMs, lastNotified: nowMs, lastValue: value, breaches: 0 },
    };
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
}

export async function loadAlertStates(db: Db): Promise<ReadonlyMap<string, AlertRow>> {
  const rows = await db
    .prepare(
      'SELECT alert_id, state, since, last_notified, dedupe_key, last_value, breaches FROM alert_state',
    )
    .all<StoredRow>();
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
      } satisfies AlertRow,
    ]),
  );
}

export async function saveAlertState(db: Db, row: AlertRow, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_state(alert_id,state,since,last_notified,dedupe_key,last_value,breaches,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
       ON CONFLICT(alert_id) DO UPDATE SET state=excluded.state, since=excluded.since,
         last_notified=excluded.last_notified, dedupe_key=excluded.dedupe_key,
         last_value=excluded.last_value, breaches=excluded.breaches, updated_at=excluded.updated_at`,
    )
    .bind(
      row.alertId,
      row.state,
      row.since,
      row.lastNotified,
      row.dedupeKey,
      row.lastValue,
      row.breaches,
      nowMs,
    )
    .run();
}
