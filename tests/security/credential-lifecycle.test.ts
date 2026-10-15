import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryMessage } from '../../src/env';
import { credentialFingerprint } from '../../src/crypto/fingerprint';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { credentialStatus } from '../../src/pipeline/credentials';
import { createConnectionKeys, open, seal, parseKeyHex, createKeyring } from '../../src/crypto/envelope';
import { keyringFromEnv } from '../../src/crypto/keyring-env';
import { EVENT, SLACK, caller, setup, signHeaders, type Harness } from '../sources/harness';
import { scanDatabase } from '../support/scan';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

let h: Harness;
const call = caller(worker, () => h);

interface Created {
  source: { id: string; endpointId: string; credentialFingerprint: string | null; revoked: boolean };
  secret: string;
}
interface IntegrationView {
  id: string;
  credentials: string;
  revoked: boolean;
  credentialFingerprint: string | null;
  enabled: boolean;
}

const SLACK_NEW = 'https://hooks.slack.com/services/T000/B000/ReplacementTokenPath';

async function createSource(): Promise<Created> {
  const res = await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI pipeline' } });
  expect(res.status).toBe(201);
  return res.json<Created>();
}

async function route(sourceId: string, as = 'alice'): Promise<string> {
  const res = await call('POST', '/api/integrations', {
    as,
    body: { name: 'to slack', sourceId, destination: 'slack', webhookUrl: SLACK },
  });
  expect(res.status).toBe(201);
  return (await res.json<{ integration: { id: string } }>()).integration.id;
}

async function ingest(src: Created, secret = src.secret): Promise<Response> {
  const body = JSON.stringify(EVENT);
  return worker.fetch(
    new Request(`https://noti.test/webhooks/generic/${src.source.endpointId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signHeaders(secret, body) },
      body,
    }),
    h.env,
    { waitUntil: h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

const deps: ConsumerDeps = {
  random: () => 0.5,
  now: () => Date.now(),
  newClaimToken: () => crypto.randomUUID(),
};

async function drainOutbox(): Promise<void> {
  const rows = h.db.raw.prepare('SELECT payload_json FROM notification_outbox ORDER BY rowid').all() as {
    payload_json: string;
  }[];
  for (const r of rows) {
    const msg = {
      body: JSON.parse(r.payload_json) as DeliveryMessage,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeDeliveries(
      { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
      h.env,
      deps,
    );
  }
}

const auditRows = (action: string) =>
  h.db.raw.prepare('SELECT metadata_json, organization_id FROM audit_events WHERE action=?').all(action) as {
    metadata_json: string;
    organization_id: string | null;
  }[];

beforeEach(() => {
  h = setup();
});
afterEach(() => vi.unstubAllGlobals());

describe('credential fingerprint (F39)', () => {
  it('is stored at seal time, shown on reads, and matches the credential and nothing else', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    const view = (
      await (
        await call('GET', `/api/integrations/${id}`, { as: 'alice' })
      ).json<{
        integration: IntegrationView;
      }>()
    ).integration;
    expect(view.credentialFingerprint).toBe(
      await credentialFingerprint(SLACK, 'org-a', h.env.FINGERPRINT_KEY),
    );
    expect(view.credentialFingerprint).toMatch(/^[A-Z2-7]{8}$/);
    expect(view.credentialFingerprint).not.toBe(
      await credentialFingerprint(SLACK_NEW, 'org-a', h.env.FINGERPRINT_KEY),
    );
    // The source's secret is fingerprinted the same way, and the fingerprint is not the secret.
    expect(src.source.credentialFingerprint).toBe(
      await credentialFingerprint(src.secret, 'org-a', h.env.FINGERPRINT_KEY),
    );
    expect(JSON.stringify(view)).not.toContain('Secret');
    expect(JSON.stringify(view)).not.toContain(new URL(SLACK).pathname);
  });

  it('changes when the credential is replaced', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    const res = await call('PATCH', `/api/integrations/${id}`, {
      as: 'alice',
      body: { webhookUrl: SLACK_NEW },
    });
    expect((await res.json<{ integration: IntegrationView }>()).integration.credentialFingerprint).toBe(
      await credentialFingerprint(SLACK_NEW, 'org-a', h.env.FINGERPRINT_KEY),
    );
  });
});

describe('revoking an integration credential (F40)', () => {
  it('stops delivery of messages already queued, never decrypts for them, and audits once', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    expect((await ingest(src)).status).toBe(202);

    const res = await call('POST', `/api/integrations/${id}/revoke-credentials`, {
      as: 'alice',
      body: { reason: 'compromised' },
    });
    expect(res.status).toBe(200);
    const { integration } = await res.json<{ integration: IntegrationView }>();
    // Distinct from a quarantine for the dashboard, yet still reads as "stopped" to old clients.
    expect(integration).toMatchObject({ revoked: true, credentials: 'quarantined' });
    expect(
      h.db.raw.prepare('SELECT credentials_quarantine_reason AS r FROM integrations WHERE id=?').get(id),
    ).toEqual({ r: 'revoked' });

    h.fetchMock.mockClear();
    await drainOutbox();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.db.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state='sent'").get()).toEqual({
      n: 0,
    });

    const entries = auditRows('integration.credentials.revoke');
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]?.metadata_json ?? '{}')).toEqual({
      destinationHost: 'hooks.slack.com',
      reason: 'compromised',
    });
    expect(JSON.stringify(entries)).not.toContain('SecretTokenPath');
  });

  it('is counted as revoked, not quarantined, in the credential status', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect(await credentialStatus(h.env.DB, 1)).toEqual({
      legacyRemaining: 0,
      staleKekRemaining: 0,
      quarantined: 0,
      revoked: 1,
      // Nothing was in flight, so the key was destroyed in the revoke request itself.
      revokedKeysRemaining: 0,
    });
  });

  it('is admin-only, CSRF-protected, tenant-scoped, validated and idempotent', async () => {
    const src = await createSource();
    const id = await route(src.source.id, 'bob');
    const path = `/api/integrations/${id}/revoke-credentials`;
    const denied = await call('POST', path, { as: 'bob' });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('integration.revoke');
    expect((await call('POST', path, { as: 'alice', origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', path, { as: 'alice', origin: null })).status).toBe(403);
    expect((await call('POST', path, { as: 'mallory' })).status).toBe(404);
    expect((await call('POST', path, { as: 'alice', body: { reason: 'because' } })).status).toBe(422);
    expect(auditRows('integration.credentials.revoke')).toHaveLength(0);

    expect((await call('POST', path, { as: 'alice' })).status).toBe(200);
    expect((await call('POST', path, { as: 'alice' })).status).toBe(200);
    expect(auditRows('integration.credentials.revoke')).toHaveLength(1);
    expect((await call('POST', '/api/integrations/missing/revoke-credentials', { as: 'alice' })).status).toBe(
      404,
    );
  });

  it('is cleared only by entering a new credential, which seals under fresh key material', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    const before = h.db.raw.prepare('SELECT dek_wrapped FROM integrations WHERE id=?').get(id);
    // Re-enabling or renaming does not lift it.
    const renamed = await call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { enabled: true } });
    expect((await renamed.json<{ integration: IntegrationView }>()).integration.revoked).toBe(true);

    const res = await call('PATCH', `/api/integrations/${id}`, {
      as: 'alice',
      body: { webhookUrl: SLACK_NEW },
    });
    const { integration } = await res.json<{ integration: IntegrationView }>();
    expect(integration).toMatchObject({ revoked: false, credentials: 'ok' });
    expect(h.db.raw.prepare('SELECT dek_wrapped FROM integrations WHERE id=?').get(id)).not.toEqual(before);

    h.fetchMock.mockClear();
    expect((await ingest(src)).status).toBe(202);
    await drainOutbox();
    expect(String(h.fetchMock.mock.calls[0]?.[0])).toBe(SLACK_NEW);
  });
});

describe('revoking a source credential (F40)', () => {
  it('turns the endpoint off, blocks re-enabling, and is lifted only by a new secret', async () => {
    const src = await createSource();
    await route(src.source.id);
    const path = `/api/sources/${src.source.id}`;
    expect((await ingest(src)).status).toBe(202);

    const res = await call('POST', `${path}/revoke-credentials`, {
      as: 'alice',
      body: { reason: 'compromised' },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ source: { revoked: boolean; enabled: boolean } }>()).source).toMatchObject({
      revoked: true,
      enabled: false,
    });
    // The burned secret gets nothing from ingress; the endpoint is off, so it is 410 Gone (F50).
    expect((await ingest(src)).status).toBe(410);
    expect((await call('PATCH', path, { as: 'alice', body: { enabled: true } })).status).toBe(422);
    expect(auditRows('source.credentials.revoke')).toHaveLength(1);
    // Idempotent: no second audit entry.
    expect((await call('POST', `${path}/revoke-credentials`, { as: 'alice' })).status).toBe(200);
    expect(auditRows('source.credentials.revoke')).toHaveLength(1);

    const rotated = await call('POST', `${path}/rotate`, { as: 'alice' });
    const next = await rotated.json<{ source: { revoked: boolean; enabled: boolean }; secret: string }>();
    expect(next.source).toMatchObject({ revoked: false, enabled: true });
    expect((await ingest(src, src.secret)).status).toBe(401);
    expect((await ingest(src, next.secret)).status).toBe(202);
  });

  it('is admin-only, CSRF-protected and tenant-scoped', async () => {
    const src = await createSource();
    const path = `/api/sources/${src.source.id}/revoke-credentials`;
    const denied = await call('POST', path, { as: 'bob' });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('source.revoke');
    expect((await call('POST', path, { as: 'alice', origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', path, { as: 'mallory' })).status).toBe(404);
    expect((await call('POST', path, { as: 'alice', body: { reason: 'x' } })).status).toBe(422);
    expect(auditRows('source.credentials.revoke')).toHaveLength(0);
  });

  it('refuses a request with no origin or for a missing source, leaves the row untouched, and audits the reason', async () => {
    const src = await createSource();
    const path = `/api/sources/${src.source.id}/revoke-credentials`;
    const state = () =>
      h.db.raw
        .prepare('SELECT enabled, credentials_revoked_at AS r FROM sources WHERE id=?')
        .get(src.source.id) as { enabled: number; r: string | null };
    expect((await call('POST', path, { as: 'alice', origin: null })).status).toBe(403);
    expect((await call('POST', path, { as: 'bob' })).status).toBe(403);
    expect((await call('POST', path, { as: 'mallory' })).status).toBe(404);
    expect((await call('POST', '/api/sources/missing/revoke-credentials', { as: 'alice' })).status).toBe(404);
    // Nothing above changed the row: another workspace cannot even switch it off.
    expect(state()).toEqual({ enabled: 1, r: null });
    expect(auditRows('source.credentials.revoke')).toHaveLength(0);

    const res = await call('POST', path, { as: 'alice', body: { reason: 'no_longer_used' } });
    expect(res.status).toBe(200);
    // The dashboard reads the fingerprint and revoked state from this response (ADR 0049).
    expect((await res.json<{ source: Created['source'] }>()).source).toMatchObject({
      revoked: true,
      credentialFingerprint: src.source.credentialFingerprint,
    });
    expect(state().enabled).toBe(0);
    const entries = auditRows('source.credentials.revoke');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.organization_id).toBe('org-a');
    expect(JSON.parse(entries[0]?.metadata_json ?? '{}')).toEqual({
      kind: 'generic',
      reason: 'no_longer_used',
    });
  });
});

describe('crypto-shredding on delete (F40)', () => {
  it('leaves nothing that can open a deleted connection’s ciphertext, even with the KEK', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    const row = h.db.raw
      .prepare('SELECT organization_id,key_salt,dek_wrapped,webhook_envelope FROM integrations WHERE id=?')
      .get(id) as Record<string, Uint8Array | string>;
    const saved = {
      salt: new Uint8Array(row.key_salt as Uint8Array),
      wrapped: new Uint8Array(row.dek_wrapped as Uint8Array),
      envelope: new Uint8Array(row.webhook_envelope as Uint8Array),
    };

    expect((await call('DELETE', `/api/integrations/${id}`, { as: 'alice' })).status).toBe(204);

    // 1. Neither the wrapped key, nor its salt, nor the ciphertext survives ANYWHERE in the database
    //    (audit log, outbox, deliveries included): the key material is not stored a second time.
    const hits = scanDatabase(h.db.raw, [
      { label: 'dek_wrapped', value: saved.wrapped },
      { label: 'key_salt', value: saved.salt },
      { label: 'webhook_envelope', value: saved.envelope },
    ]);
    expect(hits).toEqual([]);

    // 2. An attacker who kept a copy of the ciphertext and also holds the KEK still cannot open it:
    //    the data key is random, was only ever stored wrapped in the deleted row, and re-deriving
    //    "a" key (fresh salt, fresh DEK) yields one that fails the authentication tag.
    const keyring = keyringFromEnv(h.env);
    const guess = await createConnectionKeys(keyring, {
      orgId: 'org-a',
      connectionId: id,
      purpose: 'destination',
    });
    const ctx = { orgId: 'org-a', connectionId: id, field: 'url', purpose: 'destination' } as const;
    await expect(open(guess.dek, saved.envelope, ctx)).rejects.toMatchObject({
      code: 'destination_credentials_invalid',
    });
    // 3. Control: the same primitive opens a ciphertext sealed under that key, so the failure above
    //    is the missing key and not a broken test.
    const control = await seal(guess.dek, 'control', ctx);
    expect(await open(guess.dek, control, ctx)).toBe('control');
    // And the KEK alone, used directly as a data key, opens nothing.
    const kekAsKey = await crypto.subtle.importKey('raw', parseKeyHex(h.env.KEK_V1), 'AES-GCM', false, [
      'decrypt',
    ]);
    await expect(open(kekAsKey, saved.envelope, ctx)).rejects.toMatchObject({
      code: 'destination_credentials_invalid',
    });
    expect(createKeyring(1, new Map([[1, h.env.KEK_V1]])).activeVersion).toBe(1);
  });

  it('also holds for a source: deleting it removes the only copy of its wrapped key', async () => {
    const src = await createSource();
    const row = h.db.raw
      .prepare('SELECT key_salt,dek_wrapped,secret_envelope FROM sources WHERE id=?')
      .get(src.source.id) as Record<string, Uint8Array>;
    const needles = (['key_salt', 'dek_wrapped', 'secret_envelope'] as const).map((k) => ({
      label: k,
      value: new Uint8Array(row[k] as Uint8Array),
    }));
    expect((await call('DELETE', `/api/sources/${src.source.id}`, { as: 'alice' })).status).toBe(204);
    expect(scanDatabase(h.db.raw, needles)).toEqual([]);
  });
});
