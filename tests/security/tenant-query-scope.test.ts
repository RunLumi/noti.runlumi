import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFakeD1 } from '../support/d1';
import { collectStatements, findViolations, readSources, type Violation } from '../support/sql-scope';
import { must } from '../support/must';
import { LEGACY_OLD_TABLES } from '../../src/pipeline/purge';

/**
 * F26 / F233: every query on a tenant table carries an `organization_id` predicate, and every
 * tenant table carries a NOT NULL organization_id with a foreign key (F25, migration 0026).
 *
 * The scanner lives in tests/support/sql-scope.ts and states its limits. The short version: it
 * reads SQL written as literals in `src/` (including `${CONST}` interpolation, `+` concatenation
 * and `${where.join(...)}` over a const array), proves an org comparison against a bound value
 * EXISTS in each statement, and cannot see SQL assembled dynamically or prove WHICH organization
 * the bound value is. The cross-workspace API tests and the isolation drill (tests/drill) cover
 * that half.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ---------------------------------------------------------------------------------------------
// Schema: which tables are tenant tables, and is each one constrained?
// ---------------------------------------------------------------------------------------------

/**
 * Tables that carry NO organization_id column, each with the reason it is not a tenant table.
 * A new table must appear here or gain an organization_id: adding one forces the decision.
 */
const NOT_TENANT_TABLES: Readonly<Record<string, string>> = {
  organization: 'the tenant itself',
  user: 'Better Auth identity, global; membership is the tenant link',
  account: 'Better Auth credentials, keyed by user',
  session: 'Better Auth session, keyed by user (active_organization_id is a preference, not data)',
  verification: 'Better Auth one-time tokens, keyed by identifier',
  passkey: 'Better Auth passkeys, keyed by user',
  rate_limit: 'Better Auth rate limiter counters, keyed by IP and path',
  api_rate_limits: 'fixed-window counters keyed by actor and window; no tenant data',
  ops_state: 'cron heartbeat key/value; no tenant data',
  job_runs:
    'history of cron job failures and outcome changes (F192): job name, times, outcome, counters; platform-wide',
  job_state: 'one row per cron job, upserted each run (F192): times, outcome, counters; platform-wide',
  egress_guard_buckets:
    'per-provider per-minute request and invalid-response counts (F108); counts only; platform-wide by design: the Discord breaker is cross-tenant',
  egress_guard_state:
    'one row per guarded provider: when the global breaker is open; platform-wide by design',
  alert_state: 'one row per alert in the fixed registry (F200); counts and times only; platform-wide',
  github_installation_tombstones: 'installation ids that were deleted, so a replay cannot rebind them',
  github_installation_repositories: 'child of github_installations; scoped through installation_row_id',
  legacy_orphaned_rows:
    'quarantine of rows that had no derivable tenant (0026); metadata only, read by no code',
  _snapshot_0026:
    'DDL text of the indexes and triggers 0026 recreates (temporary, until finalize); no tenant data',
  auth_users: 'retired 0004 identity table (F31); no code reads it',
  auth_orgs: 'retired 0004 identity table (F31); no code reads it',
  auth_memberships: 'retired 0004 identity table (F31); no code reads it',
  auth_tokens: 'retired 0004 identity table (F31); no code reads it',
  auth_invites: 'retired 0004 identity table (F31); no code reads it',
};

/** Tenant tables that are deliberately not `NOT NULL REFERENCES organization ON DELETE CASCADE`. */
const CONTRACT_EXCEPTIONS: Readonly<Record<string, string>> = {
  audit_events:
    'organization_id is NULL for a denial against a workspace that does not exist, and for workspace.purged; FK with CASCADE is present',
  workspace_deletions:
    'the purge ledger must outlive the organization, so it has no foreign key by design (0011)',
};

/** Child tables with no organization_id: table -> parent that carries it. */
const CHILD_TABLES = new Map([['github_installation_repositories', 'github_installations']]);

interface Col {
  name: string;
  notnull: number;
}
interface Fk {
  from: string;
  table: string;
  on_delete: string;
}

function schema() {
  const { raw } = createFakeD1();
  // The temporary `<table>_old` originals kept by migration 0026 until finalize are pre-contract by
  // definition (nullable organization_id, no foreign key); they are covered by the retention matrix
  // (kind 'temporary') and by the purge, not by the contract.
  const temporary = new Set<string>(LEGACY_OLD_TABLES);
  const tables = (
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  )
    .map((t) => t.name)
    .filter((t) => !temporary.has(t));
  const info = new Map(
    tables.map((t) => [
      t,
      {
        cols: raw.prepare(`PRAGMA table_info("${t}")`).all() as unknown as Col[],
        fks: raw.prepare(`PRAGMA foreign_key_list("${t}")`).all() as unknown as Fk[],
      },
    ]),
  );
  const tenant = new Set(
    tables.filter((t) => must(info.get(t)).cols.some((c) => c.name === 'organization_id')),
  );
  return { tables, info, tenant };
}

describe('every tenant table is constrained in the schema (F25)', () => {
  const { tables, info, tenant } = schema();

  it('classifies every table: it has an organization_id or an explained exemption', () => {
    const unclassified = tables.filter((t) => !tenant.has(t) && !(t in NOT_TENANT_TABLES));
    expect(
      unclassified,
      'new table: add organization_id (NOT NULL, FK) or explain it in NOT_TENANT_TABLES',
    ).toEqual([]);
    // No dead exemptions: a listed table must exist and must really lack organization_id.
    for (const t of Object.keys(NOT_TENANT_TABLES)) {
      expect(tables, `${t} is exempt but does not exist`).toContain(t);
      expect(tenant.has(t), `${t} now has organization_id; remove its exemption`).toBe(false);
    }
    expect([...tenant].sort()).toEqual(
      expect.arrayContaining([
        'integrations',
        'deliveries',
        'notification_outbox',
        'sources',
        'held_events',
        'routing_decisions',
        'noise_open_failures',
        'github_installations',
        'github_auth_states',
        'audit_events',
        'member',
        'invitation',
      ]),
    );
  });

  it('gives every tenant table organization_id NOT NULL REFERENCES organization(id) ON DELETE CASCADE', () => {
    const offenders: string[] = [];
    for (const t of tenant) {
      if (t in CONTRACT_EXCEPTIONS) continue;
      const { cols, fks } = must(info.get(t));
      const notNull = must(cols.find((c) => c.name === 'organization_id')).notnull === 1;
      const cascades = fks.some(
        (f) => f.from === 'organization_id' && f.table === 'organization' && f.on_delete === 'CASCADE',
      );
      if (!notNull || !cascades) offenders.push(`${t} (notNull=${notNull}, cascade=${cascades})`);
    }
    expect(offenders).toEqual([]);
    for (const t of Object.keys(CONTRACT_EXCEPTIONS)) {
      expect(tenant.has(t), `${t} is excepted but is not a tenant table`).toBe(true);
    }
  });

  it('the exceptions are the ones the spec allows, and no more', () => {
    expect(Object.keys(CONTRACT_EXCEPTIONS).sort()).toEqual(['audit_events', 'workspace_deletions']);
    const audit = must(info.get('audit_events'));
    expect(audit.fks.some((f) => f.from === 'organization_id' && f.on_delete === 'CASCADE')).toBe(true);
    expect(must(info.get('workspace_deletions')).fks).toEqual([]);
  });

  it('a child table without organization_id has a parent that does', () => {
    for (const [child, parent] of CHILD_TABLES) {
      expect(tenant.has(parent), `${child} -> ${parent}`).toBe(true);
      const fk = must(info.get(child)).fks.find((f) => f.table === parent);
      expect(fk?.on_delete, `${child} must cascade from ${parent}`).toBe('CASCADE');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Source: every query on a tenant table has an organization predicate
// ---------------------------------------------------------------------------------------------

interface Allowed {
  readonly file: string;
  /** Substring of the whitespace-normalised SQL that identifies the one statement. */
  readonly includes: string;
  readonly category:
    | 'credential-keyed ingress'
    | 'cron sweep'
    | 'retention'
    | 'correlated by primary key'
    | 'self-scoped by user id';
  readonly reason: string;
}

/**
 * Reviewed exceptions. Each is tenant-agnostic BY DESIGN, and the code that acts on what it
 * returns scopes by organization again. An entry that no longer matches a statement fails the
 * test (no dead entries), and a new unscoped statement in the same file does not match by
 * accident because `includes` pins the statement text.
 */
const ALLOWLIST: readonly Allowed[] = [
  // --- credential-keyed ingress: the lookup key is the credential; the tenant comes FROM the row ---
  {
    file: 'src/connectors/sources/generic/route.ts',
    includes: 'FROM sources WHERE endpoint_id=? AND kind=',
    category: 'credential-keyed ingress',
    reason:
      'Ingress resolves a source by its unguessable endpoint id, then verifies the signature against that row; the organization is read from the row, never from the request.',
  },
  {
    file: 'src/connectors/sources/provider-route.ts',
    includes: 'FROM sources WHERE endpoint_id=? AND kind=?',
    category: 'credential-keyed ingress',
    reason: 'Same as the generic route: endpoint id selects the row, the row supplies the organization.',
  },
  {
    file: 'src/connectors/sources/github/tenant.ts',
    includes: 'SELECT organization_id, status FROM github_installations WHERE installation_id=? AND app_id=?',
    category: 'credential-keyed ingress',
    reason:
      'The installation registry (F27): a verified installation id maps to exactly one organization (UNIQUE(installation_id, app_id)); an unknown installation is refused.',
  },
  {
    file: 'src/connectors/sources/github/tenant.ts',
    includes: 'SELECT id,repository_selection FROM github_installations WHERE installation_id=? AND app_id=?',
    category: 'credential-keyed ingress',
    reason: 'Same registry lookup, run after the organization was resolved by the statement above.',
  },
  {
    file: 'src/connectors/sources/github/lifecycle.ts',
    includes:
      'SELECT id,organization_id,status,repository_selection FROM github_installations WHERE installation_id=? AND app_id=?',
    category: 'credential-keyed ingress',
    reason:
      'Installation lifecycle webhooks (suspend, delete) arrive signed by the App; the row found by installation id carries its own organization.',
  },
  {
    file: 'src/connectors/sources/github/install.ts',
    includes: 'SELECT id,organization_id FROM github_installations WHERE installation_id=? AND app_id=?',
    category: 'credential-keyed ingress',
    reason:
      'Bind step: finds a possibly existing registry row for a verified installation, then REFUSES when its organization differs from the caller (installation_bound_elsewhere).',
  },
  {
    file: 'src/connectors/sources/github/install.ts',
    includes: 'UPDATE github_auth_states SET used_at=?',
    category: 'credential-keyed ingress',
    reason:
      'Single-use claim of an OAuth state by the hash of an unguessable value; consumeState then checks the user and the callers re-check workspace membership.',
  },
  {
    file: 'src/connectors/sources/github/install.ts',
    includes: 'FROM github_auth_states WHERE state_hash=?',
    category: 'credential-keyed ingress',
    reason: 'Reads the claimed state row by its hash; organization is taken from the row and re-authorized.',
  },
  {
    file: 'src/connectors/sources/github/install.ts',
    includes: 'UPDATE github_auth_states SET pkce_verifier=NULL WHERE state_hash=?',
    category: 'credential-keyed ingress',
    reason: 'Erases the PKCE verifier of the state this request just consumed.',
  },
  // --- cron and operator sweeps: enumerate work across tenants, act per tenant afterwards ---
  {
    file: 'src/connectors/sources/generic/secret.ts',
    includes: 'FROM sources WHERE kek_version IS NOT ?',
    category: 'cron sweep',
    reason:
      'KEK rotation re-seals every source secret under the current key; it is operator work across tenants.',
  },
  {
    file: 'src/pipeline/credentials.ts',
    includes: 'WHERE webhook_envelope IS NULL AND organization_id IS NOT NULL AND credentials_qua',
    category: 'cron sweep',
    reason:
      'Legacy credential migration sweep: seals pre-envelope integrations; the row keeps its own organization.',
  },
  {
    file: 'src/pipeline/credentials.ts',
    includes:
      'WHERE dek_wrapped IS NOT NULL AND kek_version IS NOT ? AND credentials_quarantined_at IS NULL LIMIT ?',
    category: 'cron sweep',
    reason:
      'KEK rotation sweep over integrations; re-wraps each DEK without exposing plaintext across tenants.',
  },
  {
    file: 'src/pipeline/credentials.ts',
    includes: 'SELECT SUM(CASE WHEN webhook_envelope IS NULL',
    category: 'cron sweep',
    reason:
      'Aggregate counts of integrations still on a legacy or old-KEK envelope; numbers only, no row content.',
  },
  {
    file: 'src/delivery/claim.ts',
    includes:
      'SELECT organization_id FROM notification_outbox WHERE organization_id IS NOT NULL AND created_at < ?1',
    category: 'cron sweep',
    reason:
      'Retention discovery: which organizations have outbox rows to purge; the purge then runs per organization.',
  },
  {
    file: 'src/delivery/claim.ts',
    includes:
      "SELECT organization_id FROM notification_outbox WHERE organization_id IS NOT NULL AND ((state = 'pending'",
    category: 'cron sweep',
    reason:
      'Dispatch discovery: which organizations have due outbox work; each is then claimed per organization.',
  },
  {
    file: 'src/delivery/ledger.ts',
    includes: "SELECT organization_id FROM deliveries WHERE state = 'claimed' AND claimed_at <= ?1",
    category: 'cron sweep',
    reason:
      'Reclaim discovery: which organizations have stale claims; the reclaim then runs per organization.',
  },
  {
    file: 'src/pipeline/noise-release.ts',
    includes: 'UPDATE held_events SET state=CASE WHEN attempts+1>=?3',
    category: 'cron sweep',
    reason:
      'Expired-lease reclaim for held events, bounded and keyed by rowid of rows whose lease lapsed; touches state only.',
  },
  {
    file: 'src/pipeline/noise-release.ts',
    includes: 'SELECT h.organization_id, h.integration_id FROM held_events h JOIN integrations i',
    category: 'cron sweep',
    reason:
      'Due-unit discovery for the release job: returns (organization, integration) pairs; release then loads rows per organization.',
  },
  {
    file: 'src/pipeline/purge.ts',
    includes:
      'SELECT organization_id FROM workspace_deletions WHERE cancelled_at IS NULL AND purged_at IS NULL AND purge_after <= ?',
    category: 'cron sweep',
    reason:
      'Finds the next workspace whose deletion window has elapsed; the purge itself deletes strictly by that organization id.',
  },
  {
    file: 'src/observability/stall.ts',
    includes: "SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM notification_outbox WHERE state='pending'",
    category: 'cron sweep',
    reason:
      'Operator stall detector: counts of stuck work across all tenants. Numbers only; never row content.',
  },
  {
    file: 'src/observability/alerts/signals.ts',
    includes: "FROM delivery_attempts WHERE started_at >= ?1 AND outcome = 'dead_lettered'",
    category: 'cron sweep',
    reason: 'Alert signal: a platform-wide COUNT of recent dead-lettering attempts. A number, never a row.',
  },
  {
    file: 'src/observability/alerts/signals.ts',
    includes: "FROM destination_health WHERE state IN ('open','half_open')",
    category: 'cron sweep',
    reason: 'Alert signal: a platform-wide COUNT of open breakers. A number, never a row.',
  },
  {
    file: 'src/observability/alerts/signals.ts',
    includes: 'FROM integrations WHERE credentials_quarantined_at IS NOT NULL',
    category: 'cron sweep',
    reason: 'Alert signal: a platform-wide COUNT of quarantined integrations. A number, never a row.',
  },
  {
    file: 'src/observability/alerts/signals.ts',
    includes: "SELECT created_at AS at FROM deliveries WHERE state = 'pending'",
    category: 'cron sweep',
    reason: 'Alert signal: the age of the oldest pending delivery anywhere. A timestamp, never a row.',
  },
  {
    file: 'src/observability/alerts/signals.ts',
    includes: 'FROM sources WHERE last_dropped_at IS NOT NULL',
    category: 'cron sweep',
    reason: 'Alert signal: a platform-wide COUNT of sources that recently dropped events. A number only.',
  },
  {
    file: 'src/observability/alerts/signals.ts',
    includes:
      "SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM deliveries WHERE state = 'pending' AND is_test = 0",
    category: 'cron sweep',
    reason:
      'Alert signal (dead-letter proxy): counts of ledger rows stuck for hours across tenants. Numbers only.',
  },
  // --- retention: age-based deletion across tenants ---
  {
    file: 'src/pipeline/retention.ts',
    includes:
      "DELETE FROM deliveries WHERE rowid IN ( SELECT rowid FROM deliveries WHERE state IN ('sent','accepted','suppressed','dead_lettered','failed') AND created_at < ?1",
    category: 'retention',
    reason: 'Delivery retention is a time window applied to every tenant alike (F237).',
  },
  {
    file: 'src/pipeline/retention.ts',
    includes: 'AND created_at IS NULL AND updated_at < ?1',
    category: 'retention',
    reason: 'Same window for rows written before created_at existed.',
  },
  {
    file: 'src/pipeline/retention.ts',
    includes: 'DELETE FROM notification_outbox WHERE rowid IN ( SELECT o.rowid FROM notification_outbox o',
    category: 'retention',
    reason: 'Orphaned outbox rows older than the window, for every tenant.',
  },
  {
    file: 'src/pipeline/retention.ts',
    includes:
      'DELETE FROM audit_events WHERE rowid IN ( SELECT rowid FROM audit_events WHERE created_at < ?1',
    category: 'retention',
    reason: 'Audit retention window.',
  },
  {
    file: 'src/routing/noise-store.ts',
    includes: "DELETE FROM held_events WHERE rowid IN ( SELECT rowid FROM held_events WHERE state='released'",
    category: 'retention',
    reason: 'Released held events older than the window.',
  },
  {
    file: 'src/routing/noise-store.ts',
    includes: "DELETE FROM held_events WHERE rowid IN ( SELECT rowid FROM held_events WHERE state='failed'",
    category: 'retention',
    reason: 'Failed held events older than the window.',
  },
  {
    file: 'src/routing/noise-store.ts',
    includes:
      'DELETE FROM noise_open_failures WHERE rowid IN ( SELECT rowid FROM noise_open_failures WHERE opened_at < ?',
    category: 'retention',
    reason: 'Open-failure markers older than the window.',
  },
  {
    file: 'src/routing/provenance.ts',
    includes:
      'DELETE FROM routing_decisions WHERE rowid IN ( SELECT rowid FROM routing_decisions WHERE decided_at < ?',
    category: 'retention',
    reason: 'Routing decision retention window.',
  },
  // --- the caller's own account (DSAR, F238): keyed by the verified session's user id ---
  {
    file: 'src/api/account.ts',
    includes: 'm.role AS role, m.created_at AS joined_at',
    category: 'self-scoped by user id',
    reason: 'Export: the memberships of the signed-in person, keyed by their own user id.',
  },
  {
    file: 'src/api/account.ts',
    includes: '(SELECT COUNT(*) FROM member x WHERE x.organization_id=m.organization_id',
    category: 'self-scoped by user id',
    reason: "Erasure preview: the signed-in person's own memberships and each workspace admin count.",
  },
  {
    file: 'src/api/account.ts',
    includes: 'FROM invitation WHERE inviter_id=? ORDER BY created_at',
    category: 'self-scoped by user id',
    reason: 'Export: invitations the signed-in person sent, keyed by their user id.',
  },
  {
    file: 'src/api/account.ts',
    includes: 'FROM audit_events WHERE actor_id=?',
    category: 'self-scoped by user id',
    reason: 'Export: audit rows where the signed-in person is the actor, keyed by their user id.',
  },
  {
    file: 'src/api/account.ts',
    includes: 'SELECT organization_id FROM member WHERE user_id=?',
    category: 'self-scoped by user id',
    reason: 'Erasure: the workspaces of the signed-in person, keyed by their user id.',
  },
  {
    file: 'src/api/account.ts',
    includes: 'DELETE FROM github_auth_states WHERE user_id=?',
    category: 'self-scoped by user id',
    reason: 'Erasure: pending install states of the signed-in person.',
  },
  {
    file: 'src/api/account.ts',
    includes: 'UPDATE invitation SET inviter_id=(',
    category: 'self-scoped by user id',
    reason:
      'Erasure: hands invitations the erased person sent to another admin of the same workspace (the subquery is joined on the invitation own organization).',
  },
  {
    file: 'src/api/account.ts',
    includes: 'DELETE FROM invitation WHERE lower(email)=lower(?)',
    category: 'self-scoped by user id',
    reason: 'Erasure: invitations addressed to the verified email of the signed-in person.',
  },
  // --- expiry sweeps of auth state, over a fixed list of tables ---
  {
    file: 'src/pipeline/expired-records.ts',
    includes: 'DELETE FROM ${...} WHERE rowid IN (SELECT rowid FROM ${...} WHERE ${...} < ?1 LIMIT ?2)',
    category: 'cron sweep',
    reason:
      'Bounded expiry delete over four fixed constant tables (sessions, verifications, install states, auth rate limits), by expiry time alone.',
  },
  {
    file: 'src/pipeline/expired-records.ts',
    includes: 'SELECT COUNT(*) AS n FROM ${...} WHERE expires_at < ?1',
    category: 'cron sweep',
    reason:
      'Sanity guard: counts wrong-unit expiry values in session and verification before the sweep; numbers only.',
  },
  // --- delivery ledger depth (0025, ADR 0023): age-based retention across tenants ---
  {
    file: 'src/delivery/dedup.ts',
    includes:
      'DELETE FROM event_dedup WHERE rowid IN ( SELECT rowid FROM event_dedup WHERE expires_at < ?1 LIMIT ?2)',
    category: 'retention',
    reason: 'Dedup rows past their own expiry, for every tenant alike (PURGE_EVENT_DEDUP_SQL).',
  },
  {
    file: 'src/pipeline/retention.ts',
    includes:
      'DELETE FROM delivery_attempts WHERE rowid IN ( SELECT a.rowid FROM delivery_attempts a WHERE a.started_at < ?2',
    category: 'retention',
    reason:
      'PURGE_ATTEMPTS_SQL: attempts older than the window whose delivery is gone or is itself due, for every tenant; the NOT EXISTS / EXISTS branches join the delivery by id AND organization_id, so a delivery of another tenant never matches.',
  },
  {
    file: 'src/pipeline/retention.ts',
    includes: 'DELETE FROM ingress_usage WHERE rowid IN ( SELECT rowid FROM ingress_usage WHERE day < ?1',
    category: 'retention',
    reason:
      'PURGE_INGRESS_USAGE_SQL: usage day rows past their retention, for every tenant alike (counts only).',
  },
  {
    file: 'src/pipeline/retention.ts',
    includes:
      "DELETE FROM destination_health WHERE rowid IN ( SELECT rowid FROM destination_health WHERE state='closed' AND updated_at < ?1",
    category: 'retention',
    reason: 'PURGE_DESTINATION_HEALTH_SQL: idle closed breakers, for every tenant alike.',
  },
  // --- custom-webhook host re-resolution (0029, ADR 0029): a maintenance sweep across tenants ---
  {
    file: 'src/connectors/destinations/generic-webhook/host-control.ts',
    includes: 'FROM webhook_host_resolutions WHERE resolved_at < ?1 ORDER BY resolved_at LIMIT ?2',
    category: 'retention',
    reason:
      'DUE_RESOLUTIONS_SQL: the cron sweep lists the oldest stale records of every tenant; each row is then re-read, checked and rewritten with its own organization_id and integration_id.',
  },
  {
    file: 'src/connectors/destinations/generic-webhook/host-control.ts',
    includes: 'DELETE FROM webhook_host_resolutions WHERE resolved_at < ?1',
    category: 'retention',
    reason: 'Resolution records nothing has refreshed for the retention period, for every tenant alike.',
  },
  // --- correlated by primary key to an org-scoped outer row ---
  {
    file: 'src/observability/slis.ts',
    includes: 'NOT EXISTS (SELECT 1 FROM deliveries t WHERE t.id=notification_outbox.id',
    category: 'correlated by primary key',
    reason:
      'The inner deliveries lookup is correlated by primary key to a notification_outbox row the outer WHERE already scoped to one organization.',
  },
];

function violationsInSource(): Violation[] {
  const statements = collectStatements(readSources(root));
  return findViolations(statements, schema().tenant, CHILD_TABLES);
}

const covers = (a: Allowed, v: Violation): boolean => a.file === v.file && v.sql.includes(a.includes);

describe('every query on a tenant table has an organization predicate (F26, F233)', () => {
  const found = violationsInSource();

  it('finds SQL to scan (the scanner has not gone blind)', () => {
    const statements = collectStatements(readSources(root));
    expect(statements.length).toBeGreaterThan(120);
    const files = new Set(statements.map((s) => s.file));
    for (const f of [
      'src/api/integrations.ts',
      'src/api/deliveries.ts',
      'src/api/delivery-queries.ts',
      'src/api/audit-view.ts',
      'src/pipeline/purge.ts',
    ])
      expect(files, f).toContain(f);
  });

  it('has no unscoped statement outside the reviewed allowlist', () => {
    const unreviewed = found.filter((v) => !ALLOWLIST.some((a) => covers(a, v)));
    expect(
      unreviewed.map((v) => `${v.file}:${v.line} ${v.table} (${v.kind}): ${v.sql.slice(0, 160)}`),
      'a tenant table is read or written without an organization_id comparison; scope it, or add a reviewed ALLOWLIST entry with a reason',
    ).toEqual([]);
  });

  it('has no dead allowlist entries', () => {
    const dead = ALLOWLIST.filter((a) => !found.some((v) => covers(a, v)));
    expect(dead.map((a) => `${a.file}: ${a.includes}`)).toEqual([]);
  });

  it('requires a reason on every allowlist entry, and no duplicates', () => {
    for (const a of ALLOWLIST) expect(a.reason.length, `${a.file}: ${a.includes}`).toBeGreaterThanOrEqual(20);
    const keys = ALLOWLIST.map((a) => `${a.file}|${a.includes}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never lets application code touch the quarantine or read the retired identity tables', () => {
    const sources = readSources(root);
    // The retention matrix (src/compliance/retention.ts) must name every table, including this one.
    const offenders = sources
      .filter((s) => /legacy_orphaned_rows/.test(s.text) && s.file !== 'src/compliance/retention.ts')
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The scanner itself: it must flag what it claims to, and pass what is scoped
// ---------------------------------------------------------------------------------------------

describe('the scanner (tests/support/sql-scope.ts)', () => {
  const tenant = new Set(['integrations', 'deliveries', 'sources', 'github_installations']);
  const scan = (code: string): Violation[] =>
    findViolations(collectStatements([{ file: 'fixture.ts', text: code }]), tenant, CHILD_TABLES);

  it.each([
    ['SELECT by id alone', 'db.prepare("SELECT * FROM integrations WHERE id=?")'],
    ['UPDATE by id alone', 'db.prepare("UPDATE integrations SET enabled=0 WHERE id=?")'],
    ['DELETE by id alone', 'db.prepare("DELETE FROM deliveries WHERE id=?")'],
    ['no WHERE at all', 'db.prepare("SELECT COUNT(*) FROM deliveries")'],
    [
      'org compared to NULL, not a bound value',
      'db.prepare("SELECT * FROM integrations WHERE organization_id IS NULL")',
    ],
    ['org only in the SELECT list', 'db.prepare("SELECT organization_id FROM integrations WHERE id=?")'],
    ['org set, not compared', 'db.prepare("UPDATE integrations SET organization_id=? WHERE id=?")'],
    [
      'org only as a join equality, never bound',
      'db.prepare("SELECT 1 FROM deliveries d JOIN integrations i ON i.organization_id=d.organization_id")',
    ],
    ['a template literal', 'const t = 1; db.prepare(`SELECT * FROM integrations WHERE id=${t}`)'],
    ['multi-line SQL', 'db.prepare(`\n  SELECT *\n    FROM integrations\n   WHERE id = ?\n`)'],
    ['string concatenation', 'db.prepare("SELECT * FROM integrations " + "WHERE id=?")'],
    [
      'a constant spliced in',
      'const COLS = "id, repo"; db.prepare(`SELECT ${COLS} FROM integrations WHERE id=?`)',
    ],
    [
      'a JOIN where only one side is scoped',
      'db.prepare("SELECT 1 FROM deliveries d JOIN integrations i ON i.id=d.integration_id WHERE d.organization_id=?")',
    ],
    [
      'a subquery that is not scoped',
      'db.prepare("SELECT * FROM deliveries WHERE organization_id=? AND integration_id IN (SELECT id FROM integrations WHERE repo=?)")',
    ],
    ['a dynamic table name with no predicate', 'const t = f(); db.prepare(`DELETE FROM ${t} WHERE id=?`)'],
    [
      'an INSERT that names no organization_id',
      'db.prepare("INSERT INTO integrations(id,repo) VALUES(?,?)")',
    ],
    [
      'an UNION arm that is unscoped',
      'db.prepare("SELECT id FROM integrations WHERE organization_id=? UNION ALL SELECT id FROM deliveries WHERE state=?")',
    ],
    [
      'a top-level OR with the tenant first',
      'db.prepare("SELECT * FROM integrations WHERE organization_id=? OR id=?")',
    ],
    [
      'a top-level OR with the tenant last',
      'db.prepare("SELECT * FROM integrations WHERE id=? OR organization_id=?")',
    ],
    [
      'the tenant inside an OR group',
      'db.prepare("SELECT * FROM integrations WHERE (id=? OR organization_id=?)")',
    ],
    ['NOT on the tenant', 'db.prepare("SELECT * FROM integrations WHERE NOT organization_id=?")'],
    ['a not-equal comparison', 'db.prepare("SELECT * FROM integrations WHERE organization_id<>?")'],
    ['a not-equal comparison (!=)', 'db.prepare("DELETE FROM deliveries WHERE organization_id != ?")'],
    [
      'the predicate only inside a block comment',
      'db.prepare("SELECT * FROM integrations WHERE id=? /* organization_id=? */")',
    ],
    [
      'the predicate only inside a line comment',
      'db.prepare(`SELECT * FROM integrations WHERE id=? -- organization_id=?\n`)',
    ],
    ['a comma join', 'db.prepare("SELECT 1 FROM integrations i, deliveries d WHERE i.organization_id=?")'],
  ])('flags %s', (_name, code) => {
    expect(scan(code).length).toBeGreaterThan(0);
  });

  it.each([
    ['a bound predicate', 'db.prepare("SELECT * FROM integrations WHERE id=? AND organization_id=?")'],
    ['numbered parameters', 'db.prepare("SELECT * FROM integrations WHERE organization_id=?1 AND id=?2")'],
    [
      'an unrelated OR group beside the tenant predicate',
      'db.prepare("SELECT * FROM integrations WHERE (enabled=? OR repo=?) AND organization_id=?")',
    ],
    [
      'an outer row picked by equality with a scoped subquery',
      'db.prepare("SELECT 1 FROM deliveries l WHERE l.rowid = (SELECT rowid FROM deliveries WHERE organization_id=?1 LIMIT 1)")',
    ],
    [
      'a block comment elsewhere',
      'db.prepare("SELECT * FROM integrations /* why */ WHERE organization_id=?")',
    ],
    ['an IN list', 'db.prepare("SELECT * FROM integrations WHERE organization_id IN (?, ?)")'],
    [
      'a qualified predicate with an alias',
      'db.prepare("SELECT i.id FROM integrations i WHERE i.organization_id=?")',
    ],
    [
      'a join scoped on both sides',
      'db.prepare("SELECT 1 FROM deliveries d JOIN integrations i ON i.id=d.integration_id AND i.organization_id=d.organization_id WHERE d.organization_id=?")',
    ],
    [
      'an UPDATE with org in WHERE',
      'db.prepare("UPDATE integrations SET enabled=0 WHERE id=? AND organization_id=?")',
    ],
    [
      'a scoped subquery feeding a DELETE',
      'db.prepare("DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries WHERE organization_id=? LIMIT ?)")',
    ],
    [
      'an INSERT naming organization_id',
      'db.prepare("INSERT INTO integrations(id,organization_id) VALUES(?,?)")',
    ],
    [
      'a dynamic table with a predicate',
      'const t = f(); db.prepare(`DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE organization_id=? LIMIT ?)`)',
    ],
    [
      'a dynamic WHERE built from a const array that starts with the predicate',
      'const where = ["organization_id = ?"]; db.prepare(`SELECT * FROM integrations WHERE ${where.join(" AND ")}`)',
    ],
    ['a table that is not a tenant table', 'db.prepare("SELECT * FROM api_rate_limits WHERE key=?")'],
    ['a message that merely starts with SELECT', 'throw new Error("SELECT a workspace first")'],
    ['an unrelated string', 'const x = "UPDATE your profile"'],
  ])('passes %s', (_name, code) => {
    expect(scan(code)).toEqual([]);
  });

  it('judges a child table through its parent', () => {
    expect(scan('db.prepare("DELETE FROM github_installation_repositories WHERE full_name=?")').length).toBe(
      1,
    );
    expect(
      scan('db.prepare("DELETE FROM github_installation_repositories WHERE installation_row_id=?")'),
    ).toEqual([]);
    expect(
      scan(
        'db.prepare("SELECT 1 FROM github_installation_repositories r JOIN github_installations i ON i.id=r.installation_row_id WHERE i.organization_id=?")',
      ),
    ).toEqual([]);
  });

  it('catches the real code losing its predicate: stripping organization_id from real files adds findings', () => {
    const tenantTables = schema().tenant;
    for (const file of ['src/api/integrations.ts', 'src/api/deliveries.ts', 'src/api/sources.ts']) {
      const original = must(readSources(root).find((s) => s.file === file));
      const mutated = original.text.replace(/organization_id\s*=\s*\?(\d*)/g, 'organization_id IS NOT NULL');
      expect(mutated, file).not.toBe(original.text);
      const base = findViolations(collectStatements([original]), tenantTables, CHILD_TABLES);
      const after = findViolations(collectStatements([{ file, text: mutated }]), tenantTables, CHILD_TABLES);
      expect(after.length, file).toBeGreaterThan(base.length);
    }
  });

  it('reports the file, line and table', () => {
    const [v] = scan('\n\ndb.prepare("SELECT * FROM integrations WHERE id=?")');
    expect(v).toMatchObject({ file: 'fixture.ts', line: 3, table: 'integrations', kind: 'read-or-write' });
  });
});
