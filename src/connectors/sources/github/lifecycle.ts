import { auditStatement, type AuditEntry } from '../../../audit/audit';
import { asRecord } from '../../../lib/json';
import { pickRepositories } from './install';
import { readInstallationBlock } from './tenant';

/**
 * Installation lifecycle events are security events (F68). They cannot be unsubscribed and
 * are our only reliable revocation signal, so each one changes state immediately and is
 * audited. They never route a notification.
 *
 * Binding happens only through the verified install flow (install.ts). A lifecycle event
 * for an installation no workspace has bound is acknowledged and otherwise ignored: the
 * signed payload proves it came from GitHub, not which workspace it belongs to.
 */
export const LIFECYCLE_EVENTS = new Set([
  'installation',
  'installation_repositories',
  'github_app_authorization',
]);

export type LifecycleOutcome =
  | { kind: 'ignored'; reason: 'unbound' | 'unsupported_action' | 'no_installation' | 'app_mismatch' }
  | { kind: 'applied'; action: string; organizationId: string };

interface InstallationRow {
  id: string;
  organization_id: string;
  status: string;
}

type RepoRef = { id: string; fullName: string };

function lifecycleAudit(
  db: D1Database,
  row: InstallationRow,
  action: string,
  metadata: AuditEntry['metadata'],
) {
  return auditStatement(db, {
    organizationId: row.organization_id,
    actorId: null,
    action: 'github.installation.lifecycle',
    subjectType: 'github_installation',
    subjectId: row.id,
    outcome: 'success',
    metadata: { action, ...metadata },
  });
}

function setStatus(db: D1Database, row: InstallationRow, status: string, suspended: boolean) {
  return db
    .prepare(
      `UPDATE github_installations SET status=?,suspended_at=${suspended ? 'CURRENT_TIMESTAMP' : 'NULL'},
         updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
    )
    .bind(status, row.id, row.organization_id);
}

function addRepositories(db: D1Database, row: InstallationRow, repos: readonly RepoRef[]) {
  return repos.map((r) =>
    db
      .prepare(
        `INSERT INTO github_installation_repositories(installation_row_id,repository_id,full_name) VALUES(?,?,?)
         ON CONFLICT(installation_row_id,repository_id) DO UPDATE SET full_name=excluded.full_name`,
      )
      .bind(row.id, r.id, r.fullName),
  );
}

function removeRepositories(db: D1Database, row: InstallationRow, repos: readonly RepoRef[]) {
  return repos.map((r) =>
    db
      .prepare('DELETE FROM github_installation_repositories WHERE installation_row_id=? AND repository_id=?')
      .bind(row.id, r.id),
  );
}

function selectionOf(event: Record<string, unknown>): 'all' | 'selected' | null {
  const value = event.repository_selection ?? asRecord(event.installation)?.repository_selection;
  return value === 'all' || value === 'selected' ? value : null;
}

function statements(
  db: D1Database,
  kind: string,
  action: string,
  event: Record<string, unknown>,
  row: InstallationRow,
): D1PreparedStatement[] | null {
  if (kind === 'installation') {
    switch (action) {
      case 'deleted':
        return [setStatus(db, row, 'uninstalled', false), lifecycleAudit(db, row, action, {})];
      case 'suspend':
        return [setStatus(db, row, 'suspended', true), lifecycleAudit(db, row, action, {})];
      case 'unsuspend':
        return [setStatus(db, row, 'active', false), lifecycleAudit(db, row, action, {})];
      case 'new_permissions_accepted':
        return [lifecycleAudit(db, row, action, {})];
      case 'created':
        // Re-installed after uninstall: GitHub reuses nothing, but be safe if it does.
        return [
          setStatus(db, row, 'active', false),
          ...addRepositories(db, row, pickRepositories({ repositories: event.repositories })),
          lifecycleAudit(db, row, action, {}),
        ];
      default:
        return null;
    }
  }
  if (kind === 'installation_repositories' && (action === 'added' || action === 'removed')) {
    const added = pickRepositories({ repositories: event.repositories_added });
    const removed = pickRepositories({ repositories: event.repositories_removed });
    const selection = selectionOf(event);
    return [
      ...(selection
        ? [
            db
              .prepare(
                'UPDATE github_installations SET repository_selection=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
              )
              .bind(selection, row.id),
          ]
        : []),
      ...addRepositories(db, row, added),
      ...removeRepositories(db, row, removed),
      lifecycleAudit(db, row, action, {
        added: added.map((r) => r.fullName).slice(0, 50),
        removed: removed.map((r) => r.fullName).slice(0, 50),
        ...(selection ? { selection } : {}),
      }),
    ];
  }
  return null;
}

export async function handleLifecycle(
  db: D1Database,
  appId: string,
  kind: string,
  event: Record<string, unknown>,
): Promise<LifecycleOutcome> {
  // We hold no user tokens (ADR 0008: the verification token is revoked immediately), so
  // a revoked user authorization needs no action beyond acknowledging it.
  if (kind === 'github_app_authorization') return { kind: 'ignored', reason: 'unsupported_action' };

  const block = readInstallationBlock(event, appId);
  if (block.kind === 'app-mismatch') return { kind: 'ignored', reason: 'app_mismatch' };
  if (block.kind !== 'ok') return { kind: 'ignored', reason: 'no_installation' };

  const row = await db
    .prepare(
      'SELECT id,organization_id,status FROM github_installations WHERE installation_id=? AND app_id=?',
    )
    .bind(block.installationId, appId)
    .first<InstallationRow>();
  if (!row) return { kind: 'ignored', reason: 'unbound' };

  const action = typeof event.action === 'string' ? event.action : '';
  const batch = statements(db, kind, action, event, row);
  if (!batch) return { kind: 'ignored', reason: 'unsupported_action' };
  await db.batch(batch);
  return { kind: 'applied', action: `${kind}.${action}`, organizationId: row.organization_id };
}
