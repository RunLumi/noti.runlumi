import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_INTEGRATIONS_PER_WORKSPACE } from '../../src/api/integrations';
import { MAX_REPOSITORY_DELTA } from '../../src/connectors/sources/github/lifecycle';
import { MAX_BODY_BYTES } from '../../src/connectors/sources/github/route';
import { createRig, ORG, type Rig } from '../conformance/rig';
import { loadFixtureJson, loadManifest, type FixtureEntry } from '../fixtures/load';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * F64 ack budget. GitHub expects a 2xx within 10 seconds and otherwise "terminates the connection and
 * considers the delivery a failure"; the repository records this in docs/specs/05-source-github.md F64
 * (asserted below, so the citation cannot silently go stale). A wall-clock assertion against a fake D1
 * would prove nothing about production, so the budget is held structurally instead, for every GitHub
 * fixture in the manifest:
 *
 *  - no outbound network call before the response, and a network that never answers cannot delay it;
 *  - no timer is waited on, except D1's own bounded write retry, whose total wait is bounded here;
 *  - the D1 work does not grow with what the sender controls (payload size, label count, commit count),
 *    only with the workspace's own integrations, which the API caps; and an oversize repository delta
 *    in a lifecycle event is refused into a bounded, fail-closed write.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const github = loadManifest().filter((m) => m.provider === 'github');
const entry = (id: string): FixtureEntry => {
  const e = github.find((m) => m.id === id);
  if (!e) throw new Error(id);
  return e;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Count every statement the request prepares (each `.first/.all/.run` or batch member is one). */
function counting(rig: Rig): { statements: () => number } {
  let n = 0;
  const real = rig.h.env.DB;
  rig.h.env = {
    ...rig.h.env,
    DB: new Proxy(real, {
      get: (target, prop, receiver) => {
        if (prop === 'prepare')
          return (sql: string) => {
            n++;
            return target.prepare(sql);
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
  return { statements: () => n };
}

describe('the recorded budget', () => {
  it('docs/specs/05-source-github.md F64 records GitHub’s 10-second window', () => {
    const spec = readFileSync(join(root, 'docs', 'specs', '05-source-github.md'), 'utf8');
    const f64 = spec.slice(spec.indexOf('## F64'), spec.indexOf('## F65'));
    expect(f64).toContain('should respond with a 2XX response within 10 seconds');
    expect(f64).toContain('terminates the connection and considers the delivery a failure');
  });
});

describe.each(github.map((e) => [e.id, e] as const))('%s', (_id, e) => {
  it('acknowledges without any outbound call or timer, even when the network never answers', async () => {
    const rig = await createRig('github', worker);
    // A network that hangs forever: if ingress awaited any fetch, this request would never return.
    rig.h.fetchMock.mockReturnValue(new Promise<Response>(() => undefined));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const res = await rig.post(rig.encode(loadFixtureJson(e)), { headers: e.headers });
    const fetchesBeforeAck = rig.h.fetchMock.mock.calls.length;
    const timersBeforeAck = timers.mock.calls.length;
    expect(res.status, e.id).toBeLessThan(500);
    expect(fetchesBeforeAck, e.id).toBe(0);
    expect(timersBeforeAck, e.id).toBe(0);
    // The only background work is the dispatcher hint, after the durable write, and only for a delivery.
    expect(rig.h.waitUntil.mock.calls.length, e.id).toBeLessThanOrEqual(e.expect === 'delivered' ? 1 : 0);
  });
});

describe('D1 work is bounded by the workspace, not by the payload', () => {
  const pr = entry('github/pull_request.opened');
  const push = entry('github/push.new_branch');

  async function statementsFor(e: FixtureEntry, json: Record<string, unknown>): Promise<number> {
    const rig = await createRig('github', worker);
    const meter = counting(rig);
    const res = await rig.post(rig.encode(json), { headers: e.headers });
    expect(res.status).toBe(202);
    return meter.statements();
  }

  it('a pull request with 1,000 labels and a body near the 1 MiB cap costs what the plain one costs', async () => {
    const json = loadFixtureJson(pr) as { pull_request: Record<string, unknown> };
    const plain = await statementsFor(pr, json);
    const label = (json.pull_request.labels as Record<string, unknown>[])[0] ?? {};
    // The documented label stays first, so every integration routes exactly as for the plain event.
    const labels = [
      label,
      ...Array.from({ length: 999 }, (_, i) => ({ ...label, id: i + 1, name: `label-${i}` })),
    ];
    const base = JSON.stringify({ ...json, pull_request: { ...json.pull_request, labels } }).length;
    const body = 'x'.repeat(MAX_BODY_BYTES - base - 1000);
    const heavy = { ...json, pull_request: { ...json.pull_request, labels, body } };
    expect(JSON.stringify(heavy).length).toBeGreaterThan(MAX_BODY_BYTES * 0.9);
    expect(await statementsFor(pr, heavy)).toBe(plain);
  });

  it('a push with 2,000 commits costs what a push with one costs', async () => {
    const json = loadFixtureJson(push) as { commits: Record<string, unknown>[] };
    const one = await statementsFor(push, json);
    const commit = json.commits[0] ?? {};
    const many = { ...json, commits: Array.from({ length: 2000 }, (_, i) => ({ ...commit, id: `c${i}` })) };
    expect(await statementsFor(push, many)).toBe(one);
  });

  it('grows only per matching integration, and the workspace cap bounds that', async () => {
    const rig = await createRig('github', worker);
    const six = Object.keys(rig.integrations).length;
    let meter = counting(rig);
    await rig.post(rig.encode(loadFixtureJson(pr)), { headers: pr.headers });
    const base = meter.statements();
    // Up to the API's cap, all on the same repository and subscribed to everything.
    const types = rig.h.db.raw.prepare('SELECT event_types FROM integrations LIMIT 1').get() as {
      event_types: string;
    };
    for (let i = six; i < MAX_INTEGRATIONS_PER_WORKSPACE; i++)
      rig.h.db.raw
        .prepare(
          `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(`int-bulk-${i}`, 'Codertocat/Hello-World', types.event_types, 'slack', '', ORG);
    meter = counting(rig);
    const res = await rig.post(rig.encode(loadFixtureJson(pr)), { headers: pr.headers });
    expect(res.status).toBe(202);
    const perIntegration = (meter.statements() - base) / (MAX_INTEGRATIONS_PER_WORKSPACE - six);
    // A small constant per integration (the delivery transaction plus provenance), never a payload term.
    expect(perIntegration).toBeGreaterThan(0);
    expect(perIntegration).toBeLessThanOrEqual(10);
  });

  it('a failing D1 is given up on after a bounded wait, far inside the window, and answered 5xx', async () => {
    const rig = await createRig('github', worker);
    const real = rig.h.env.DB;
    rig.h.env = {
      ...rig.h.env,
      DB: new Proxy(real, {
        get: (target, prop, receiver) =>
          prop === 'batch'
            ? () => Promise.reject(new Error('D1_ERROR: Network connection lost.'))
            : (Reflect.get(target, prop, receiver) as unknown),
      }),
    };
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await rig.post(rig.encode(loadFixtureJson(pr)), { headers: pr.headers });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // ingressBatch: 3 attempts, full-jitter backoff below 100 ms then 200 ms (src/db/retry.ts).
    expect(waits.length).toBeLessThanOrEqual(2);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(300);
    expect(rig.count('deliveries')).toBe(0);
  });
});

describe('an oversize repository delta (installation_repositories) stays bounded and fails closed', () => {
  const added = entry('github/installation_repositories.added');

  function delta(count: number): Record<string, unknown> {
    const json = loadFixtureJson(added) as { repositories_added: Record<string, unknown>[] };
    const repo = json.repositories_added[0] ?? {};
    return {
      ...json,
      repositories_added: Array.from({ length: count }, (_, i) => ({
        ...repo,
        id: 900_000 + i,
        name: `r${i}`,
        full_name: `Codertocat/r${i}`,
      })),
    };
  }

  async function selectedRig(): Promise<Rig> {
    const rig = await createRig('github', worker);
    rig.h.db.raw
      .prepare("UPDATE github_installations SET repository_selection='selected' WHERE id='gi-1'")
      .run();
    rig.h.db.raw
      .prepare(
        "INSERT INTO github_installation_repositories(installation_row_id,repository_id,full_name) VALUES('gi-1','1296269','Codertocat/Hello-World')",
      )
      .run();
    return rig;
  }

  it(`stores a delta of ${MAX_REPOSITORY_DELTA} repositories inside the per-invocation query budget`, async () => {
    const rig = await selectedRig();
    const meter = counting(rig);
    const res = await rig.post(rig.encode(delta(MAX_REPOSITORY_DELTA)), { headers: added.headers });
    expect(res.status).toBe(202);
    expect(rig.count('github_installation_repositories')).toBe(MAX_REPOSITORY_DELTA + 1);
    // docs/specs/01-platform-runtime.md: 50 D1 queries per invocation on the Free plan.
    expect(meter.statements()).toBeLessThan(50);
  });

  it('one more is not stored piecemeal: the set is cleared, a reconnect is asked for, and nothing routes', async () => {
    const rig = await selectedRig();
    const meter = counting(rig);
    const res = await rig.post(rig.encode(delta(MAX_REPOSITORY_DELTA + 1)), { headers: added.headers });
    expect(res.status).toBe(202);
    expect(meter.statements()).toBeLessThan(10);
    expect(rig.count('github_installation_repositories')).toBe(0);
    const row = rig.h.db.raw
      .prepare("SELECT repository_selection,repositories_complete FROM github_installations WHERE id='gi-1'")
      .get() as { repository_selection: string; repositories_complete: number };
    expect(row).toEqual({ repository_selection: 'selected', repositories_complete: 0 });
    const audit = rig.h.db.raw
      .prepare("SELECT metadata_json FROM audit_events WHERE action='github.installation.lifecycle'")
      .get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ action: 'added', overflow: true });
    // Fail closed: a repository that was in the old set no longer routes until the reconnect.
    const pr = entry('github/pull_request.opened');
    expect((await rig.post(rig.encode(loadFixtureJson(pr)), { headers: pr.headers })).status).toBe(403);
  });
});
