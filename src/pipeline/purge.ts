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

/** Tenant tables without a foreign key to organization, purged explicitly. */
export const TENANT_TABLES = ['notification_outbox', 'deliveries', 'integrations'] as const;

export interface PurgeReport {
  readonly organizationId: string | null;
  readonly deleted: number;
  readonly completed: boolean;
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

  await db
    .prepare(
      `UPDATE workspace_deletions SET purge_started_at=COALESCE(purge_started_at,CURRENT_TIMESTAMP)
       WHERE organization_id=? AND cancelled_at IS NULL`,
    )
    .bind(org)
    .run();

  const results = await db.batch(
    TENANT_TABLES.map((table) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE organization_id=? LIMIT ?)`,
        )
        .bind(org, PURGE_ROWS_PER_TICK),
    ),
  );
  const deleted = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  if (results.some((r) => (r.meta.changes ?? 0) === PURGE_ROWS_PER_TICK)) {
    return { organizationId: org, deleted, completed: false };
  }

  // Every tenant table is empty for this organization: remove the organization itself.
  await db.batch([
    db.prepare('UPDATE "session" SET active_organization_id=NULL WHERE active_organization_id=?').bind(org),
    db.prepare('DELETE FROM organization WHERE id=?').bind(org),
    db
      .prepare('UPDATE workspace_deletions SET purged_at=CURRENT_TIMESTAMP WHERE organization_id=?')
      .bind(org),
  ]);
  return { organizationId: org, deleted, completed: true };
}
