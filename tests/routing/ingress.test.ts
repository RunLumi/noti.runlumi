import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { purgeDueWorkspace } from '../../src/pipeline/purge';
import { parseFilters, serializeFilters } from '../../src/routing/filter-input';
import { purgeRoutingDecisions, ROUTING_RETENTION_MS } from '../../src/routing/provenance';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * Routing filters at ingress, end to end over the real migrations: a signed webhook is
 * verified, the tenant is resolved from the installation, and each subscribed integration
 * either gets a delivery or a recorded suppression reason (ADR 0010).
 */
const HMAC_FIXTURE = ['test', 'fixture', 'hmac'].join('-');
const APP_ID = '777';

let db: FakeD1;
let sent: DeliveryMessage[];
let env: Bindings;

beforeEach(() => {
  db = createFakeD1();
  sent = [];
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  installation('org-a', '1001');
  installation('org-b', '1002');
  env = {
    DB: db.d1,
    DELIVERY_QUEUE: {
      send: (m: DeliveryMessage) => {
        sent.push(m);
        return Promise.resolve();
      },
    } as unknown as Queue<DeliveryMessage>,
    GITHUB_WEBHOOK_SECRET: HMAC_FIXTURE,
    GITHUB_APP_ID: APP_ID,
    ENCRYPTION_KEY: '',
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
  } as unknown as Bindings;
});

function installation(org: string, installationId: string): void {
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection,status)
       VALUES(?,?,?,?,?,?,?,'active')`,
    )
    .run(`gi-${installationId}`, org, installationId, APP_ID, org, 'Organization', 'all');
}

function integration(
  id: string,
  org: string,
  filters: unknown,
  eventTypes: string[] = ['push', 'pull_request.opened', 'issues.opened', 'workflow_run.failure'],
  raw?: string,
): void {
  const parsed = parseFilters(filters);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,filters_json)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, 'acme/web', JSON.stringify(eventTypes), 'slack', '', org, raw ?? serializeFilters(parsed.value));
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(HMAC_FIXTURE),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function post(
  kind: string,
  event: Record<string, unknown>,
  deliveryId = 'gh-1',
): Promise<{ status: number; persisted?: number }> {
  const body = JSON.stringify({
    installation: { id: 1001, app_id: Number(APP_ID) },
    repository: { full_name: 'acme/web', html_url: 'https://github.com/acme/web' },
    ...event,
  });
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request('https://noti.test/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': await sign(body),
        'x-github-event': kind,
        'x-github-delivery': deliveryId,
      },
    }),
    env,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
  const json = (await res.json().catch(() => ({}))) as { persisted?: number };
  return { status: res.status, ...(json.persisted !== undefined ? { persisted: json.persisted } : {}) };
}

const push = (branch: string, login = 'octocat', type = 'User') => ({
  ref: `refs/heads/${branch}`,
  sender: { login, type },
});

const pullRequest = (over: {
  draft?: boolean;
  head?: string;
  base?: string;
  login?: string;
  type?: string;
  labels?: string[];
}) => ({
  action: 'opened',
  sender: { login: over.login ?? 'octocat', type: over.type ?? 'User' },
  pull_request: {
    title: 'Add thing',
    html_url: 'https://github.com/acme/web/pull/1',
    draft: over.draft ?? false,
    head: { ref: over.head ?? 'feat/x' },
    base: { ref: over.base ?? 'main' },
    labels: (over.labels ?? []).map((name) => ({ name })),
  },
});

interface Decision {
  id: string;
  organization_id: string;
  integration_id: string;
  event_type: string;
  outcome: string;
  filter_id: string | null;
  reason: string;
  unknown_fact: number;
}
const decisions = (): Decision[] =>
  db.raw
    .prepare('SELECT * FROM routing_decisions ORDER BY integration_id, rowid')
    .all() as unknown as Decision[];
const deliveryCount = (integrationId: string): number =>
  (
    db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE integration_id=?').get(integrationId) as {
      n: number;
    }
  ).n;

describe('ingress routing filters', () => {
  it('an integration without filters is delivered and the decision says so', async () => {
    integration('i1', 'org-a', null);
    expect((await post('push', push('anything'))).persisted).toBe(1);
    expect(deliveryCount('i1')).toBe(1);
    expect(decisions()).toMatchObject([
      {
        integration_id: 'i1',
        outcome: 'delivered',
        reason: 'no_filters',
        filter_id: null,
        organization_id: 'org-a',
      },
    ]);
    expect(sent).toHaveLength(1);
  });

  it('a branch allow-list holds back other branches and records which filter did it', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } });
    expect((await post('push', push('dev'), 'gh-dev')).persisted).toBe(0);
    expect(deliveryCount('i1')).toBe(0);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()).toEqual({ n: 0 });
    expect(sent).toHaveLength(0);
    expect((await post('push', push('main'), 'gh-main')).persisted).toBe(1);
    expect(decisions().map((d) => [d.outcome, d.filter_id, d.reason])).toEqual([
      ['filtered', 'branch', 'not_in_allow_list'],
      ['delivered', null, 'allowed'],
    ]);
  });

  it('answers per integration: one delivers and one is filtered for the same event', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } });
    integration('i2', 'org-a', { branch: { deny: ['main'] } });
    expect((await post('push', push('main'))).persisted).toBe(1);
    expect(deliveryCount('i1')).toBe(1);
    expect(deliveryCount('i2')).toBe(0);
    expect(decisions().map((d) => [d.integration_id, d.outcome, d.reason])).toEqual([
      ['i1', 'delivered', 'allowed'],
      ['i2', 'filtered', 'in_deny_list'],
    ]);
  });

  it('draft pull requests and bots are filtered; a ready human PR is delivered', async () => {
    integration('i1', 'org-a', { draft: 'exclude', actor: { bots: 'exclude' } });
    await post('pull_request', pullRequest({ draft: true }), 'a');
    await post('pull_request', pullRequest({ login: 'dependabot[bot]', type: 'Bot' }), 'b');
    await post('pull_request', pullRequest({}), 'c');
    expect(decisions().map((d) => [d.outcome, d.filter_id, d.reason])).toEqual([
      ['filtered', 'draft', 'draft_excluded'],
      ['filtered', 'actor', 'bot_excluded'],
      ['delivered', null, 'allowed'],
    ]);
    expect(deliveryCount('i1')).toBe(1);
  });

  it('base-branch and label filters read the pull request', async () => {
    integration('i1', 'org-a', { baseBranch: { allow: ['main'] }, labels: { include: ['release'] } });
    await post('pull_request', pullRequest({ base: 'dev', labels: ['release'] }), 'a');
    await post('pull_request', pullRequest({ base: 'main', labels: ['docs'] }), 'b');
    await post('pull_request', pullRequest({ base: 'main', labels: ['Release'] }), 'c');
    expect(decisions().map((d) => [d.outcome, d.filter_id])).toEqual([
      ['filtered', 'baseBranch'],
      ['filtered', 'labels'],
      ['delivered', null],
    ]);
  });

  it('a workflow run is filtered by head branch', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } });
    const run = (head: string) => ({
      action: 'completed',
      sender: { login: 'octocat', type: 'User' },
      workflow_run: {
        name: 'CI',
        conclusion: 'failure',
        head_branch: head,
        html_url: 'https://github.com/acme/web/actions/runs/1',
      },
    });
    await post('workflow_run', run('feature/x'), 'a');
    await post('workflow_run', run('main'), 'b');
    expect(decisions().map((d) => [d.event_type, d.outcome])).toEqual([
      ['workflow_run.failure', 'filtered'],
      ['workflow_run.failure', 'delivered'],
    ]);
  });

  it('flags an unknown fact instead of hiding it', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } });
    // A tag push carries no branch, so an allow-list cannot say yes, and says so.
    await post('push', { ref: 'refs/tags/v1', sender: { login: 'octocat', type: 'User' } });
    expect(decisions()).toMatchObject([{ outcome: 'filtered', reason: 'field_unknown', unknown_fact: 1 }]);
  });

  it('only integrations subscribed to the event type are considered', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } }, ['issues.opened']);
    await post('push', push('dev'));
    expect(decisions()).toEqual([]);
  });

  it('does not consider disabled integrations', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } });
    db.raw.prepare("UPDATE integrations SET enabled=0 WHERE id='i1'").run();
    await post('push', push('dev'));
    expect(decisions()).toEqual([]);
  });

  it('fails open, with a recorded reason, when stored filters no longer validate', async () => {
    integration('i1', 'org-a', null, undefined, '{"v":99,"branch":{"allow":["main"]}}');
    expect((await post('push', push('dev'))).persisted).toBe(1);
    expect(decisions()).toMatchObject([{ outcome: 'delivered', reason: 'config_invalid' }]);
  });

  it('keeps tenants apart: another workspace never sees or influences a decision', async () => {
    integration('a1', 'org-a', { branch: { allow: ['main'] } });
    integration('b1', 'org-b', { branch: { deny: ['dev'] } }); // same repo name, other tenant
    await post('push', push('dev'));
    expect(decisions().map((d) => [d.organization_id, d.integration_id, d.outcome])).toEqual([
      ['org-a', 'a1', 'filtered'],
    ]);
    expect(deliveryCount('b1')).toBe(0);
  });

  it('records no payload content: ids, event type and a code only', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] }, actor: { deny: ['mallory'] } });
    await post('push', push('very-secret-branch-name', 'mallory'));
    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM routing_decisions').all());
    expect(dump).not.toContain('very-secret-branch-name');
    expect(dump).not.toContain('mallory');
    expect(dump).not.toContain('main');
  });

  it('a provider redelivery never duplicates a decision', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } });
    await post('push', push('dev'), 'same');
    await post('push', push('dev'), 'same');
    expect(decisions()).toHaveLength(1);
  });

  it('a redelivery after a filter edit corrects "filtered" to "delivered", never the reverse', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } });
    await post('push', push('dev'), 'same');
    expect(decisions()[0]?.outcome).toBe('filtered');
    db.raw.prepare("UPDATE integrations SET filters_json=NULL WHERE id='i1'").run();
    await post('push', push('dev'), 'same');
    expect(decisions()).toMatchObject([{ outcome: 'delivered', filter_id: null }]);
    db.raw
      .prepare("UPDATE integrations SET filters_json=? WHERE id='i1'")
      .run(serializeFilters({ branch: { allow: ['main'], deny: [] } }));
    await post('push', push('dev'), 'same');
    expect(decisions()).toMatchObject([{ outcome: 'delivered' }]);
  });

  it('an event suppressed everywhere is still acknowledged with 202', async () => {
    integration('i1', 'org-a', { branch: { allow: ['main'] } });
    const res = await post('push', push('dev'));
    expect(res).toEqual({ status: 202, persisted: 0 });
  });
});

describe('routing decision lifecycle', () => {
  const insert = (id: string, org: string, at: number) =>
    db.raw
      .prepare(
        `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,reason,decided_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(id, org, 'i1', 'push', 'delivered', 'allowed', at);

  it('retention removes only decisions past the window', async () => {
    const now = Date.now();
    insert('old', 'org-a', now - ROUTING_RETENTION_MS - 1000);
    insert('new', 'org-a', now - 1000);
    expect(await purgeRoutingDecisions(db.d1, now)).toBe(1);
    expect(db.raw.prepare('SELECT id FROM routing_decisions').all()).toEqual([{ id: 'new' }]);
  });

  it('a purged workspace takes its decisions with it and leaves other tenants alone', async () => {
    insert('a', 'org-a', Date.now());
    insert('b', 'org-b', Date.now());
    db.raw
      .prepare('INSERT INTO workspace_deletions(organization_id,requested_by,purge_after) VALUES(?,?,?)')
      .run('org-a', 'u', 1);
    let report = await purgeDueWorkspace(db.d1, Date.now());
    while (!report.completed && report.organizationId) report = await purgeDueWorkspace(db.d1, Date.now());
    expect(db.raw.prepare('SELECT id FROM routing_decisions').all()).toEqual([{ id: 'b' }]);
  });

  it('the schema refuses a filtered decision with no filter id and an outcome outside the vocabulary', () => {
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,reason,decided_at)
           VALUES('x','org-a','i','push','filtered','r',1)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,reason,decided_at)
           VALUES('y','org-a','i','push','maybe','r',1)`,
        )
        .run(),
    ).toThrow();
  });
});
