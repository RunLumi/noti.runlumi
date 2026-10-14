import { afterEach, describe, expect, it, vi } from 'vitest';
import * as validate from '../../src/events/validate';
import { canonicalFromDisplay } from '../../src/events/canonical';
import { boundedEventId } from '../../src/events/id';
import { loadFixtureJson, loadManifest } from '../fixtures/load';
import { createRig } from './rig';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * Our own mapper/validator mismatch must never become a provider-visible failure (ADR 0020): GitLab
 * disables a hook after repeated 4xx, Stripe retries for days, and GitHub never retries, so a 4xx
 * would lose the event silently. A refusal for OUR fault is a logged, counted 2xx.
 */
const entry = (id: string) => {
  const e = loadManifest().find((m) => m.id === id);
  if (!e) throw new Error(id);
  return e;
};

afterEach(() => vi.restoreAllMocks());

describe('a validator rejection is acknowledged, logged and counted, never a 4xx', () => {
  for (const id of ['github/pull_request.opened', 'gitlab/push', 'stripe/invoice.payment_failed']) {
    it(id, async () => {
      const e = entry(id);
      const rig = await createRig(e.provider, worker);
      vi.spyOn(validate, 'validateCanonicalEvent').mockReturnValue({
        ok: false,
        errors: [{ field: 'data.title', reason: 'unsafe_text' }],
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await rig.post(rig.encode(loadFixtureJson(e)), { headers: e.headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: false, ignored: 'schema_invalid' });
      expect(rig.count('deliveries')).toBe(0);
      expect(rig.count('notification_outbox')).toBe(0);
      const line = error.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('canonical_event_invalid'));
      expect(line).toBeDefined();
      // Field names and reasons only: never a value.
      expect(JSON.parse(line as string).fields).toEqual(['data.title:unsafe_text']);
      if (e.provider !== 'github') {
        const row = rig.h.db.raw.prepare('SELECT dropped_events FROM sources').get() as {
          dropped_events: number;
        };
        expect(row.dropped_events).toBe(1);
      }
    });
  }
});

describe('degrade rather than refuse', () => {
  it('a generic event whose summary is cut inside an emoji is accepted (it used to leave half a pair)', async () => {
    const e = entry('generic/flat');
    const rig = await createRig('generic', worker);
    const body = { ...loadFixtureJson(e), summary: `${'x'.repeat(278)}\u{1f600}tail`, fields: {} };
    const res = await rig.post(rig.encode(body), { headers: e.headers });
    expect(res.status).toBe(202);
    const summary = rig.messages()[0]?.summary ?? '';
    expect(summary.endsWith('…')).toBe(true);
    expect(/[\ud800-\udbff]$/.test(summary.slice(0, -1))).toBe(false);
  });

  it('a link that is not plain https is dropped and the event is still delivered', () => {
    for (const url of [
      'http://a.test/x',
      'javascript:alert(1)',
      'https://u:p@a.test/',
      'https://a.test/\u0007',
    ]) {
      const event = canonicalFromDisplay({
        provider: 'gitlab',
        adapterVersion: '1.0.0',
        id: 'i',
        source: 'https://gitlab.com',
        display: { title: 't', url, eventType: 'push', status: 'info' },
      });
      expect(event.data.url).toBeUndefined();
      expect(validate.validateCanonicalEvent(event).ok).toBe(true);
    }
  });

  it('an over-long or unprintable provider id is hashed, deterministically, not refused', async () => {
    const long = 'd'.repeat(600);
    const hashed = await boundedEventId(long);
    expect(hashed).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await boundedEventId(long)).toBe(hashed);
    expect(await boundedEventId('ok-id')).toBe('ok-id');
    expect(await boundedEventId('a\u0000b')).toMatch(/^sha256:/);
    const e = entry('github/pull_request.opened');
    const rig = await createRig('github', worker);
    const res = await rig.post(rig.encode(loadFixtureJson(e)), { headers: e.headers, deliveryId: long });
    expect(res.status).toBe(202);
    expect(rig.count('deliveries')).toBeGreaterThan(0);
  });
});
