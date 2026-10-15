import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMPACT_COUNT_CAP } from '../../src/delivery/impact';
import { SLACK, caller, setup, type Harness } from '../sources/harness';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

/**
 * `GET /api/integrations/:id/impact` (F217, ADR 0050) over the real migrations and the real Worker:
 * the counts the pause and delete confirmations show, their tenant scope, their bound, and that
 * they describe what the pause and the delete really do to the rows.
 */
let h: Harness;
const call = caller(worker, () => h);

interface Impact {
  deliveries: Record<'total' | 'unsent' | 'sending', { count: number; capped: boolean }>;
  held: { waiting: number; failed: number };
}

function githubInstallation(org: string, installationId: string): void {
  h.db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(`gi-${installationId}`, org, installationId, '1', 'acme', 'Organization', 'all');
}

async function create(as: string, repo = 'acme/web'): Promise<string> {
  const res = await call('POST', '/api/integrations', {
    as,
    body: { name: 'Alerts', repo, eventTypes: ['issues.opened'], destination: 'slack', webhookUrl: SLACK },
  });
  expect(res.status).toBe(201);
  return (await res.json<{ integration: { id: string } }>()).integration.id;
}

function deliveries(org: string, integration: string, state: string, n: number, prefix = state): void {
  const insert = h.db.raw.prepare(
    'INSERT INTO deliveries(id,integration_id,organization_id,state,attempts,created_at,updated_at) VALUES(?,?,?,?,0,?,?)',
  );
  for (let i = 0; i < n; i++)
    insert.run(
      `${prefix}-${integration}-${i}`,
      integration,
      org,
      state,
      '2026-10-15 08:00:00',
      '2026-10-15 08:00:00',
    );
}

function held(org: string, integration: string, state: 'held' | 'failed', n: number): void {
  const insert = h.db.raw.prepare(
    `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
     VALUES(?,?,?,'quiet_hours',?,?,?,1,'issues.opened','t','','','','info','')`,
  );
  for (let i = 0; i < n; i++)
    insert.run(
      `${state}-${integration}-${i}`,
      org,
      integration,
      'k'.repeat(32),
      state,
      Date.now() + 3_600_000,
    );
}

const impactOf = async (id: string, as = 'alice'): Promise<Response> =>
  call('GET', `/api/integrations/${id}/impact`, { as });

const count = (sql: string, ...args: string[]): number =>
  (h.db.raw.prepare(sql).get(...args) as { n: number }).n;

beforeEach(() => {
  h = setup();
  githubInstallation('org-a', '1001');
  githubInstallation('org-b', '1002');
});
afterEach(() => vi.unstubAllGlobals());

describe('impact counts', () => {
  it('counts unsent, sending, all deliveries and held updates of this integration only', async () => {
    const id = await create('alice');
    const other = await create('alice', 'acme/api');
    deliveries('org-a', id, 'pending', 2);
    deliveries('org-a', id, 'retrying', 3);
    deliveries('org-a', id, 'claimed', 1);
    deliveries('org-a', id, 'sent', 4);
    deliveries('org-a', id, 'dead_lettered', 1);
    deliveries('org-a', other, 'pending', 7);
    held('org-a', id, 'held', 2);
    held('org-a', id, 'failed', 1);
    held('org-a', other, 'held', 5);

    const res = await impactOf(id);
    expect(res.status).toBe(200);
    const { impact } = await res.json<{ impact: Impact }>();
    expect(impact).toEqual({
      deliveries: {
        total: { count: 11, capped: false },
        unsent: { count: 5, capped: false },
        sending: { count: 1, capped: false },
      },
      held: { waiting: 2, failed: 1 },
    });
  });

  it('is zero, not an error, for an integration with no history', async () => {
    const id = await create('alice');
    const { impact } = await (await impactOf(id)).json<{ impact: Impact }>();
    expect(impact.deliveries.total).toEqual({ count: 0, capped: false });
    expect(impact.held).toEqual({ waiting: 0, failed: 0 });
  });

  it('stops counting at the cap and says so', async () => {
    const id = await create('alice');
    deliveries('org-a', id, 'sent', IMPACT_COUNT_CAP + 5);
    deliveries('org-a', id, 'pending', 3);
    const { impact } = await (await impactOf(id)).json<{ impact: Impact }>();
    expect(impact.deliveries.total).toEqual({ count: IMPACT_COUNT_CAP, capped: true });
    // The unsent count is its own bounded range, not a slice of the capped total.
    expect(impact.deliveries.unsent).toEqual({ count: 3, capped: false });
  });

  it('is readable by a member, since the same rows are in the activity log', async () => {
    const id = await create('alice');
    deliveries('org-a', id, 'pending', 1);
    const res = await impactOf(id, 'bob');
    expect(res.status).toBe(200);
  });
});

describe('tenant scope', () => {
  it('refuses another workspace with 404 and no counts, by session or by naming the workspace', async () => {
    const id = await create('alice');
    deliveries('org-a', id, 'pending', 2);
    held('org-a', id, 'held', 1);
    for (const path of [`/api/integrations/${id}/impact`, `/api/integrations/${id}/impact?org=org-a`]) {
      const res = await call('GET', path, { as: 'mallory' });
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain('"impact"');
      expect(body).not.toContain('count');
    }
  });

  it('never counts rows another workspace holds under the same integration id', async () => {
    const id = await create('alice');
    deliveries('org-a', id, 'pending', 1);
    // A foreign row that names this integration id: the organization predicate must exclude it.
    deliveries('org-b', id, 'pending', 4, 'foreign');
    held('org-b', id, 'held', 3);
    const { impact } = await (await impactOf(id)).json<{ impact: Impact }>();
    expect(impact.deliveries.unsent.count).toBe(1);
    expect(impact.deliveries.total.count).toBe(1);
    expect(impact.held.waiting).toBe(0);
  });

  it('requires a session', async () => {
    const id = await create('alice');
    expect((await call('GET', `/api/integrations/${id}/impact`)).status).toBe(401);
  });
});

describe('the counts describe what pause and delete really do', () => {
  it('a pause keeps every delivery and every held update', async () => {
    const id = await create('alice');
    deliveries('org-a', id, 'pending', 2);
    deliveries('org-a', id, 'sent', 3);
    held('org-a', id, 'held', 2);
    const res = await call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { enabled: false } });
    expect(res.status).toBe(200);
    const { impact } = await (await impactOf(id)).json<{ impact: Impact }>();
    expect(impact.deliveries.total.count).toBe(5);
    expect(impact.held.waiting).toBe(2);
  });

  it('a delete removes the held updates and keeps the delivery rows', async () => {
    const id = await create('alice');
    deliveries('org-a', id, 'pending', 2);
    deliveries('org-a', id, 'sent', 3);
    held('org-a', id, 'held', 2);
    held('org-a', id, 'failed', 1);
    expect((await call('DELETE', `/api/integrations/${id}`, { as: 'alice' })).status).toBe(204);
    expect(count('SELECT COUNT(*) AS n FROM held_events WHERE integration_id=?', id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM deliveries WHERE integration_id=?', id)).toBe(5);
    // And once deleted, the integration has no impact to report.
    expect((await impactOf(id)).status).toBe(404);
  });
});
