import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { bootReport } from '../../src/platform/config';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { keyringFromEnv } from '../../src/crypto/keyring-env';
import {
  credentialStatus,
  CredentialJobAborted,
  migrateLegacyCredentials,
  rewrapStaleKeys,
} from '../../src/pipeline/credentials';
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
    APP_ORIGIN: 'https://noti.test',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789ab',
    ENCRYPTION_KEY: K_LEGACY,
    KEK_V1: K1,
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENVIRONMENT_NAME: 'staging',
    KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
    // Staging check value of K2, so a rotation test can hold K2 alone.
    KEK_CHECK_V2: 'a05d760333a74120cc3c488d4871cb25',
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

async function postWebhook(
  event: Record<string, unknown>,
  deliveryId = 'gh-delivery-1',
  githubEvent = 'issues',
): Promise<Response> {
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
        'x-github-event': githubEvent,
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
  const retryAll = () => messages.forEach((m) => m.retry());
  await worker.queue({ messages, retryAll } as unknown as MessageBatch<unknown>, e);
}

/** Queue one delivery for an existing integration's repo and consume it. */
async function postWebhookFor(integrationId: string): Promise<void> {
  installation('org-a', '100');
  db.raw
    .prepare('UPDATE integrations SET event_types=? WHERE id=?')
    .run(JSON.stringify(['issues.opened']), integrationId);
  await postWebhook(issueEvent(100), `d-${integrationId}`);
  const m = sent.find((x) => x.integrationId === integrationId);
  if (!m) throw new Error('nothing queued');
  await consume([message(m)]);
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
      'correlationId',
      'eventType',
      'id',
      'integrationId',
      'organizationId',
      'repo',
      'status',
      'summary',
      'title',
      'url',
    ]);
    const outbox = db.raw.prepare('SELECT payload_json FROM notification_outbox').all() as {
      payload_json: string;
    }[];
    for (const row of outbox) expect(row.payload_json).not.toMatch(/ciphertext|larksuite/);
  });

  it('answers 429 with Retry-After once an installation exceeds the ingress limit (F29)', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run('ingress:github:100', windowStart, 600);
    const res = await postWebhook(issueEvent(100), 'flood-1');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
  });

  it('never rate-limits lifecycle events, so a revocation is not delayed', async () => {
    installation('org-a', '100');
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run('ingress:github:100', windowStart, 10_000);
    const res = await postWebhook(
      { action: 'suspend', installation: { id: 100, app_id: Number(APP_ID) } },
      'lifecycle-1',
      'installation',
    );
    expect(res.status).toBe(202);
    expect(
      db.raw.prepare("SELECT status FROM github_installations WHERE installation_id='100'").get(),
    ).toEqual({
      status: 'suspended',
    });
  });

  it('fails open when the limiter itself errors, rather than dropping the notification', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    db.raw.exec('DROP TABLE api_rate_limits');
    const res = await postWebhook(issueEvent(100), 'failopen-1');
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it('ignores event types outside the catalog without touching integrations (D16)', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    db.raw.prepare('UPDATE integrations SET event_types=\'["issues.transferred"]\'').run();
    const res = await postWebhook({ ...issueEvent(100), action: 'transferred' });
    expect(await res.json()).toEqual({ accepted: true, persisted: 0 });
    expect(sent).toHaveLength(0);
  });

  it('matches the repository case-insensitively, as GitHub does', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A, 'Acme/Web');
    await postWebhook(issueEvent(100, 'acme/web'));
    expect(sent.map((m) => m.integrationId)).toEqual(['int-a']);
  });

  describe('canonical notification fields', () => {
    const all =
      '["issues.opened","workflow_run.failure","workflow_run.timed_out","workflow_run.success","workflow_run.cancelled","pull_request.merged","pull_request.opened"]';

    async function ingest(kind: string, event: Record<string, unknown>): Promise<DeliveryMessage> {
      installation('org-a', '100');
      await integration('int-a', 'org-a', LARK_A);
      db.raw.prepare('UPDATE integrations SET event_types=?').run(all);
      await postWebhook({ installation: { id: 100, app_id: Number(APP_ID) }, ...event }, 'gh-x', kind);
      const m = sent[0];
      if (!m) throw new Error('nothing queued');
      return m;
    }

    const repository = { full_name: 'acme/web', html_url: 'https://github.com/acme/web' };

    it.each([
      ['failure', 'failure'],
      ['timed_out', 'failure'],
      ['success', 'success'],
      ['cancelled', 'info'],
    ])('workflow_run %s → status %s, with repo, actor and a bounded summary', async (conclusion, status) => {
      const m = await ingest('workflow_run', {
        action: 'completed',
        repository,
        sender: { login: 'octocat' },
        workflow_run: {
          name: 'CI',
          head_branch: 'main',
          conclusion,
          html_url: 'https://github.com/acme/web/actions/runs/9',
        },
      });
      expect(m).toMatchObject({
        title: 'CI',
        repo: 'acme/web',
        actor: 'octocat',
        status,
        eventType: `workflow_run.${conclusion}`,
        summary: `main · ${conclusion} · completed`,
      });
    });

    it('a merged pull request is success; an opened one is info', async () => {
      const pr = {
        number: 12,
        title: 'Add thing',
        html_url: 'https://github.com/acme/web/pull/12',
        head: { ref: 'feature' },
        base: { ref: 'main' },
        body: 'PRIVATE-BODY-TEXT',
      };
      const merged = await ingest('pull_request', {
        action: 'closed',
        repository,
        sender: { login: 'octocat' },
        pull_request: { ...pr, merged: true },
      });
      expect(merged).toMatchObject({ status: 'success', eventType: 'pull_request.merged' });
      expect(merged.summary).toBe('#12 · feature → main · closed');
    });

    it('never carries the payload: no body text, no unknown keys, summary within 280 characters', async () => {
      const m = await ingest('pull_request', {
        action: 'opened',
        repository,
        sender: { login: 'octocat', email: 'private@example.test' },
        pull_request: {
          number: 1,
          title: 'T',
          html_url: 'https://github.com/acme/web/pull/1',
          head: { ref: 'f'.repeat(400) },
          base: { ref: 'main' },
          body: 'PRIVATE-BODY-TEXT',
        },
      });
      expect(m.status).toBe('info');
      expect(m.summary?.length).toBeLessThanOrEqual(280);
      expect(JSON.stringify(m)).not.toMatch(/PRIVATE-BODY-TEXT|private@example/);
      const row = db.raw.prepare('SELECT payload_json FROM notification_outbox').get() as {
        payload_json: string;
      };
      expect(row.payload_json).not.toMatch(/PRIVATE-BODY-TEXT|private@example/);
    });

    it('omits actor when the event has no sender', async () => {
      const m = await ingest('issues', { ...issueEvent(100), sender: undefined });
      expect(m.actor).toBeUndefined();
      expect(m.status).toBe('info');
    });
  });

  it('accepts a redelivered GitHub event once', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    await postWebhook(issueEvent(100), 'same');
    const again = await postWebhook(issueEvent(100), 'same');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ accepted: true, persisted: 0, duplicate: true });
    expect(sent).toHaveLength(1);
  });

  it('does not queue a redelivery again after its outbox row was purged by retention', async () => {
    installation('org-a', '100');
    await integration('int-a', 'org-a', LARK_A);
    await postWebhook(issueEvent(100), 'purged');
    expect(sent).toHaveLength(1);
    // Retention drops dispatched outbox rows after 7 days while the delivery row lives on.
    db.raw.prepare('DELETE FROM notification_outbox').run();
    const again = await postWebhook(issueEvent(100), 'purged');
    expect(await again.json()).toEqual({ accepted: true, persisted: 0, duplicate: true });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()).toEqual({ n: 0 });
    expect(sent).toHaveLength(1);
  });

  it('cuts off a chunked body at the cap instead of buffering it (no Content-Length)', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 64) return controller.close();
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const res = await worker.fetch(
      new Request('https://noti.test/webhooks/github', {
        method: 'POST',
        body: stream,
        duplex: 'half',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'chunked',
        },
      } as RequestInit),
      env,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(413);
    // 1 MiB cap = 16 chunks; the reader stops at the first byte over, not at 64 chunks.
    expect(pulled).toBeLessThan(25);
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

  it('delivers after the v0 → v1 migration and no longer needs the legacy key', async () => {
    const m = await queued();
    const report = await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY);
    expect(report).toEqual({ processed: 1, quarantined: 0, skipped: 0 });

    const row = db.raw
      .prepare('SELECT webhook_ciphertext,kek_version,webhook_envelope FROM integrations WHERE id=?')
      .get('int-a') as { webhook_ciphertext: string; kek_version: number; webhook_envelope: Uint8Array };
    // v0 stays intact so a Worker rollback still delivers; clearing it is an operator step.
    expect(row.webhook_ciphertext).not.toBe('');
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
    expect(delivery(m.id)).toEqual({ state: 'dead_lettered', last_error: 'destination_credentials_invalid' });
  });

  it('refuses a message whose organization does not own the integration', async () => {
    const m = await queued();
    const msg = message({ ...m, organizationId: 'org-b' });
    await consume([msg]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.acked).toBe(true);
    // The forged message cannot even write to the real tenant's delivery row.
    expect(delivery(m.id)).toEqual({ state: 'pending', last_error: null });
  });

  it('does not call the provider again for a delivery already sent', async () => {
    const m = await queued();
    await consume([message(m)]);
    const again = message(m);
    await consume([again]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.acked).toBe(true);
  });

  it('retries, never drops, when the key ring is misconfigured', async () => {
    const m = await queued();
    const msg = message(m);
    const batch = { messages: [msg], retryAll: () => undefined };
    await worker.queue(batch as unknown as MessageBatch<unknown>, makeEnv({ KEK_V1: 'bad' }));
    expect(msg.retried).toBe(true);
    expect(msg.acked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(delivery(m.id)?.state).toBe('pending');
  });

  it('retries, never fails permanently, when the KEK version for a row is not configured', async () => {
    const m = await queued();
    await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY);
    const msg = message(m);
    await consume([msg], makeEnv({ KEK_V1: '', KEK_V2: K2, KMS_ACTIVE_VERSION: '2', ENCRYPTION_KEY: '' }));
    expect(msg.retried).toBe(true);
    expect(delivery(m.id)).toEqual({ state: 'retrying', last_error: 'provider_config_unknown_kek_version' });
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
    await integration('int-good', 'org-a', LARK_A);
    const report = await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY);
    expect(report).toEqual({ processed: 1, quarantined: 1, skipped: 0 });
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
    expect(await rewrapStaleKeys(db.d1, keyringFromEnv(rotating))).toEqual({
      processed: 1,
      quarantined: 0,
      skipped: 0,
    });
    expect(await rewrapStaleKeys(db.d1, keyringFromEnv(rotating))).toEqual({
      processed: 0,
      quarantined: 0,
      skipped: 0,
    });
    expect(await credentialStatus(db.d1, 2)).toEqual({
      legacyRemaining: 0,
      revokedKeysRemaining: 0,
      staleKekRemaining: 0,
      quarantined: 0,
      revoked: 0,
    });

    env = makeEnv({ KEK_V1: '', KEK_V2: K2, KMS_ACTIVE_VERSION: '2' });
    await postWebhook(issueEvent(100));
    const m = sent[0];
    if (!m) throw new Error('nothing queued');
    await consume([message(m)]);
    expect(delivery(m.id)?.state).toBe('sent');
  });
});

describe('credential job safety', () => {
  it('aborts without quarantining when every row fails, because the key is the likelier fault', async () => {
    await integration('int-1', 'org-a', LARK_A);
    await integration('int-2', 'org-a', LARK_B);
    await expect(
      migrateLegacyCredentials(db.d1, keyringFromEnv(env), '99'.repeat(32)),
    ).rejects.toBeInstanceOf(CredentialJobAborted);
    expect(await credentialStatus(db.d1, 1)).toEqual({
      legacyRemaining: 2,
      staleKekRemaining: 0,
      quarantined: 0,
      revoked: 0,
      revokedKeysRemaining: 0,
    });
  });

  it('aborts on a configuration fault instead of quarantining', async () => {
    await integration('int-1', 'org-a', LARK_A);
    await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY);
    // KEK v1 removed before the rewrap finished: a deployment fault, not a row defect.
    const v1Gone = makeEnv({ KEK_V1: '', KEK_V2: K2, KMS_ACTIVE_VERSION: '2' });
    await expect(rewrapStaleKeys(db.d1, keyringFromEnv(v1Gone))).rejects.toBeInstanceOf(CredentialJobAborted);
    expect((await credentialStatus(db.d1, 2)).quarantined).toBe(0);
  });

  it('never overwrites a credential edited between read and write', async () => {
    await integration('int-1', 'org-a', LARK_A);
    const edited = await legacySeal(LARK_B, K_LEGACY);
    let raced = false;
    // Land a concurrent edit after the job's SELECT, just before its guarded UPDATE.
    const racingDb = {
      ...db.d1,
      prepare: (sql: string) => {
        if (!raced && sql.trimStart().startsWith('UPDATE integrations SET key_salt')) {
          raced = true;
          db.raw.prepare("UPDATE integrations SET webhook_ciphertext=? WHERE id='int-1'").run(edited);
        }
        return db.d1.prepare(sql);
      },
    } as D1Database;

    expect(await migrateLegacyCredentials(racingDb, keyringFromEnv(env), K_LEGACY)).toEqual({
      processed: 0,
      quarantined: 0,
      skipped: 1,
    });
    // The next run seals the edited value, never the stale one.
    expect((await migrateLegacyCredentials(db.d1, keyringFromEnv(env), K_LEGACY)).processed).toBe(1);
    await postWebhookFor('int-1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(LARK_B);
  });
});

describe('/health', () => {
  it('a malformed optional legacy key warns the operator and does not refuse to serve', async () => {
    env = makeEnv({ ENCRYPTION_KEY: 'nope' });
    const res = await worker.fetch(new Request('https://noti.test/health'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('ENCRYPTION_KEY');
    expect(text).not.toContain('nope');
    expect(JSON.parse(text)).toEqual({ ok: true, service: 'lumi-noti' });
    expect((await bootReport(env)).warnings).toContain('ENCRYPTION_KEY');
  });

  it('refuses with a coarse code: the misconfigured key binding is named only to the operator', async () => {
    env = makeEnv({ KEK_V1: 'short' });
    const res = await worker.fetch(new Request('https://noti.test/health'), env, {} as ExecutionContext);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('KEK_V1');
    expect(text).not.toContain('short');
    expect(JSON.parse(text)).toMatchObject({ ok: false, code: 'config_invalid' });
    expect((await bootReport(env)).credentials).toContain('KEK_V1');
  });
});
