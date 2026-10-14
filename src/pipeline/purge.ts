/**
 * Workspace purge (F30). Runs from cron, bounded per tick, resumable: each tick deletes up
 * to PURGE_ROWS_PER_TICK rows per table for one due workspace, and only once every tenant
 * table is empty does it delete the organization (cascading members, invitations, GitHub
 * installations, auth states and audit events) and stamp `purged_at`.
 *
 * Deleting an integration row deletes its wrapped DEK, so every ciphertext it sealed is
 * unrecoverable from that moment (crypto-shredding). D1 Time Travel can still restore the
 * database for up to 30 days; the docs say so rather than promising faster erasure.
 */
export const PURGE_ROWS_PER_TICK = 500;

/** Tenant tables purged explicitly in bounded batches (most have no foreign key to organization). */
export const TENANT_TABLES = [
  'notification_outbox',
  'deliveries',
  'integrations',
  'routing_decisions',
  'held_events',
  'noise_open_failures',
  'sources',
  // Delivery ledger depth (0025). `event_dedup` also cascades from the organization; draining it
  // here keeps that final cascade small.
  'delivery_attempts',
  'event_dedup',
  'destination_health',
] as const;

/** Tables that cascade from organization but are drained in bounded rounds first (see boundedDeletes). */
export const DRAINED_BEFORE_ORGANIZATION_DELETE = ['audit_events', 'github_auth_states'] as const;
/** Child table of `github_installations`, drained through a join before the organization is deleted. */
export const DRAINED_VIA_INSTALLATION = ['github_installation_repositories'] as const;

export interface PurgeReport {
  readonly organizationId: string | null;
  readonly deleted: number;
  readonly completed: boolean;
}

/**
 * Bounded deletes, one per table, each removing at most PURGE_ROWS_PER_TICK rows. Tables
 * that would otherwise cascade from organization in one unbounded statement (audit events,
 * auth states, synced repositories) are drained here first, so the final organization
 * delete only cascades small, bounded sets (members, invitations, installations).
 */
function boundedDeletes(db: D1Database, org: string): D1PreparedStatement[] {
  const byOrg = [...TENANT_TABLES, ...DRAINED_BEFORE_ORGANIZATION_DELETE].map((table) =>
    db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE organization_id=? LIMIT ?)`,
      )
      .bind(org, PURGE_ROWS_PER_TICK),
  );
  const repositories = db
    .prepare(
      `DELETE FROM github_installation_repositories WHERE rowid IN (
         SELECT r.rowid FROM github_installation_repositories r
         JOIN github_installations i ON i.id=r.installation_row_id
         WHERE i.organization_id=? LIMIT ?)`,
    )
    .bind(org, PURGE_ROWS_PER_TICK);
  return [...byOrg, repositories];
}

export async function purgeDueWorkspace(db: D1Database, now: number): Promise<PurgeReport> {
  const due = await db
    .prepare(
      `SELECT organization_id FROM workspace_deletions
       WHERE cancelled_at IS NULL AND purged_at IS NULL AND purge_after <= ?
       ORDER BY purge_after LIMIT 1`,
    )
    .bind(now)
    .first<{ organization_id: string }>();
  if (!due) return { organizationId: null, deleted: 0, completed: false };
  const org = due.organization_id;

  // Claim the purge atomically. A cancel that committed after our SELECT makes this match
  // nothing, and then nothing is deleted.
  const claimed = await db
    .prepare(
      `UPDATE workspace_deletions SET purge_started_at=COALESCE(purge_started_at,CURRENT_TIMESTAMP)
       WHERE organization_id=? AND cancelled_at IS NULL AND purged_at IS NULL AND purge_after <= ?`,
    )
    .bind(org, now)
    .run();
  if (claimed.meta.changes !== 1) return { organizationId: null, deleted: 0, completed: false };

  const results = await db.batch(boundedDeletes(db, org));
  const deleted = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  if (results.some((r) => (r.meta.changes ?? 0) === PURGE_ROWS_PER_TICK)) {
    return { organizationId: org, deleted, completed: false };
  }

  // Every bounded table is empty for this organization: remove the organization itself.
  // The purge is recorded with no organization (the row must outlive it).
  await db.batch([
    db.prepare('UPDATE "session" SET active_organization_id=NULL WHERE active_organization_id=?').bind(org),
    db.prepare('DELETE FROM organization WHERE id=?').bind(org),
    db
      .prepare('UPDATE workspace_deletions SET purged_at=CURRENT_TIMESTAMP WHERE organization_id=?')
      .bind(org),
    db
      .prepare(
        `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json)
         VALUES(?,NULL,NULL,'workspace.purged','organization',?,'success','{}')`,
      )
      .bind(crypto.randomUUID(), org),
  ]);
  return { organizationId: org, deleted, completed: true };
}
