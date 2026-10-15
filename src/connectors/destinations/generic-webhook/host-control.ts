/**
 * Host controls for the custom (generic) webhook destination, the one destination whose host the customer
 * chooses (docs/specs/REMAINING.md 1.16, spec 09 F115; ADR 0029). The feature flag `GENERIC_WEBHOOK_ENABLED`
 * stays OFF: see the ADR for what must still be true before it is turned on.
 *
 * Three layers, strongest first:
 *  1. A per-workspace host ALLOWLIST (`workspace_webhook_hosts`). A webhook may only point at a host a
 *     workspace admin approved, so an attacker who can create an integration cannot pick a host at all. An
 *     empty allowlist means no custom webhook can be saved or sent: it is opt-in, never a default.
 *  2. RECORDED RESOLUTIONS (`webhook_host_resolutions`): the addresses the host resolved to, when, and how
 *     many times the set changed. Checked before every send when older than {@link RESOLUTION_TTL_MS},
 *     and refreshed by the `egress_maintenance` job, so a record that starts pointing at a private or
 *     reserved address (a rebinding attempt) is refused before the next send.
 *  3. The shape policy and send-path rules that already exist (url-policy.ts, send.ts: port 443, no
 *     redirects, fixed signature, timeouts).
 *
 * WHAT THIS DOES NOT DO. Workers `fetch` cannot be told which address to connect to, and the DNS answer we
 * check comes from a DNS-over-HTTPS resolver, not from the path `fetch` uses. A zone owner can answer
 * differently to each. So this NARROWS the rebinding window (seconds to minutes instead of "at save time
 * only"); it does not close it. Closing it needs an egress proxy that pins the connected address, or a
 * Cloudflare feature we have not verified. That is a stated blocker for turning the flag on.
 *
 * Nothing here stores or logs a URL, path, query, header or secret. The host name is stored (the tenant
 * chose it and sees it); addresses are stored for the operator and are NOT returned by any tenant API.
 */
import { log } from '../../../platform/log';
import { checkResolvedHost, type DnsFetcher, type HostCheck } from '../dns-check';
import { isBlockedCustomerHostname, type UrlPolicyOptions } from '../url-policy';

type Db = Pick<D1Database, 'prepare'>;

export const MAX_ALLOWED_HOSTS_PER_WORKSPACE = 50;
/** A recorded good resolution is trusted this long; after it the host is re-resolved before sending. */
export const RESOLUTION_TTL_MS = 5 * 60_000;
/** Hosts the maintenance job re-resolves per tick. */
export const RECHECK_BATCH = 20;
/** A resolution record that nothing has refreshed for this long is dropped (its integration is gone or idle). */
export const RESOLUTION_RETENTION_MS = 30 * 24 * 3_600_000;

export type SendRefusal = 'host_not_allowed' | 'blocked_address' | 'unresolvable' | 'lookup_failed';

/** A rule is an exact host (`hooks.example.com`) or a subdomain wildcard (`*.example.com`). */
export function normalizeHostRule(raw: string): string | null {
  const rule = raw.trim().toLowerCase();
  if (rule.length === 0 || rule.length > 253) return null;
  const wildcard = rule.startsWith('*.');
  const host = wildcard ? rule.slice(2) : rule;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null; // also rejects IP literals, ports, paths
  if (isBlockedCustomerHostname(host)) return null;
  return wildcard ? `*.${host}` : host;
}

export function hostAllowed(rules: readonly string[], host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  return rules.some((rule) => (rule.startsWith('*.') ? h.endsWith(rule.slice(1)) : h === rule));
}

export async function loadAllowedHosts(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .prepare('SELECT host FROM workspace_webhook_hosts WHERE organization_id=?1 ORDER BY host LIMIT ?2')
    .bind(organizationId, MAX_ALLOWED_HOSTS_PER_WORKSPACE)
    .all<{ host: string }>();
  return rows.results.map((r) => r.host);
}

export type AddHostResult = { ok: true; host: string } | { ok: false; reason: 'invalid_host' | 'too_many' };

export async function addAllowedHost(
  db: Db,
  organizationId: string,
  raw: string,
  createdBy: string | null,
  nowMs: number,
): Promise<AddHostResult> {
  const host = normalizeHostRule(raw);
  if (!host) return { ok: false, reason: 'invalid_host' };
  const existing = await loadAllowedHosts(db, organizationId);
  if (!existing.includes(host) && existing.length >= MAX_ALLOWED_HOSTS_PER_WORKSPACE)
    return { ok: false, reason: 'too_many' };
  await db
    .prepare(
      'INSERT OR IGNORE INTO workspace_webhook_hosts(organization_id,host,created_by,created_at) VALUES(?1,?2,?3,?4)',
    )
    .bind(organizationId, host, createdBy, nowMs)
    .run();
  return { ok: true, host };
}

export async function removeAllowedHost(db: Db, organizationId: string, host: string): Promise<boolean> {
  const r = await db
    .prepare('DELETE FROM workspace_webhook_hosts WHERE organization_id=?1 AND host=?2')
    .bind(organizationId, host.trim().toLowerCase())
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

interface StoredResolution {
  host: string;
  addresses: string;
  status: string;
  resolved_at: number;
  changed_count: number;
}

export interface Resolution {
  readonly host: string;
  readonly addresses: readonly string[];
  readonly status: string;
  readonly resolvedAt: number;
  readonly changedCount: number;
}

function parseAddresses(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export async function loadResolution(
  db: Db,
  organizationId: string,
  integrationId: string,
): Promise<Resolution | null> {
  const row = await db
    .prepare(
      'SELECT host,addresses,status,resolved_at,changed_count FROM webhook_host_resolutions WHERE organization_id=?1 AND integration_id=?2',
    )
    .bind(organizationId, integrationId)
    .first<StoredResolution>();
  return row
    ? {
        host: row.host,
        addresses: parseAddresses(row.addresses),
        status: row.status,
        resolvedAt: row.resolved_at,
        changedCount: row.changed_count,
      }
    : null;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/** Store a check's outcome; counts a change of the address set against the previous good record. */
export async function recordResolution(
  db: Db,
  organizationId: string,
  integrationId: string,
  host: string,
  status: HostCheck | 'not_allowed',
  nowMs: number,
  previous: Resolution | null,
): Promise<void> {
  const statusName = status === 'not_allowed' ? 'not_allowed' : status.ok ? 'ok' : status.reason;
  const addresses = status !== 'not_allowed' && status.ok ? status.addresses : [];
  const changed =
    status !== 'not_allowed' &&
    status.ok &&
    previous?.status === 'ok' &&
    previous.host === host &&
    !sameSet(previous.addresses, addresses)
      ? 1
      : 0;
  await db
    .prepare(
      `INSERT INTO webhook_host_resolutions(organization_id,integration_id,host,addresses,status,resolved_at,changed_count)
       VALUES(?1,?2,?3,?4,?5,?6,?7)
       ON CONFLICT(organization_id,integration_id) DO UPDATE SET host=excluded.host, addresses=excluded.addresses,
         status=excluded.status, resolved_at=excluded.resolved_at,
         changed_count = changed_count + ?7`,
    )
    .bind(
      organizationId,
      integrationId,
      host,
      JSON.stringify(addresses).slice(0, 2000),
      statusName,
      nowMs,
      changed,
    )
    .run();
  if (changed === 1)
    // Counts and ids only: no host, no address.
    log('warn', 'webhook_host_addresses_changed', {
      workspace_id: organizationId,
      integration_id: integrationId,
    });
}

export interface SendCheckDeps {
  readonly db: Db;
  readonly fetcher?: DnsFetcher;
  readonly urlPolicy?: UrlPolicyOptions;
}

/**
 * The check the consumer runs before a custom webhook request: allowlist, then a fresh-enough recorded
 * resolution (re-resolving when stale), refusing any blocked address. Fails closed.
 */
export async function verifyHostAtSend(
  deps: SendCheckDeps,
  organizationId: string,
  integrationId: string,
  host: string,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: SendRefusal }> {
  const rules = await loadAllowedHosts(deps.db, organizationId);
  const previous = await loadResolution(deps.db, organizationId, integrationId);
  if (!hostAllowed(rules, host)) {
    await recordResolution(deps.db, organizationId, integrationId, host, 'not_allowed', nowMs, previous);
    return { ok: false, reason: 'host_not_allowed' };
  }
  if (
    previous?.status === 'ok' &&
    previous.host === host &&
    nowMs - previous.resolvedAt >= 0 &&
    nowMs - previous.resolvedAt < RESOLUTION_TTL_MS
  )
    return { ok: true };
  const check = await checkResolvedHost(host, deps.fetcher, deps.urlPolicy);
  await recordResolution(deps.db, organizationId, integrationId, host, check, nowMs, previous);
  return check.ok ? { ok: true } : { ok: false, reason: check.reason };
}

/** ?1 cutoff · ?2 batch. Platform-wide by design (a maintenance sweep); each row is then handled by its own tenant keys. */
export const DUE_RESOLUTIONS_SQL = `SELECT organization_id, integration_id, host FROM webhook_host_resolutions
  WHERE resolved_at < ?1 ORDER BY resolved_at LIMIT ?2`;

export interface RecheckReport {
  readonly checked: number;
  readonly refused: number;
  readonly changed: number;
}

/**
 * Re-resolve the hosts whose record is older than the TTL, oldest first, bounded. A host that is no longer
 * allowlisted or now resolves to a blocked address is recorded as such and refused at the next send.
 */
export async function reresolveDueHosts(deps: SendCheckDeps, nowMs: number): Promise<RecheckReport> {
  const due = await deps.db
    .prepare(DUE_RESOLUTIONS_SQL)
    .bind(nowMs - RESOLUTION_TTL_MS, RECHECK_BATCH)
    .all<{ organization_id: string; integration_id: string; host: string }>();
  let refused = 0;
  let changed = 0;
  for (const row of due.results) {
    const previous = await loadResolution(deps.db, row.organization_id, row.integration_id);
    const rules = await loadAllowedHosts(deps.db, row.organization_id);
    const result: HostCheck | 'not_allowed' = hostAllowed(rules, row.host)
      ? await checkResolvedHost(row.host, deps.fetcher, deps.urlPolicy)
      : 'not_allowed';
    await recordResolution(
      deps.db,
      row.organization_id,
      row.integration_id,
      row.host,
      result,
      nowMs,
      previous,
    );
    if (result === 'not_allowed' || !result.ok) refused += 1;
    else if (
      previous?.status === 'ok' &&
      (await loadResolution(deps.db, row.organization_id, row.integration_id))?.changedCount !==
        previous.changedCount
    )
      changed += 1;
  }
  return { checked: due.results.length, refused, changed };
}

/** Housekeeping: drop records nothing has refreshed for {@link RESOLUTION_RETENTION_MS}. */
export async function purgeStaleResolutions(db: Db, nowMs: number): Promise<number> {
  const r = await db
    .prepare('DELETE FROM webhook_host_resolutions WHERE resolved_at < ?1')
    .bind(nowMs - RESOLUTION_RETENTION_MS)
    .run();
  return r.meta?.changes ?? 0;
}
