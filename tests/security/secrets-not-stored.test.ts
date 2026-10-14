import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryMessage } from '../../src/env';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { EVENT, LARK, SLACK, caller, setup, signHeaders, type Harness } from '../sources/harness';
import { legacySeal } from '../support/legacy';
import { scanDatabase, scanTexts, type Needle } from '../support/scan';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

/**
 * F34 `kek_is_never_written_to_d1` and `kek_is_absent_from_logs_and_queue_messages`: after a
 * realistic run (sources and integrations created through the API, a legacy v0 row migrated, a
 * GitHub and a generic event ingested and delivered, a KEK rotation) NO column of NO table, no
 * queue message and no log line contains a configured KEK, the legacy key, the webhook secret, the
 * session secret, or a destination credential in the clear.
 */
const KEK_1 = '11'.repeat(32);
const KEK_2 = '22'.repeat(32);
const LEGACY = 'aa'.repeat(32);
const GITHUB_SECRET = ['scan', 'fixture', 'github', 'webhook', 'value'].join('-');
const SESSION_SECRET = ['scan', 'fixture', 'session', 'signing', 'value', '0123456789'].join('-');
const LEGACY_URL = 'https://open.larksuite.com/open-apis/bot/v2/hook/legacy-scan-fixture';

let h: Harness;
const call = caller(worker, () => h);
const queued: DeliveryMessage[] = [];
let logs: string[];

const deps: ConsumerDeps = {
  random: () => 0.5,
  now: () => Date.now(),
  newClaimToken: () => crypto.randomUUID(),
};
const ctx = (): ExecutionContext =>
  ({ waitUntil: () => undefined, passThroughOnException: () => undefined }) as unknown as ExecutionContext;

beforeEach(() => {
  h = setup();
  queued.length = 0;
  logs = [];
  h.env = {
    ...h.env,
    KEK_V1: KEK_1,
    KEK_V2: KEK_2,
    ENCRYPTION_KEY: LEGACY,
    GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
    GITHUB_APP_ID: '777',
    BETTER_AUTH_SECRET: SESSION_SECRET,
    DELIVERY_QUEUE: {
      send: (m: DeliveryMessage) => {
        queued.push(m);
        return Promise.resolve();
      },
    } as unknown as Queue<DeliveryMessage>,
  };
  for (const level of ['info', 'warn', 'error', 'debug', 'log'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function githubEvent(): Promise<void> {
  const body = JSON.stringify({
    action: 'opened',
    installation: { id: 100, app_id: 777 },
    repository: { full_name: 'acme/web', html_url: 'https://github.com/acme/web' },
    issue: { title: 'Checkout is broken', html_url: 'https://github.com/acme/web/issues/1' },
  });
  const res = await worker.fetch(
    new Request('https://noti.test/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', GITHUB_SECRET).update(body).digest('hex')}`,
        'x-github-event': 'issues',
        'x-github-delivery': 'scan-1',
      },
    }),
    h.env,
    ctx(),
  );
  expect(res.status).toBe(202);
}

async function tick(): Promise<void> {
  await worker.scheduled({} as ScheduledEvent, h.env);
}

async function deliverQueued(): Promise<void> {
  for (const body of queued.splice(0)) {
    const msg = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await consumeDeliveries(
      { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
      h.env,
      deps,
    );
  }
}

async function seedRealisticData(): Promise<{ sourceSecret: string }> {
  // A generic source and two integrations created through the API (sealed under KEK v1).
  const created = await (
    await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } })
  ).json<{
    source: { id: string; endpointId: string };
    secret: string;
  }>();
  for (const [destination, url] of [
    ['slack', SLACK],
    ['lark', LARK],
  ] as const) {
    const res = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: destination, sourceId: created.source.id, destination, webhookUrl: url },
    });
    expect(res.status).toBe(201);
  }
  // A GitHub-routed integration still on the legacy v0 format, which the cron job migrates.
  h.db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection,status)
       VALUES('gi-100','org-a','100','777','acme','Organization','all','active')`,
    )
    .run();
  h.db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id)
       VALUES('legacy-1','acme/web','["issues.opened"]','lark',?,'org-a')`,
    )
    .run(await legacySeal(LEGACY_URL, LEGACY));

  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ code: 0 }), { status: 200 })));
  const body = JSON.stringify(EVENT);
  const ingest = await worker.fetch(
    new Request(`https://noti.test/webhooks/generic/${created.source.endpointId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signHeaders(created.secret, body) },
      body,
    }),
    h.env,
    ctx(),
  );
  expect(ingest.status).toBe(202);
  await githubEvent();
  await tick(); // migrates the v0 row, reconciles the outbox onto the queue
  await deliverQueued();
  // Rotate the KEK: v2 becomes active and every wrapped key is rewrapped under it.
  h.env = { ...h.env, KMS_ACTIVE_VERSION: '2' };
  await tick();
  await deliverQueued();
  return { sourceSecret: created.secret };
}

function needles(sourceSecret: string): Needle[] {
  return [
    { label: 'KEK_V1', value: KEK_1 },
    { label: 'KEK_V2', value: KEK_2 },
    { label: 'ENCRYPTION_KEY', value: LEGACY },
    { label: 'GITHUB_WEBHOOK_SECRET', value: GITHUB_SECRET },
    { label: 'BETTER_AUTH_SECRET', value: SESSION_SECRET },
    { label: 'FINGERPRINT_KEY', value: '44'.repeat(32) },
    // Credentials are stored only sealed: the cleartext must not exist anywhere either.
    { label: 'slack webhook URL', value: SLACK },
    { label: 'lark webhook URL', value: LARK },
    { label: 'legacy webhook URL', value: LEGACY_URL },
    { label: 'source signing secret', value: sourceSecret },
  ];
}

describe('secrets are never written (F34)', () => {
  it('the scan is not vacuous: it finds a KEK planted in any column, in any shape', () => {
    h.db.raw.exec('CREATE TABLE scratch(a TEXT, b BLOB)');
    for (const planted of [KEK_1, Buffer.from(KEK_1, 'hex').toString('base64'), `x${KEK_1}y`]) {
      h.db.raw.prepare('INSERT INTO scratch(a) VALUES(?)').run(planted);
      expect(scanDatabase(h.db.raw, [{ label: 'KEK_V1', value: KEK_1 }])).toEqual([
        { table: 'scratch', column: 'a', needle: 'KEK_V1' },
      ]);
      h.db.raw.exec('DELETE FROM scratch');
    }
    h.db.raw.prepare('INSERT INTO scratch(b) VALUES(?)').run(Buffer.from(KEK_1, 'hex'));
    expect(scanDatabase(h.db.raw, [{ label: 'KEK_V1', value: KEK_1 }])).toHaveLength(1);
    expect(scanTexts([`token=${KEK_1}`], [{ label: 'KEK_V1', value: KEK_1 }])).toEqual(['KEK_V1']);
  });

  it('no column of any table holds a KEK, the legacy key, a secret or a clear credential', async () => {
    const { sourceSecret } = await seedRealisticData();

    // The run really exercised the paths the scan is about.
    const count = (sql: string) => (h.db.raw.prepare(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM integrations WHERE webhook_envelope IS NOT NULL')).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM integrations WHERE kek_version=2')).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM sources WHERE kek_version=2')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM deliveries')).toBeGreaterThanOrEqual(3);
    expect(count('SELECT COUNT(*) AS n FROM notification_outbox')).toBeGreaterThanOrEqual(3);
    expect(count('SELECT COUNT(*) AS n FROM audit_events')).toBeGreaterThanOrEqual(3);

    expect(scanDatabase(h.db.raw, needles(sourceSecret))).toEqual([]);
  });

  it('no queue message and no log line carries one either', async () => {
    const delivered: DeliveryMessage[] = [];
    const original = h.env.DELIVERY_QUEUE;
    h.env = {
      ...h.env,
      DELIVERY_QUEUE: {
        send: (m: DeliveryMessage) => {
          delivered.push(m);
          return original.send(m);
        },
      } as unknown as Queue<DeliveryMessage>,
    };
    const { sourceSecret } = await seedRealisticData();

    expect(delivered.length).toBeGreaterThanOrEqual(3);
    expect(logs.length).toBeGreaterThan(0);
    const n = needles(sourceSecret);
    expect(
      scanTexts(
        delivered.map((m) => JSON.stringify(m)),
        n,
      ),
    ).toEqual([]);
    expect(scanTexts(logs, n)).toEqual([]);
  });
});
