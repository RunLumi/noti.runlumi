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
const EXPORT_ROW_LIMIT = 5000;

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
  if (await pendingDeletion(c.env.DB, who.orgId))
    return c.json({ error: 'Deletion is already scheduled.' }, 409);

  const enabled = await c.env.DB.prepare('SELECT id FROM integrations WHERE organization_id=? AND enabled=1')
    .bind(who.orgId)
    .all<{ id: string }>();
  const ids = enabled.results.map((r) => r.id);
  const purgeAfter = Date.now() + RETENTION_DAYS * DAY_MS;

  await c.env.DB.batch([
    // INSERT OR REPLACE: a previously cancelled request is superseded by the new one.
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO workspace_deletions(organization_id,requested_by,purge_after,disabled_integration_ids)
       VALUES(?,?,?,?)`,
    ).bind(who.orgId, who.userId, purgeAfter, JSON.stringify(ids)),
    c.env.DB.prepare(
      'UPDATE integrations SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND enabled=1',
    ).bind(who.orgId),
    auditStatement(c.env.DB, {
      organizationId: who.orgId,
      actorId: who.userId,
      action: 'workspace.deletion.request',
      subjectType: 'organization',
      subjectId: who.orgId,
      outcome: 'success',
      ...requestOrigin(c.req.raw.headers),
      metadata: { purgeAfter: new Date(purgeAfter).toISOString(), disabledIntegrations: ids.length },
    }),
  ]);
  return c.json(view(await pendingDeletion(c.env.DB, who.orgId)), 202);
});

function restorableIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

lifecycle.delete('/deletion', async (c) => {
  const rejected = originRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, 'workspace.delete');
  if (who instanceof Response) return who;
  const pending = await pendingDeletion(c.env.DB, who.orgId);
  if (!pending) return c.json({ error: 'No deletion is scheduled.' }, 404);
  if (pending.purge_started_at)
    return c.json({ error: 'The purge has already started and cannot be cancelled.' }, 409);

  const ids = restorableIds(pending.disabled_integration_ids);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE workspace_deletions SET cancelled_at=CURRENT_TIMESTAMP WHERE organization_id=? AND purge_started_at IS NULL',
    ).bind(who.orgId),
    // Restore only what the request turned off, and only inside this workspace.
    ...ids.map((id) =>
      c.env.DB.prepare(
        'UPDATE integrations SET enabled=1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?',
      ).bind(id, who.orgId),
    ),
    auditStatement(c.env.DB, {
      organizationId: who.orgId,
      actorId: who.userId,
      action: 'workspace.deletion.cancel',
      subjectType: 'organization',
      subjectId: who.orgId,
      outcome: 'success',
      ...requestOrigin(c.req.raw.headers),
      metadata: { restoredIntegrations: ids.length },
    }),
  ]);
  return c.json({ scheduled: false });
});

/**
 * Machine-readable export. Credential columns (envelopes, salts, wrapped keys, legacy
 * ciphertext) are never selected, so they cannot leak through a future serialiser change.
 */
lifecycle.get('/export', async (c) => {
  const who = await gate(c, 'workspace.export');
  if (who instanceof Response) return who;
  const db = c.env.DB;
  const [members, integrations, installations, deliveries, audit] = await db.batch([
    db
      .prepare(
        `SELECT u.name AS name, u.email AS email, m.role AS role, m.created_at AS joined_at
         FROM member m JOIN "user" u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY m.created_at`,
      )
      .bind(who.orgId),
    db
      .prepare(
        `SELECT id,name,repo,event_types,destination,destination_host,enabled,created_at,updated_at
         FROM integrations WHERE organization_id=? ORDER BY created_at`,
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
        `SELECT id,integration_id,state,attempts,updated_at FROM deliveries WHERE organization_id=? LIMIT ?`,
      )
      .bind(who.orgId, EXPORT_ROW_LIMIT),
    db
      .prepare(
        `SELECT action,subject_type,subject_id,outcome,metadata_json,created_at FROM audit_events
         WHERE organization_id=? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(who.orgId, EXPORT_ROW_LIMIT),
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
    githubInstallations: installations?.results ?? [],
    deliveries: deliveries?.results ?? [],
    auditEvents: audit?.results ?? [],
  };
  return c.json(body, 200, {
    'content-disposition': `attachment; filename="lumi-noti-export-${who.orgId}.json"`,
    'cache-control': 'no-store',
  });
});

export default lifecycle;
