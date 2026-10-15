import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrationsServedBy } from '../../src/connectors/sources/github/disconnect';
import { createRig, ORG, type Rig } from '../conformance/rig';
import { loadFixtureJson, loadManifest } from '../fixtures/load';
import { caller, SLACK } from '../sources/harness';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * User-initiated disconnect of a GitHub installation (spec 05 F70, ADR 0058), over the real Worker and
 * migrations. The rig binds installation `gi-1` (account Codertocat, all repositories) to org-a and gives
 * it six enabled integrations on Codertocat/Hello-World; alice is an admin of org-a, bob a member, and
 * mallory an admin of org-b.
 */
const pr = loadManifest().find((m) => m.id === 'github/pull_request.opened');
if (!pr) throw new Error('fixture');
const PATH = '/api/github/installations/gi-1/disconnect';

afterEach(() => vi.unstubAllGlobals());

const status = (rig: Rig): string =>
  (
    rig.h.db.raw.prepare("SELECT status FROM github_installations WHERE id='gi-1'").get() as {
      status: string;
    }
  ).status;
const enabled = (rig: Rig, where = '1=1'): number => rig.count('integrations', `enabled=1 AND ${where}`);
const audits = (rig: Rig, action: string) =>
  rig.h.db.raw
    .prepare('SELECT organization_id,actor_id,subject_id,metadata_json FROM audit_events WHERE action=?')
    .all(action) as {
    organization_id: string;
    actor_id: string;
    subject_id: string;
    metadata_json: string;
  }[];

function addIntegration(rig: Rig, id: string, org: string, repo: string, sourceId: string | null = null) {
  rig.h.db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,source_id)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, repo, '["pull_request.opened"]', 'slack', '', org, sourceId);
}

describe('POST /api/github/installations/:id/disconnect', () => {
  it('stops the installation, pauses its integrations with a reason, audits it, and ingress refuses later events', async () => {
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    // Neighbours that must be left alone: another account's repository in the same workspace, and the
    // same repository name in another workspace.
    addIntegration(rig, 'int-other-owner', ORG, 'someone-else/repo');
    addIntegration(rig, 'int-org-b', 'org-b', 'Codertocat/Hello-World');
    // Before: an event is accepted.
    expect((await rig.post(rig.encode(loadFixtureJson(pr)), { headers: pr.headers })).status).toBe(202);
    const githubIntegrations = Object.keys(rig.integrations).length;

    const res = await call('POST', PATH, { as: 'alice' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      disconnected: true,
      account: 'Codertocat',
      alreadyStopped: false,
      pausedIntegrations: githubIntegrations,
    });
    expect(status(rig)).toBe('uninstalled');
    expect(enabled(rig, `organization_id='${ORG}' AND repo='Codertocat/Hello-World'`)).toBe(0);
    expect(enabled(rig, "id='int-other-owner'")).toBe(1);
    expect(enabled(rig, "id='int-org-b'")).toBe(1);

    const [disconnect, ...more] = audits(rig, 'github.installation.disconnect');
    expect(more).toHaveLength(0);
    expect(disconnect).toMatchObject({ organization_id: ORG, actor_id: 'alice', subject_id: 'gi-1' });
    expect(JSON.parse(disconnect?.metadata_json ?? '{}')).toEqual({
      account: 'Codertocat',
      previousStatus: 'active',
      pausedIntegrations: githubIntegrations,
    });
    const paused = audits(rig, 'integration.update');
    expect(paused.map((a) => a.subject_id).sort()).toEqual(Object.values(rig.integrations).sort());
    for (const row of paused) {
      expect(row).toMatchObject({ organization_id: ORG, actor_id: 'alice' });
      expect(JSON.parse(row.metadata_json)).toEqual({
        fields: ['enabled'],
        enabled: false,
        previousEnabled: true,
        reason: 'github_disconnected',
      });
    }

    // After: GitHub keeps delivering until the App is uninstalled there; every event is refused.
    const deliveries = rig.count('deliveries');
    const after = await rig.post(rig.encode(loadFixtureJson(pr)), { headers: pr.headers });
    expect(after.status).toBe(403);
    expect(rig.count('deliveries')).toBe(deliveries);
    // Even an integration someone turns back on routes nothing while the installation is stopped.
    rig.h.db.raw.prepare(`UPDATE integrations SET enabled=1 WHERE organization_id='${ORG}'`).run();
    expect((await rig.post(rig.encode(loadFixtureJson(pr)), { headers: pr.headers })).status).toBe(403);
    expect(rig.count('deliveries')).toBe(deliveries);
    // GitHub was not called: there is no token of ours to revoke.
    expect(rig.h.fetchMock).not.toHaveBeenCalled();
  });

  it('is idempotent: a repeat changes nothing and writes no second audit row', async () => {
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    expect((await call('POST', PATH, { as: 'alice' })).status).toBe(200);
    const again = await call('POST', PATH, { as: 'alice' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyStopped: true, pausedIntegrations: 0 });
    expect(audits(rig, 'github.installation.disconnect')).toHaveLength(1);
    expect(audits(rig, 'integration.update')).toHaveLength(Object.keys(rig.integrations).length);
  });

  it('refuses another workspace with 404 and changes nothing', async () => {
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    const res = await call('POST', PATH, { as: 'mallory' });
    expect(res.status).toBe(404);
    expect(status(rig)).toBe('active');
    expect(enabled(rig)).toBe(Object.keys(rig.integrations).length);
    expect(audits(rig, 'github.installation.disconnect')).toHaveLength(0);
    // Naming org-a explicitly does not help an outsider either.
    expect((await call('POST', `${PATH}?org=${ORG}`, { as: 'mallory' })).status).toBe(404);
    expect(status(rig)).toBe('active');
  });

  it('refuses a member (admin only) and a request without our Origin', async () => {
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    expect((await call('POST', PATH, { as: 'bob' })).status).toBe(403);
    expect((await call('POST', PATH, { as: 'alice', origin: null })).status).toBe(403);
    expect((await call('POST', PATH, { as: 'alice', origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('POST', PATH)).status).toBe(401);
    expect(status(rig)).toBe('active');
    expect(enabled(rig)).toBe(Object.keys(rig.integrations).length);
    expect(audits(rig, 'github.installation.disconnect')).toHaveLength(0);
    // The ingress keeps working for the installation nobody disconnected.
    expect((await rig.post(rig.encode(loadFixtureJson(pr)), { headers: pr.headers })).status).toBe(202);
  });

  it('answers 404 for an unknown id, and disconnects a suspended installation too', async () => {
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    expect((await call('POST', '/api/github/installations/nope/disconnect', { as: 'alice' })).status).toBe(
      404,
    );
    rig.h.db.raw.prepare("UPDATE github_installations SET status='suspended' WHERE id='gi-1'").run();
    const res = await call('POST', PATH, { as: 'alice' });
    expect(await res.json()).toMatchObject({ alreadyStopped: false });
    expect(status(rig)).toBe('uninstalled');
    const meta = JSON.parse(audits(rig, 'github.installation.disconnect')[0]?.metadata_json ?? '{}');
    expect(meta.previousStatus).toBe('suspended');
  });

  it('leaves destinations and source-bound integrations alone', async () => {
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    const created = await call('POST', '/api/sources', {
      as: 'alice',
      body: { name: 'ci', kind: 'generic' },
    });
    const source = (await created.json<{ source: { id: string } }>()).source.id;
    const connect = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 'to slack', sourceId: source, destination: 'slack', webhookUrl: SLACK },
    });
    expect(connect.status).toBe(201);
    const before = rig.h.db.raw
      .prepare('SELECT id,webhook_ciphertext,webhook_envelope FROM integrations ORDER BY id')
      .all();
    expect((await call('POST', PATH, { as: 'alice' })).status).toBe(200);
    expect(enabled(rig, `source_id='${source}'`)).toBe(1);
    // Destination credentials belong to the workspace, not to GitHub (F70).
    expect(
      rig.h.db.raw
        .prepare('SELECT id,webhook_ciphertext,webhook_envelope FROM integrations ORDER BY id')
        .all(),
    ).toEqual(before);
  });

  it('pauses an integration saved before an account rename, through the synced repository set', () => {
    expect(
      integrationsServedBy(
        'NewName',
        ['OldName/api'],
        [
          { id: 'a', repo: 'newname/web' },
          { id: 'b', repo: 'OldName/api' },
          { id: 'c', repo: 'OldName/other' },
          { id: 'd', repo: 'NewNameX/web' },
        ],
      ),
    ).toEqual(['a', 'b']);
  });

  it('pauses up to the workspace cap of integrations in a bounded number of statements', async () => {
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    for (let i = 0; i < 94; i++)
      addIntegration(rig, `bulk-${String(i).padStart(3, '0')}`, ORG, 'Codertocat/r');
    const total = enabled(rig);
    expect(total).toBe(100);
    let statements = 0;
    const real = rig.h.env.DB;
    rig.h.env = {
      ...rig.h.env,
      DB: new Proxy(real, {
        get: (target, prop, receiver) =>
          prop === 'batch'
            ? (list: D1PreparedStatement[]) => {
                statements += list.length;
                return target.batch(list);
              }
            : (Reflect.get(target, prop, receiver) as unknown),
      }),
    };
    const res = await call('POST', PATH, { as: 'alice' });
    expect(await res.json()).toMatchObject({ pausedIntegrations: 100 });
    expect(enabled(rig)).toBe(0);
    expect(audits(rig, 'integration.update')).toHaveLength(100);
    // 2 for the installation and its audit, 3 multi-row audit inserts, 2 chunked pauses.
    expect(statements).toBeLessThanOrEqual(7);
  });
});

describe('connecting a disconnected installation again', () => {
  it('is refused with installation_disconnected, which tells the person to reinstall on GitHub', async () => {
    const { bindInstallation, InstallFlowError } =
      await import('../../src/connectors/sources/github/install');
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    expect((await call('POST', PATH, { as: 'alice' })).status).toBe(200);
    const attempt = bindInstallation(
      rig.h.env.DB,
      '777',
      ORG,
      'alice',
      {
        installationId: '1001',
        accountLogin: 'Codertocat',
        accountId: '1',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
        repositories: [],
      },
      { ip: null, userAgent: null },
    );
    await expect(attempt).rejects.toBeInstanceOf(InstallFlowError);
    await expect(attempt).rejects.toMatchObject({ code: 'installation_disconnected' });
    expect(status(rig)).toBe('uninstalled');
  });
});

describe('a disconnect whose audit row cannot be written', () => {
  it('changes nothing: the installation stays active and its integrations stay on (ADR 0055)', async () => {
    const rig = await createRig('github', worker);
    const call = caller(worker, () => rig.h);
    const before = enabled(rig);
    // As a full or failing audit store would: the audit insert for this one action aborts.
    rig.h.db.raw.exec(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='github.installation.disconnect'
       BEGIN SELECT RAISE(ABORT,'audit store unavailable'); END`,
    );
    const res = await call('POST', PATH, { as: 'alice' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(status(rig)).toBe('active');
    expect(enabled(rig)).toBe(before);
    expect(audits(rig, 'github.installation.disconnect')).toHaveLength(0);
  });
});
