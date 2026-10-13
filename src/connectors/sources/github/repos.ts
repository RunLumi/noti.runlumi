/**
 * Repository-set writes, chunked. One multi-row INSERT per 25 repositories keeps each
 * statement at 75 bound parameters (under D1's 100) and keeps a 1,000-repository sync to
 * 40 statements, inside D1's per-invocation query budget.
 */
export type RepoRef = { readonly id: string; readonly fullName: string };

const ROWS_PER_STATEMENT = 25;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function insertRepositories(db: D1Database, installationRowId: string, repos: readonly RepoRef[]) {
  return chunks(repos, ROWS_PER_STATEMENT).map((chunk) =>
    db
      .prepare(
        `INSERT INTO github_installation_repositories(installation_row_id,repository_id,full_name)
         VALUES ${chunk.map(() => '(?,?,?)').join(',')}
         ON CONFLICT(installation_row_id,repository_id) DO UPDATE SET full_name=excluded.full_name`,
      )
      .bind(...chunk.flatMap((r) => [installationRowId, r.id, r.fullName])),
  );
}

export function deleteRepositories(db: D1Database, installationRowId: string, repos: readonly RepoRef[]) {
  return chunks(repos, 90).map((chunk) =>
    db
      .prepare(
        `DELETE FROM github_installation_repositories
         WHERE installation_row_id=? AND repository_id IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(installationRowId, ...chunk.map((r) => r.id)),
  );
}
