/**
 * Is the alert webhook actually delivering? One `ops_state` record (`alert_sink_health`), written only on
 * ticks that attempted a webhook notice: the last success, the last failure and the consecutive-failure
 * count. Times and a count; never a URL or a response. Shown to admins in `GET /api/observability/summary`
 * (`alerting`). It is NOT on `/health`, which deliberately touches no dependency.
 */
type Db = Pick<D1Database, 'prepare'>;

export const SINK_HEALTH_KEY = 'alert_sink_health';

export interface SinkHealth {
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly consecutiveFailures: number;
}

const EMPTY: SinkHealth = { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function readSinkHealth(db: Db): Promise<SinkHealth> {
  const row = await db
    .prepare('SELECT value FROM ops_state WHERE key=?1')
    .bind(SINK_HEALTH_KEY)
    .first<{ value: string }>();
  if (!row) return EMPTY;
  try {
    const v = JSON.parse(row.value) as Record<string, unknown>;
    return {
      lastSuccessAt: num(v.lastSuccessAt),
      lastFailureAt: num(v.lastFailureAt),
      consecutiveFailures: Math.max(0, num(v.consecutiveFailures) ?? 0),
    };
  } catch {
    return EMPTY;
  }
}

/** Fold one tick's outcome (any failure counts as a failed tick) into the record. */
export async function recordSinkAttempt(db: Db, nowMs: number, ok: boolean): Promise<void> {
  const prev = await readSinkHealth(db);
  const next: SinkHealth = ok
    ? { ...prev, lastSuccessAt: nowMs, consecutiveFailures: 0 }
    : { ...prev, lastFailureAt: nowMs, consecutiveFailures: prev.consecutiveFailures + 1 };
  await db
    .prepare(
      `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .bind(SINK_HEALTH_KEY, JSON.stringify(next), nowMs)
    .run();
}
