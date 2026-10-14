import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import {
  DEFAULT_EVENT_TYPES,
  EVIDENCE_ROWS,
  FIRST_EVENT_SQL,
  STEP_IDS,
  VERIFIED_SQL,
  deriveProgress,
  isCustomized,
  type IntegrationEvidence,
  type SetupEvidence,
} from '../../src/api/setup-progress';
import { DEFAULT_EVENTS } from '../../web/src/integrations/events';
import type { Bindings } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
                session: { activeOrganizationId: null },
              }
            : null,
        );
      },
    },
    handler: () => new Response(null, { status: 404 }),
  }),
}));

const { default: worker } = await import('../../src/index');

const T = '2026-10-01 08:00:00';

const none: SetupEvidence = {
  githubConfigured: true,
  installation: null,
  otherSource: null,
  integration: null,
  focus: null,
  verified: null,
  verifiedAccepted: null,
  firstEvent: null,
};
const focus = (over: Partial<IntegrationEvidence> = {}): IntegrationEvidence => ({
  id: 'int-a',
  enabled: true,
  quarantined: false,
  customized: false,
  ...over,
});
const withIntegration: SetupEvidence = { ...none, installation: T, integration: T, focus: focus() };

describe('deriveProgress (pure, table-driven)', () => {
  const states = (e: SetupEvidence): string =>
    deriveProgress(e)
      .steps.map((s) => s.state)
      .join(',');

  const cases: {
    name: string;
    evidence: SetupEvidence;
    states: string;
    next: string | null;
    complete: boolean;
  }[] = [
    {
      name: 'a new workspace: GitHub is the step to do',
      evidence: none,
      states: 'done,doing,todo,todo,todo,todo,todo',
      next: 'github_connected',
      complete: false,
    },
    {
      name: 'GitHub connected: pick a repository',
      evidence: { ...none, installation: T },
      states: 'done,done,doing,todo,todo,todo,todo',
      next: 'repositories_selected',
      complete: false,
    },
    {
      name: 'an integration with default events: events are skipped, the test is next',
      evidence: withIntegration,
      states: 'done,done,done,done,skipped,doing,todo',
      next: 'test_delivered',
      complete: false,
    },
    {
      name: 'custom events count as chosen',
      evidence: { ...withIntegration, focus: focus({ customized: true }) },
      states: 'done,done,done,done,done,doing,todo',
      next: 'test_delivered',
      complete: false,
    },
    {
      name: 'tested but no real event yet: complete, with the optional last step still open',
      evidence: { ...withIntegration, verified: T },
      states: 'done,done,done,done,skipped,done,doing',
      next: 'activated',
      complete: true,
    },
    {
      name: 'everything done',
      evidence: { ...withIntegration, verified: T, firstEvent: T },
      states: 'done,done,done,done,skipped,done,done',
      next: null,
      complete: true,
    },
    {
      name: 'a generic source instead of GitHub skips the GitHub step',
      evidence: { ...withIntegration, installation: null, otherSource: T },
      states: 'done,skipped,done,done,skipped,doing,todo',
      next: 'test_delivered',
      complete: false,
    },
  ];

  it.each(cases)('$name', ({ evidence, states: expected, next, complete }) => {
    const p = deriveProgress(evidence);
    expect(p.steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(states(evidence)).toBe(expected);
    expect(p.next).toBe(next);
    expect(p.complete).toBe(complete);
    expect(p.version).toBe(2);
    // Exactly one step is `doing` unless the next step is blocked or nothing is left.
    expect(p.steps.filter((s) => s.state === 'doing').length).toBe(next === null ? 0 : 1);
  });

  it('an unconfigured GitHub App blocks the GitHub step with an honest reason, and the repository step too', () => {
    const p = deriveProgress({ ...none, githubConfigured: false });
    expect(p.steps[1]).toMatchObject({
      state: 'blocked',
      blockedBy: 'github_app_not_configured',
      nextAction: 'connect_github',
    });
    expect(p.steps[2]).toMatchObject({ state: 'blocked', blockedBy: 'github_not_connected' });
    expect(p.next).toBe('github_connected');
    expect(p.resume.step).toBe('github_connected');
  });

  it('a configured app with an existing installation is never blocked by configuration', () => {
    expect(deriveProgress({ ...none, githubConfigured: false, installation: T }).steps[1]?.state).toBe(
      'done',
    );
  });

  it('quarantined credentials block the destination and the test, and name the repair', () => {
    const p = deriveProgress({ ...withIntegration, focus: focus({ quarantined: true }) });
    expect(p.steps[3]).toMatchObject({
      state: 'blocked',
      blockedBy: 'credentials_quarantined',
      nextAction: 'repair_integration',
    });
    expect(p.steps[5]).toMatchObject({ state: 'blocked', blockedBy: 'credentials_quarantined' });
    expect(p.next).toBe('destination_connected');
  });

  it('a paused integration blocks the test with a resume action', () => {
    const p = deriveProgress({ ...withIntegration, focus: focus({ enabled: false }) });
    expect(p.steps[5]).toMatchObject({
      state: 'blocked',
      blockedBy: 'integration_paused',
      nextAction: 'resume_integration',
    });
  });

  it('accepted-only evidence is a done test that says it was not confirmed', () => {
    const p = deriveProgress({ ...withIntegration, verifiedAccepted: T });
    expect(p.steps[5]).toMatchObject({ state: 'done', verification: 'accepted' });
    expect(p.steps[5]?.since).toBe('2026-10-01T08:00:00.000Z');
    // Confirmed evidence wins over accepted.
    expect(deriveProgress({ ...withIntegration, verified: T, verifiedAccepted: T }).steps[5]).toMatchObject({
      verification: 'confirmed',
    });
  });

  it('resume names the newest integration and changes when the resume point does', () => {
    const a = deriveProgress(withIntegration).resume;
    expect(a).toMatchObject({ step: 'test_delivered', integrationId: 'int-a' });
    const b = deriveProgress({ ...withIntegration, verified: T }).resume;
    expect(b.point).not.toBe(a.point);
    expect(deriveProgress(none).resume.integrationId).toBeNull();
  });

  it('every unfinished step names a next action and a finished one names none', () => {
    for (const evidence of [none, withIntegration, { ...withIntegration, verified: T, firstEvent: T }])
      for (const step of deriveProgress(evidence).steps)
        expect(step.nextAction === 'none', `${step.id} ${step.state}`).toBe(
          step.state === 'done' || step.state === 'skipped',
        );
  });

  it('since is an ISO instant for a done step and null otherwise', () => {
    const p = deriveProgress({ ...none, installation: T });
    expect(p.steps[1]?.since).toBe('2026-10-01T08:00:00.000Z');
    expect(p.steps[2]?.since).toBeNull();
  });
});

describe('isCustomized and the quiet default', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'i',
    event_types: '["workflow_run.timed_out","workflow_run.failure"]',
    filters_json: null,
    noise_json: null,
    source_id: null,
    enabled: 1,
    quarantined_at: null,
    ...over,
  });
  it('the server default is the wizard default, so "skipped" means exactly "untouched"', () => {
    expect([...DEFAULT_EVENT_TYPES].sort()).toEqual([...DEFAULT_EVENTS].sort());
    expect(isCustomized(row())).toBe(false);
  });
  it.each([
    ['other events', { event_types: '["push"]' }],
    ['filters', { filters_json: '{}' }],
    ['noise settings', { noise_json: '{}' }],
    ['a generic source', { source_id: 's1' }],
    ['unreadable event types', { event_types: 'nope' }],
  ])('%s count as customised', (_name, over) => expect(isCustomized(row(over))).toBe(true));
});

let db: FakeD1;
let env: Bindings;

function seedUser(id: string, org: string): void {
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, `${id}@example.test`, 1, 1, 1);
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run(`${id}-${org}`, id, org, 'member', 1);
}

const GITHUB_APP = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_SLUG: 'lumi-noti-test',
  GITHUB_CLIENT_ID: 'client-test-id',
  GITHUB_CLIENT_SECRET: 'client-test-value',
};

async function progress(as = 'bob'): Promise<Response> {
  return worker.fetch(
    new Request('https://noti.test/api/setup/progress', { headers: as ? { 'x-test-user': as } : {} }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

interface Body {
  organizationId: string;
  version: number;
  steps: { id: string; state: string; verification: string | null; blockedBy: string | null }[];
  complete: boolean;
  next: string | null;
  nextAction: string;
  resume: { step: string; integrationId: string | null; point: string };
}

const body = async (): Promise<Body> => await (await progress()).json();
const state = (b: Body, id: string): string | undefined => b.steps.find((s) => s.id === id)?.state;
const done = (b: Body): string[] => b.steps.filter((s) => s.state === 'done').map((s) => s.id);

function installation(org: string, status: string): void {
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection,status)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(`gi-${org}-${status}`, org, `${org}-${status}`, '1', org, 'Organization', 'all', status);
}

function integration(
  id: string,
  org: string,
  eventTypes = '["workflow_run.failure","workflow_run.timed_out"]',
): void {
  db.raw
    .prepare(
      `INSERT INTO integrations(id,organization_id,repo,event_types,destination,webhook_ciphertext)
       VALUES(?,?,'acme/web',?,'slack','')`,
    )
    .run(id, org, eventTypes);
}

const nowSql = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');

function delivery(
  id: string,
  org: string,
  deliveryState: string,
  opts: { test?: boolean; createdAt?: string } = {},
): void {
  db.raw
    .prepare(
      'INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,is_test) VALUES(?,?,?,?,?,?)',
    )
    .run(id, 'int-a', org, deliveryState, opts.createdAt ?? nowSql(), opts.test ? 1 : 0);
}

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  seedUser('bob', 'org-a');
  seedUser('mallory', 'org-b');
  env = { ...BOOT_ENV, DB: db.d1, APP_ORIGIN: 'https://noti.test', ...GITHUB_APP } as unknown as Bindings;
});

describe('GET /api/setup/progress', () => {
  it('requires a session', async () => {
    expect((await progress('')).status).toBe(401);
  });

  it('an empty workspace has only the workspace done and GitHub next', async () => {
    const b = await body();
    expect(b.version).toBe(2);
    expect(done(b)).toEqual(['workspace_created']);
    expect(b.next).toBe('github_connected');
    expect(b.nextAction).toBe('connect_github');
    expect(b.resume).toMatchObject({ step: 'github_connected', integrationId: null });
  });

  it('without GitHub App credentials the GitHub step is blocked, honestly', async () => {
    env = { ...env, GITHUB_APP_ID: '' };
    const b = await body();
    expect(b.steps.find((s) => s.id === 'github_connected')).toMatchObject({
      state: 'blocked',
      blockedBy: 'github_app_not_configured',
    });
  });

  it('only an ACTIVE installation counts; a suspended one does not', async () => {
    installation('org-a', 'suspended');
    expect(state(await body(), 'github_connected')).toBe('doing');
    installation('org-a', 'active');
    expect(state(await body(), 'github_connected')).toBe('done');
  });

  it('a generic source skips the GitHub step; a disabled one does not', async () => {
    const source = (enabled: number) =>
      db.raw
        .prepare(
          `INSERT OR REPLACE INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version,enabled,created_by)
           VALUES('s1','org-a','generic','CI',?,x'0a',x'0b',x'0c',1,?,'bob')`,
        )
        .run('e'.repeat(24), enabled);
    source(0);
    expect(state(await body(), 'github_connected')).toBe('doing');
    source(1);
    expect(state(await body(), 'github_connected')).toBe('skipped');
  });

  it('an integration finishes the repository and destination steps; default events are skipped, not done', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    const b = await body();
    expect(done(b)).toEqual([
      'workspace_created',
      'github_connected',
      'repositories_selected',
      'destination_connected',
    ]);
    expect(state(b, 'events_chosen')).toBe('skipped');
    expect(b.next).toBe('test_delivered');
    expect(b.resume).toMatchObject({ step: 'test_delivered', integrationId: 'int-a' });
  });

  it('changed events make the events step done', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a', '["push"]');
    expect(state(await body(), 'events_chosen')).toBe('done');
  });

  it('resume points at the newest integration', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    db.raw.prepare("UPDATE integrations SET created_at='2026-01-01 00:00:00'").run();
    integration('int-z', 'org-a');
    db.raw.prepare("UPDATE integrations SET created_at='2026-09-01 00:00:00' WHERE id='int-z'").run();
    expect((await body()).resume.integrationId).toBe('int-z');
  });

  it('a test delivery verifies the destination but is NOT a real event', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    delivery('t1', 'org-a', 'sent', { test: true });
    const b = await body();
    expect(state(b, 'test_delivered')).toBe('done');
    expect(b.steps.find((s) => s.id === 'test_delivered')?.verification).toBe('confirmed');
    expect(state(b, 'activated')).toBe('doing');
    expect(b.complete).toBe(true);
  });

  it('failed, retrying and pending verify nothing; accepted is reported as accepted', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    delivery('f1', 'org-a', 'dead_lettered', { test: true });
    delivery('f2', 'org-a', 'retrying', { test: true });
    delivery('f3', 'org-a', 'pending', { test: true });
    expect(state(await body(), 'test_delivered')).toBe('doing');
    delivery('a1', 'org-a', 'accepted', { test: true });
    const b = await body();
    expect(state(b, 'test_delivered')).toBe('done');
    expect(b.steps.find((s) => s.id === 'test_delivered')?.verification).toBe('accepted');
  });

  it('a delivery older than 30 days does not verify, but a real one still proves the source', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    delivery('old', 'org-a', 'sent', { createdAt: '2020-01-01 00:00:00' });
    const b = await body();
    expect(state(b, 'test_delivered')).toBe('doing');
    expect(state(b, 'activated')).toBe('done');
  });

  it('a real event in any state (even failed) proves the source reached us', async () => {
    integration('int-a', 'org-a');
    delivery('r1', 'org-a', 'dead_lettered');
    expect(state(await body(), 'activated')).toBe('done');
  });

  it('everything done is complete with nothing next', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    delivery('r1', 'org-a', 'sent');
    const b = await body();
    expect(b.complete).toBe(true);
    expect(b.next).toBeNull();
    expect(b.resume.step).toBe('activated');
  });

  it('quarantined credentials block the destination step and name the repair', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    db.raw.prepare("UPDATE integrations SET credentials_quarantined_at='2026-10-01 00:00:00'").run();
    const b = await body();
    expect(b.steps.find((s) => s.id === 'destination_connected')).toMatchObject({
      state: 'blocked',
      blockedBy: 'credentials_quarantined',
    });
    expect(b.nextAction).toBe('repair_integration');
  });

  it('a delivery to a since-deleted or paused integration verifies nothing', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    delivery('s1', 'org-a', 'sent');
    expect(state(await body(), 'test_delivered')).toBe('done');
    db.raw.prepare("UPDATE integrations SET enabled=0 WHERE id='int-a'").run();
    const paused = await body();
    expect(paused.steps.find((s) => s.id === 'test_delivered')).toMatchObject({
      state: 'blocked',
      blockedBy: 'integration_paused',
    });
    db.raw.prepare("DELETE FROM integrations WHERE id='int-a'").run();
    expect(state(await body(), 'test_delivered')).not.toBe('done');
  });

  it('never counts another workspace’s rows', async () => {
    installation('org-b', 'active');
    integration('int-b', 'org-b');
    delivery('x1', 'org-b', 'sent');
    const b = await body();
    expect(b.organizationId).toBe('org-a');
    expect(done(b)).toEqual(['workspace_created']);
    expect(b.resume.integrationId).toBeNull();
  });

  it('test evidence belongs to the newest integration: an older working one proves nothing', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    db.raw.prepare("UPDATE integrations SET created_at='2026-01-01 00:00:00' WHERE id='int-a'").run();
    delivery('s1', 'org-a', 'sent', { test: true });
    expect(state(await body(), 'test_delivered')).toBe('done');
    // A new integration B, never tested.
    integration('int-b', 'org-a');
    db.raw.prepare("UPDATE integrations SET created_at='2026-09-01 00:00:00' WHERE id='int-b'").run();
    const b = await body();
    expect(b.resume.integrationId).toBe('int-b');
    expect(state(b, 'test_delivered')).toBe('doing');
    // Testing B (deliveries carry the integration id) completes it.
    db.raw
      .prepare(
        'INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,is_test) VALUES(?,?,?,?,?,1)',
      )
      .run('s2', 'int-b', 'org-a', 'sent', nowSql());
    expect(state(await body(), 'test_delivered')).toBe('done');
  });

  it('same-second integrations: the later insert is the focus, deterministically', async () => {
    installation('org-a', 'active');
    for (const id of ['int-z', 'int-a', 'int-m']) {
      integration(id, 'org-a');
      db.raw.prepare("UPDATE integrations SET created_at='2026-09-01 00:00:00' WHERE id=?").run(id);
    }
    expect((await body()).resume.integrationId).toBe('int-m');
  });

  it('a confirmed delivery wins over an accepted one in the single evidence query', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    delivery('a1', 'org-a', 'accepted', { test: true });
    delivery('s1', 'org-a', 'sent', { test: true });
    const b = await body();
    expect(b.steps.find((x) => x.id === 'test_delivered')?.verification).toBe('confirmed');
  });

  it('evidence reads are bounded: a miss reads as few rows as a hit', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    for (const [sql, args] of [
      [VERIFIED_SQL, ['org-a', '2026-01-01 00:00:00', 'int-a']],
      [FIRST_EVENT_SQL, ['org-a', '1970-01-01 00:00:00']],
    ] as const) {
      expect(sql).toMatch(new RegExp(`LIMIT ${EVIDENCE_ROWS}`));
      const rows = await db.d1
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...args)
        .all<{ detail: string }>();
      const plan = rows.results.map((r) => r.detail).join('\n');
      expect(plan).toContain('deliveries_org_created');
      expect(plan).not.toMatch(/SCAN d(eliveries)?(?! USING)\b/);
    }
  });

  it('with more than EVIDENCE_ROWS test deliveries ahead, a real event is not found (documented bound)', async () => {
    installation('org-a', 'active');
    integration('int-a', 'org-a');
    const insert = db.raw.prepare(
      'INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,is_test) VALUES(?,?,?,?,?,?)',
    );
    for (let i = 0; i < EVIDENCE_ROWS; i += 1)
      insert.run(
        `t${i}`,
        'int-a',
        'org-a',
        'sent',
        `2026-09-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
        1,
      );
    insert.run('real', 'int-a', 'org-a', 'sent', '2026-09-02 00:00:00', 0);
    expect(state(await body(), 'activated')).not.toBe('done');
  });

  it('every evidence query is index-driven: EXPLAIN QUERY PLAN names deliveries_org_created and no full scan of deliveries', async () => {
    for (const [sql, args] of [
      [VERIFIED_SQL, ['org-a', '2026-01-01 00:00:00', 'int-a']],
      [FIRST_EVENT_SQL, ['org-a', '1970-01-01 00:00:00']],
    ] as const) {
      const rows = await db.d1
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...args)
        .all<{ detail: string }>();
      const plan = rows.results.map((r) => r.detail).join('\n');
      expect(plan).toContain('deliveries_org_created');
      expect(plan).not.toMatch(/SCAN d(eliveries)?(?! USING)\b/);
    }
  });
});
