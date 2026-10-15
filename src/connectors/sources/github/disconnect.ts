import { auditStatement, enabledIntegrationAudits } from '../../../audit/audit';

/**
 * User-initiated disconnect of a GitHub installation from a workspace (spec 05 F70, ADR 0058).
 *
 * What it does, in one D1 batch:
 *  1. marks OUR row `uninstalled`, so ingress refuses every later event for it (`resolveTenant`
 *     answers `not-active`, 403) and the repository picker stops offering its repositories;
 *  2. pauses the workspace's GitHub integrations that use it, each with an audit row giving the
 *     reason (`github_disconnected`), so nothing resumes silently if GitHub is connected again;
 *  3. records one `github.installation.disconnect` audit row.
 *
 * What it does NOT do: call GitHub. We hold no installation token (ADR 0008: the verification token
 * is revoked at once, and nothing calls the API as the App yet), so there is nothing of ours to
 * revoke there. The App stays installed on the GitHub account until someone with access to that
 * account uninstalls it in GitHub's settings; the dashboard says so. Destination credentials are
 * untouched: they belong to the workspace, not to GitHub (F70).
 *
 * `uninstalled` is the only stopped state the schema has (0006 CHECK), and it is terminal by design
 * (lifecycle.ts, `bindInstallation`): this installation id can be connected again only after the App
 * is uninstalled and reinstalled on GitHub, which issues a new id. The install flow says so with
 * `installation_disconnected`.
 */

export type DisconnectOutcome =
  | { readonly kind: 'not_found' }
  /** Already stopped (disconnected here, or uninstalled on GitHub). Nothing was changed. */
  | { readonly kind: 'already_stopped'; readonly account: string }
  | { readonly kind: 'disconnected'; readonly account: string; readonly pausedIntegrations: number };

interface InstallationRow {
  id: string;
  account_login: string;
  status: string;
}

/** Above this many matching integrations something is wrong; the API caps a workspace at 100. */
const MAX_SCANNED_INTEGRATIONS = 500;
/** Rows per pause UPDATE: one bound id each plus the organization, under D1's 100 parameters. */
const IDS_PER_PAUSE = 90;

const ownerOf = (repo: string): string => (repo.split('/')[0] ?? '').toLowerCase();

/**
 * The enabled GitHub integrations (no `source_id`) of this workspace that this installation serves:
 * the repository's owner is the installation's account (every repository an installation can cover
 * belongs to its account), or the repository is in its synced set (which keeps an integration saved
 * before an account rename). Pure over the rows, so it is tested directly.
 */
export function integrationsServedBy(
  account: string,
  listed: readonly string[],
  integrations: readonly { readonly id: string; readonly repo: string }[],
): string[] {
  const owner = account.toLowerCase();
  const names = new Set(listed.map((r) => r.toLowerCase()));
  return integrations
    .filter((i) => ownerOf(i.repo) === owner || names.has(i.repo.toLowerCase()))
    .map((i) => i.id);
}

function pauseStatement(db: D1Database, organizationId: string, chunk: readonly string[]) {
  return db
    .prepare(
      `UPDATE integrations SET enabled=0,updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=? AND enabled=1 AND source_id IS NULL AND id IN (${chunk.map(() => '?').join(',')})`,
    )
    .bind(organizationId, ...chunk);
}

export async function disconnectInstallation(
  db: D1Database,
  input: {
    readonly organizationId: string;
    readonly installationRowId: string;
    readonly actorId: string;
    readonly ip: string | null;
    readonly userAgent: string | null;
  },
): Promise<DisconnectOutcome> {
  const { organizationId, installationRowId } = input;
  const row = await db
    .prepare('SELECT id,account_login,status FROM github_installations WHERE id=? AND organization_id=?')
    .bind(installationRowId, organizationId)
    .first<InstallationRow>();
  // Another workspace's installation is indistinguishable from a missing one.
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'active' && row.status !== 'suspended')
    return { kind: 'already_stopped', account: row.account_login };

  const candidates = await db
    .prepare(
      `SELECT id,repo FROM integrations WHERE organization_id=? AND source_id IS NULL AND enabled=1
       ORDER BY id LIMIT ${MAX_SCANNED_INTEGRATIONS}`,
    )
    .bind(organizationId)
    .all<{ id: string; repo: string }>();
  const listed = await db
    .prepare(
      `SELECT r.full_name AS full_name FROM github_installation_repositories r
       JOIN github_installations i ON i.id=r.installation_row_id
       WHERE i.id=? AND i.organization_id=?`,
    )
    .bind(row.id, organizationId)
    .all<{ full_name: string }>();
  const paused = integrationsServedBy(
    row.account_login,
    listed.results.map((r) => r.full_name),
    candidates.results,
  );

  const who = {
    actorId: input.actorId,
    ip: input.ip,
    userAgent: input.userAgent,
    outcome: 'success',
  } as const;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE github_installations SET status='uninstalled',suspended_at=NULL,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=? AND status IN ('active','suspended')`,
      )
      .bind(row.id, organizationId),
    // Only if the UPDATE above changed the row: of two concurrent disconnects, one is recorded.
    auditStatement(
      db,
      {
        ...who,
        organizationId,
        action: 'github.installation.disconnect',
        subjectType: 'github_installation',
        subjectId: row.id,
        metadata: {
          account: row.account_login,
          previousStatus: row.status,
          pausedIntegrations: paused.length,
        },
      },
      undefined,
      { onlyIfPreviousStatementChangedRows: true },
    ),
    // Before the pause, so exactly the integrations it turns off get an entry.
    ...enabledIntegrationAudits(
      db,
      {
        ...who,
        organizationId,
        action: 'integration.update',
        metadata: {
          fields: ['enabled'],
          enabled: false,
          previousEnabled: true,
          reason: 'github_disconnected',
        },
      },
      paused,
    ),
  ];
  for (let i = 0; i < paused.length; i += IDS_PER_PAUSE)
    statements.push(pauseStatement(db, organizationId, paused.slice(i, i + IDS_PER_PAUSE)));
  const results = await db.batch(statements);
  if (results[0]?.meta.changes !== 1) return { kind: 'already_stopped', account: row.account_login };
  return { kind: 'disconnected', account: row.account_login, pausedIntegrations: paused.length };
}
