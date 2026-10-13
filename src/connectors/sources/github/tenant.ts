import { asRecord } from '../../../lib/json';

/**
 * Resolve the workspace that owns an inbound GitHub delivery.
 *
 * The signature alone proves only that the request was signed with our App-wide webhook
 * secret — which every installation of our App holds. It does **not** identify a tenant.
 * The `installation` block in the verified payload body is the only tenant signal we can
 * trust, because it arrives inside the signed bytes.
 *
 * `X-GitHub-Hook-Installation-Target-ID` / `-Type` are deliberately NOT used: GitHub
 * documents them only as "the resource where the webhook was created", and the sole worked
 * example is a repository webhook, so their meaning for an App webhook is undefined.
 *
 * Every non-`ok` outcome is a rejection. There is no fallback to "route it everywhere".
 */
export type TenantResolution =
  | { kind: 'ok'; organizationId: string; installationId: string }
  | { kind: 'no-installation' }
  | { kind: 'app-mismatch' }
  | { kind: 'unknown-installation' }
  | { kind: 'not-active' };

/** Pure part of tenant resolution: validate the payload's installation block. */
export function readInstallationBlock(
  event: Record<string, unknown>,
  expectedAppId: string,
): { kind: 'ok'; installationId: string } | { kind: 'no-installation' | 'app-mismatch' } {
  const installation = asRecord(event.installation);
  if (!installation) return { kind: 'no-installation' };

  const appId = installation.app_id;
  // Absent `app_id` is tolerated (GitHub omits it in some shapes) and the installation
  // lookup is still scoped to OUR app id. But a *present* app_id must be a number that
  // matches ours — any other type or value is a cross-App payload and is rejected.
  if (appId !== undefined && (typeof appId !== 'number' || String(appId) !== expectedAppId)) {
    return { kind: 'app-mismatch' };
  }

  const id = installation.id;
  // GitHub installation ids are positive integers; anything else is not a real installation.
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return { kind: 'no-installation' };

  return { kind: 'ok', installationId: String(id) };
}

type InstallationRow = { organization_id: string; status: string };

export async function resolveTenant(
  db: D1Database,
  appId: string,
  event: Record<string, unknown>,
): Promise<TenantResolution> {
  const block = readInstallationBlock(event, appId);
  if (block.kind !== 'ok') return block;

  const row = await db
    .prepare('SELECT organization_id, status FROM github_installations WHERE installation_id=? AND app_id=?')
    .bind(block.installationId, appId)
    .first<InstallationRow>();

  if (!row) return { kind: 'unknown-installation' };
  if (row.status !== 'active') return { kind: 'not-active' };
  return { kind: 'ok', organizationId: row.organization_id, installationId: block.installationId };
}

/**
 * Repository scope (F67). For a `selected` installation, the repository must be in the
 * synced set; `installation_repositories` events keep that set current. For `all`, GitHub
 * only sends events for repositories the installation covers, and the payload is signed.
 */
export async function repositoryInScope(
  db: D1Database,
  appId: string,
  installationId: string,
  repositoryId: unknown,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT id,repository_selection FROM github_installations WHERE installation_id=? AND app_id=?')
    .bind(installationId, appId)
    .first<{ id: string; repository_selection: string }>();
  if (!row) return false;
  if (row.repository_selection === 'all') return true;
  if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId)) return false;
  const hit = await db
    .prepare(
      'SELECT 1 AS x FROM github_installation_repositories WHERE installation_row_id=? AND repository_id=?',
    )
    .bind(row.id, String(repositoryId))
    .first();
  return hit !== null;
}
