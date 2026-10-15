import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destroyRevokedCredentials } from '../../src/pipeline/credential-destroy';
import { SLACK, caller, setup, type Harness } from '../sources/harness';

/**
 * A revoked secret that cannot get a fingerprint is never wiped by the sweep (ADR 0036, review M-a): it is
 * counted, shown to the operator, and wiped by `scripts/force-destroy-revoked.mjs`. Also: deleting an
 * integration removes its kept `integrations_old` copy.
 */
vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

interface Script {
  forceDestroyStatements: (e: {
    kind: 'integration' | 'source';
    id: string;
    organizationId: string;
    actor: string;
    nowMs?: number;
    legacyOld?: boolean;
  }) => string[];
}
const scriptPath = '../../scripts/force-destroy-revoked.mjs';
const script = (await import(/* @vite-ignore */ scriptPath)) as Script;

let h: Harness;
const call = caller(worker, () => h);

async function createSource(): Promise<{ source: { id: string }; secret: string }> {
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

const row = (id: string) =>
  h.db.raw
    .prepare('SELECT dek_wrapped, webhook_envelope, webhook_ciphertext AS c FROM integrations WHERE id=?')
    .get(id) as { dek_wrapped: unknown; webhook_envelope: unknown; c: string } | undefined;

const audit = (action: string) =>
  h.db.raw
    .prepare('SELECT actor_id, subject_id, organization_id, metadata_json FROM audit_events WHERE action=?')
    .all(action) as {
    actor_id: string;
    subject_id: string;
    organization_id: string;
    metadata_json: string;
  }[];

function run(statements: string[]): void {
  for (const sql of statements) h.db.raw.exec(sql);
}

/** A revoked integration with no fingerprint and no way to get one: the sweep will never wipe it. */
async function stuckIntegration(): Promise<string> {
  delete (h.env as { FINGERPRINT_KEY?: string }).FINGERPRINT_KEY;
  const src = await createSource();
  const id = await route(src.source.id);
  await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
  expect(row(id)?.dek_wrapped).not.toBeNull();
  return id;
}

beforeEach(() => {
  h = setup();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a revoked secret that cannot be wiped by the sweep is visible', () => {
  it('is counted as deferred and awaiting a fingerprint, never as "0 deferred"', async () => {
    await stuckIntegration();
    const report = await destroyRevokedCredentials(h.env.DB, Date.now());
    expect(report).toMatchObject({ integrations: 0, awaitingFingerprint: 1, deferred: 1 });
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((l) => l.includes('revoked_secret_awaiting_fingerprint'))).toBe(true);
  });

  it('is shown to the platform operator in the readiness view', async () => {
    await stuckIntegration();
    (h.env as { PLATFORM_OPERATOR_USER_IDS?: string }).PLATFORM_OPERATOR_USER_IDS = 'alice';
    const res = await call('GET', '/api/observability/readiness', { as: 'alice' });
    expect(res.status).toBe(200);
    const body = await res.json<{ warnings: string[]; revokedSecretsAwaitingFingerprint: number }>();
    expect(body.revokedSecretsAwaitingFingerprint).toBe(1);
    expect(body.warnings).toContain('revoked_secrets_not_wiped');
  });
});

describe('scripts/force-destroy-revoked.mjs', () => {
  it('wipes the stuck secret, audits it as an operator action, and the sweep then reports nothing waiting', async () => {
    const id = await stuckIntegration();
    run(
      script.forceDestroyStatements({
        kind: 'integration',
        id,
        organizationId: 'org-a',
        actor: 'ops@example.test',
      }),
    );
    expect(row(id)).toEqual({ dek_wrapped: null, webhook_envelope: null, c: '' });
    const events = audit('integration.key_destroyed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_id: 'ops@example.test',
      subject_id: id,
      organization_id: 'org-a',
    });
    expect(JSON.parse(events[0]?.metadata_json ?? '{}')).toMatchObject({
      trigger: 'operator',
      reason: 'destroyed_without_fingerprint',
      kekVersion: 1,
    });
    expect((await destroyRevokedCredentials(h.env.DB, Date.now())).awaitingFingerprint).toBe(0);
    // Running it again is a no-op and writes no second event.
    run(
      script.forceDestroyStatements({
        kind: 'integration',
        id,
        organizationId: 'org-a',
        actor: 'ops@example.test',
      }),
    );
    expect(audit('integration.key_destroyed')).toHaveLength(1);
  });

  it('refuses a connection that is not revoked, and another workspace’s', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    run(script.forceDestroyStatements({ kind: 'integration', id, organizationId: 'org-a', actor: 'ops' }));
    expect(row(id)?.dek_wrapped).not.toBeNull();
    const stuck = await stuckIntegration();
    run(
      script.forceDestroyStatements({
        kind: 'integration',
        id: stuck,
        organizationId: 'org-b',
        actor: 'ops',
      }),
    );
    expect(row(stuck)?.dek_wrapped).not.toBeNull();
    expect(audit('integration.key_destroyed')).toEqual([]);
  });

  it('waits for a live delivery claim (the drain), then proceeds', async () => {
    const id = await stuckIntegration();
    h.db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state,claimed_at,claim_token,created_at) VALUES('live',?,'org-a','claimed',?,'tok','2026')",
      )
      .run(id, Date.now());
    const statements = script.forceDestroyStatements({
      kind: 'integration',
      id,
      organizationId: 'org-a',
      actor: 'ops',
    });
    run(statements);
    expect(row(id)?.dek_wrapped).not.toBeNull();
    h.db.raw.prepare("UPDATE deliveries SET state='sent', claimed_at=NULL WHERE id='live'").run();
    run(script.forceDestroyStatements({ kind: 'integration', id, organizationId: 'org-a', actor: 'ops' }));
    expect(row(id)?.dek_wrapped).toBeNull();
  });

  it('also wipes the kept integrations_old copy', async () => {
    const id = await stuckIntegration();
    h.db.raw.prepare('INSERT INTO integrations_old SELECT * FROM integrations WHERE id=?').run(id);
    run(
      script.forceDestroyStatements({
        kind: 'integration',
        id,
        organizationId: 'org-a',
        actor: 'ops',
        legacyOld: true,
      }),
    );
    expect(h.db.raw.prepare('SELECT dek_wrapped FROM integrations_old WHERE id=?').get(id)).toEqual({
      dek_wrapped: null,
    });
  });

  it('wipes a revoked source once the drain window has passed, and refuses an unrevoked one', async () => {
    const src = await createSource();
    run(
      script.forceDestroyStatements({
        kind: 'source',
        id: src.source.id,
        organizationId: 'org-a',
        actor: 'ops',
      }),
    );
    const len = () =>
      h.db.raw.prepare('SELECT length(dek_wrapped) AS d FROM sources WHERE id=?').get(src.source.id) as {
        d: number;
      };
    expect(len().d).toBeGreaterThan(0);
    await call('POST', `/api/sources/${src.source.id}/revoke-credentials`, { as: 'alice' });
    h.db.raw
      .prepare("UPDATE sources SET credentials_revoked_at='2000-01-01 00:00:00' WHERE id=?")
      .run(src.source.id);
    run(
      script.forceDestroyStatements({
        kind: 'source',
        id: src.source.id,
        organizationId: 'org-a',
        actor: 'ops',
      }),
    );
    expect(len().d).toBe(0);
    expect(audit('source.key_destroyed')).toHaveLength(1);
  });

  it('rejects hostile ids, organizations and actors before building any SQL', () => {
    const base = { kind: 'integration' as const, id: 'i1', organizationId: 'org-a', actor: 'ops' };
    for (const bad of [
      { id: "x'; DROP TABLE integrations; --" },
      { organizationId: "o' OR '1'='1" },
      { actor: "ops'); DELETE FROM audit_events; --" },
      { id: '' },
    ])
      expect(() => script.forceDestroyStatements({ ...base, ...bad })).toThrow();
  });
});

describe('deleting an integration while migration 0026 is not finalized', () => {
  it('removes the kept integrations_old copy in the same batch', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    h.db.raw.prepare('INSERT INTO integrations_old SELECT * FROM integrations WHERE id=?').run(id);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM integrations_old WHERE id=?').get(id)).toEqual({
      n: 1,
    });
    expect((await call('DELETE', `/api/integrations/${id}`, { as: 'alice' })).status).toBe(204);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM integrations_old WHERE id=?').get(id)).toEqual({
      n: 0,
    });
  });

  it('works when the kept table no longer exists (after finalize)', async () => {
    const src = await createSource();
    const id = await route(src.source.id);
    h.db.raw.exec('DROP TABLE integrations_old');
    expect((await call('DELETE', `/api/integrations/${id}`, { as: 'alice' })).status).toBe(204);
    expect(row(id)).toBeUndefined();
  });
});
