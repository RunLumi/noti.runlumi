import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '../../src/connectors/sources/github/route';
import { createRig, type Rig } from '../conformance/rig';
import { loadFixtureJson, loadManifest } from '../fixtures/load';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * GitHub ingress contract (spec 05 F59, F60, F63, F64, F65): the header contract, actor handling
 * through the route, the oversize behaviour, and ack discipline, each pinned by a test so an
 * upstream or internal change fails CI rather than a customer's channel.
 */
const entry = (id: string) => {
  const e = loadManifest().find((m) => m.id === id);
  if (!e) throw new Error(id);
  return e;
};
const pr = entry('github/pull_request.opened');
const body = (rig: Rig, e = pr) => rig.encode(loadFixtureJson(e));

afterEach(() => vi.unstubAllGlobals());

describe('F59 header contract', () => {
  it('uses X-GitHub-Event and X-GitHub-Delivery; a delivery without either is 400 after verification', async () => {
    const rig = await createRig('github', worker);
    const noEvent = await rig.post(body(rig), { headers: {} });
    expect(noEvent.status).toBe(400);
    // An empty delivery id header is as good as none.
    const noDelivery = await rig.post(body(rig), { headers: { ...pr.headers }, deliveryId: '' });
    expect(noDelivery.status).toBe(400);
    expect(rig.count('deliveries')).toBe(0);
  });

  it('treats the delivery id as an opaque string: any shape is accepted and used as identity', async () => {
    const rig = await createRig('github', worker);
    for (const id of ['72d3162e-cc78-11e3-81ab-4c9367dc0958', 'not-a-uuid', 'ZZZ_123', 'x'.repeat(100)]) {
      const res = await rig.post(body(rig), { headers: pr.headers, deliveryId: id });
      expect(res.status, id).toBe(202);
    }
    // Four distinct ids are four distinct events (per integration that wanted it).
    expect(rig.count('deliveries') % 4).toBe(0);
  });

  it('takes the action from the body, not from a header', async () => {
    const rig = await createRig('github', worker);
    const json = loadFixtureJson(pr);
    const res = await rig.post(rig.encode({ ...json, action: 'closed' }), {
      headers: { ...pr.headers, 'x-github-action': 'opened' },
    });
    expect(res.status).toBe(202);
    expect(rig.messages()[0]?.eventType).toBe('pull_request.closed');
  });

  it('reads headers case-insensitively', async () => {
    const rig = await createRig('github', worker);
    const res = await rig.post(body(rig), { headers: { 'X-GitHub-Event': 'pull_request' } });
    expect(res.status).toBe(202);
    expect(rig.count('deliveries')).toBeGreaterThan(0);
  });

  it('refuses a SHA-1-only signature: only X-Hub-Signature-256 verifies', async () => {
    const rig = await createRig('github', worker);
    const res = await worker.fetch(
      new Request(`https://noti.test${rig.path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'd1',
          'x-hub-signature': `sha1=${'a'.repeat(40)}`,
        },
        body: body(rig),
      }),
      rig.h.env,
      { waitUntil: rig.h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it('ignores the installation-target headers: they never select a tenant', async () => {
    const rig = await createRig('github', worker);
    const res = await rig.post(JSON.stringify({ ...loadFixtureJson(pr), installation: undefined }), {
      headers: {
        ...pr.headers,
        'x-github-hook-installation-target-id': '1001',
        'x-github-hook-installation-target-type': 'integration',
      },
    });
    expect(res.status).toBe(403);
  });
});

describe('F60 actor trust through the route', () => {
  it('a ghost sender is delivered without attribution, and a bot by its own login', async () => {
    const ghost = await createRig('github', worker);
    await ghost.post(body(ghost, entry('github/pull_request.opened_by_ghost')), { headers: pr.headers });
    expect(ghost.messages()[0]).toBeDefined();
    expect(ghost.messages()[0]?.actor).toBeUndefined();
    const bot = await createRig('github', worker);
    await bot.post(body(bot, entry('github/pull_request.opened_by_bot')), { headers: pr.headers });
    expect(bot.messages()[0]?.actor).toBe('dependabot[bot]');
  });

  it('a bot is held back by an integration that excludes bots, and delivered to one that does not', async () => {
    const rig = await createRig('github', worker);
    await rig.post(body(rig, entry('github/pull_request.opened_by_bot')), { headers: pr.headers });
    const delivered = (id: string) =>
      (
        rig.h.db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE integration_id=?').get(id) as {
          n: number;
        }
      ).n;
    expect(delivered(rig.integrations['humans-only'] as string)).toBe(0);
    expect(delivered(rig.integrations.all as string)).toBe(1);
  });
});

describe('F63 payload caps', () => {
  it('documents the cap and refuses over it with 413, naming the reason in the log (constants only)', async () => {
    expect(MAX_BODY_BYTES).toBe(1024 * 1024);
    const rig = await createRig('github', worker);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await rig.post(new Uint8Array(MAX_BODY_BYTES + 1).fill(0x20), {
      headers: pr.headers,
      signature: 'none',
    });
    expect(res.status).toBe(413);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('github_event_too_large'));
    warn.mockRestore();
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toMatchObject({
      reason: 'over_ingress_cap',
      limit_bytes: MAX_BODY_BYTES,
    });
    expect(rig.count('deliveries')).toBe(0);
  });

  it('accepts a body of exactly the cap, and a push with no commits is not an error', async () => {
    const rig = await createRig('github', worker);
    const text = body(rig, entry('github/push'));
    expect(JSON.parse(text).commits).toEqual([]);
    const res = await rig.post(text, { headers: { 'x-github-event': 'push' } });
    expect(res.status).toBe(202);
    const padded = text.slice(0, -1) + ' '.repeat(MAX_BODY_BYTES - text.length) + '}';
    expect(padded.length).toBe(MAX_BODY_BYTES);
    expect((await rig.post(padded, { headers: { 'x-github-event': 'push' } })).status).toBe(202);
  });
});

describe('F64 ack discipline', () => {
  const failingBatch = (rig: Rig): void => {
    const real = rig.h.env.DB;
    rig.h.env = {
      ...rig.h.env,
      DB: new Proxy(real, {
        get: (target, prop, receiver) =>
          prop === 'batch'
            ? () => Promise.reject(new Error('D1 unavailable'))
            : (Reflect.get(target, prop, receiver) as unknown),
      }),
    };
  };

  it('answers 5xx, not 2xx, when the durable write fails, and never kicks the dispatcher', async () => {
    const rig = await createRig('github', worker);
    failingBatch(rig);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await rig.post(body(rig), { headers: pr.headers });
    error.mockRestore();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(rig.count('deliveries')).toBe(0);
    expect(rig.count('notification_outbox')).toBe(0);
    expect(rig.h.waitUntil).not.toHaveBeenCalled();
  });

  it('a lifecycle update that fails is also a 5xx, so a revocation is never silently lost', async () => {
    const rig = await createRig('github', worker);
    failingBatch(rig);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const e = entry('github/installation.deleted');
    const res = await rig.post(body(rig, e), { headers: e.headers });
    error.mockRestore();
    expect(res.status).toBe(500);
  });

  it('the 2xx comes with the rows already committed, and the dispatcher kick is only a hint after it', async () => {
    const rig = await createRig('github', worker);
    const order: string[] = [];
    rig.h.waitUntil.mockImplementation(() => order.push(`waitUntil:${rig.count('notification_outbox')}`));
    const res = await rig.post(body(rig), { headers: pr.headers });
    expect(res.status).toBe(202);
    const persisted = (await res.json<{ persisted: number }>()).persisted;
    expect(persisted).toBeGreaterThan(0);
    expect(order).toEqual([`waitUntil:${persisted}`]);
  });

  it('makes no outbound network call while ingesting', async () => {
    const rig = await createRig('github', worker);
    await rig.post(body(rig), { headers: pr.headers });
    expect(rig.h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('F65 what can be detected without the App private key', () => {
  it('a redelivery keeps X-GitHub-Delivery and is absorbed; a gap in ids is not a signal', async () => {
    const rig = await createRig('github', worker);
    await rig.post(body(rig), { headers: pr.headers, deliveryId: 'same' });
    const again = await rig.post(body(rig), { headers: pr.headers, deliveryId: 'same' });
    expect((await again.json<{ persisted: number }>()).persisted).toBe(0);
    // Delivery ids are opaque GUIDs with no sequence: nothing here can reveal a delivery that
    // never arrived. Detecting one needs GET /app/hook/deliveries with the App JWT (F65/F69,
    // blocked on the App private key), so no reconciliation is claimed.
  });
});
