import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeDueWorkspace } from '../../src/pipeline/purge';
import {
  FAILED_RETENTION_MS,
  HELD_RETENTION_MS,
  OPEN_FAILURE_RETENTION_MS,
  purgeNoise,
} from '../../src/routing/noise-store';
import {
  EVENT,
  SLACK,
  caller,
  setup,
  signHeaders,
  type CreatedSource,
  type Harness,
} from '../sources/harness';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());

const { default: worker } = await import('../../src/index');

/**
 * The noise settings API (`noise` on integrations, `GET /:id/noise-status`), the generic source
 * route's use of them, deletion cleanup and workspace purge, over the real migrations.
 */
let h: Harness;
const call = caller(worker, () => h);

const HCM = 'Asia/Ho_Chi_Minh';
const quietDoc = { timezone: HCM, quietHours: { start: '22:00', end: '08:00' } };

function githubInstallation(org: string, installationId: string): void {
  h.db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(`gi-${installationId}`, org, installationId, '1', 'acme', 'Organization', 'all');
}

beforeEach(() => {
  h = setup();
  githubInstallation('org-a', '1001');
  githubInstallation('org-b', '1002');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface View {
  id: string;
  noise: Record<string, unknown> | null;
  noiseInvalid: boolean;
  noiseNewer: boolean;
}

async function createGithub(as: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return call('POST', '/api/integrations', {
    as,
    body: {
      name: 'Alerts',
      repo: 'acme/web',
      eventTypes: ['issue_comment.created', 'workflow_run.failure', 'workflow_run.success'],
      destination: 'slack',
      webhookUrl: SLACK,
      ...extra,
    },
  });
}

async function createdId(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  return (await res.json<{ integration: View }>()).integration.id;
}

const storedNoise = (id: string): unknown =>
  (
    h.db.raw.prepare('SELECT noise_json FROM integrations WHERE id=?').get(id) as {
      noise_json: string | null;
    }
  ).noise_json;

describe('creating with noise settings', () => {
  it('stores a normalised, versioned document and returns it', async () => {
    const res = await createGithub('alice', {
      noise: { ...quietDoc, groupWindowSec: 300, digest: 'daily', digestAt: '09:00', resolution: true },
    });
    expect(res.status).toBe(201);
    const { integration } = await res.json<{ integration: View }>();
    expect(integration.noise).toEqual({
      timezone: HCM,
      quietHours: { start: '22:00', end: '08:00' },
      groupWindowSec: 300,
      maxWaitSec: 0,
      digest: 'daily',
      digestAt: '09:00',
      resolution: true,
    });
    expect(integration.noiseInvalid).toBe(false);
    expect(JSON.parse(String(storedNoise(integration.id)))).toMatchObject({ v: 1, groupWindowSec: 300 });
  });

  it('stores nothing and reports null when no noise settings are sent', async () => {
    const id = await createdId(await createGithub('alice'));
    expect(storedNoise(id)).toBeNull();
    const { integration } = await (
      await call('GET', `/api/integrations/${id}`, { as: 'alice' })
    ).json<{
      integration: View;
    }>();
    expect(integration.noise).toBeNull();
  });

  it('puts feature names, never times or zones, in the audit log', async () => {
    await createGithub('alice', { noise: { ...quietDoc, groupWindowSec: 60 } });
    const row = h.db.raw
      .prepare("SELECT metadata_json FROM audit_events WHERE action='integration.create'")
      .get() as { metadata_json: string };
    const metadata = JSON.parse(row.metadata_json) as { noise: string[] };
    expect(metadata.noise).toEqual(['quietHours', 'grouping']);
    expect(row.metadata_json).not.toContain(HCM);
    expect(row.metadata_json).not.toContain('22:00');
  });
});

describe('validation', () => {
  it.each([
    ['an unknown zone', { timezone: 'Mars/Phobos' }, 'noise.timezone'],
    ['an offset instead of a zone', { timezone: '+07:00' }, 'noise.timezone'],
    ['equal start and end', { quietHours: { start: '08:00', end: '08:00' } }, 'noise.quietHours.end'],
    ['a malformed time', { quietHours: { start: '9pm', end: '08:00' } }, 'noise.quietHours.start'],
    ['an off-menu window', { groupWindowSec: 7 }, 'noise.groupWindowSec'],
    ['an off-menu maximum wait', { groupWindowSec: 300, maxWaitSec: 7 }, 'noise.maxWaitSec'],
    ['a maximum wait with no combine window', { maxWaitSec: 900 }, 'noise.maxWaitSec'],
    ['a weekly digest', { digest: 'weekly' }, 'noise.digest'],
    ['an unknown setting', { sound: true }, 'noise.sound'],
    ['a non-object', 'always', 'noise'],
  ])('rejects %s with 422 and the field path', async (_name, noise, field) => {
    const res = await createGithub('alice', { noise });
    expect(res.status).toBe(422);
    const body = await res.json<{ fields: { field: string }[] }>();
    expect(body.fields.map((f) => f.field)).toContain(field);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
  });

  it('refuses resolved notices unless failing runs are among the selected updates', async () => {
    const res = await createGithub('alice', {
      eventTypes: ['issue_comment.created'],
      noise: { resolution: true },
    });
    expect(res.status).toBe(422);
    expect((await res.json<{ fields: { field: string }[] }>()).fields[0]?.field).toBe('noise.resolution');
  });

  it('never echoes what was typed', async () => {
    const typed = 'unlikely-typed-zone';
    const res = await createGithub('alice', { noise: { timezone: typed } });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain(typed);
  });
});

describe('updating', () => {
  it('sets, replaces and clears (null and {} both clear)', async () => {
    const id = await createdId(await createGithub('alice'));
    const patch = (noise: unknown) =>
      call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { noise } });

    expect((await patch(quietDoc)).status).toBe(200);
    expect(JSON.parse(String(storedNoise(id)))).toMatchObject({ v: 1, quietHours: { start: '22:00' } });

    expect((await patch({ digest: 'hourly' })).status).toBe(200);
    expect(JSON.parse(String(storedNoise(id)))).toMatchObject({ digest: 'hourly', quietHours: null });

    expect((await patch(null)).status).toBe(200);
    expect(storedNoise(id)).toBeNull();

    await patch(quietDoc);
    expect((await patch({})).status).toBe(200);
    expect(storedNoise(id)).toBeNull();
  });

  it('keeps resolved notices consistent with the selected updates in both directions', async () => {
    const id = await createdId(await createGithub('alice', { noise: { resolution: true } }));
    const patch = (body: unknown) => call('PATCH', `/api/integrations/${id}`, { as: 'alice', body });
    // Removing every failing-run update while resolution is on is refused.
    const drop = await patch({ eventTypes: ['issue_comment.created'] });
    expect(drop.status).toBe(422);
    // Turning resolution off first makes the same change valid.
    expect((await patch({ noise: null })).status).toBe(200);
    expect((await patch({ eventTypes: ['issue_comment.created'] })).status).toBe(200);
    // And turning it on with no failing-run update is refused.
    expect((await patch({ noise: { resolution: true } })).status).toBe(422);
  });

  it('records which features changed, not their values', async () => {
    const id = await createdId(await createGithub('alice'));
    await call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { noise: quietDoc } });
    const row = h.db.raw
      .prepare("SELECT metadata_json FROM audit_events WHERE action='integration.update' ORDER BY rowid DESC")
      .get() as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toMatchObject({ fields: ['noise'], noise: ['quietHours'] });
    expect(row.metadata_json).not.toContain(HCM);
  });

  describe('what is already held follows a settings change', () => {
    async function seed() {
      const id = await createdId(await createGithub('alice', { noise: quietDoc }));
      const farFuture = Date.now() + 20 * 3_600_000;
      const insert = h.db.raw.prepare(
        `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
         VALUES(?,'org-a',?,?,?,'held',?,1,'issues.opened','t','','','','info','')`,
      );
      insert.run('quiet1', id, 'quiet_hours', 'k'.repeat(32), farFuture);
      insert.run('digest1', id, 'digest', 'd'.repeat(32), farFuture);
      insert.run('group1', id, 'grouped', 'g'.repeat(32), farFuture);
      return { id, farFuture };
    }
    const at = (rowId: string): number =>
      (h.db.raw.prepare('SELECT release_at FROM held_events WHERE id=?').get(rowId) as { release_at: number })
        .release_at;

    it('rescheduling to a new digest moves quiet-hours and digest rows, not grouped ones', async () => {
      const { id, farFuture } = await seed();
      const res = await call('PATCH', `/api/integrations/${id}`, {
        as: 'alice',
        body: { noise: { digest: 'hourly' } },
      });
      expect(res.status).toBe(200);
      // The next hourly boundary is at most an hour away; the grouped row keeps its window.
      for (const row of ['quiet1', 'digest1']) {
        expect(at(row)).toBeLessThanOrEqual(Date.now() + 3_600_000);
        expect(at(row)).toBeGreaterThan(Date.now() - 1000);
      }
      expect(at('group1')).toBe(farFuture);
    });

    it('settings that no longer hold digest-style make those rows due now', async () => {
      const { id } = await seed();
      await call('PATCH', `/api/integrations/${id}`, {
        as: 'alice',
        body: { noise: { groupWindowSec: 300 } },
      });
      expect(at('quiet1')).toBeLessThanOrEqual(Date.now());
      expect(at('digest1')).toBeLessThanOrEqual(Date.now());
    });

    it('a later daily summary moves them to that boundary', async () => {
      const { id } = await seed();
      await call('PATCH', `/api/integrations/${id}`, {
        as: 'alice',
        body: { noise: { timezone: 'UTC', digest: 'daily', digestAt: '23:59' } },
      });
      const boundary = new Date();
      boundary.setUTCHours(23, 59, 0, 0);
      if (boundary.getTime() <= Date.now()) boundary.setUTCDate(boundary.getUTCDate() + 1);
      expect(at('quiet1')).toBe(boundary.getTime());
    });

    it('turning every setting off releases everything held at the next tick', async () => {
      const { id } = await seed();
      expect(
        (await call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { noise: null } })).status,
      ).toBe(200);
      for (const row of ['quiet1', 'digest1', 'group1']) expect(at(row)).toBeLessThanOrEqual(Date.now());
    });
  });

  it('flags an unreadable stored document without hiding the integration', async () => {
    const id = await createdId(await createGithub('alice'));
    h.db.raw.prepare('UPDATE integrations SET noise_json=? WHERE id=?').run('{"v":1,"digest":"weekly"}', id);
    let view = (
      await (await call('GET', `/api/integrations/${id}`, { as: 'alice' })).json<{ integration: View }>()
    ).integration;
    expect(view).toMatchObject({ noise: null, noiseInvalid: true, noiseNewer: false });
    h.db.raw.prepare('UPDATE integrations SET noise_json=? WHERE id=?').run('{"v":3}', id);
    view = (
      await (await call('GET', `/api/integrations/${id}`, { as: 'alice' })).json<{ integration: View }>()
    ).integration;
    expect(view).toMatchObject({ noiseInvalid: false, noiseNewer: true });
  });
});

describe('authorization and CSRF', () => {
  it('requires a session', async () => {
    const id = await createdId(await createGithub('alice'));
    expect((await call('PATCH', `/api/integrations/${id}`, { body: { noise: quietDoc } })).status).toBe(401);
    expect((await call('GET', `/api/integrations/${id}/noise-status`)).status).toBe(401);
  });

  it('does not let another workspace read or change noise settings (404)', async () => {
    const id = await createdId(await createGithub('alice'));
    const patch = await call('PATCH', `/api/integrations/${id}`, {
      as: 'mallory',
      body: { noise: quietDoc },
    });
    expect(patch.status).toBe(404);
    expect(storedNoise(id)).toBeNull();
    expect((await call('GET', `/api/integrations/${id}/noise-status`, { as: 'mallory' })).status).toBe(404);
  });

  it('refuses a foreign Origin and a non-JSON body', async () => {
    const id = await createdId(await createGithub('alice'));
    const foreign = await call('PATCH', `/api/integrations/${id}`, {
      as: 'alice',
      body: { noise: quietDoc },
      origin: 'https://evil.test',
    });
    expect(foreign.status).toBe(403);
    const text = await call('PATCH', `/api/integrations/${id}`, {
      as: 'alice',
      body: { noise: quietDoc },
      contentType: 'text/plain',
    });
    expect(text.status).toBe(415);
    expect(storedNoise(id)).toBeNull();
  });

  it('is blocked while the workspace is scheduled for deletion', async () => {
    const id = await createdId(await createGithub('alice'));
    await call('POST', '/api/workspace/deletion', { as: 'alice', body: { confirm: 'org-a' } });
    expect(
      (await call('PATCH', `/api/integrations/${id}`, { as: 'alice', body: { noise: quietDoc } })).status,
    ).toBe(409);
  });
});

describe('a source integration', () => {
  async function source(): Promise<CreatedSource> {
    const res = await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI pipeline' } });
    const body = await res.json<{
      source: { id: string; endpointId: string; endpointUrl: string };
      secret: string;
    }>();
    return { ...body.source, secret: body.secret };
  }
  async function route(src: CreatedSource, noise?: unknown): Promise<string> {
    const res = await call('POST', '/api/integrations', {
      as: 'alice',
      body: {
        name: 'to slack',
        sourceId: src.id,
        destination: 'slack',
        webhookUrl: SLACK,
        ...(noise === undefined ? {} : { noise }),
      },
    });
    return createdId(res);
  }
  async function post(src: CreatedSource, body: unknown, id: string): Promise<Response> {
    const text = JSON.stringify(body);
    return worker.fetch(
      new Request(`https://noti.test/webhooks/generic/${src.endpointId}`, {
        method: 'POST',
        headers: { ...signHeaders(src.secret, text, { id }), 'content-type': 'application/json' },
        body: text,
      }),
      h.env,
      { waitUntil: h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
  }

  it('cannot ask for resolved notices (they are GitHub-only)', async () => {
    const src = await source();
    const res = await call('POST', '/api/integrations', {
      as: 'alice',
      body: {
        name: 'x',
        sourceId: src.id,
        destination: 'slack',
        webhookUrl: SLACK,
        noise: { resolution: true },
      },
    });
    expect(res.status).toBe(422);
  });

  it('holds a non-critical generic event in quiet hours, delivers a failure, and reports held', async () => {
    const src = await source();
    const id = await route(src, quietDoc);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T16:00:00Z'));
    const calm = await post(src, { ...EVENT, severity: 'info', type: 'deploy.ok' }, 'msg_1');
    expect(calm.status).toBe(202);
    expect(await calm.json()).toEqual({ accepted: true, persisted: 0, held: 1 });
    const failing = await post(src, { ...EVENT, severity: 'error' }, 'msg_2');
    expect(await failing.json()).toEqual({ accepted: true, persisted: 1 });
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM held_events').get()).toEqual({ n: 1 });
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 1 });

    // A repeat of the held event is not "duplicate" noise: it is simply not held twice.
    const again = await post(src, { ...EVENT, severity: 'info', type: 'deploy.ok' }, 'msg_1');
    expect(again.status).toBe(200);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM held_events').get()).toEqual({ n: 1 });

    const status = await call('GET', `/api/integrations/${id}/noise-status`, { as: 'alice' });
    expect(await status.json()).toEqual({
      held: { count: 1, nextReleaseAt: '2026-10-15T01:00:00.000Z' },
      failed: 0,
    });
  });
});

describe('workspace export', () => {
  it('includes the noise settings of each integration, and no held updates', async () => {
    await createGithub('alice', { noise: quietDoc });
    const res = await call('GET', '/api/workspace/export', { as: 'alice' });
    expect(res.status).toBe(200);
    const body = await res.json<{ integrations: { noise_json: string | null }[] }>();
    expect(JSON.parse(String(body.integrations[0]?.noise_json))).toMatchObject({ v: 1, timezone: HCM });
  });
});

describe('noise-status', () => {
  it('reports nothing held for a quiet integration', async () => {
    const id = await createdId(await createGithub('alice'));
    const res = await call('GET', `/api/integrations/${id}/noise-status`, { as: 'alice' });
    expect(await res.json()).toEqual({ held: { count: 0, nextReleaseAt: null }, failed: 0 });
  });
});

describe('cleanup', () => {
  function seedHeld(org: string, integration: string, n = 2): void {
    const insert = h.db.raw.prepare(
      `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,event_type,title,url,repo,actor,status,summary)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < n; i++)
      insert.run(
        `${integration}-h${i}`,
        org,
        integration,
        'digest',
        'k'.repeat(32),
        'held',
        1,
        1,
        'issues.opened',
        't',
        '',
        '',
        '',
        'info',
        '',
      );
    h.db.raw
      .prepare(
        'INSERT INTO noise_open_failures(organization_id,integration_id,key_hash,opened_at) VALUES(?,?,?,?)',
      )
      .run(org, integration, 'f'.repeat(32), 1);
  }
  const rows = (table: string, integration: string): number =>
    (
      h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE integration_id=?`).get(integration) as {
        n: number;
      }
    ).n;

  it('deleting an integration deletes what it was holding, and only that', async () => {
    const a = await createdId(await createGithub('alice'));
    const b = await createdId(await createGithub('alice', { name: 'Other' }));
    seedHeld('org-a', a);
    seedHeld('org-a', b);
    expect((await call('DELETE', `/api/integrations/${a}`, { as: 'alice' })).status).toBe(204);
    expect(rows('held_events', a)).toBe(0);
    expect(rows('noise_open_failures', a)).toBe(0);
    expect(rows('held_events', b)).toBe(2);
    expect(rows('noise_open_failures', b)).toBe(1);
  });

  it('deleting a source with cascade deletes what its integrations were holding', async () => {
    const res = await call('POST', '/api/sources', { as: 'alice', body: { name: 'CI' } });
    const { source } = await res.json<{ source: { id: string } }>();
    const route = await call('POST', '/api/integrations', {
      as: 'alice',
      body: { name: 'x', sourceId: source.id, destination: 'slack', webhookUrl: SLACK, noise: quietDoc },
    });
    const id = await createdId(route);
    seedHeld('org-a', id);
    expect((await call('DELETE', `/api/sources/${source.id}?cascade=true`, { as: 'alice' })).status).toBe(
      204,
    );
    expect(rows('held_events', id)).toBe(0);
  });

  it('the workspace purge removes held events and open failures of that workspace only', async () => {
    const a = await createdId(await createGithub('alice'));
    seedHeld('org-a', a);
    seedHeld('org-b', 'other-integration');
    await call('POST', '/api/workspace/deletion', { as: 'alice', body: { confirm: 'org-a' } });
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000;
    while (!(await purgeDueWorkspace(h.db.d1, later)).completed) {
      // bounded ticks: keep going until the workspace is gone
    }
    const count = (table: string, org: string): number =>
      (
        h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id=?`).get(org) as {
          n: number;
        }
      ).n;
    expect(count('held_events', 'org-a')).toBe(0);
    expect(count('noise_open_failures', 'org-a')).toBe(0);
    expect(count('held_events', 'org-b')).toBe(2);
    expect(count('noise_open_failures', 'org-b')).toBe(1);
  });
});

describe('retention', () => {
  it('removes released rows after 7 days and open failures after 30, never a waiting row', async () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const insert = h.db.raw.prepare(
      `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,released_at,event_type,title,url,repo,actor,status,summary)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const args = (id: string, state: string, releasedAt: number | null) =>
      [
        id,
        'org-a',
        'i',
        'digest',
        'k'.repeat(32),
        state,
        1,
        1,
        releasedAt,
        'x',
        't',
        '',
        '',
        '',
        'info',
        '',
      ] as const;
    insert.run(...args('old-released', 'released', now - HELD_RETENTION_MS - 1));
    insert.run(...args('fresh-released', 'released', now - HELD_RETENTION_MS + 60_000));
    insert.run(...args('ancient-waiting', 'held', null));
    const failure = h.db.d1.prepare(
      'INSERT INTO noise_open_failures(organization_id,integration_id,key_hash,opened_at) VALUES(?,?,?,?)',
    );
    await failure.bind('org-a', 'i', 'a'.repeat(32), now - OPEN_FAILURE_RETENTION_MS - 1).run();
    await failure.bind('org-a', 'i', 'b'.repeat(32), now - 1000).run();
    expect(await purgeNoise(h.db.d1, now)).toEqual({ held: 1, openFailures: 1, failed: 0 });
    const ids = (h.db.raw.prepare('SELECT id FROM held_events ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).toEqual(['ancient-waiting', 'fresh-released']);
  });

  it('drains a backlog in bounded rounds', async () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const insert = h.db.raw.prepare(
      `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,released_at,event_type,title,url,repo,actor,status,summary)
       VALUES(?,'org-a','i','digest',?,'released',1,1,1,'x','t','','','','info','')`,
    );
    for (let i = 0; i < 3200; i++) insert.run(`r${i}`, 'k'.repeat(32));
    const first = await purgeNoise(h.db.d1, now);
    expect(first.held).toBe(2500); // 5 rounds of 500
    expect((await purgeNoise(h.db.d1, now)).held).toBe(700);
  });
});

describe('dead-lettered rows', () => {
  it('are kept 30 days for inspection, then removed', async () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const insert = h.db.raw.prepare(
      `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,state,release_at,held_at,released_at,attempts,last_error_class,event_type,title,url,repo,actor,status,summary)
       VALUES(?,'org-a','i','digest',?,'failed',1,1,?,5,'batch_failed','x','t','','','','info','')`,
    );
    insert.run('old', 'a'.repeat(32), now - FAILED_RETENTION_MS - 1);
    insert.run('new', 'b'.repeat(32), now - 1000);
    expect(await purgeNoise(h.db.d1, now)).toMatchObject({ failed: 1 });
    const ids = (h.db.raw.prepare('SELECT id FROM held_events').all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(['new']);
  });
});
