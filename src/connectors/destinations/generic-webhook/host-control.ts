/**
 * Host controls for the custom (generic) webhook destination, the one destination whose host the customer
 * chooses (docs/specs/REMAINING.md 1.16, spec 09 F115; ADR 0029). The feature flag `GENERIC_WEBHOOK_ENABLED`
 * stays OFF: see the ADR for what must still be true before it is turned on.
 *
 * What helps, in order of strength:
 *  1. A per-workspace host ALLOWLIST (`workspace_webhook_hosts`). A webhook may only point at a host a
 *     workspace admin approved, so someone who can create an integration cannot pick a host at all. An empty
 *     allowlist means no custom webhook can be saved or sent: opt-in, never a default. This is the control
 *     that matters.
 *  2. RECORDED RESOLUTIONS (`webhook_host_resolutions`): the addresses the host resolved to, when, and how
 *     many times the set changed. A record older than {@link RESOLUTION_TTL_MS} is re-resolved before a send,
 *     and the `egress_maintenance` job refreshes records of ENABLED integrations. This catches a zone whose
 *     records were STATICALLY changed to a private or reserved address. It is a hygiene check and an
 *     operator signal, not a rebinding defence.
 *  3. The shape policy and send-path rules that already exist (url-policy.ts, send.ts: port 443, no
 *     redirects, fixed signature, timeouts) and, for this kind, a {@link HostVerification} that
 *     `sendRequest` requires.
 *
 * WHAT THIS DOES NOT DO. DNS rebinding is NOT defended. The answer we check comes from a DNS-over-HTTPS
 * resolver, a different path from the one `fetch` uses at send time, and Workers `fetch` cannot be told
 * which address to connect to. A zone owner who answers differently per resolver, or per query, passes every
 * check here and still reaches a private address. Re-resolution shortens nothing against that attacker.
 * Closing it needs an egress proxy that pins the connected address (or a platform feature not verified
 * here). That is a stated blocker for turning the flag on.
 *
 * Nothing here stores or logs a URL, path, query, header or secret. The host name is stored (the tenant
 * chose it and sees it); addresses are stored for the operator and are NOT returned by any tenant API.
 */
import { log } from '../../../platform/log';
import { checkResolvedHost, type DnsFetcher, type HostCheck } from '../dns-check';
import { mintHostVerification, type HostVerification } from './verified';
import { isBlockedCustomerHostname, type UrlPolicyOptions } from '../url-policy';

type Db = Pick<D1Database, 'prepare'>;

export const MAX_ALLOWED_HOSTS_PER_WORKSPACE = 50;
/** A recorded good resolution is trusted this long; after it the host is re-resolved before sending. */
export const RESOLUTION_TTL_MS = 5 * 60_000;
/**
 * Hosts the maintenance job re-resolves per tick. A Worker invocation has a subrequest budget (50 on the free
 * plan, 1,000 on paid; UNVERIFIED for this account), shared with the other cron jobs of the tick: each host
 * costs two DNS-over-HTTPS fetches and about six D1 calls, so five hosts is about forty subrequests.
 */
export const RECHECK_BATCH = 5;
/** Stale or orphaned records deleted per tick. */
export const PURGE_BATCH = 100;
/** A resolution record that no SEND has checked for this long is dropped (the cron sweep does not count as use). */
export const RESOLUTION_RETENTION_MS = 30 * 24 * 3_600_000;

export type SendRefusal = 'host_not_allowed' | 'blocked_address' | 'unresolvable' | 'lookup_failed';

/**
 * Public suffixes and shared-hosting domains a wildcard rule must never sit on: `*.herokuapp.com` would
 * approve every customer of that platform. A SMALL bundled list, not the full Public Suffix List: the
 * management API must use the full list (a blocker recorded in ADR 0029). Exact hosts are not affected.
 */
export const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  'herokuapp.com',
  'github.io',
  'githubusercontent.com',
  'gitlab.io',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'appspot.com',
  'azurewebsites.net',
  'cloudfront.net',
  'amazonaws.com',
  'elasticbeanstalk.com',
  'blogspot.com',
  'wordpress.com',
  'myshopify.com',
  'ngrok.io',
  'ngrok-free.app',
  'trycloudflare.com',
  'fly.dev',
  'onrender.com',
  'railway.app',
  'surge.sh',
  'glitch.me',
  'repl.co',
  'replit.app',
  'bubbleapps.io',
  'webflow.io',
  'wixsite.com',
  'weebly.com',
  'zapier.com',
  'pipedream.net',
  'webhook.site',
  'requestbin.com',
  'dyndns.org',
  'no-ip.com',
  'duckdns.org',
  'cloudflare.net',
  'azureedge.net',
  'herokudns.com',
]);
const SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set([
  'co',
  'com',
  'org',
  'net',
  'gov',
  'edu',
  'ac',
  'or',
  'ne',
  'go',
]);

/** True for a base a wildcard must not cover: a bare TLD, `co.uk`-style, or a shared-hosting suffix. */
export function isSharedSuffix(base: string): boolean {
  const labels = base.split('.');
  if (labels.length < 2) return true;
  if (SHARED_SUFFIXES.has(base)) return true;
  const last = labels.at(-1) ?? '';
  return labels.length === 2 && last.length === 2 && SECOND_LEVEL_LABELS.has(labels[0] ?? '');
}

/** A rule is an exact host (`hooks.example.com`) or a subdomain wildcard (`*.example.com`). */
export function normalizeHostRule(raw: string): string | null {
  const rule = raw.trim().toLowerCase();
  if (rule.length === 0 || rule.length > 253) return null;
  const wildcard = rule.startsWith('*.');
  const host = wildcard ? rule.slice(2) : rule;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null; // also rejects IP literals, ports, paths
  if (isBlockedCustomerHostname(host)) return null;
  if (wildcard && isSharedSuffix(host)) return null;
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
  /** A send (true) refreshes `last_used_at`; the cron sweep (false) does not. */
  touch: boolean,
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
      `INSERT INTO webhook_host_resolutions(organization_id,integration_id,host,addresses,status,resolved_at,last_used_at,changed_count)
       VALUES(?1,?2,?3,?4,?5,?6,?6,?7)
       ON CONFLICT(organization_id,integration_id) DO UPDATE SET host=excluded.host, addresses=excluded.addresses,
         status=excluded.status, resolved_at=excluded.resolved_at,
         last_used_at = CASE WHEN ?8 = 1 THEN excluded.last_used_at ELSE last_used_at END,
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
      touch ? 1 : 0,
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
): Promise<{ ok: true; verification: HostVerification } | { ok: false; reason: SendRefusal }> {
  const rules = await loadAllowedHosts(deps.db, organizationId);
  const previous = await loadResolution(deps.db, organizationId, integrationId);
  if (!hostAllowed(rules, host)) {
    await recordResolution(
      deps.db,
      organizationId,
      integrationId,
      host,
      'not_allowed',
      nowMs,
      previous,
      true,
    );
    return { ok: false, reason: 'host_not_allowed' };
  }
  if (
    previous?.status === 'ok' &&
    previous.host === host &&
    nowMs - previous.resolvedAt >= 0 &&
    nowMs - previous.resolvedAt < RESOLUTION_TTL_MS
  )
    return { ok: true, verification: mintHostVerification(host) };
  const check = await checkResolvedHost(host, deps.fetcher, deps.urlPolicy);
  await recordResolution(deps.db, organizationId, integrationId, host, check, nowMs, previous, true);
  return check.ok
    ? { ok: true, verification: mintHostVerification(host) }
    : { ok: false, reason: check.reason };
}

/**
 * ?1 cutoff · ?2 batch. Platform-wide by design (a maintenance sweep); each row is then handled by its own
 * tenant keys. Only ENABLED custom-webhook integrations are re-resolved: a deleted or disabled one is not
 * checked forever.
 */
export const DUE_RESOLUTIONS_SQL = `SELECT r.organization_id, r.integration_id, r.host FROM webhook_host_resolutions r
  JOIN integrations i ON i.id = r.integration_id AND i.organization_id = r.organization_id
    AND i.enabled = 1 AND i.destination = 'generic_webhook'
  WHERE r.resolved_at < ?1 ORDER BY r.resolved_at LIMIT ?2`;

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
      false,
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

/**
 * ?1 last-use cutoff · ?2 batch. Records no send has checked for the retention period, and records whose
 * integration is gone or disabled. Platform-wide by design; bounded per run.
 */
export const PURGE_RESOLUTIONS_SQL = `DELETE FROM webhook_host_resolutions WHERE rowid IN (
  SELECT r.rowid FROM webhook_host_resolutions r
  WHERE r.last_used_at < ?1 OR NOT EXISTS (
    SELECT 1 FROM integrations i WHERE i.id = r.integration_id AND i.organization_id = r.organization_id
      AND i.enabled = 1 AND i.destination = 'generic_webhook')
  LIMIT ?2)`;

/** Housekeeping, bounded per run. Returns the number removed. */
export async function purgeStaleResolutions(db: Db, nowMs: number): Promise<number> {
  const r = await db
    .prepare(PURGE_RESOLUTIONS_SQL)
    .bind(nowMs - RESOLUTION_RETENTION_MS, PURGE_BATCH)
    .run();
  return r.meta?.changes ?? 0;
}
