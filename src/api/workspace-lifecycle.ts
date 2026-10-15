import { Hono, type Context } from 'hono';
import { auditStatement, recordAudit, requestOrigin } from '../audit/audit';
import { authorize, isFailure, type Resolved } from '../auth/workspace';
import type { Capability } from '../auth/permissions';
import type { Bindings } from '../env';
import { asRecord } from '../lib/json';

/**
 * Workspace export and deletion (F30; closes N3). Admin only.
 *
 * Deletion is two-phase: a request disables every integration at once (ingress then has
 * nothing to route to and nothing is delivered), and after RETENTION_DAYS the cron purge
 * removes the data. Cancelling inside the window restores exactly the integrations that
 * were enabled. Export never contains a credential, sealed or otherwise.
 */
export const RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_ROW_LIMIT = 2000;

type Ctx = Context<{ Bindings: Bindings }>;

const lifecycle = new Hono<{ Bindings: Bindings }>();

async function gate(c: Ctx, capability: Capability): Promise<Resolved | Response> {
  const who = await authorize(c, capability);
  return isFailure(who) ? c.json({ error: who.error }, who.status) : who;
}

function originRejected(c: Ctx): Response | null {
  const origin = c.req.header('origin');
  return !origin || origin !== new URL(c.env.APP_ORIGIN).origin ? c.json({ error: 'Forbidden' }, 403) : null;
}

interface DeletionRow {
  requested_by: string;
  requested_at: string;
  purge_after: number;
  disabled_integration_ids: string;
  cancelled_at: string | null;
  purge_started_at: string | null;
}

async function pendingDeletion(db: D1Database, orgId: string): Promise<DeletionRow | null> {
  return db
    .prepare(
      `SELECT requested_by,requested_at,purge_after,disabled_integration_ids,cancelled_at,purge_started_at
       FROM workspace_deletions WHERE organization_id=? AND cancelled_at IS NULL AND purged_at IS NULL`,
    )
    .bind(orgId)
    .first<DeletionRow>();
}

/** True while a workspace is scheduled for deletion; mutating routes refuse new work. */
export async function isDeletionPending(db: D1Database, orgId: string): Promise<boolean> {
  return (await pendingDeletion(db, orgId)) !== null;
}

function view(row: DeletionRow | null) {
  return row
    ? {
        scheduled: true,
        requestedAt: row.requested_at,
        purgeAfter: new Date(row.purge_after).toISOString(),
        purgeStarted: row.purge_started_at !== null,
      }
    : { scheduled: false };
}

lifecycle.get('/deletion', async (c) => {
  const who = await gate(c, 'workspace.delete');
  if (who instanceof Response) return who;
  return c.json(view(await pendingDeletion(c.env.DB, who.orgId)));
});

lifecycle.post('/deletion', async (c) => {
  const rejected = originRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, 'workspace.delete');
  if (who instanceof Response) return who;

  // Typing the workspace name is the confirmation: a stray click cannot schedule this.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  if (asRecord(body)?.confirm !== who.orgName)
    return c.json(
      { error: 'Type the workspace name exactly to confirm.', fields: [{ field: 'confirm' }] },
      422,
    );

  // One batch, one transaction (F236: an audit failure fails the action). The upsert takes the snapshot of
  // enabled integrations and schedules the purge; it inserts, or revives a previously cancelled request, and
  // matches nothing while a request is pending, so a double-click cannot overwrite the snapshot with [].
  // The audit row exists only if the upsert changed a row, and the integrations are switched off only if the
  // audit row was written: each guard reads `changes()` of the statement just before it. If the audit insert
  // fails, the whole batch rolls back and nothing is scheduled or paused.
  const purgeAfter = Date.now() + RETENTION_DAYS * DAY_MS;
  const db = c.env.DB;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO workspace_deletions(organization_id,requested_by,requested_at,purge_after,disabled_integration_ids)
         VALUES(?,?,CURRENT_TIMESTAMP,?,(SELECT json_group_array(id) FROM integrations WHERE organization_id=? AND enabled=1))
         ON CONFLICT(organization_id) DO UPDATE SET
           requested_by=excluded.requested_by, requested_at=excluded.requested_at, purge_after=excluded.purge_after,
           disabled_integration_ids=excluded.disabled_integration_ids, cancelled_at=NULL, purge_started_at=NULL
         WHERE workspace_deletions.cancelled_at IS NOT NULL AND workspace_deletions.purged_at IS NULL`,
      )
      .bind(who.orgId, who.userId, purgeAfter, who.orgId),
    auditStatement(
      db,
      {
        organizationId: who.orgId,
        actorId: who.userId,
        action: 'workspace.deletion.request',
        subjectType: 'organization',
        subjectId: who.orgId,
        outcome: 'success',
        ...requestOrigin(c.req.raw.headers),
        metadata: { purgeAfter: new Date(purgeAfter).toISOString() },
      },
      undefined,
      {
        onlyIfPreviousStatementChangedRows: true,
        countAs: { key: 'disabledIntegrations', count: 'deletionSnapshot', organizationId: who.orgId },
      },
    ),
    db
      .prepare(
        'UPDATE integrations SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND enabled=1 AND changes() > 0',
      )
      .bind(who.orgId),
  ]);
  if (results[0]?.meta.changes !== 1) return c.json({ error: 'Deletion is already scheduled.' }, 409);
  return c.json(view(await pendingDeletion(db, who.orgId)), 202);
});

lifecycle.delete('/deletion', async (c) => {
  const rejected = originRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, 'workspace.delete');
  if (who instanceof Response) return who;

  // One batch, one transaction, chained like the request: the guarded cancel (if the purge claimed the row
  // first it changes nothing), then the audit row only if the cancel changed a row, then the restore only if
  // the audit row was written. The restore reads the snapshot from the row just cancelled: only ids from it,
  // only in this workspace, in one statement regardless of count. A failed audit insert rolls all of it back.
  const db = c.env.DB;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE workspace_deletions SET cancelled_at=CURRENT_TIMESTAMP
         WHERE organization_id=? AND cancelled_at IS NULL AND purged_at IS NULL AND purge_started_at IS NULL`,
      )
      .bind(who.orgId),
    auditStatement(
      db,
      {
        organizationId: who.orgId,
        actorId: who.userId,
        action: 'workspace.deletion.cancel',
        subjectType: 'organization',
        subjectId: who.orgId,
        outcome: 'success',
        ...requestOrigin(c.req.raw.headers),
      },
      undefined,
      {
        onlyIfPreviousStatementChangedRows: true,
        countAs: { key: 'restoredIntegrations', count: 'deletionSnapshot', organizationId: who.orgId },
      },
    ),
    db
      .prepare(
        `UPDATE integrations SET enabled=1,updated_at=CURRENT_TIMESTAMP
         WHERE organization_id=?1 AND changes() > 0 AND id IN (SELECT value FROM json_each((
           SELECT disabled_integration_ids FROM workspace_deletions
           WHERE organization_id=?1 AND cancelled_at IS NOT NULL AND purged_at IS NULL)))`,
      )
      .bind(who.orgId),
  ]);
  if (results[0]?.meta.changes !== 1) {
    return (await pendingDeletion(db, who.orgId))
      ? c.json({ error: 'The purge has already started and cannot be cancelled.' }, 409)
      : c.json({ error: 'No deletion is scheduled.' }, 404);
  }
  return c.json({ scheduled: false, restoredIntegrations: results[2]?.meta.changes ?? 0 });
});

/**
 * Machine-readable export. Credential columns (envelopes, salts, wrapped keys, legacy
 * ciphertext) are never selected, so they cannot leak through a future serialiser change.
 */
lifecycle.get('/export', async (c) => {
  const who = await gate(c, 'workspace.export');
  if (who instanceof Response) return who;
  const db = c.env.DB;
  const [members, integrations, sources, installations, deliveries, attempts, audit, webhookHosts] =
    await db.batch([
      db
        .prepare(
          `SELECT u.name AS name, u.email AS email, m.role AS role, m.created_at AS joined_at
         FROM member m JOIN "user" u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY m.created_at`,
        )
        .bind(who.orgId),
      db
        .prepare(
          `SELECT id,name,repo,source_id,event_types,filters_json,noise_json,destination,destination_host,enabled,created_at,updated_at,
           credential_fingerprint,
           (credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason = 'revoked') AS credentials_revoked
         FROM integrations WHERE organization_id=? ORDER BY created_at`,
        )
        .bind(who.orgId),
      // Never the secret, key, salt or envelope: an explicit column list, not SELECT *.
      db
        .prepare(
          `SELECT id,kind,name,endpoint_id,auth_mode,livemode,enabled,created_at,updated_at,last_received_at,
           secret_rotated_at,dropped_events,last_dropped_at,credential_fingerprint,
           (credentials_revoked_at IS NOT NULL) AS credentials_revoked
         FROM sources WHERE organization_id=? ORDER BY created_at`,
        )
        .bind(who.orgId),
      db
        .prepare(
          `SELECT installation_id,account_login,account_type,repository_selection,status,created_at
         FROM github_installations WHERE organization_id=?`,
        )
        .bind(who.orgId),
      db
        .prepare(
          `SELECT id,integration_id,state,attempts,updated_at,possible_duplicate,suppressed_reason,duplicate_of
         FROM deliveries WHERE organization_id=? ORDER BY updated_at DESC LIMIT ?`,
        )
        .bind(who.orgId, EXPORT_ROW_LIMIT + 1),
      // The attempt history (F184): closed vocabularies and numbers only, no payload or URL.
      db
        .prepare(
          `SELECT delivery_id,attempt,started_at,finished_at,outcome,error_code,reason,status_class,retry_after_ms,
           possible_duplicate
         FROM delivery_attempts WHERE organization_id=? ORDER BY started_at DESC LIMIT ?`,
        )
        .bind(who.orgId, EXPORT_ROW_LIMIT + 1),
      db
        .prepare(
          `SELECT action,subject_type,subject_id,outcome,metadata_json,created_at FROM audit_events
         WHERE organization_id=? ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(who.orgId, EXPORT_ROW_LIMIT + 1),
      db
        .prepare(
          'SELECT host,created_by,created_at FROM workspace_webhook_hosts WHERE organization_id=? ORDER BY host LIMIT 50',
        )
        .bind(who.orgId),
    ]);

  await recordAudit(db, {
    organizationId: who.orgId,
    actorId: who.userId,
    action: 'workspace.export',
    subjectType: 'organization',
    subjectId: who.orgId,
    outcome: 'success',
    ...requestOrigin(c.req.raw.headers),
  });

  const body = {
    format: 'lumi-noti-export/v1',
    exportedAt: new Date().toISOString(),
    workspace: { id: who.orgId, name: who.orgName },
    credentialsIncluded: false,
    rowLimitPerTable: EXPORT_ROW_LIMIT,
    members: members?.results ?? [],
    integrations: integrations?.results ?? [],
    sources: sources?.results ?? [],
    githubInstallations: installations?.results ?? [],
    deliveries: (deliveries?.results ?? []).slice(0, EXPORT_ROW_LIMIT),
    deliveryAttempts: (attempts?.results ?? []).slice(0, EXPORT_ROW_LIMIT),
    auditEvents: (audit?.results ?? []).slice(0, EXPORT_ROW_LIMIT),
    webhookHosts: webhookHosts?.results ?? [],
    // The most recent rows are exported; `true` means older rows exist and were left out.
    truncated: {
      deliveries: (deliveries?.results.length ?? 0) > EXPORT_ROW_LIMIT,
      deliveryAttempts: (attempts?.results.length ?? 0) > EXPORT_ROW_LIMIT,
      auditEvents: (audit?.results.length ?? 0) > EXPORT_ROW_LIMIT,
    },
  };
  return c.json(body, 200, {
    'content-disposition': `attachment; filename="lumi-noti-export-${who.orgId}.json"`,
    'cache-control': 'no-store',
  });
});

export default lifecycle;
