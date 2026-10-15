import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { can, type Capability } from '../../src/auth/permissions';
import { ROUTE_POLICY } from '../../src/auth/route-policy';
import { EVENT, caller, setup, signHeaders, type CreatedSource, type Harness } from '../sources/harness';
import { must } from '../support/must';

/**
 * The tenant-isolation drill (F233 evidence item 2), run over the real Worker and a fake D1.
 *
 * Workspace A's members present their own valid credentials and try to read, change, delete and
 * invoke workspace B's data by naming B or by guessing B's ids, on EVERY route in the route
 * policy (the same registry as tests/security/route-capability.test.ts). Every attempt must be
 * a 404, leak none of B's identifiers, change no row, and send nothing to B's destination. The
 * same plan then runs in the other direction (B against A). A control run proves each request
 * would have succeeded for its owner, so a 404 cannot come from a malformed request.
 *
 * This is NOT the staging drill. It proves the application and the migrated schema on a fake D1;
 * the deployed Worker, real D1 and real Better Auth sessions are exercised by
 * scripts/tenant-isolation-drill.mjs, which has not been run (docs/RUNBOOK.md, UNVERIFIED).
 */
vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

interface Victim {
  orgId: string;
  orgName: string;
  integrationId: string;
  sourceId: string;
  deliveryId: string;
  invitationId: string;
  githubInstallationId: string;
}
interface Attack {
  name: string;
  key: string;
  method: string;
  path: string;
  body: unknown;
  vector: 'org-param' | 'foreign-id' | 'foreign-body-id' | 'own-scope';
  expect: number[];
  readOnly: boolean;
  capability?: string;
}
interface Plan {
  allowedStatuses: (attack: Attack, holds: (capability: string) => boolean) => number[];
  planAttacks: (routes: readonly unknown[], victim: Victim) => Attack[];
  leakedMarkers: (text: string, markers: readonly string[]) => string[];
}
const planPath = '../../scripts/lib/drill-plan.mjs';
const { planAttacks, leakedMarkers, allowedStatuses } = (await import(/* @vite-ignore */ planPath)) as Plan;

interface World {
  h: Harness;
  call: ReturnType<typeof caller>;
  victims: Record<'org-a' | 'org-b', Victim & { markers: string[] }>;
}

const OWNER = { 'org-a': 'alice', 'org-b': 'mallory' } as const;
const TAIL = (org: string): string => `${org.replace(/-/g, '')}FixtureTail`;
const SLACK_FOR = (org: string): string => `https://hooks.slack.com/services/T000/B000/${TAIL(org)}`;
const GITHUB_ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_SLUG: 'lumi-noti-drill',
  GITHUB_CLIENT_ID: 'drill-client-id',
  GITHUB_CLIENT_SECRET: 'drill-client-value',
};

let current: Harness;
const call = caller(worker, () => current);

async function ingest(h: Harness, source: CreatedSource): Promise<void> {
  const body = JSON.stringify(EVENT);
  const res = await worker.fetch(
    new Request(`https://noti.test/webhooks/generic/${source.endpointId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signHeaders(source.secret, body) },
      body,
    }),
    h.env,
    { waitUntil: h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
  expect(res.status).toBe(202);
}

async function seedWorkspace(h: Harness, org: 'org-a' | 'org-b'): Promise<Victim & { markers: string[] }> {
  const as = OWNER[org];
  const created = await call('POST', '/api/sources', { as, body: { name: `src-${org}` } });
  expect(created.status).toBe(201);
  const src = await created.json<{ source: { id: string; endpointId: string }; secret: string }>();
  const source: CreatedSource = { ...src.source, endpointUrl: '', secret: src.secret };
  const made = await call('POST', '/api/integrations', {
    as,
    body: { name: `int-${org}`, sourceId: source.id, destination: 'slack', webhookUrl: SLACK_FOR(org) },
  });
  expect(made.status).toBe(201);
  const integrationId = (await made.json<{ integration: { id: string } }>()).integration.id;
  await ingest(h, source);
  const delivery = h.db.raw.prepare('SELECT id FROM deliveries WHERE organization_id=?').get(org) as {
    id: string;
  };
  h.db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
       VALUES(?,?,?,'12345',?,'Organization','all')`,
    )
    .run(`gh-${org}`, org, org === 'org-a' ? '111' : '222', `${org}-gh-account`);
  h.db.raw
    .prepare(
      'INSERT INTO github_installation_repositories(installation_row_id,repository_id,full_name) VALUES(?,?,?)',
    )
    .run(`gh-${org}`, '1', `${org}-gh-account/private-repo`);
  // A pending invitation in this workspace, sent by one of its admins (ADR 0045): the cancel route is attacked with it.
  const inviter = h.db.raw
    .prepare("SELECT user_id AS id FROM member WHERE organization_id=? AND role='admin' LIMIT 1")
    .get(org) as { id: string };
  const invitationId = `inv-${org}`;
  h.db.raw
    .prepare(
      'INSERT INTO invitation(id,organization_id,email,role,status,expires_at,inviter_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      invitationId,
      org,
      `pending-${org}@example.test`,
      'member',
      'pending',
      Date.now() + 86_400_000,
      inviter.id,
      Date.now(),
    );
  return {
    orgId: org,
    orgName: org,
    integrationId,
    sourceId: source.id,
    deliveryId: delivery.id,
    invitationId,
    githubInstallationId: `gh-${org}`,
    markers: [
      org,
      integrationId,
      source.id,
      source.endpointId,
      delivery.id,
      invitationId,
      `pending-${org}@example.test`,
      `int-${org}`,
      `src-${org}`,
      TAIL(org),
      `${org}-gh-account`,
    ],
  };
}

async function world(): Promise<World> {
  const h = setup();
  Object.assign(h.env as unknown as Record<string, unknown>, GITHUB_ENV);
  current = h;
  const victims = {
    'org-a': await seedWorkspace(h, 'org-a'),
    'org-b': await seedWorkspace(h, 'org-b'),
  };
  h.fetchMock.mockClear();
  return { h, call, victims };
}

const TENANT_TABLES = [
  'integrations',
  'sources',
  'deliveries',
  'notification_outbox',
  'held_events',
  'routing_decisions',
  'noise_open_failures',
  'github_installations',
  'github_installation_repositories',
  'workspace_deletions',
  'member',
  'invitation',
] as const;

/** Every tenant row of both workspaces, serialised; audit events and rate-limit counters excluded. */
function snapshot(h: Harness): string {
  return JSON.stringify(
    TENANT_TABLES.map((t) => [t, h.db.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
    (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v),
  );
}

async function run(w: World, as: string, attack: Attack): Promise<{ res: Response; text: string }> {
  const res = await w.call(attack.method, attack.path, {
    as,
    ...(attack.body !== undefined ? { body: attack.body } : {}),
  });
  const text = `${await res.text()}\n${res.headers.get('location') ?? ''}`;
  return { res, text };
}

const ATTACKERS = [
  { as: 'alice', own: 'org-a', victim: 'org-b', role: 'admin' },
  { as: 'bob', own: 'org-a', victim: 'org-b', role: 'member' }, // a plain member, not an admin
  { as: 'mallory', own: 'org-b', victim: 'org-a', role: 'admin' },
] as const;

const holds = (role: string) => (capability: string) => can(role, capability as Capability);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('route coverage', () => {
  it('attacks every session- or capability-guarded route in the route policy', async () => {
    const w = await world();
    const attacks = planAttacks(ROUTE_POLICY, w.victims['org-b']);
    const guarded = ROUTE_POLICY.filter((p) => ['capability', 'member', 'session'].includes(p.access.kind));
    for (const p of guarded) {
      const key = `${p.method} ${p.path}`;
      expect(
        attacks.some((a) => a.key === key),
        `${key} is not attacked by the drill`,
      ).toBe(true);
    }
    // Not vacuous: dozens of attacks across all three vectors.
    expect(attacks.length).toBeGreaterThan(50);
    for (const vector of ['org-param', 'foreign-id', 'foreign-body-id', 'own-scope'])
      expect(
        attacks.some((a) => a.vector === vector),
        vector,
      ).toBe(true);
  });
});

describe.each(ATTACKERS)('$as ($own) against $victim: read-only attacks', ({ as, own, victim, role }) => {
  let w: World;
  let before: string;
  beforeAll(async () => {
    w = await world();
    before = snapshot(w.h);
  });

  it('every read is a 404 or leaks nothing, and changes nothing', async () => {
    const attacks = planAttacks(ROUTE_POLICY, w.victims[victim]).filter((a) => a.readOnly);
    expect(attacks.length).toBeGreaterThan(20);
    const failures: string[] = [];
    for (const attack of attacks) {
      const { res, text } = await run(w, as, attack);
      const allowed = allowedStatuses(attack, holds(role));
      if (!allowed.includes(res.status))
        failures.push(`${attack.name}: status ${res.status}, expected ${allowed.join('/')}`);
      const leaked = leakedMarkers(text, w.victims[victim].markers);
      if (leaked.length > 0) failures.push(`${attack.name}: leaked ${leaked.join(', ')}`);
    }
    expect(failures).toEqual([]);
    expect(snapshot(w.h)).toBe(before);
    // The attacker's own scope is intact: they still see their own workspace.
    const mine = await w.call('GET', '/api/integrations', { as });
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain(w.victims[own].integrationId);
  });
});

describe.each(ATTACKERS)('$as ($own) against $victim: writes and actions', ({ as, victim, role }) => {
  const names = planAttacks(ROUTE_POLICY, {
    orgId: 'x',
    orgName: 'x',
    integrationId: 'x',
    sourceId: 'x',
    deliveryId: 'x',
    invitationId: 'x',
    githubInstallationId: 'x',
  })
    .filter((a) => !a.readOnly)
    .map((a) => a.name);

  it('has write attacks to run', () => {
    expect(names.length).toBeGreaterThan(8);
  });

  it.each(names)('%s', async (name) => {
    const w = await world();
    const before = snapshot(w.h);
    const attack = must(planAttacks(ROUTE_POLICY, w.victims[victim]).find((a) => a.name === name));
    const { res, text } = await run(w, as, attack);
    expect(allowedStatuses(attack, holds(role)), `status ${res.status}`).toContain(res.status);
    expect(leakedMarkers(text, w.victims[victim].markers)).toEqual([]);
    // Nothing changed in EITHER workspace, and nothing was sent to B's destination.
    expect(snapshot(w.h)).toBe(before);
    const sentTo = w.h.fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(sentTo.filter((u) => u.includes(TAIL(victim)))).toEqual([]);
  });
});

describe('control: the same requests succeed for their owner', () => {
  const eligible = planAttacks(ROUTE_POLICY, {
    orgId: 'x',
    orgName: 'x',
    integrationId: 'x',
    sourceId: 'x',
    deliveryId: 'x',
    invitationId: 'x',
    githubInstallationId: 'x',
  }).filter((a) => a.vector === 'org-param' || a.vector === 'foreign-body-id');

  it.each(eligible.map((a) => [a.name] as const))('%s', async (name) => {
    const w = await world();
    const owner = OWNER['org-a'];
    const mine = w.victims['org-a'];
    const attack = must(planAttacks(ROUTE_POLICY, mine).find((a) => a.name === name));
    // A deletion can only be cancelled once it has been requested.
    if (attack.key === 'DELETE /api/workspace/deletion') {
      const requested = await w.call('POST', '/api/workspace/deletion?org=org-a', {
        as: owner,
        body: { confirm: mine.orgName },
      });
      expect(requested.status).toBe(202);
    }
    const body =
      attack.vector === 'foreign-body-id'
        ? { ...(attack.body as object), webhookUrl: SLACK_FOR('control-a') }
        : attack.body;
    const { res } = await run(w, owner, { ...attack, body });
    // Not unauthorised, not hidden, not a crash: the request is well-formed and the owner may.
    expect([401, 403, 404]).not.toContain(res.status);
    expect(res.status).toBeLessThan(500);
  });
});

describe('ingress: a signed event reaches only the workspace whose source it was signed for', () => {
  const post = (
    w: World,
    endpointId: string,
    secret: string,
    tamper?: (h: Record<string, string>) => void,
  ) => {
    const body = JSON.stringify(EVENT);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...signHeaders(secret, body),
    };
    tamper?.(headers);
    return worker.fetch(
      new Request(`https://noti.test/webhooks/generic/${endpointId}`, { method: 'POST', headers, body }),
      w.h.env,
      { waitUntil: w.h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
  };
  const count = (w: World, org: string): number =>
    (
      w.h.db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE organization_id=?').get(org) as {
        n: number;
      }
    ).n;

  it("A's secret cannot post to B's endpoint, and an unsigned post is refused", async () => {
    const w = await world();
    // Recover A's and B's secrets by rotating through the API as each owner.
    const rotate = async (org: 'org-a' | 'org-b') => {
      const r = await w.call('POST', `/api/sources/${w.victims[org].sourceId}/rotate`, {
        as: OWNER[org],
        body: {},
      });
      expect(r.status).toBe(200);
      return (await r.json<{ secret: string }>()).secret;
    };
    const secretA = await rotate('org-a');
    const endpointB = (
      w.h.db.raw.prepare('SELECT endpoint_id AS e FROM sources WHERE organization_id=?').get('org-b') as {
        e: string;
      }
    ).e;
    const before = [count(w, 'org-a'), count(w, 'org-b')];
    const forged = await post(w, endpointB, secretA);
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(forged.status).toBeLessThan(500);
    const unsigned = await post(w, endpointB, secretA, (h) => {
      delete h['webhook-signature'];
    });
    expect(unsigned.status).toBeGreaterThanOrEqual(400);
    expect([count(w, 'org-a'), count(w, 'org-b')]).toEqual(before);
    // Sanity: the owner's own secret still works on the owner's endpoint.
    const secretB = await rotate('org-b');
    expect((await post(w, endpointB, secretB)).status).toBe(202);
    expect(count(w, 'org-b')).toBe(must(before[1]) + 1);
    expect(count(w, 'org-a')).toBe(before[0]);
  });

  it('every delivery row created by an event belongs to the source owner organization', async () => {
    const w = await world();
    const rows = w.h.db.raw
      .prepare(
        `SELECT d.organization_id AS d_org, i.organization_id AS i_org FROM deliveries d
         JOIN integrations i ON i.id = d.integration_id`,
      )
      .all() as { d_org: string; i_org: string }[];
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.d_org).toBe(r.i_org);
  });

  it('a GitHub event for an unknown installation is refused and routes nowhere', async () => {
    const w = await world();
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 999999, app_id: 1 },
      repository: { full_name: 'org-b-gh-account/private-repo' },
      issue: { number: 1, title: 'x', html_url: 'https://github.com/x/y/issues/1', user: { login: 'u' } },
    });
    const sig = `sha256=${createHmac('sha256', 'x').update(body).digest('hex')}`;
    const before = [count(w, 'org-a'), count(w, 'org-b')];
    const res = await worker.fetch(
      new Request('https://noti.test/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'drill-delivery-1',
          'x-hub-signature-256': sig,
        },
        body,
      }),
      w.h.env,
      { waitUntil: w.h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(403);
    expect([count(w, 'org-a'), count(w, 'org-b')]).toEqual(before);
  });
});

describe('denials', () => {
  it("a probe of B's workspace is recorded against B so its admins can see it, and B's data is not changed", async () => {
    const w = await world();
    const res = await w.call('GET', '/api/integrations?org=org-b', { as: 'alice' });
    expect(res.status).toBe(404);
    const rows = w.h.db.raw
      .prepare(
        "SELECT actor_id,action,outcome FROM audit_events WHERE organization_id='org-b' AND action='access.denied'",
      )
      .all();
    expect(rows).toEqual([{ actor_id: 'alice', action: 'access.denied', outcome: 'denied' }]);
    // The denial is invisible to the prober: nothing in A's audit view names B.
    const audit = await w.call('GET', '/api/audit', { as: 'alice' });
    expect(await audit.text()).not.toContain('org-b');
  });

  it('a non-member and a workspace that does not exist answer identically', async () => {
    const w = await world();
    const real = await w.call('GET', '/api/integrations?org=org-b', { as: 'alice' });
    const none = await w.call('GET', '/api/integrations?org=org-nonexistent', { as: 'alice' });
    expect(real.status).toBe(none.status);
    expect(await real.text()).toBe(await none.text());
  });
});
