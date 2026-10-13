import type { GithubInstallation } from '../../lib/api';

/**
 * Which repositories an integration may name, mirroring `src/api/repo-scope.ts` (F67): a
 * repository listed by an active `selected` installation, or any repository whose owner is the
 * account of an active `all` installation. Matching is case-insensitive, as GitHub's is. The
 * server re-checks on every write and stores GitHub's casing.
 */
export function activeInstallations(installations: readonly GithubInstallation[]): GithubInstallation[] {
  return installations.filter((i) => i.status === 'active');
}

export function isCovered(repo: string, installations: readonly GithubInstallation[]): boolean {
  const lower = repo.toLowerCase();
  const owner = lower.split('/')[0] ?? '';
  return activeInstallations(installations).some((i) =>
    i.repositorySelection === 'all'
      ? i.account.toLowerCase() === owner
      : i.repositories.some((r) => r.toLowerCase() === lower),
  );
}

/** The `all` installation whose account owns `repo`, if any (for the typed-name mode). */
export function allInstallationFor(
  repo: string,
  installations: readonly GithubInstallation[],
): GithubInstallation | undefined {
  const owner = (repo.split('/')[0] ?? '').toLowerCase();
  return activeInstallations(installations).find(
    (i) => i.repositorySelection === 'all' && i.account.toLowerCase() === owner,
  );
}

/** Repository part of `owner/name`, or '' when there is none yet. */
export function repoName(repo: string): string {
  const slash = repo.indexOf('/');
  return slash === -1 ? '' : repo.slice(slash + 1);
}
