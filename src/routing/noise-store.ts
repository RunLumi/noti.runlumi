import type { DeliveryMessage } from '../env';
import type { HoldReason } from './noise';

/**
 * SQL for held events and open-failure tracking (migration 0021, docs/adr/0016). Every statement
 * carries `organization_id` (F24); held rows hold small display fields only, never a payload.
 */

/** Released rows stay this long so a provider redelivery is still recognised. */
export const HELD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** An open failure older than this is forgotten: a much later success is just a success. */
export const OPEN_FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Open failures tracked per integration; beyond this new ones are simply not tracked. */
export const OPEN_FAILURES_PER_INTEGRATION = 200;
export const NOISE_PURGE_ROWS = 500;
export const NOISE_PURGE_ROUNDS = 5;

type Display = Pick<DeliveryMessage, 'title' | 'url' | 'repo' | 'actor' | 'status' | 'eventType' | 'summary'>;

export interface HeldRow {
  /** The deterministic delivery id for (dedup key, integration). */
  readonly id: string;
  /** The pre-0009 id some old GitHub rows use; a held row is not written if either exists. */
  readonly legacyId: string;
  readonly organizationId: string;
  readonly integrationId: string;
  readonly reason: HoldReason;
  readonly groupKey: string;
  readonly releaseAt: number;
  readonly heldAt: number;
  readonly resolved: boolean;
  readonly display: Display;
}

export interface HoldContext {
  readonly heldCount: number;
  readonly openGroupReleaseAt: number | null;
}

/** One read per noise-enabled integration per event: backlog size and the open group, if any. */
export async function readHoldContext(
  db: D1Database,
  organizationId: string,
  integrationId: string,
  groupKey: string,
): Promise<HoldContext> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n,
              MIN(CASE WHEN hold_reason='grouped' AND state='held' AND group_key=? THEN release_at END) AS g
       FROM held_events
       WHERE organization_id=? AND integration_id=? AND state IN ('held','claimed')`,
    )
    .bind(groupKey, organizationId, integrationId)
    .first<{ n: number; g: number | null }>();
  return { heldCount: row?.n ?? 0, openGroupReleaseAt: row?.g ?? null };
}

/** Display text is bounded to what the table's CHECKs admit; an over-long URL is dropped, not cut. */
export function boundedDisplay(d: Display): Required<Display> {
  return {
    title: d.title.slice(0, 300),
    url: d.url.length <= 1000 ? d.url : '',
    repo: (d.repo ?? '').slice(0, 200),
    actor: (d.actor ?? '').slice(0, 100),
    status: d.status ?? 'info',
    eventType: (d.eventType ?? 'notification').slice(0, 100),
    summary: (d.summary ?? '').slice(0, 280),
  };
}

/**
 * Hold one event. `INSERT OR IGNORE` on the deterministic id makes a provider redelivery a
 * no-op, and the guard skips the insert when a delivery for the same event already exists (it
 * was delivered before the settings changed), so one event is never both delivered and held.
 */
export function holdStatement(db: D1Database, row: HeldRow): D1PreparedStatement {
  const d = boundedDisplay(row.display);
  return db
    .prepare(
      `INSERT OR IGNORE INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,
         release_at,held_at,event_type,title,url,repo,actor,status,summary,resolved)
       SELECT ?,?,?,?,?,'held',?,?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM deliveries WHERE organization_id=? AND id IN (?,?))`,
    )
    .bind(
      row.id,
      row.organizationId,
      row.integrationId,
      row.reason,
      row.groupKey,
      row.releaseAt,
      row.heldAt,
      d.eventType,
      d.title,
      d.url,
      d.repo,
      d.actor,
      d.status,
      d.summary,
      row.resolved ? 1 : 0,
      row.organizationId,
      row.id,
      row.legacyId,
    );
}

// --- open failures (resolution notices) -------------------------------------------------------

export async function failureKeyHash(parts: {
  readonly organizationId: string;
  readonly integrationId: string;
  readonly repo: string;
  readonly workflow: string;
  readonly branch: string;
}): Promise<string> {
  const text = [
    parts.organizationId,
    parts.integrationId,
    parts.repo.toLowerCase(),
    parts.workflow,
    parts.branch,
  ]
    .map((p) => `${p.length}:${p}`)
    .join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hasOpenFailure(
  db: D1Database,
  organizationId: string,
  integrationId: string,
  keyHash: string,
  nowMs: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS open FROM noise_open_failures
       WHERE organization_id=? AND integration_id=? AND key_hash=? AND opened_at>=?`,
    )
    .bind(organizationId, integrationId, keyHash, nowMs - OPEN_FAILURE_RETENTION_MS)
    .first<{ open: number }>();
  return row !== null;
}

/**
 * Remember a failure. Bounded per integration; refreshes the time when it is already open.
 *
 * Skipped when this very event already has a delivery or a held row (`eventIds` are its ids), so
 * a provider REDELIVERY of an old failure cannot re-open one that a later success closed. The
 * statement must therefore run BEFORE the statement that creates the delivery or the held row
 * in the same batch. (A genuinely late, out-of-order failure of a different run is
 * indistinguishable and may still re-open one; webhooks are not ordered. ADR 0016.)
 */
export function openFailureStatement(
  db: D1Database,
  organizationId: string,
  integrationId: string,
  keyHash: string,
  nowMs: number,
  eventIds: readonly [string, string],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO noise_open_failures(organization_id,integration_id,key_hash,opened_at)
       SELECT ?1,?2,?3,?4
       WHERE ((EXISTS (SELECT 1 FROM noise_open_failures WHERE organization_id=?1 AND integration_id=?2 AND key_hash=?3))
          OR ((SELECT COUNT(*) FROM noise_open_failures WHERE organization_id=?1 AND integration_id=?2) < ?5))
         AND NOT EXISTS (SELECT 1 FROM deliveries WHERE organization_id=?1 AND id IN (?6,?7))
         AND NOT EXISTS (SELECT 1 FROM held_events WHERE organization_id=?1 AND id=?6)
       ON CONFLICT(organization_id,integration_id,key_hash) DO UPDATE SET opened_at=excluded.opened_at`,
    )
    .bind(
      organizationId,
      integrationId,
      keyHash,
      nowMs,
      OPEN_FAILURES_PER_INTEGRATION,
      eventIds[0],
      eventIds[1],
    );
}

export function closeFailureStatement(
  db: D1Database,
  organizationId: string,
  integrationId: string,
  keyHash: string,
): D1PreparedStatement {
  return db
    .prepare('DELETE FROM noise_open_failures WHERE organization_id=? AND integration_id=? AND key_hash=?')
    .bind(organizationId, integrationId, keyHash);
}

// --- retention --------------------------------------------------------------------------------

/** Bounded rounds, like routing decisions: released rows past 7 days, open failures past 30. */
export async function purgeNoise(
  db: D1Database,
  nowMs: number,
): Promise<{ held: number; openFailures: number }> {
  const drain = async (sql: string, cutoff: number): Promise<number> => {
    let total = 0;
    for (let i = 0; i < NOISE_PURGE_ROUNDS; i++) {
      const res = await db.prepare(sql).bind(cutoff, NOISE_PURGE_ROWS).run();
      const changed = res.meta.changes ?? 0;
      total += changed;
      if (changed < NOISE_PURGE_ROWS) break;
    }
    return total;
  };
  const held = await drain(
    `DELETE FROM held_events WHERE rowid IN (
       SELECT rowid FROM held_events WHERE state='released' AND released_at IS NOT NULL AND released_at < ? LIMIT ?)`,
    nowMs - HELD_RETENTION_MS,
  );
  const openFailures = await drain(
    `DELETE FROM noise_open_failures WHERE rowid IN (
       SELECT rowid FROM noise_open_failures WHERE opened_at < ? LIMIT ?)`,
    nowMs - OPEN_FAILURE_RETENTION_MS,
  );
  return { held, openFailures };
}

// --- status for the dashboard -----------------------------------------------------------------

export interface HeldStatus {
  readonly count: number;
  /** Epoch ms of the earliest scheduled release, or null when nothing is waiting. */
  readonly nextReleaseAt: number | null;
}

export async function heldStatus(
  db: D1Database,
  organizationId: string,
  integrationId: string,
): Promise<HeldStatus> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(release_at) AS next FROM held_events
       WHERE organization_id=? AND integration_id=? AND state IN ('held','claimed')`,
    )
    .bind(organizationId, integrationId)
    .first<{ n: number; next: number | null }>();
  return { count: row?.n ?? 0, nextReleaseAt: row?.next ?? null };
}
