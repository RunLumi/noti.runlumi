import { auditStatement, type AuditEntry } from '../../../audit/audit';
import { asRecord } from '../../../lib/json';
import { pickRepositories } from './install';
import { deleteRepositories, insertRepositories } from './repos';
import { readInstallationBlock } from './tenant';

/**
 * Installation lifecycle events are security events (F68). They cannot be unsubscribed and
 * are our only reliable revocation signal, so each one changes state immediately and is
 * audited. They never route a notification.
 *
 * Webhooks are unordered and can be redelivered, so every transition is guarded on the
 * state it starts from: a late `unsuspend` cannot revive an `uninstalled` installation,
 * and `uninstalled` is terminal (GitHub issues a new installation id on reinstall).
 *
 * Binding happens only through the verified install flow (install.ts). For an installation
 * no workspace has bound, only `deleted` matters: it is tombstoned so a later bind of that
 * id is refused.
 */
export const LIFECYCLE_EVENTS = new Set([
  'installation',
  'installation_repositories',
  'installation_target',
  'github_app_authorization',
]);

export type LifecycleOutcome =
  | { kind: 'ignored'; reason: 'unbound' | 'unsupported_action' | 'no_installation' | 'app_mismatch' }
  | { kind: 'applied'; action: string; organizationId: string | null };

interface InstallationRow {
  id: string;
  organization_id: string;
  status: string;
  repository_selection: string;
}

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

/** A status change that applies only from the listed states. */
function transition(db: D1Database, row: InstallationRow, to: string, from: readonly string[]) {
  const suspended = to === 'suspended' ? 'CURRENT_TIMESTAMP' : 'NULL';
  return db
    .prepare(
      `UPDATE github_installations SET status=?,suspended_at=${suspended},updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=? AND status IN (${from.map(() => '?').join(',')})`,
    )
    .bind(to, row.id, row.organization_id, ...from);
}

function selectionOf(event: Record<string, unknown>): 'all' | 'selected' | null {
  const value = event.repository_selection ?? asRecord(event.installation)?.repository_selection;
  return value === 'all' || value === 'selected' ? value : null;
}

function installationStatements(
  db: D1Database,
  action: string,
  row: InstallationRow,
): D1PreparedStatement[] | null {
  switch (action) {
    case 'deleted':
      return [
        transition(db, row, 'uninstalled', ['active', 'suspended']),
        lifecycleAudit(db, row, action, {}),
      ];
    case 'suspend':
      return [transition(db, row, 'suspended', ['active']), lifecycleAudit(db, row, action, {})];
    case 'unsuspend':
      return [transition(db, row, 'active', ['suspended']), lifecycleAudit(db, row, action, {})];
    case 'new_permissions_accepted':
    case 'created':
      // `created` for a row we already hold is a redelivery: record it, change nothing.
      return [lifecycleAudit(db, row, action, {})];
    default:
      return null;
  }
}

function repositoryStatements(
  db: D1Database,
  action: string,
  event: Record<string, unknown>,
  row: InstallationRow,
): D1PreparedStatement[] | null {
  if (action !== 'added' && action !== 'removed') return null;
  const added = pickRepositories({ repositories: event.repositories_added });
  const removed = pickRepositories({ repositories: event.repositories_removed });
  const selection = selectionOf(event);
  const statements: D1PreparedStatement[] = [];

  if (selection === 'all') {
    // Scope is now the whole account; the stored list is irrelevant and is cleared.
    statements.push(
      db
        .prepare(
          `UPDATE github_installations SET repository_selection='all',repositories_complete=1,
             updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
        )
        .bind(row.id, row.organization_id),
      db.prepare('DELETE FROM github_installation_repositories WHERE installation_row_id=?').bind(row.id),
    );
  } else {
    if (selection === 'selected' && row.repository_selection === 'all') {
      // Switching from 'all' to 'selected' sends only a delta, so the full set is unknown.
      // Ingress keeps checking the stored set (fail closed) until a reconnect resyncs it.
      statements.push(
        db
          .prepare(
            `UPDATE github_installations SET repository_selection='selected',repositories_complete=0,
               updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
          )
          .bind(row.id, row.organization_id),
      );
    }
    statements.push(...insertRepositories(db, row.id, added), ...deleteRepositories(db, row.id, removed));
  }

  statements.push(
    lifecycleAudit(db, row, action, {
      added: added.map((r) => r.fullName).slice(0, 50),
      removed: removed.map((r) => r.fullName).slice(0, 50),
      ...(selection ? { selection } : {}),
    }),
  );
  return statements;
}

function renameStatements(
  db: D1Database,
  action: string,
  event: Record<string, unknown>,
  row: InstallationRow,
): D1PreparedStatement[] | null {
  const account = asRecord(event.account);
  const login = account?.login;
  const id = account?.id;
  if (action !== 'renamed' || typeof login !== 'string' || typeof id !== 'number') return null;
  return [
    db
      .prepare(
        `UPDATE github_installations SET account_login=?,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=? AND (account_id IS NULL OR account_id=?)`,
      )
      .bind(login, row.id, row.organization_id, String(id)),
    lifecycleAudit(db, row, action, { account: login }),
  ];
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
  const action = typeof event.action === 'string' ? event.action : '';

  const row = await db
    .prepare(
      'SELECT id,organization_id,status,repository_selection FROM github_installations WHERE installation_id=? AND app_id=?',
    )
    .bind(block.installationId, appId)
    .first<InstallationRow>();

  if (!row) {
    if (kind === 'installation' && action === 'deleted') {
      await db
        .prepare('INSERT OR IGNORE INTO github_installation_tombstones(installation_id,app_id) VALUES(?,?)')
        .bind(block.installationId, appId)
        .run();
      return { kind: 'applied', action: 'installation.deleted', organizationId: null };
    }
    return { kind: 'ignored', reason: 'unbound' };
  }

  const batch =
    kind === 'installation'
      ? installationStatements(db, action, row)
      : kind === 'installation_repositories'
        ? repositoryStatements(db, action, event, row)
        : renameStatements(db, action, event, row);
  if (!batch) return { kind: 'ignored', reason: 'unsupported_action' };
  await db.batch(batch);
  return { kind: 'applied', action: `${kind}.${action}`, organizationId: row.organization_id };
}
