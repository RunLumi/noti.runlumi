import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryMessage } from '../../src/env';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { DELIVERY_CLAIM_LEASE_MS } from '../../src/delivery/ledger';
import { credentialStatus } from '../../src/pipeline/credentials';
import { credentialFingerprint } from '../../src/crypto/fingerprint';
import { backfillRevokedFingerprints } from '../../src/pipeline/fingerprint-backfill';
import {
  SOURCE_DRAIN_MS,
  destroyIntegrationKey,
  destroyRevokedCredentials,
  destroySourceKey,
  INTEGRATION_KEY_DESTROY_SQL,
  INTEGRATION_KEY_DESTROYED_AUDIT_SQL,
  SELECT_INTEGRATIONS_TO_DESTROY_SQL,
} from '../../src/pipeline/credential-destroy';
import { EVENT, SLACK, caller, setup, signHeaders, type Harness } from '../sources/harness';
import { scanDatabase } from '../support/scan';

/**
 * Revoke, drain, destroy, audit (F40, ADR 0036): the sealed secret of a revoked connection is destroyed, not
 * merely refused, and the order is fixed.
 */
vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

let h: Harness;
const call = caller(worker, () => h);

/**
 * SQLite stamps `credentials_revoked_at` from the real clock while the suite pins `Date` to a fixed instant
 * (tests/setup/pin-clock.ts), up to a minute apart: a later "now" must clear that gap as well as the window.
 */
const CLOCK_SKEW_MS = 120_000;

const SLACK_NEW = 'https://hooks.slack.com/services/T000/B000/ReplacementTokenPath';

interface IntegrationView {
  id: string;
  credentials: string;
  revoked: boolean;
  keyDestroyed: boolean;
  credentialFingerprint: string | null;
}

async function createSource(): Promise<{ source: { id: string; endpointId: string }; secret: string }> {
  const res = await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI pipeline' } });
  expect(res.status).toBe(201);
  return res.json();
}

async function route(sourceId: string): Promise<string> {
  const res = await call('POST', '/api/integrations', {
    as: 'alice',
    body: { name: 'to slack', sourceId, destination: 'slack', webhookUrl: SLACK },
  });
  expect(res.status).toBe(201);
  return (await res.json<{ integration: { id: string } }>()).integration.id;
}

async function ingest(src: { source: { endpointId: string } }, secret: string): Promise<Response> {
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

const audit = (action: string) =>
  h.db.raw
    .prepare('SELECT actor_id, subject_id, organization_id, metadata_json FROM audit_events WHERE action=?')
    .all(action) as {
    actor_id: string | null;
    subject_id: string;
    organization_id: string;
    metadata_json: string;
  }[];

const integrationRow = (id: string) =>
  h.db.raw
    .prepare(
      `SELECT webhook_ciphertext,lark_secret_ciphertext,key_salt,dek_wrapped,kek_version,webhook_envelope,
              lark_secret_envelope,credential_fingerprint FROM integrations WHERE id=?`,
    )
    .get(id) as Record<string, unknown>;

beforeEach(() => {
  h = setup();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('revoking an integration destroys its key', () => {
  it('wipes every credential column in the revoke request, keeps the fingerprint, and audits key_destroyed once', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    const before = integrationRow(id);
    const saved = [
      { label: 'dek_wrapped', value: new Uint8Array(before.dek_wrapped as Uint8Array) },
      { label: 'key_salt', value: new Uint8Array(before.key_salt as Uint8Array) },
      { label: 'webhook_envelope', value: new Uint8Array(before.webhook_envelope as Uint8Array) },
    ];
    expect(saved.every((s) => s.value.length > 0)).toBe(true);

    const res = await call('POST', `/api/integrations/${id}/revoke-credentials`, {
      as: 'alice',
      body: { reason: 'compromised' },
    });
    expect(res.status).toBe(200);
    const { integration } = await res.json<{ integration: IntegrationView }>();
    expect(integration).toMatchObject({
      revoked: true,
      keyDestroyed: true,
      credentials: 'quarantined',
      credentialFingerprint: before.credential_fingerprint,
    });
    expect(integration.credentialFingerprint).toMatch(/^[A-Z2-7]{8}$/);

    expect(integrationRow(id)).toEqual({
      webhook_ciphertext: '',
      lark_secret_ciphertext: null,
      key_salt: null,
      dek_wrapped: null,
      kek_version: null,
      webhook_envelope: null,
      lark_secret_envelope: null,
      credential_fingerprint: before.credential_fingerprint,
    });
    // Nowhere in the database: not the row, the outbox, the deliveries or the audit log.
    expect(scanDatabase(h.db.raw, saved)).toEqual([]);

    const events = audit('integration.key_destroyed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_id: 'alice', subject_id: id, organization_id: 'org-a' });
    expect(JSON.parse(events[0]?.metadata_json ?? '{}')).toEqual({
      kekVersion: 1,
      trigger: 'revoke',
      destinationHost: 'hooks.slack.com',
    });
    expect(audit('integration.credentials.revoke')).toHaveLength(1);
  });

  it('is idempotent: a second revoke, or a second destroy, is a no-op that writes no second event', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    const path = `/api/integrations/${id}/revoke-credentials`;
    await call('POST', path, { as: 'alice' });
    expect((await call('POST', path, { as: 'alice' })).status).toBe(200);
    expect(
      await destroyIntegrationKey(h.env.DB, 'org-a', id, Date.now(), { actorId: null, trigger: 'sweep' }),
    ).toBe('deferred');
    expect(audit('integration.key_destroyed')).toHaveLength(1);
    expect(audit('integration.credentials.revoke')).toHaveLength(1);
  });

  it('is scoped to the workspace: another workspace cannot destroy or even reach it', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect((await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'mallory' })).status).toBe(
      404,
    );
    // A destroy for the wrong organization matches nothing, whatever the row says.
    const second = await createSource();
    const other = await route(second.source.id);
    await call('POST', `/api/integrations/${other}/revoke-credentials`, { as: 'alice' });
    h.db.raw.prepare("UPDATE integrations SET dek_wrapped=x'01' WHERE id=?").run(other);
    expect(
      await destroyIntegrationKey(h.env.DB, 'org-b', other, Date.now(), { actorId: null, trigger: 'sweep' }),
    ).toBe('deferred');
    expect(integrationRow(other).dek_wrapped).not.toBeNull();
  });

  it('never destroys a connection that was not revoked', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    expect(
      await destroyIntegrationKey(h.env.DB, 'org-a', id, Date.now(), { actorId: null, trigger: 'sweep' }),
    ).toBe('deferred');
    expect(integrationRow(id).dek_wrapped).not.toBeNull();
    expect((await destroyRevokedCredentials(h.env.DB, Date.now())).integrations).toBe(0);
    expect(audit('integration.key_destroyed')).toEqual([]);
  });
});

describe('drain before destroy', () => {
  const claim = (id: string, claimedAt: number) =>
    h.db.raw
      .prepare(
        `INSERT INTO deliveries(id,integration_id,organization_id,state,claimed_at,claim_token,created_at)
         VALUES('live',?,'org-a','claimed',?,'tok','2026')`,
      )
      .run(id, claimedAt);

  it('revokes at once but keeps the key while a consumer holds a live claim, then the sweep finishes it', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    claim(id, Date.now());
    const res = await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    const { integration } = await res.json<{ integration: IntegrationView }>();
    // Stopped immediately: nothing new can open the secret.
    expect(integration).toMatchObject({ revoked: true, keyDestroyed: false });
    expect(integrationRow(id).dek_wrapped).not.toBeNull();
    expect(audit('integration.key_destroyed')).toEqual([]);
    expect(await credentialStatus(h.env.DB, 1)).toMatchObject({ revoked: 1, revokedKeysRemaining: 1 });

    // The sweep defers while the claim is live ...
    expect(await destroyRevokedCredentials(h.env.DB, Date.now())).toEqual({
      integrations: 0,
      sources: 0,
      deferred: 1,
      failed: 0,
      awaitingFingerprint: 0,
    });
    // ... and destroys once it has finished.
    h.db.raw
      .prepare("UPDATE deliveries SET state='sent', claimed_at=NULL, claim_token=NULL WHERE id='live'")
      .run();
    expect(await destroyRevokedCredentials(h.env.DB, Date.now())).toEqual({
      integrations: 1,
      sources: 0,
      deferred: 0,
      failed: 0,
      awaitingFingerprint: 0,
    });
    expect(integrationRow(id).dek_wrapped).toBeNull();
    const events = audit('integration.key_destroyed');
    expect(events).toHaveLength(1);
    // The sweep has no person: the actor and reason are on the paired revoke event for the same subject.
    expect(events[0]).toMatchObject({ actor_id: null, subject_id: id });
    expect(JSON.parse(events[0]?.metadata_json ?? '{}')).toMatchObject({ trigger: 'sweep', kekVersion: 1 });
    expect(await credentialStatus(h.env.DB, 1)).toMatchObject({ revokedKeysRemaining: 0 });
  });

  it('a claim older than the lease is a dead consumer and does not hold the key forever', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    claim(id, Date.now() - DELIVERY_CLAIM_LEASE_MS - 1000);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect(integrationRow(id).dek_wrapped).toBeNull();
  });

  it('repeating the revoke finishes a destroy the first call had to defer', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    claim(id, Date.now());
    const path = `/api/integrations/${id}/revoke-credentials`;
    await call('POST', path, { as: 'alice' });
    h.db.raw.prepare("UPDATE deliveries SET state='sent', claimed_at=NULL WHERE id='live'").run();
    const again = await call('POST', path, { as: 'alice' });
    expect((await again.json<{ integration: IntegrationView }>()).integration.keyDestroyed).toBe(true);
    expect(audit('integration.key_destroyed')).toHaveLength(1);
    expect(audit('integration.credentials.revoke')).toHaveLength(1);
  });

  it('the audit and the wipe share one predicate, so the event exists exactly when the wipe did', () => {
    const predicate = (sql: string) =>
      /WHERE[\s\S]*$/
        .exec(sql)?.[0]
        .replace(/\s+/g, ' ')
        .replace(/^WHERE id = \?1 AND organization_id = \?2 /, '')
        // Each statement numbers its own fingerprint flag; the clause is the same.
        .replace(/\?[47]\b/, '?F');
    expect(predicate(INTEGRATION_KEY_DESTROYED_AUDIT_SQL)).toBe(predicate(INTEGRATION_KEY_DESTROY_SQL));
    // The sweep's candidate query uses the same "revoked and still holding key material" clauses.
    const material =
      "(dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL)";
    for (const sql of [INTEGRATION_KEY_DESTROY_SQL, SELECT_INTEGRATIONS_TO_DESTROY_SQL])
      expect(sql.replace(/\s+/g, ' ')).toContain(material);
  });
});

describe('a message for a revoked connection (destination_revoked)', () => {
  it('is dead-lettered as destination_revoked, permanent, with no request and no decryption', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    expect((await ingest(src, src.secret)).status).toBe(202);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });

    h.fetchMock.mockClear();
    await drainOutbox();
    expect(h.fetchMock).not.toHaveBeenCalled();
    const delivery = h.db.raw
      .prepare('SELECT state,last_error_code,last_error,attempts FROM deliveries WHERE integration_id=?')
      .get(id) as { state: string; last_error_code: string; last_error: string; attempts: number };
    expect(delivery).toMatchObject({
      state: 'dead_lettered',
      last_error_code: 'destination_revoked',
      last_error: 'credentials_revoked',
    });
    expect(delivery.last_error).not.toBe('integration_unavailable');
  });

  it('reports a paused or missing integration as before, not as revoked', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    expect((await ingest(src, src.secret)).status).toBe(202);
    h.db.raw.prepare('UPDATE integrations SET enabled=0 WHERE id=?').run(id);
    await drainOutbox();
    expect(
      h.db.raw
        .prepare('SELECT last_error_code AS c, last_error AS e FROM deliveries WHERE integration_id=?')
        .get(id),
    ).toEqual({ c: 'config_invalid', e: 'integration_unavailable' });
  });

  it('shows a revoked integration in the delivery view with its fingerprint, and offers no replay', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    expect((await ingest(src, src.secret)).status).toBe(202);
    const fingerprint = integrationRow(id).credential_fingerprint;
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    await drainOutbox();
    const list = await call('GET', '/api/deliveries', { as: 'alice' });
    const body = await list.json<{
      deliveries: {
        integrationStatus: string;
        canReplay: boolean;
        integration: { credentialFingerprint: string | null };
        error: { code: string } | null;
      }[];
    }>();
    expect(body.deliveries[0]).toMatchObject({
      integrationStatus: 'revoked',
      canReplay: false,
      integration: { credentialFingerprint: fingerprint },
      error: { code: 'destination_revoked' },
    });
  });
});

describe('entering a credential after the key was destroyed', () => {
  it('refuses the burned value again by its fingerprint, and accepts a new one', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect(integrationRow(id).dek_wrapped).toBeNull();

    const same = await call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { webhookUrl: SLACK } });
    expect(same.status).toBe(422);
    expect(await same.text()).toContain('revoked');
    expect(integrationRow(id).dek_wrapped).toBeNull();

    // A member who is not allowed to revoke cannot lift it either.
    const member = await call('PATCH', `/api/integrations/${id}`, {
      as: 'bob',
      body: { webhookUrl: SLACK_NEW },
    });
    expect(member.status).toBe(403);

    const fresh = await call('PATCH', `/api/integrations/${id}`, {
      as: 'alice',
      body: { webhookUrl: SLACK_NEW },
    });
    expect(fresh.status).toBe(200);
    expect((await fresh.json<{ integration: IntegrationView }>()).integration).toMatchObject({
      revoked: false,
      keyDestroyed: false,
      credentials: 'ok',
    });
    expect(integrationRow(id).dek_wrapped).not.toBeNull();
    h.fetchMock.mockClear();
    expect((await ingest(src, src.secret)).status).toBe(202);
    await drainOutbox();
    expect(String(h.fetchMock.mock.calls[0]?.[0])).toBe(SLACK_NEW);
  });

  it('without a fingerprint key the destroy waits (outside development): the sealed value still refuses the burned one', async () => {
    delete (h.env as { FINGERPRINT_KEY?: string }).FINGERPRINT_KEY;
    const src = await createSource();
    const id = await route(src.source.id);
    expect(integrationRow(id).credential_fingerprint).toBeNull();
    const res = await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    const { integration } = await res.json<{ integration: IntegrationView }>();
    // Revoked and unusable, but NOT destroyed: nothing could recognise the burned value afterwards.
    expect(integration).toMatchObject({ revoked: true, keyDestroyed: false });
    expect(integrationRow(id).dek_wrapped).not.toBeNull();
    expect(audit('integration.key_destroyed')).toEqual([]);
    expect(await destroyRevokedCredentials(h.env.DB, Date.now())).toMatchObject({
      integrations: 0,
      deferred: 1,
      awaitingFingerprint: 1,
    });
    // Still refused, by comparing with the value that has not been destroyed.
    const same = await call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { webhookUrl: SLACK } });
    expect(same.status).toBe(422);
    expect(await credentialStatus(h.env.DB, 1)).toMatchObject({ revokedKeysRemaining: 1 });
  });

  it('in development the destroy does not wait for a fingerprint (nothing to protect)', async () => {
    delete (h.env as { FINGERPRINT_KEY?: string }).FINGERPRINT_KEY;
    const src = await createSource();
    const id = await route(src.source.id);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect(integrationRow(id).dek_wrapped).not.toBeNull();
    const report = await destroyRevokedCredentials(h.env.DB, Date.now(), { requireFingerprint: false });
    expect(report.integrations).toBe(1);
    expect(integrationRow(id).dek_wrapped).toBeNull();
  });

  it('computes and stores a missing fingerprint at revoke time, then destroys', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    // Sealed before fingerprints existed: no fingerprint stored.
    h.db.raw.prepare('UPDATE integrations SET credential_fingerprint=NULL WHERE id=?').run(id);
    const res = await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    const { integration } = await res.json<{ integration: IntegrationView }>();
    expect(integration).toMatchObject({ keyDestroyed: true });
    expect(integration.credentialFingerprint).toBe(
      await credentialFingerprint(SLACK, 'org-a', h.env.FINGERPRINT_KEY),
    );
    const same = await call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { webhookUrl: SLACK } });
    expect(same.status).toBe(422);
  });

  it('the sweep backfills a missing fingerprint of a deferred revoke, then destroys it', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    h.db.raw.prepare('UPDATE integrations SET credential_fingerprint=NULL WHERE id=?').run(id);
    h.db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state,claimed_at,claim_token,created_at) VALUES('live',?,'org-a','claimed',?,'tok','2026')",
      )
      .run(id, Date.now());
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect(integrationRow(id).dek_wrapped).not.toBeNull();
    // The revoke already backfilled it; clear it again to exercise the scheduled path.
    h.db.raw.prepare('UPDATE integrations SET credential_fingerprint=NULL WHERE id=?').run(id);
    h.db.raw.prepare("UPDATE deliveries SET state='sent', claimed_at=NULL WHERE id='live'").run();
    expect(await backfillRevokedFingerprints(h.env)).toBe(1);
    expect((await destroyRevokedCredentials(h.env.DB, Date.now())).integrations).toBe(1);
    expect(integrationRow(id).credential_fingerprint).not.toBeNull();
  });
});

describe('the kept originals of migration 0026 (integrations_old)', () => {
  const copyToOld = (id: string) =>
    h.db.raw.prepare('INSERT INTO integrations_old SELECT * FROM integrations WHERE id=?').run(id);
  const oldRow = (id: string) =>
    h.db.raw
      .prepare(
        'SELECT dek_wrapped,key_salt,webhook_envelope,webhook_ciphertext FROM integrations_old WHERE id=?',
      )
      .get(id) as Record<string, unknown> | undefined;

  it('revoke wipes the kept copy in the same destroy, so no secret survives in either table', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    const before = integrationRow(id);
    copyToOld(id);
    expect(oldRow(id)?.dek_wrapped).not.toBeNull();
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect(oldRow(id)).toEqual({
      dek_wrapped: null,
      key_salt: null,
      webhook_envelope: null,
      webhook_ciphertext: '',
    });
    expect(
      scanDatabase(h.db.raw, [
        { label: 'dek_wrapped', value: new Uint8Array(before.dek_wrapped as Uint8Array) },
        { label: 'webhook_envelope', value: new Uint8Array(before.webhook_envelope as Uint8Array) },
      ]),
    ).toEqual([]);
  });

  it('a kept copy of an unrevoked connection is left alone', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    copyToOld(id);
    await destroyRevokedCredentials(h.env.DB, Date.now());
    expect(oldRow(id)?.dek_wrapped).not.toBeNull();
  });

  it('the sweep wipes a kept copy of a connection that was already destroyed', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    // A copy that reappears afterwards (a restore, a late snapshot) is wiped by the next sweep.
    h.db.raw
      .prepare(
        "INSERT INTO integrations_old(id,repo,event_types,destination,webhook_ciphertext,organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope) VALUES('stale','r','[]','slack','x','org-a',x'01',x'02',1,x'03')",
      )
      .run();
    h.db.raw.prepare("UPDATE integrations_old SET id=? WHERE id='stale'").run(id);
    await destroyRevokedCredentials(h.env.DB, Date.now());
    expect(oldRow(id)).toMatchObject({ dek_wrapped: null, webhook_ciphertext: '' });
  });

  it('migration-0026-recover re-applies the revoke and the wipe to the restored original', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    const keep = await createSource();
    const keepId = await route(keep.source.id);
    // The pre-swap original holds both secrets; afterwards one is revoked (and destroyed) on the live table.
    copyToOld(id);
    copyToOld(keepId);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    // Put the pre-revoke copy back, as it was kept (the wipe above had cleaned it, so restore it by hand).
    h.db.raw.prepare('DELETE FROM integrations_old WHERE id=?').run(id);
    // Seed the live, pre-wipe copy of the revoked row from the unrevoked sibling's shape: recreate from the sibling.
    h.db.raw
      .prepare(
        'INSERT INTO integrations_old SELECT ?, repo,event_types,destination,webhook_ciphertext,enabled,lark_secret_ciphertext,organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,NULL,NULL,name,destination_host,created_by,created_at,updated_at,filters_json,source_id,noise_json,credential_fingerprint FROM integrations_old WHERE id=?',
      )
      .run(id, keepId);
    expect(oldRow(id)?.dek_wrapped).not.toBeNull();

    const raw = h.db.raw;
    const executor = {
      query: (sql: string) => Promise.resolve(raw.prepare(sql).all() as Record<string, unknown>[]),
      run: (statements: string[]) => {
        for (const sql of statements) raw.exec(sql);
        return Promise.resolve();
      },
    };
    const scriptPath = '../../scripts/migration-0026-recover.mjs';
    const recover = (await import(/* @vite-ignore */ scriptPath)) as {
      planRecovery: (
        e: typeof executor,
        o: { discardLiveChanges: boolean },
      ) => Promise<{ statements: string[]; restored: string[]; blockers: string[] }>;
    };
    const plan = await recover.planRecovery(executor, { discardLiveChanges: true });
    expect(plan.blockers).toEqual([]);
    expect(plan.restored).toContain('integrations');
    await executor.run(plan.statements);

    const revoked = raw
      .prepare(
        'SELECT credentials_quarantine_reason AS r, credentials_quarantined_at AS q, dek_wrapped, webhook_envelope, webhook_ciphertext AS c FROM integrations WHERE id=?',
      )
      .get(id) as Record<string, unknown>;
    expect(revoked).toMatchObject({ r: 'revoked', dek_wrapped: null, webhook_envelope: null, c: '' });
    expect(revoked.q).not.toBeNull();
    // The sibling that was never revoked is restored intact, and the scratch table is gone.
    expect(
      (raw.prepare('SELECT dek_wrapped FROM integrations WHERE id=?').get(keepId) as Record<string, unknown>)
        .dek_wrapped,
    ).not.toBeNull();
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='_recover_revoked'").get(),
    ).toEqual({ n: 0 });
  });

  it('kek-destroy-check counts the kept copy, so a KEK version it still uses cannot be destroyed', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    copyToOld(id);
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    // Live is wiped; make the kept copy depend on KEK v1 in the real envelope layout.
    const envelope = new Uint8Array(64);
    envelope[0] = 1;
    new DataView(envelope.buffer).setUint32(2, 1, false);
    h.db.raw.prepare('UPDATE integrations_old SET dek_wrapped=?, kek_version=1 WHERE id=?').run(envelope, id);
    const scriptPath = '../../scripts/kek-destroy-check.mjs';
    const script = (await import(/* @vite-ignore */ scriptPath)) as {
      destroyCheckSql: (v: number, o?: { legacyOld?: boolean }) => string;
      destroyAuditSql: (e: Record<string, unknown>) => string;
    };
    expect(h.db.raw.prepare(script.destroyCheckSql(1)).get()).toEqual({ integrations: 0, sources: 1 });
    expect(h.db.raw.prepare(script.destroyCheckSql(1, { legacyOld: true })).get()).toEqual({
      integrations: 1,
      sources: 1,
    });
    const audit = script.destroyAuditSql({
      version: 1,
      active: 2,
      actor: 'ops',
      reason: 'retired',
      legacyOld: true,
    });
    h.db.raw.exec(audit);
    expect(
      h.db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='key.destroy'").get(),
    ).toEqual({ n: 0 });
  });
});

describe('the destroy needs no key and survives a failing neighbour (M1)', () => {
  it('wipes even when the rest of credential maintenance aborts (every legacy row fails)', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    // A live claim defers the destroy at revoke time.
    h.db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state,claimed_at,claim_token,created_at) VALUES('live',?,'org-a','claimed',?,'tok','2026')",
      )
      .run(id, Date.now());
    await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect(integrationRow(id).dek_wrapped).not.toBeNull();
    h.db.raw.prepare("UPDATE deliveries SET state='sent', claimed_at=NULL WHERE id='live'").run();
    // Two undecryptable v0 rows: the migration step aborts with every_row_failed.
    for (const n of ['a', 'b'])
      h.db.raw
        .prepare(
          "INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES(?,?, '[]','slack','not-a-ciphertext','org-a')",
        )
        .run(`legacy-${n}`, `r/${n}`);
    (h.env as { ENCRYPTION_KEY: string }).ENCRYPTION_KEY = 'aa'.repeat(32);
    await expect(worker.scheduled({} as ScheduledEvent, h.env)).rejects.toThrow();
    expect(integrationRow(id).dek_wrapped).toBeNull();
    expect(audit('integration.key_destroyed')).toHaveLength(1);
  });

  it('one row failing does not stop the others, and is counted', async () => {
    const a = await createSource();
    const b = await createSource();
    const idA = await route(a.source.id);
    const idB = await route(b.source.id);
    for (const id of [idA, idB]) {
      h.db.raw
        .prepare(
          "INSERT INTO deliveries(id,integration_id,organization_id,state,claimed_at,claim_token,created_at) VALUES(?,?,'org-a','claimed',?,'tok','2026')",
        )
        .run(`live-${id}`, id, Date.now());
      await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    }
    h.db.raw.prepare("UPDATE deliveries SET state='sent', claimed_at=NULL").run();
    let batches = 0;
    const real = h.env.DB;
    const flaky = {
      prepare: real.prepare.bind(real),
      batch: (statements: D1PreparedStatement[]) => {
        batches++;
        if (batches === 1) throw new Error('boom');
        return real.batch(statements);
      },
    } as unknown as D1Database;
    const report = await destroyRevokedCredentials(flaky, Date.now());
    expect(report).toMatchObject({ failed: 1, integrations: 1 });
    expect(
      [integrationRow(idA).dek_wrapped, integrationRow(idB).dek_wrapped].filter((v) => v === null),
    ).toHaveLength(1);
  });
});

describe('PATCH races a revoke (L1)', () => {
  it('a rotation that read the row before a revoke does not clear it, and writes no false audit', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    // Revoke lands between the PATCH reading the row and writing it: simulate by revoking at the database
    // when the PATCH's own UPDATE is about to run.
    const real = h.env.DB;
    let armed = true;
    h.env.DB = {
      prepare: (sql: string) => {
        if (armed && /^UPDATE integrations SET updated_at=CURRENT_TIMESTAMP,/.test(sql.trim())) {
          armed = false;
          void real
            .prepare(
              "UPDATE integrations SET credentials_quarantined_at=CURRENT_TIMESTAMP, credentials_quarantine_reason='revoked' WHERE id=?",
            )
            .bind(id)
            .run();
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const res = await call('PATCH', `/api/integrations/${id}`, {
      as: 'alice',
      body: { webhookUrl: SLACK_NEW },
    });
    h.env.DB = real;
    expect(res.status).toBe(409);
    expect(
      h.db.raw.prepare('SELECT credentials_quarantine_reason AS r FROM integrations WHERE id=?').get(id),
    ).toEqual({ r: 'revoked' });
    expect(audit('integration.credentials.rotate')).toEqual([]);
  });

  it('a source cannot be switched on by a request that read it before the revoke', async () => {
    const src = await createSource();
    await call('PATCH', `/api/sources/${src.source.id}`, { as: 'alice', body: { enabled: false } });
    const real = h.env.DB;
    let armed = true;
    h.env.DB = {
      prepare: (sql: string) => {
        if (armed && /^UPDATE sources SET updated_at=CURRENT_TIMESTAMP,/.test(sql.trim())) {
          armed = false;
          void real
            .prepare('UPDATE sources SET credentials_revoked_at=CURRENT_TIMESTAMP WHERE id=?')
            .bind(src.source.id)
            .run();
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const res = await call('PATCH', `/api/sources/${src.source.id}`, {
      as: 'alice',
      body: { enabled: true },
    });
    h.env.DB = real;
    expect(res.status).toBe(409);
    expect(h.db.raw.prepare('SELECT enabled FROM sources WHERE id=?').get(src.source.id)).toEqual({
      enabled: 0,
    });
  });
});
describe('revoking a source destroys its key after the drain window', () => {
  const sourceRow = (id: string) =>
    h.db.raw
      .prepare(
        'SELECT length(secret_envelope) AS e, length(key_salt) AS s, length(dek_wrapped) AS d, kek_version AS k, credential_fingerprint AS f FROM sources WHERE id=?',
      )
      .get(id) as { e: number; s: number; d: number; k: number; f: string | null };

  it('revokes and turns the endpoint off at once, and wipes the key once the window has passed', async () => {
    const src = await createSource();
    const before = sourceRow(src.source.id);
    expect(before.d).toBeGreaterThan(0);
    const res = await call('POST', `/api/sources/${src.source.id}/revoke-credentials`, {
      as: 'alice',
      body: { reason: 'compromised' },
    });
    expect((await res.json<{ source: { revoked: boolean; keyDestroyed: boolean } }>()).source).toMatchObject({
      revoked: true,
      keyDestroyed: false,
    });
    expect((await ingest(src, src.secret)).status).toBe(410);
    expect(sourceRow(src.source.id).d).toBeGreaterThan(0);
    expect(audit('source.key_destroyed')).toEqual([]);

    // Inside the window nothing happens.
    expect(await destroyRevokedCredentials(h.env.DB, Date.now())).toMatchObject({ sources: 0, deferred: 1 });
    // After it the sweep wipes the key.
    const later = Date.now() + SOURCE_DRAIN_MS + CLOCK_SKEW_MS;
    expect(await destroyRevokedCredentials(h.env.DB, later)).toEqual({
      integrations: 0,
      sources: 1,
      deferred: 0,
      failed: 0,
      awaitingFingerprint: 0,
    });
    expect(sourceRow(src.source.id)).toEqual({ e: 0, s: 0, d: 0, k: 0, f: before.f });
    const events = audit('source.key_destroyed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_id: null, subject_id: src.source.id, organization_id: 'org-a' });
    expect(JSON.parse(events[0]?.metadata_json ?? '{}')).toEqual({
      kekVersion: 1,
      trigger: 'sweep',
      kind: 'generic',
    });
    // A second sweep, or a repeated destroy, writes nothing more.
    expect(await destroyRevokedCredentials(h.env.DB, later + 1000)).toEqual({
      integrations: 0,
      sources: 0,
      deferred: 0,
      failed: 0,
      awaitingFingerprint: 0,
    });
    expect(
      await destroySourceKey(h.env.DB, 'org-a', src.source.id, later, {
        actorId: 'alice',
        trigger: 'revoke',
      }),
    ).toBe('deferred');
    expect(audit('source.key_destroyed')).toHaveLength(1);
    const view = await call('GET', `/api/sources/${src.source.id}`, { as: 'alice' });
    expect((await view.json<{ source: { keyDestroyed: boolean } }>()).source.keyDestroyed).toBe(true);
  });

  it('lets a new secret be rotated in after the destroy, and the new secret verifies', async () => {
    const src = await createSource();
    await call('POST', `/api/sources/${src.source.id}/revoke-credentials`, { as: 'alice' });
    await destroyRevokedCredentials(h.env.DB, Date.now() + SOURCE_DRAIN_MS + CLOCK_SKEW_MS);
    expect(sourceRow(src.source.id).d).toBe(0);
    const rotated = await call('POST', `/api/sources/${src.source.id}/rotate`, { as: 'alice' });
    expect(rotated.status).toBe(200);
    const next = await rotated.json<{
      source: { revoked: boolean; enabled: boolean; keyDestroyed: boolean };
      secret: string;
    }>();
    expect(next.source).toMatchObject({ revoked: false, enabled: true, keyDestroyed: false });
    expect(sourceRow(src.source.id).d).toBeGreaterThan(0);
    expect((await ingest(src, src.secret)).status).toBe(401);
    expect((await ingest(src, next.secret)).status).toBe(202);
  });

  it('does not break the KEK rewrap job, and no longer counts toward a KEK version the operator wants to destroy', async () => {
    const src = await createSource();
    await call('POST', `/api/sources/${src.source.id}/revoke-credentials`, { as: 'alice' });
    await destroyRevokedCredentials(h.env.DB, Date.now() + SOURCE_DRAIN_MS + CLOCK_SKEW_MS);
    const { rewrapStaleSourceKeys } = await import('../../src/connectors/sources/generic/secret');
    const { keyringFromEnv } = await import('../../src/crypto/keyring-env');
    // Active version 2 makes every row "stale": a wiped row must be skipped, not crash the job.
    const ring = keyringFromEnv({ ...h.env, KEK_V2: '22'.repeat(32), KMS_ACTIVE_VERSION: '2' });
    await expect(rewrapStaleSourceKeys(h.env.DB, ring)).resolves.toBe(0);
    const scriptPath = '../../scripts/kek-destroy-check.mjs';
    const script = (await import(/* @vite-ignore */ scriptPath)) as {
      destroyCheckSql: (v: number) => string;
    };
    expect(h.db.raw.prepare(script.destroyCheckSql(1)).get()).toEqual({ integrations: 0, sources: 0 });
  });
});
