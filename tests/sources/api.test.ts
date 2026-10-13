import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SOURCES_PER_WORKSPACE, SOURCE_MUTATIONS_PER_MINUTE } from '../../src/api/sources';
import { openSourceSecret, rewrapStaleSourceKeys } from '../../src/connectors/sources/generic/secret';
import { keyringFromEnv } from '../../src/crypto/keyring-env';
import { purgeDueWorkspace } from '../../src/pipeline/purge';
import { EVENT, SLACK, caller, setup, signHeaders, type Harness } from './harness';

vi.mock('../../src/auth/better-auth', async () => (await import('./harness')).mockAuth());

const { default: worker } = await import('../../src/index');

let h: Harness;
const call = caller(worker, () => h);

interface View {
  id: string;
  name: string;
  kind: string;
  endpointId: string;
  endpointUrl: string;
  enabled: boolean;
  integrationCount: number;
  lastReceivedAt: string | null;
  secretRotatedAt: string | null;
}
type Created = { source: View; secret: string };

const create = async (as = 'alice', name = 'CI pipeline') =>
  call('POST', '/api/sources', { as, body: { name } });
const createOk = async (as = 'alice', name?: string) => await (await create(as, name)).json<Created>();
const audits = (org: string) =>
  (
    h.db.raw.prepare('SELECT action FROM audit_events WHERE organization_id=? ORDER BY rowid').all(org) as {
      action: string;
    }[]
  ).map((r) => r.action);
const count = (sql: string, ...a: string[]) => (h.db.raw.prepare(sql).get(...a) as { n: number }).n;

async function ingest(c: Created, id = `evt_${Math.random().toString(36).slice(2)}`) {
  const body = JSON.stringify(EVENT);
  return worker.fetch(
    new Request(c.source.endpointUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signHeaders(c.secret, body, { id }) },
      body,
    }),
    h.env,
    { waitUntil: () => undefined } as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  h = setup();
});
afterEach(() => vi.unstubAllGlobals());

describe('create', () => {
  it('returns the signing secret once, with no-store, and the public endpoint URL', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { source, secret } = await res.json<Created>();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32);
    expect(source).toMatchObject({
      name: 'CI pipeline',
      kind: 'generic',
      enabled: true,
      integrationCount: 0,
    });
    expect(source.endpointId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(source.endpointUrl).toBe(`https://noti.test/webhooks/generic/${source.endpointId}`);
    expect(audits('org-a')).toEqual(['source.create']);
  });

  it('generates distinct secrets and endpoint ids', async () => {
    const [a, b] = [await createOk(), await createOk()];
    expect(a.secret).not.toBe(b.secret);
    expect(a.source.endpointId).not.toBe(b.source.endpointId);
  });

  it('stores the secret only sealed, bound to org, source and purpose', async () => {
    const { source, secret } = await createOk();
    const row = h.db.raw.prepare('SELECT * FROM sources WHERE id=?').get(source.id) as Record<
      string,
      unknown
    >;
    expect(row.organization_id).toBe('org-a');
    const flat = JSON.stringify(Object.values(row).map((v) => (Array.isArray(v) ? v.join(',') : String(v))));
    expect(flat).not.toContain(secret);
    expect(flat).not.toContain(secret.slice(6));
    const opened = await openSourceSecret(row as never, keyringFromEnv(h.env));
    expect(Buffer.from(opened).toString('base64')).toBe(secret.slice(6));
    // Replaying the sealed bytes under another organization or source id fails to open.
    await expect(
      openSourceSecret({ ...(row as object), organization_id: 'org-b' } as never, keyringFromEnv(h.env)),
    ).rejects.toThrow();
    await expect(
      openSourceSecret({ ...(row as object), id: 'other' } as never, keyringFromEnv(h.env)),
    ).rejects.toThrow();
  });

  it('validates the name', async () => {
    for (const name of ['', '   ', 'x'.repeat(81), 'a\nb', 5, null]) {
      const res = await call('POST', '/api/sources', { as: 'alice', body: { name } });
      expect(res.status).toBe(422);
    }
    expect((await call('POST', '/api/sources', { as: 'alice', body: [] })).status).toBe(422);
    expect(count('SELECT COUNT(*) AS n FROM sources')).toBe(0);
  });

  it('enforces the per-workspace quota', async () => {
    for (let i = 0; i < MAX_SOURCES_PER_WORKSPACE; i++)
      h.db.raw
        .prepare(
          `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
           VALUES(?,?,'generic','s',?,x'00',x'00',x'00',1)`,
        )
        .run(`s${i}`, 'org-a', String(i).padStart(24, 'e'));
    expect((await create()).status).toBe(409);
  });

  it('is rate limited per user', async () => {
    h.db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run('sources:alice', Math.floor(Date.now() / 60_000) * 60_000, SOURCE_MUTATIONS_PER_MINUTE);
    const res = await create();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('read, authorization and CSRF', () => {
  it('never returns a secret, key or envelope from list or get', async () => {
    const { source, secret } = await createOk();
    const list = await (await call('GET', '/api/sources', { as: 'bob' })).text();
    const one = await (await call('GET', `/api/sources/${source.id}`, { as: 'bob' })).text();
    for (const text of [list, one]) {
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/whsec|envelope|dek|salt/i);
    }
    expect(JSON.parse(list).sources).toHaveLength(1);
  });

  it('requires a signed-in member of the workspace', async () => {
    expect((await call('GET', '/api/sources')).status).toBe(401);
    expect((await call('POST', '/api/sources', { body: { name: 'x' } })).status).toBe(401);
    // mallory belongs to org-b only: asking for org-a is a 404, never a 403.
    expect((await call('GET', '/api/sources?org=org-a', { as: 'mallory' })).status).toBe(404);
  });

  it('lists only the caller’s workspace and 404s every verb on another workspace’s source', async () => {
    const mine = await createOk('alice');
    await createOk('mallory', 'Theirs');
    const list = await (await call('GET', '/api/sources', { as: 'bob' })).json<{ sources: View[] }>();
    expect(list.sources.map((s) => s.id)).toEqual([mine.source.id]);
    const path = `/api/sources/${mine.source.id}`;
    expect((await call('GET', path, { as: 'mallory' })).status).toBe(404);
    expect((await call('PATCH', path, { as: 'mallory', body: { enabled: false } })).status).toBe(404);
    expect((await call('POST', `${path}/rotate`, { as: 'mallory' })).status).toBe(404);
    expect((await call('DELETE', path, { as: 'mallory' })).status).toBe(404);
    expect((await ingest(mine)).status).toBe(202);
    const row = h.db.raw.prepare('SELECT enabled FROM sources WHERE id=?').get(mine.source.id);
    expect(row).toEqual({ enabled: 1 });
  });

  it('lets members create, list, rename and pause; rotate and delete are admin-only', async () => {
    const created = await create('bob');
    expect(created.status).toBe(201);
    const { source } = await created.json<Created>();
    const path = `/api/sources/${source.id}`;
    expect((await call('GET', '/api/sources', { as: 'bob' })).status).toBe(200);
    expect((await call('PATCH', path, { as: 'bob', body: { enabled: false } })).status).toBe(200);
    const rotate = await call('POST', `${path}/rotate`, { as: 'bob' });
    expect(rotate.status).toBe(403);
    expect(await rotate.text()).toContain('source.rotate');
    expect((await call('DELETE', `${path}?cascade=true`, { as: 'bob' })).status).toBe(403);
    expect(count('SELECT COUNT(*) AS n FROM sources')).toBe(1);
    // The refusal is audited, and nothing changed.
    expect(audits('org-a')).toContain('access.denied');
    expect((await call('POST', `${path}/rotate`, { as: 'alice' })).status).toBe(200);
    expect((await call('DELETE', path, { as: 'alice' })).status).toBe(204);
  });

  it('rejects cross-site and non-JSON mutations', async () => {
    const { source } = await createOk();
    const path = `/api/sources/${source.id}`;
    expect(
      (await call('POST', '/api/sources', { as: 'alice', origin: null, body: { name: 'x' } })).status,
    ).toBe(403);
    expect(
      (await call('POST', '/api/sources', { as: 'alice', origin: 'https://evil.test', body: { name: 'x' } }))
        .status,
    ).toBe(403);
    expect(
      (await call('POST', '/api/sources', { as: 'alice', contentType: 'text/plain', body: { name: 'x' } }))
        .status,
    ).toBe(415);
    expect((await call('POST', `${path}/rotate`, { as: 'alice', origin: 'https://evil.test' })).status).toBe(
      403,
    );
    expect((await call('PATCH', path, { as: 'alice', origin: null, body: { enabled: false } })).status).toBe(
      403,
    );
    expect((await call('DELETE', path, { as: 'alice', origin: null })).status).toBe(403);
    expect(count('SELECT COUNT(*) AS n FROM sources')).toBe(1);
  });
});

describe('update', () => {
  it('renames and disables; a disabled source answers 404 at ingress, re-enabling restores it', async () => {
    const c = await createOk();
    const path = `/api/sources/${c.source.id}`;
    const renamed = await (
      await call('PATCH', path, { as: 'alice', body: { name: 'Renamed' } })
    ).json<{ source: View }>();
    expect(renamed.source.name).toBe('Renamed');
    await call('PATCH', path, { as: 'alice', body: { enabled: false } });
    expect((await ingest(c)).status).toBe(404);
    await call('PATCH', path, { as: 'alice', body: { enabled: true } });
    expect((await ingest(c)).status).toBe(202);
    expect(audits('org-a')).toEqual(['source.create', 'source.update', 'source.update', 'source.update']);
  });

  it('rejects unknown fields (endpoint id and secret are immutable), bad types and empty updates', async () => {
    const { source } = await createOk();
    const path = `/api/sources/${source.id}`;
    for (const body of [
      { endpointId: 'x'.repeat(24) },
      { secret: 'whsec_x' },
      { enabled: 'yes' },
      { name: '' },
      {},
      [],
    ])
      expect((await call('PATCH', path, { as: 'alice', body })).status).toBe(422);
    const row = h.db.raw.prepare('SELECT endpoint_id FROM sources WHERE id=?').get(source.id);
    expect(row).toEqual({ endpoint_id: source.endpointId });
  });

  it('the database refuses to move a source to another organization', async () => {
    const { source } = await createOk();
    expect(() =>
      h.db.raw.prepare("UPDATE sources SET organization_id='org-b' WHERE id=?").run(source.id),
    ).toThrow(/cannot change/);
    expect(() =>
      h.db.raw
        .prepare(
          `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
                  VALUES('z','','generic','n',?,x'00',x'00',x'00',1)`,
        )
        .run('q'.repeat(24)),
    ).toThrow(/required/);
  });
});

describe('rotate', () => {
  it('shows a new secret once and invalidates the old one immediately', async () => {
    const c = await createOk();
    await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 'n', sourceId: c.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    const before = h.db.raw
      .prepare('SELECT key_salt,dek_wrapped FROM sources WHERE id=?')
      .get(c.source.id) as Record<string, unknown>;
    const res = await call('POST', `/api/sources/${c.source.id}/rotate`, { as: 'alice' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const rotated = await res.json<Created>();
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(c.secret);
    expect(rotated.source.endpointUrl).toBe(c.source.endpointUrl);
    expect(rotated.source.secretRotatedAt).not.toBeNull();

    expect((await ingest(c)).status).toBe(401);
    expect((await ingest({ ...c, secret: rotated.secret })).status).toBe(202);
    const after = h.db.raw
      .prepare('SELECT key_salt,dek_wrapped FROM sources WHERE id=?')
      .get(c.source.id) as Record<string, unknown>;
    expect(after.key_salt).not.toEqual(before.key_salt);
    expect(after.dek_wrapped).not.toEqual(before.dek_wrapped);
    expect(audits('org-a')).toEqual(['source.create', 'integration.create', 'source.secret.rotate']);
    expect(JSON.stringify(h.db.raw.prepare('SELECT metadata_json FROM audit_events').all())).not.toContain(
      'whsec_',
    );
    // A later read does not show it.
    const text = await (await call('GET', `/api/sources/${c.source.id}`, { as: 'alice' })).text();
    expect(text).not.toContain(rotated.secret);
  });
});

describe('delete', () => {
  it('removes the source, its bound integrations and the wrapped key; unrelated integrations survive', async () => {
    const c = await createOk();
    const bound = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 'bound', sourceId: c.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    expect(bound.status).toBe(201);
    h.db.raw
      .prepare(
        `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id)
                VALUES('gh','acme/web','[]','slack','x','org-a')`,
      )
      .run();
    // Without an explicit cascade nothing is touched and the count is reported.
    const refused = await call('DELETE', `/api/sources/${c.source.id}`, { as: 'alice' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ integrations: 1 });
    expect(count('SELECT COUNT(*) AS n FROM sources')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM integrations')).toBe(2);
    const res = await call('DELETE', `/api/sources/${c.source.id}?cascade=true`, { as: 'alice' });
    expect(res.status).toBe(204);
    expect(count('SELECT COUNT(*) AS n FROM sources')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM integrations')).toBe(1);
    expect((await ingest(c)).status).toBe(404);
    expect(audits('org-a').at(-1)).toBe('source.delete');
    expect((await call('DELETE', `/api/sources/${c.source.id}`, { as: 'alice' })).status).toBe(404);
  });
});

describe('integrations that reference a source', () => {
  it('creates one without a repository, shows sourceId, and never lists a repo', async () => {
    const { source } = await createOk();
    const res = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 'to slack', sourceId: source.id, destination: 'slack', webhookUrl: SLACK },
    });
    const { integration } = await res.json<{
      integration: { sourceId: string; repo: string; eventTypes: string[] };
    }>();
    expect(integration).toMatchObject({ sourceId: source.id, repo: '', eventTypes: [] });
    const counted = await (
      await call('GET', `/api/sources/${source.id}`, { as: 'alice' })
    ).json<{
      source: View;
    }>();
    expect(counted.source.integrationCount).toBe(1);
  });

  it('rejects mixing a source with a repository or event types, and unknown sources', async () => {
    const { source } = await createOk();
    const body = { name: 'n', destination: 'slack', webhookUrl: SLACK };
    for (const extra of [
      { sourceId: source.id, repo: 'acme/web' },
      { sourceId: source.id, eventTypes: ['issues.opened'] },
      { sourceId: 'nope' },
      { sourceId: 'a'.repeat(20) },
    ])
      expect(
        (await call('POST', '/api/integrations', { as: 'alice', body: { ...body, ...extra } })).status,
      ).toBe(422);
  });

  it('refuses to edit the repository or event types of a source integration, but allows pause and rename', async () => {
    const { source } = await createOk();
    const created = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 'n', sourceId: source.id, destination: 'slack', webhookUrl: SLACK },
    });
    const id = (await created.json<{ integration: { id: string } }>()).integration.id;
    const patch = (body: unknown) => call('PATCH', `/api/integrations/${id}`, { as: 'alice', body });
    expect((await patch({ repo: 'acme/web' })).status).toBe(422);
    expect((await patch({ eventTypes: ['issues.opened'] })).status).toBe(422);
    expect((await patch({ enabled: false })).status).toBe(200);
    expect((await patch({ name: 'renamed' })).status).toBe(200);
  });
});

describe('workspace lifecycle', () => {
  it('refuses source changes while the workspace is scheduled for deletion', async () => {
    const { source } = await createOk();
    await call('POST', '/api/workspace/deletion', { as: 'alice', body: { confirm: 'org-a' } });
    expect((await create()).status).toBe(409);
    expect((await call('POST', `/api/sources/${source.id}/rotate`, { as: 'alice' })).status).toBe(409);
    expect(
      (await call('PATCH', `/api/sources/${source.id}`, { as: 'alice', body: { enabled: false } })).status,
    ).toBe(409);
    expect((await call('DELETE', `/api/sources/${source.id}`, { as: 'alice' })).status).toBe(409);
  });

  it('delivers nothing while deletion is pending (integrations are disabled) and purge drains sources', async () => {
    const a = await createOk('alice');
    await createOk('mallory', 'Theirs');
    await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 'n', sourceId: a.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    await call('POST', '/api/workspace/deletion', { as: 'alice', body: { confirm: 'org-a' } });
    expect(await (await ingest(a)).json()).toMatchObject({ persisted: 0 });

    const report = await purgeDueWorkspace(h.db.d1, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(report).toMatchObject({ organizationId: 'org-a', completed: true });
    expect(count('SELECT COUNT(*) AS n FROM sources WHERE organization_id=?', 'org-a')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM sources WHERE organization_id=?', 'org-b')).toBe(1);
  });

  it('export lists sources and integration source ids without any secret material', async () => {
    const c = await createOk();
    await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 'n', sourceId: c.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    const res = await call('GET', '/api/workspace/export', { as: 'alice' });
    const text = await res.text();
    const body = JSON.parse(text) as {
      sources: Record<string, unknown>[];
      integrations: Record<string, unknown>[];
    };
    expect(body.sources).toHaveLength(1);
    expect(Object.keys(body.sources[0] ?? {}).sort()).toEqual([
      'created_at',
      'enabled',
      'endpoint_id',
      'id',
      'kind',
      'last_received_at',
      'name',
      'secret_rotated_at',
      'updated_at',
    ]);
    expect(body.integrations[0]).toMatchObject({ source_id: c.source.id });
    expect(text).not.toContain(c.secret);
    expect(text).not.toContain(c.secret.slice(6));
  });
});

describe('KEK rotation', () => {
  it('rewraps source keys to the active KEK without changing the secret', async () => {
    const c = await createOk();
    h.env = { ...h.env, KEK_V2: '22'.repeat(32), KMS_ACTIVE_VERSION: '2' };
    expect(await rewrapStaleSourceKeys(h.db.d1, keyringFromEnv(h.env))).toBe(1);
    expect(h.db.raw.prepare('SELECT kek_version FROM sources').get()).toEqual({ kek_version: 2 });
    expect(await rewrapStaleSourceKeys(h.db.d1, keyringFromEnv(h.env))).toBe(0);
    // The old KEK can now be retired and the same secret still verifies.
    h.env = { ...h.env, KEK_V1: '' };
    expect((await ingest(c)).status).toBe(202);
  });
});

/** Run `before` once, right before the next D1 batch: a deterministic "concurrent writer". */
function interceptBatch(before: () => void | Promise<void>): void {
  const real = h.db.d1;
  let fired = false;
  h.env = {
    ...h.env,
    DB: new Proxy(real, {
      get(target, prop) {
        if (prop !== 'batch') return Reflect.get(target, prop, target) as unknown;
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await before();
          }
          return target.batch(statements);
        };
      },
    }),
  };
}

describe('concurrency guards (L2, L3)', () => {
  it('rotate applies only if the wrapped key is the one it read: a concurrent rewrap makes it a 409', async () => {
    const c = await createOk();
    const envBefore = h.env;
    interceptBatch(async () => {
      // The KEK rewrap job runs between the read and the write.
      const next = { ...envBefore, KEK_V2: '22'.repeat(32), KMS_ACTIVE_VERSION: '2' };
      expect(await rewrapStaleSourceKeys(h.db.d1, keyringFromEnv(next))).toBe(1);
    });
    const res = await call('POST', `/api/sources/${c.source.id}/rotate`, { as: 'alice' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain('whsec_');
    expect(audits('org-a')).toEqual(['source.create']);
    // Nothing was rotated: the old secret still verifies (under the rewrapped key).
    h.env = { ...envBefore, KEK_V2: '22'.repeat(32), KMS_ACTIVE_VERSION: '2' };
    expect((await ingest(c)).status).toBe(202);
  });

  it('the quota is enforced inside the INSERT: a concurrent create that fills it makes this one 409 with no audit', async () => {
    for (let i = 0; i < MAX_SOURCES_PER_WORKSPACE - 1; i++) seedSource(`q${i}`, i);
    interceptBatch(() => seedSource('racer', 99));
    const res = await create();
    expect(res.status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM sources WHERE organization_id=?', 'org-a')).toBe(
      MAX_SOURCES_PER_WORKSPACE,
    );
    expect(audits('org-a')).toEqual([]);
  });
});

function seedSource(id: string, n: number): void {
  h.db.raw
    .prepare(
      `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
       VALUES(?,?,'generic','s',?,x'00',x'00',x'00',1)`,
    )
    .run(id, 'org-a', String(n).padStart(24, 'f'));
}

describe('database invariants (L4)', () => {
  async function bound(as = 'alice') {
    const c = await createOk(as);
    const res = await call('POST', '/api/integrations', {
      as,
      body: { name: 'n', sourceId: c.source.id, destination: 'slack', webhookUrl: SLACK },
    });
    return { c, integrationId: (await res.json<{ integration: { id: string } }>()).integration.id };
  }

  it('an integration can never be moved to another source or detached from its source', async () => {
    const { integrationId } = await bound();
    const other = await createOk('alice', 'Other');
    const set = (v: string | null) => () =>
      h.db.raw.prepare('UPDATE integrations SET source_id=? WHERE id=?').run(v, integrationId);
    expect(set(other.source.id)).toThrow(/cannot change/);
    expect(set(null)).toThrow(/cannot change/);
    // Leaving it unchanged is fine.
    h.db.raw.prepare('UPDATE integrations SET name=name WHERE id=?').run(integrationId);
  });

  it('an unbound integration can only be attached to a source of its own organization', async () => {
    const theirs = await createOk('mallory');
    h.db.raw
      .prepare(
        `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id)
         VALUES('gh','acme/web','[]','slack','x','org-a')`,
      )
      .run();
    expect(() =>
      h.db.raw.prepare("UPDATE integrations SET source_id=? WHERE id='gh'").run(theirs.source.id),
    ).toThrow(/same organization/);
    const mine = await createOk('alice');
    h.db.raw.prepare("UPDATE integrations SET source_id=? WHERE id='gh'").run(mine.source.id);
  });

  it('no orphan integrations: removing a source by any path removes its integrations', async () => {
    const a = await bound();
    await bound('mallory');
    h.db.raw.prepare('DELETE FROM sources WHERE id=?').run(a.c.source.id);
    expect(count('SELECT COUNT(*) AS n FROM integrations WHERE source_id IS NOT NULL')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM integrations WHERE organization_id=?', 'org-a')).toBe(0);
    // An organization cascade (workspace purge) leaves nothing behind either.
    h.db.raw.prepare("DELETE FROM integrations WHERE organization_id='org-b'").run();
    const again = await bound('mallory');
    h.db.raw.prepare("DELETE FROM sources WHERE organization_id='org-b'").run();
    expect(count('SELECT COUNT(*) AS n FROM integrations WHERE id=?', again.integrationId)).toBe(0);
  });
});
