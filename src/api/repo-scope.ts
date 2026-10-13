/**
 * An integration may only name a repository that one of the workspace's active GitHub
 * installations covers (F67). Returns the canonical `owner/name` (GitHub's casing) or null.
 *
 * - `selected` installations: the repository must be in the synced set.
 * - `all` installations: the owner must be the installation's account; GitHub then sends
 *   events for every repository of that account, including ones created later.
 */
export async function canonicalRepository(
  db: D1Database,
  organizationId: string,
  repo: string,
): Promise<string | null> {
  const listed = await db
    .prepare(
      `SELECT r.full_name AS full_name FROM github_installation_repositories r
       JOIN github_installations i ON i.id=r.installation_row_id
       WHERE i.organization_id=? AND i.status='active' AND r.full_name=? COLLATE NOCASE LIMIT 1`,
    )
    .bind(organizationId, repo)
    .first<{ full_name: string }>();
  if (listed) return listed.full_name;

  const owner = repo.split('/')[0] ?? '';
  const all = await db
    .prepare(
      `SELECT account_login FROM github_installations
       WHERE organization_id=? AND status='active' AND repository_selection='all' AND account_login=? COLLATE NOCASE
       LIMIT 1`,
    )
    .bind(organizationId, owner)
    .first<{ account_login: string }>();
  return all ? `${all.account_login}/${repo.slice(owner.length + 1)}` : null;
}

export const REPO_NOT_CONNECTED =
  'Noti cannot see this repository. Connect GitHub and grant Noti access to it, then try again.';
