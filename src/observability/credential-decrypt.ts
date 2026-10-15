/**
 * A platform-wide count of credential decrypt failures at send time (F97, ADR 0054), kept in `ops_state` so it
 * needs no migration. The consumer calls `recordDecryptFailure` whenever `openCredentials` throws a
 * `CryptoError` for a row it was about to send to (wrong or missing KEK, unknown KEK version, a corrupted or
 * moved envelope); the `credential_decrypt_failures` alert reads `recentDecryptFailures`.
 *
 * The record is one row, `credential_decrypt_failures`, holding `{ since, at, count }`: the failures of the
 * current burst, a burst being failures less than DECRYPT_FAILURE_WINDOW_MS apart. A failure after a quieter
 * gap starts a new burst at 1. The read reports the burst's count while its last failure is inside the window
 * and 0 after, so the alert resolves once nothing has failed for the window (plus its clear ticks).
 *
 * The update is ONE atomic upsert computed in SQL, so concurrent consumers never lose a count to a
 * read-modify-write race. It holds counts and times only: no tenant id, no integration id, no code (the log
 * line and the attempt row carry those). Recording never fails the delivery: a failed write is logged.
 */
import { log } from '../platform/log';
import { THRESHOLDS } from './alerts/thresholds';

type Db = Pick<D1Database, 'prepare'>;

export const DECRYPT_FAILURES_KEY = 'credential_decrypt_failures';

/** The burst count is capped, so a very long incident cannot grow the integer without bound. */
const COUNT_CAP = 1_000_000_000;

/**
 * ?1 key · ?2 now (epoch ms) · ?3 window (ms) · ?4 count cap. A stored value that is not valid JSON (written by
 * hand, or by a future shape) is replaced by a fresh burst rather than failing the write. Nested CASE, because
 * SQLite does not promise to short-circuit AND, and `json_extract` raises on malformed JSON.
 */
export const RECORD_DECRYPT_FAILURE_SQL = `INSERT INTO ops_state(key,value,updated_at)
  VALUES(?1, json_object('since',?2,'at',?2,'count',1), ?2)
  ON CONFLICT(key) DO UPDATE SET
    value = CASE WHEN json_valid(ops_state.value) THEN
      CASE WHEN COALESCE(json_extract(ops_state.value,'$.at'),0) >= ?2 - ?3 THEN
        json_object(
          'since', COALESCE(json_extract(ops_state.value,'$.since'), ?2),
          'at', MAX(?2, COALESCE(json_extract(ops_state.value,'$.at'), 0)),
          'count', MIN(COALESCE(json_extract(ops_state.value,'$.count'), 0) + 1, ?4))
      ELSE json_object('since',?2,'at',?2,'count',1) END
    ELSE json_object('since',?2,'at',?2,'count',1) END,
    updated_at = ?2`;

/** Count one decrypt failure. Never throws: a lost count is logged, and the delivery outcome is unchanged. */
export async function recordDecryptFailure(db: Db, nowMs: number): Promise<void> {
  try {
    await db
      .prepare(RECORD_DECRYPT_FAILURE_SQL)
      .bind(DECRYPT_FAILURES_KEY, nowMs, THRESHOLDS.decryptFailureWindowMs, COUNT_CAP)
      .run();
  } catch (error) {
    log('warn', 'credential_decrypt_count_failed', { error });
  }
}

/**
 * Failures in the current burst if its last failure is inside the window, else 0. Throws when D1 cannot be
 * read, so the signal reads `null` (unknown) rather than 0 (clear). An unparseable value reads 0.
 */
export async function recentDecryptFailures(db: Db, nowMs: number): Promise<number> {
  const row = await db
    .prepare('SELECT value FROM ops_state WHERE key=?1')
    .bind(DECRYPT_FAILURES_KEY)
    .first<{ value: string }>();
  if (!row) return 0;
  try {
    const v = JSON.parse(row.value) as { at?: unknown; count?: unknown };
    return typeof v.at === 'number' &&
      typeof v.count === 'number' &&
      nowMs - v.at <= THRESHOLDS.decryptFailureWindowMs
      ? v.count
      : 0;
  } catch {
    return 0;
  }
}
