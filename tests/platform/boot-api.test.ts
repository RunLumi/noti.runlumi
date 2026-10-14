import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLACK, caller, setup, type Harness } from '../sources/harness';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

/**
 * Per-path matrix for a credential-tier fault (H3, M3): a Worker holding another environment's KEK.
 * Requests that seal or open a credential are refused; everything else keeps working, so an
 * operator can still read, revoke and delete while the deployment is fixed.
 */
let h: Harness;
const call = caller(worker, () => h);

beforeEach(() => {
  h = setup();
  for (const level of ['info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a KEK that does not match its environment', () => {
  it('refuses to seal or open credentials, and nothing else', async () => {
    const src = await (
      await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } })
    ).json<{
      source: { id: string };
    }>();
    const created = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 's', sourceId: src.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    const integration = (await created.json<{ integration: { id: string } }>()).integration.id;

    // The deployment now carries a KEK that is not this environment's.
    h.env = { ...h.env, KEK_V1: '22'.repeat(32) };

    const refused: [string, string][] = [
      ['POST', '/api/integrations'],
      ['PATCH', `/api/integrations/${integration}`],
      ['POST', `/api/integrations/${integration}/test`],
      ['POST', '/api/sources'],
      ['POST', `/api/sources/${src.source.id}/rotate`],
    ];
    for (const [method, path] of refused) {
      const res = await call(method, path, { as: 'alice', body: {} });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(await res.json()).toEqual({ error: 'Service unavailable' });
    }

    // Reads, revoke and delete never touch a key and stay available.
    expect((await call('GET', '/api/integrations', { as: 'alice' })).status).toBe(200);
    expect((await call('GET', '/api/sources', { as: 'alice' })).status).toBe(200);
    expect((await call('GET', '/api/deliveries', { as: 'alice' })).status).toBe(200);
    expect(
      (await call('POST', `/api/integrations/${integration}/revoke-credentials`, { as: 'alice' })).status,
    ).toBe(200);
    expect(
      (await call('POST', `/api/sources/${src.source.id}/revoke-credentials`, { as: 'alice' })).status,
    ).toBe(200);
    expect((await call('DELETE', `/api/integrations/${integration}`, { as: 'alice' })).status).toBe(204);
  });

  it('a missing queue binding or a malformed legacy key blocks no API request', async () => {
    h.env = { ...h.env, DELIVERY_QUEUE: undefined as never, ENCRYPTION_KEY: 'nope' };
    expect((await call('GET', '/api/integrations', { as: 'alice' })).status).toBe(200);
    expect((await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } })).status).toBe(201);
  });
});

describe('revoke is not undone by re-entering the burned credential (M4)', () => {
  async function revokedIntegration(): Promise<string> {
    const src = await (
      await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } })
    ).json<{
      source: { id: string };
    }>();
    const res = await call('POST', '/api/integrations', {
      as: 'bob',
      body: { name: 's', sourceId: src.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    const id = (await res.json<{ integration: { id: string } }>()).integration.id;
    expect((await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' })).status).toBe(
      200,
    );
    return id;
  }

  it('a member cannot clear a revoke at all; an admin must enter a different value', async () => {
    const id = await revokedIntegration();
    const path = `/api/integrations/${id}`;
    const member = await call('PATCH', path, { as: 'bob', body: { webhookUrl: `${SLACK}new` } });
    expect(member.status).toBe(403);
    expect(await member.text()).toContain('integration.revoke');

    const same = await call('PATCH', path, { as: 'alice', body: { webhookUrl: SLACK } });
    expect(same.status).toBe(422);
    expect(await same.text()).toContain('revoked');
    expect(
      h.db.raw.prepare('SELECT credentials_quarantine_reason AS r FROM integrations WHERE id=?').get(id),
    ).toEqual({ r: 'revoked' });

    const fresh = await call('PATCH', path, {
      as: 'alice',
      body: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/BrandNewTokenPath' },
    });
    expect(fresh.status).toBe(200);
    expect((await fresh.json<{ integration: { revoked: boolean } }>()).integration.revoked).toBe(false);
  });

  it('a member can still edit a revoked integration without touching its credential', async () => {
    const id = await revokedIntegration();
    const res = await call('PATCH', `/api/integrations/${id}`, { as: 'bob', body: { name: 'renamed' } });
    expect(res.status).toBe(200);
    expect((await res.json<{ integration: { revoked: boolean } }>()).integration.revoked).toBe(true);
  });
});

describe('revoke writes one audit entry however many callers race (M5)', () => {
  it('two concurrent revokes of an integration', async () => {
    const src = await (
      await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } })
    ).json<{
      source: { id: string };
    }>();
    const created = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 's', sourceId: src.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    const id = (await created.json<{ integration: { id: string } }>()).integration.id;
    const path = `/api/integrations/${id}/revoke-credentials`;
    const results = await Promise.all([
      call('POST', path, { as: 'alice' }),
      call('POST', path, { as: 'alice' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      h.db.raw
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='integration.credentials.revoke'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it('a revoke whose UPDATE changes no row writes no audit entry (the guard, not the pre-read, decides)', async () => {
    const src = await (
      await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } })
    ).json<{
      source: { id: string };
    }>();
    const created = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 's', sourceId: src.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    const id = (await created.json<{ integration: { id: string } }>()).integration.id;
    // Another caller revokes between this request's read and its batch.
    const real = h.env.DB;
    let armed = true;
    h.env = {
      ...h.env,
      DB: new Proxy(real, {
        get(target, prop) {
          if (prop !== 'batch') return Reflect.get(target, prop) as unknown;
          return (statements: D1PreparedStatement[]) => {
            if (armed) {
              armed = false;
              target
                .prepare(
                  "UPDATE integrations SET credentials_quarantined_at=CURRENT_TIMESTAMP,credentials_quarantine_reason='revoked' WHERE id=?",
                )
                .bind(id)
                .run()
                .catch(() => undefined);
            }
            return target.batch(statements);
          };
        },
      }),
    };
    const res = await call('POST', `/api/integrations/${id}/revoke-credentials`, { as: 'alice' });
    expect(res.status).toBe(200);
    expect(
      h.db.raw
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='integration.credentials.revoke'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it('two concurrent revokes of a source', async () => {
    const src = await (
      await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } })
    ).json<{
      source: { id: string };
    }>();
    const path = `/api/sources/${src.source.id}/revoke-credentials`;
    await Promise.all([call('POST', path, { as: 'alice' }), call('POST', path, { as: 'alice' })]);
    expect(
      h.db.raw
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='source.credentials.revoke'")
        .get(),
    ).toEqual({ n: 1 });
  });
});

describe('a revoked provider source cannot be restored with the burned credential (M4)', () => {
  it('rotate refuses the same pasted token and accepts a new one', async () => {
    const GITLAB_TOKEN = ['gitlab', 'fixture', 'token', 'value'].join('-');
    const created = await call('POST', '/api/sources', {
      as: 'alice',
      body: { name: 'GL', kind: 'gitlab', secret: GITLAB_TOKEN, authMode: 'secret_token' },
    });
    expect(created.status).toBe(201);
    const id = (await created.json<{ source: { id: string } }>()).source.id;
    expect((await call('POST', `/api/sources/${id}/revoke-credentials`, { as: 'alice' })).status).toBe(200);

    const same = await call('POST', `/api/sources/${id}/rotate`, {
      as: 'alice',
      body: { secret: GITLAB_TOKEN, authMode: 'secret_token' },
    });
    expect(same.status).toBe(422);
    expect(await same.text()).toContain('revoked');

    const fresh = await call('POST', `/api/sources/${id}/rotate`, {
      as: 'alice',
      body: { secret: `${GITLAB_TOKEN}-second`, authMode: 'secret_token' },
    });
    expect(fresh.status).toBe(200);
    expect((await fresh.json<{ source: { revoked: boolean; enabled: boolean } }>()).source).toMatchObject({
      revoked: false,
      enabled: true,
    });
  });
});
