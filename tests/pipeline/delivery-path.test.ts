import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { keyringFromEnv } from '../../src/crypto/keyring-env';
import { migrateLegacyCredentials, rewrapStaleKeys } from '../../src/pipeline/credentials';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { legacySeal } from '../support/legacy';

/**
 * The real delivery path, end to end over the real migrations: signed webhook → tenant
 * resolution → outbox → queue → consumer → provider. Closes D13.
 */
const K_LEGACY = 'aa'.repeat(32);
const K1 = '11'.repeat(32);
const K2 = '22'.repeat(32);
const HMAC_FIXTURE = ['test', 'fixture', 'hmac'].join('-');
const APP_ID = '777';
const LARK_A = 'https://open.larksuite.com/open-apis/bot/v2/hook/tenant-a';
const LARK_B = 'https://open.larksuite.com/open-apis/bot/v2/hook/tenant-b';

let db: FakeD1;
let sent: DeliveryMessage[];
let env: Bindings;
let fetchMock: ReturnType<typeof vi.fn>;

function makeEnv(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: db.d1,
    DELIVERY_QUEUE: {
      send: (m: DeliveryMessage) => {
        sent.push(m);
        return Promise.resolve();
      },
    } as unknown as Queue<DeliveryMessage>,
    GITHUB_WEBHOOK_SECRET: HMAC_FIXTURE,
    GITHUB_APP_ID: APP_ID,
    ENCRYPTION_KEY: K_LEGACY,
    KEK_V1: K1,
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ...over,
  } as Bindings;
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

async function postWebhook(event: Record<string, unknown>, deliveryId = 'gh-delivery-1'): Promise<Response> {
  const body = JSON.stringify(event);
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => waits.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const res = await worker.fetch(
    new Request('https://noti.test/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': await sign(body),
        'x-github-event': 'issues',
        'x-github-delivery': deliveryId,
      },
    }),
    env,
    ctx,
  );
  await Promise.all(waits);
  return res;
}

function issueEvent(installationId: number, repo = 'acme/web'): Record<string, unknown> {
  return {
    action: 'opened',
    installation: { id: installationId, app_id: Number(APP_ID) },
    repository: { full_name: repo, html_url: `https://github.com/${repo}` },
    issue: { title: 'Checkout is broken', html_url: `https://github.com/${repo}/issues/1` },
  };
}

function installation(org: string, installationId: string, status = 'active'): void {
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection,status)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(`gi-${installationId}`, org, installationId, APP_ID, org, 'Organization', 'all', status);
}

async function integration(id: string, org: string, url: string, repo = 'acme/web'): Promise<void> {
  db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(id, repo, JSON.stringify(['issues.opened']), 'lark', await legacySeal(url, K_LEGACY), org);
}

interface FakeMessage {
  body: unknown;
  acked: boolean;
  retried: boolean;
  ack(): void;
  retry(): void;
}

function message(body: unknown): FakeMessage {
  return {
    body,
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  };
}

async function consume(messages: FakeMessage[], e: Bindings = env): Promise<void> {
  await worker.queue({ messages } as unknown as MessageBatch<unknown>, e);
}

function delivery(id: string): { state: string; last_error: string | null } | undefined {
  return db.raw.prepare('SELECT state,last_error FROM deliveries WHERE id=?').get(id) as
    { state: string; last_error: string | null } | undefined;
}

function larkOk(): Response {
  return new Response(JSON.stringify({ code: 0 }), { status: 200 });
}

beforeEach(() => {
  db = createFakeD1();
  sent = [];
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  env = makeEnv();
  fetchMock = vi.fn(() => Promise.resolve(larkOk()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ingress tenant isolation', () => {
  it('rejects an unknown installation and persists nothing', async () => {
    const res = await postWebhook(issueEvent(999));
    expect(res.status).toBe(403);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 0 });
  });

  it('rejects a suspended installation', async () => {
    installation('org-a', '100', 'suspended');
    expect((await postWebhook(issueEvent(100))).status).toBe(403);
  });

  it('routes only to the installing tenant even when another tenant uses the same repo name', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    await integration('int-b', 'org-b', LARK_B);

    const res = await postWebhook(issueEvent(100));
    expect(res.status).toBe(202);
    expect(sent.map((m) => m.integrationId)).toEqual(['int-a']);
  });

  it('puts identifiers and display text on the queue, never a credential (D5)', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    await postWebhook(issueEvent(100));

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual([
      'id',
      'integrationId',
      'organizationId',
      'title',
      'url',
    ]);
    const outbox = db.raw.prepare('SELECT payload_json FROM notification_outbox').all() as {
      payload_json: string;
    }[];
    for (const row of outbox) expect(row.payload_json).not.toMatch(/ciphertext|larksuite/);
  });

  it('accepts a redelivered GitHub event once', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    await postWebhook(issueEvent(100), 'same');
    const again = await postWebhook(issueEvent(100), 'same');
    expect(await again.json()).toEqual({ accepted: true, persisted: 0 });
    expect(sent).toHaveLength(1);
  });
});

describe('consumer', () => {
  async function queued(): Promise<DeliveryMessage> {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    await postWebhook(issueEvent(100));
    const m = sent[0];
    if (!m) throw new Error('nothing queued');
    return m;
  }

  it('delivers a legacy v0 row and records it as sent', async () => {
    const m = await queued();
    const msg = message(m);
    await consume([msg]);
    expect(msg.acked).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(LARK_A);
    expect(delivery(m.id)?.state).toBe('sent');
  });

  it('delivers after the v0 → v1 migration and clears the v0 ciphertext', async () => {
    const m = await queued();
    const report = await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY);
    expect(report).toEqual({ processed: 1, quarantined: 0 });

    const row = db.raw
      .prepare('SELECT webhook_ciphertext,kek_version,webhook_envelope FROM integrations WHERE id=?')
      .get('int-a') as { webhook_ciphertext: string; kek_version: number; webhook_envelope: Uint8Array };
    expect(row.webhook_ciphertext).toBe('');
    expect(row.kek_version).toBe(1);
    expect(row.webhook_envelope[0]).toBe(0x01);

    // The legacy key is no longer needed to deliver.
    await consume([message(m)], makeEnv({ ENCRYPTION_KEY: '00'.repeat(32) }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(LARK_A);
  });

  it('refuses a v1 credential copied from another row and never calls the provider', async () => {
    const m = await queued();
    await integration('int-a2', 'org-a', LARK_B, 'acme/other');
    await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY);
    // Copy int-a2's sealed URL and key material onto int-a: a database-write attack.
    db.raw.exec(`UPDATE integrations SET
        webhook_envelope=(SELECT webhook_envelope FROM integrations WHERE id='int-a2')
      WHERE id='int-a'`);

    const msg = message(m);
    await consume([msg]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.acked).toBe(true);
    expect(delivery(m.id)).toEqual({ state: 'failed', last_error: 'destination_credentials_invalid' });
  });

  it('refuses a message whose organization does not own the integration', async () => {
    const m = await queued();
    const msg = message({ ...m, organizationId: 'org-b' });
    await consume([msg]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(delivery(m.id)?.last_error).toBe('integration_unavailable');
  });

  it('refuses a destination outside the allowlist', async () => {
    installation('org-a', '100');
    await integration('int-evil', 'org-a', 'https://open.larksuite.com.evil.test/open-apis/bot/v2/hook/x');
    await postWebhook(issueEvent(100));
    const m = sent[0];
    if (!m) throw new Error('nothing queued');
    await consume([message(m)]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(delivery(m.id)?.last_error).toBe('destination_not_allowed');
  });

  it('retries a provider 5xx with a minted error code', async () => {
    const m = await queued();
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 503 }));
    const msg = message(m);
    await consume([msg]);
    expect(msg.retried).toBe(true);
    expect(delivery(m.id)).toEqual({ state: 'retrying', last_error: 'provider_http_503' });
  });

  it('never records a platform error message, which may echo the URL', async () => {
    const m = await queued();
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${LARK_A}`));
    await consume([message(m)]);
    expect(delivery(m.id)?.last_error).toBe('transient_error');
  });

  it('acknowledges a message it did not write instead of looping', async () => {
    const msg = message({ nonsense: true });
    await consume([msg]);
    expect(msg.acked).toBe(true);
  });
});

describe('credential maintenance jobs', () => {
  it('quarantines a v0 row that will not decrypt instead of skipping it', async () => {
    db.raw
      .prepare(
        `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id)
         VALUES('int-bad','acme/web','[]','lark',?,'org-a')`,
      )
      .run(await legacySeal(LARK_A, '99'.repeat(32)));
    const report = await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY);
    expect(report).toEqual({ processed: 0, quarantined: 1 });
    const row = db.raw
      .prepare('SELECT credentials_quarantine_reason AS r FROM integrations WHERE id=?')
      .get('int-bad') as { r: string };
    expect(row.r).toBe('destination_credentials_invalid');
  });

  it('rotates to a new KEK and keeps delivering once the old KEK is removed', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY);

    const rotating = makeEnv({ KEK_V2: K2, KMS_ACTIVE_VERSION: '2' });
    expect(await rewrapStaleKeys(db.d1, keyringFromEnv(rotating))).toEqual({ processed: 1, quarantined: 0 });
    expect(await rewrapStaleKeys(db.d1, keyringFromEnv(rotating))).toEqual({ processed: 0, quarantined: 0 });

    env = makeEnv({ KEK_V1: '', KEK_V2: K2, KMS_ACTIVE_VERSION: '2' });
    await postWebhook(issueEvent(100));
    const m = sent[0];
    if (!m) throw new Error('nothing queued');
    await consume([message(m)]);
    expect(delivery(m.id)?.state).toBe('sent');
  });
});

describe('/health', () => {
  it('names the misconfigured key binding without revealing a value', async () => {
    env = makeEnv({ KEK_V1: 'short' });
    const res = await worker.fetch(new Request('https://noti.test/health'), env, {} as ExecutionContext);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('KEK_V1');
    expect(text).not.toContain('short');
  });
});
