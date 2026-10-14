import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEBHOOK_PROBES_RECORDED_PER_MINUTE } from '../../src/connectors/sources/github/probe';
import { INGRESS_LIMIT_PER_MINUTE } from '../../src/security/rate-limit';
import { createRig, type Rig } from '../conformance/rig';
import { loadFixtureJson, loadManifest } from '../fixtures/load';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * F50 response codes, F29 flood control and the refused-tenant audit (REMAINING 1.17, 2.4, 1.23),
 * pinned through the whole GitHub route over the fake D1.
 */
const entry = (id: string) => {
  const e = loadManifest().find((m) => m.id === id);
  if (!e) throw new Error(id);
  return e;
};
const pr = entry('github/pull_request.opened');
const body = (rig: Rig, e = pr) => rig.encode(loadFixtureJson(e));

afterEach(() => vi.restoreAllMocks());

describe('F50 response codes on the GitHub route', () => {
  it('answers 415, not a later 400 or 401, to a body that is not application/json', async () => {
    const rig = await createRig('github', worker);
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', null]) {
      const res = await rig.post(`payload=${encodeURIComponent(body(rig))}`, {
        headers: pr.headers,
        contentType,
      });
      expect(res.status, String(contentType)).toBe(415);
    }
    expect(rig.count('deliveries')).toBe(0);
    // Parameters on the right type are fine.
    const ok = await rig.post(body(rig), {
      headers: pr.headers,
      contentType: 'application/json; charset=utf-8',
    });
    expect(ok.status).toBe(202);
  });

  it('answers an exact duplicate 200 (not 202, not 4xx) and still queues nothing new', async () => {
    const rig = await createRig('github', worker);
    const first = await rig.post(body(rig), { headers: pr.headers, deliveryId: 'dup-1' });
    expect(first.status).toBe(202);
    const delivered = rig.count('deliveries', "state != 'suppressed'");
    const outbox = rig.count('notification_outbox');
    const again = await rig.post(body(rig), { headers: pr.headers, deliveryId: 'dup-1' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ accepted: true, persisted: 0, duplicate: true });
    expect(rig.count('deliveries', "state != 'suppressed'")).toBe(delivered);
    expect(rig.count('notification_outbox')).toBe(outbox);
  });

  it('puts our correlation id in the body of every non-2xx answer, and never a secret or the payload', async () => {
    const rig = await createRig('github', worker);
    const forged = await rig.post(body(rig), { headers: pr.headers, signature: 'forged' });
    expect(forged.status).toBe(401);
    const text = await forged.text();
    const parsed = JSON.parse(text) as { error: string; correlation_id: string };
    expect(parsed.correlation_id).toBe(forged.headers.get('x-request-id'));
    expect(text).not.toContain('sha256=');
    expect(text).not.toContain('Hello-World');
    const missing = await rig.post(body(rig), { headers: {} });
    expect(missing.status).toBe(400);
    expect((await missing.json<{ correlation_id: string }>()).correlation_id).toBeTruthy();
    const wrongType = await rig.post(body(rig), { headers: pr.headers, contentType: 'text/plain' });
    expect((await wrongType.json<{ correlation_id: string }>()).correlation_id).toBeTruthy();
  });
});

describe('F29 flood control through the whole GitHub route', () => {
  it('answers 429 with Retry-After once an installation is over budget, queues nothing, and counts it', async () => {
    const rig = await createRig('github', worker);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 14, 12, 0, 10));
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    // The window is already at the limit; the next verified event is over it.
    rig.h.db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run('ingress:github:1001', windowStart, INGRESS_LIMIT_PER_MINUTE);
    const res = await rig.post(body(rig), { headers: pr.headers, deliveryId: 'flood-1' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('50');
    expect((await res.json<{ correlation_id: string }>()).correlation_id).toBeTruthy();
    expect(rig.count('deliveries')).toBe(0);
    expect(rig.count('notification_outbox')).toBe(0);
    expect(rig.h.waitUntil).not.toHaveBeenCalled();
    // The next window is a fresh budget.
    now.mockReturnValue(Date.UTC(2026, 9, 14, 12, 1, 5));
    expect((await rig.post(body(rig), { headers: pr.headers, deliveryId: 'flood-2' })).status).toBe(202);
    // Accounting is separate from the limiter and says what happened.
    expect(
      rig.h.db.raw
        .prepare(
          'SELECT organization_id AS o, source, events_accepted AS a, events_rate_limited AS r FROM ingress_usage',
        )
        .all(),
    ).toEqual([{ o: 'org-a', source: 'github', a: 1, r: 1 }]);
  });

  it('does not limit a lifecycle event, and an unsigned flood never spends the budget', async () => {
    const rig = await createRig('github', worker);
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    rig.h.db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run('ingress:github:1001', windowStart, INGRESS_LIMIT_PER_MINUTE + 50);
    const e = entry('github/installation.deleted');
    expect((await rig.post(body(rig, e), { headers: e.headers })).status).toBe(202);
    const before = rig.h.db.raw.prepare('SELECT count FROM api_rate_limits').get();
    for (let i = 0; i < 3; i++) await rig.post(body(rig), { headers: pr.headers, signature: 'forged' });
    expect(rig.h.db.raw.prepare('SELECT count FROM api_rate_limits').get()).toEqual(before);
  });

  it('counts accepted events and duplicates per workspace, apart from the abuse counters', async () => {
    const rig = await createRig('github', worker);
    await rig.post(body(rig), { headers: pr.headers, deliveryId: 'c1' });
    await rig.post(body(rig), { headers: pr.headers, deliveryId: 'c1' });
    await rig.post(body(rig), { headers: pr.headers, deliveryId: 'c2' });
    expect(
      rig.h.db.raw
        .prepare(
          'SELECT organization_id AS o, source, events_accepted AS a, events_duplicate AS d, events_rate_limited AS r FROM ingress_usage',
        )
        .all(),
    ).toEqual([{ o: 'org-a', source: 'github', a: 2, d: 1, r: 0 }]);
  });
});

describe('1.23 refused tenants are audited, boundedly, and the answer does not change', () => {
  const refusals = (rig: Rig) =>
    rig.h.db.raw
      .prepare(
        "SELECT organization_id AS o, subject_type AS t, subject_id AS s, outcome, metadata_json AS m FROM audit_events WHERE action='github.webhook.refused'",
      )
      .all();
  const asInstallation = (rig: Rig, id: number) =>
    JSON.stringify({
      ...(JSON.parse(rig.encode(loadFixtureJson(pr))) as Record<string, unknown>),
      installation: { id, app_id: 777 },
    });

  it('records a signed event for an installation no workspace owns once an hour, with no workspace', async () => {
    const rig = await createRig('github', worker);
    const answers = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await rig.post(asInstallation(rig, 424242), { headers: pr.headers, deliveryId: `u${i}` });
      expect(res.status).toBe(403);
      answers.add((await res.text()).replace(/,"correlation_id":"[^"]+"/, ''));
    }
    expect(answers.size).toBe(1);
    expect(refusals(rig)).toEqual([
      {
        o: null,
        t: 'github_installation',
        s: '424242',
        outcome: 'denied',
        m: JSON.stringify({ reason: 'unknown_installation' }),
      },
    ]);
    expect(rig.count('deliveries')).toBe(0);
  });

  it('caps the platform-wide rate, so many installation ids cannot flood the log', async () => {
    const rig = await createRig('github', worker);
    for (let i = 0; i < WEBHOOK_PROBES_RECORDED_PER_MINUTE + 10; i++)
      expect((await rig.post(asInstallation(rig, 5000 + i), { headers: pr.headers })).status).toBe(403);
    expect(refusals(rig)).toHaveLength(WEBHOOK_PROBES_RECORDED_PER_MINUTE);
  });

  it('records a suspended installation against ITS workspace', async () => {
    const rig = await createRig('github', worker);
    rig.h.db.raw.prepare("UPDATE github_installations SET status='suspended' WHERE id='gi-1'").run();
    const res = await rig.post(body(rig), { headers: pr.headers });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Installation not active');
    expect(refusals(rig)).toEqual([
      {
        o: 'org-a',
        t: 'github_installation',
        s: '1001',
        outcome: 'denied',
        m: JSON.stringify({ reason: 'not_active' }),
      },
    ]);
  });

  it('answers the same when recording fails (a failed write never changes the response)', async () => {
    const rig = await createRig('github', worker);
    rig.h.db.raw.exec('DROP TABLE audit_events');
    const res = await rig.post(asInstallation(rig, 777777), { headers: pr.headers });
    expect(res.status).toBe(403);
  });
});
