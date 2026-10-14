import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLACK, setup, type Harness } from '../sources/harness';
import { PIPELINE_FAILED, PUSH } from '../sources/fixtures/gitlab';
import { gitlabSignHeaders, newSigningToken, providerHelpers } from '../sources/provider-harness';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/** Noise control on the provider route (GitLab here; Stripe shares the route code). */
let h: Harness;
const { call, createProviderSource, postTo } = providerHelpers(worker, () => h);

beforeEach(() => {
  h = setup();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const count = (table: string, where = '1=1'): number =>
  (h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

describe('GitLab source with quiet hours', () => {
  async function connect() {
    const src = await createProviderSource('gitlab', newSigningToken(), { authMode: 'signing_token' });
    const res = await call('POST', '/api/integrations', {
      as: 'alice',
      body: {
        name: 'to slack',
        sourceId: src.id,
        destination: 'slack',
        webhookUrl: SLACK,
        noise: { timezone: 'Asia/Ho_Chi_Minh', quietHours: { start: '22:00', end: '08:00' } },
      },
    });
    expect(res.status).toBe(201);
    return src;
  }
  const post = (src: { endpointId: string; secret: string }, event: string, payload: unknown, id: string) => {
    const body = JSON.stringify(payload);
    return postTo(`/webhooks/gitlab/${src.endpointId}`, body, {
      'x-gitlab-event': event,
      ...gitlabSignHeaders(src.secret, body, { id }),
    });
  };

  it('holds a push at night, lets a failed pipeline through, and does not call a held repeat a duplicate', async () => {
    const src = await connect();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T16:00:00Z'));
    const push = await post(src, 'Push Hook', PUSH, 'msg_1');
    expect(await push.json()).toEqual({ accepted: true, persisted: 0, held: 1 });
    const failed = await post(src, 'Pipeline Hook', PIPELINE_FAILED, 'msg_2');
    expect(await failed.json()).toEqual({ accepted: true, persisted: 1 });
    expect(count('held_events', "hold_reason='quiet_hours'")).toBe(1);
    expect(count('deliveries')).toBe(1);

    // The provider retries the held push: still one held row, no delivery.
    const retry = await post(src, 'Push Hook', PUSH, 'msg_1');
    expect(retry.status).toBe(200);
    expect(count('held_events')).toBe(1);
    expect(count('deliveries', "state != 'suppressed'")).toBe(1);
    expect(count('deliveries', "state = 'suppressed'")).toBe(1);

    // The bypass and the hold are both on record, as reason codes only.
    const reasons = h.db.raw.prepare('SELECT reason FROM routing_decisions ORDER BY rowid').all();
    expect(reasons).toEqual([{ reason: 'quiet_hours' }, { reason: 'critical_bypass' }]);
  });

  it('delivers normally outside quiet hours', async () => {
    const src = await connect();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T05:00:00Z'));
    const push = await post(src, 'Push Hook', PUSH, 'msg_1');
    expect(await push.json()).toEqual({ accepted: true, persisted: 1 });
    expect(count('held_events')).toBe(0);
  });
});
