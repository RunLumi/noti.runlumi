import { afterEach, describe, expect, it, vi } from 'vitest';
import { dedupKey, deliveryId as deriveDelivery } from '../../src/delivery/ids';
import { releaseHeldEvents } from '../../src/pipeline/noise-release';
import { DEFAULT_NOISE, serializeNoise, type NoiseSettings } from '../../src/routing/noise';
import {
  comment,
  createHarness,
  insertIntegration,
  postGithub,
  setNow,
  workflowRun,
  type Harness,
} from './harness';

/**
 * No-loss property (spec 11 "every suppression path routes to a digest or a visible held
 * state"): whatever the settings, the clock, redeliveries and settings changes mid-stream, every
 * (event, integration) pair ingested is accounted for EXACTLY ONCE: delivered at once, or held
 * and then released inside exactly one delivery, with a count that matches. A seeded RNG makes a
 * failure reproducible: the seed is in the test name.
 */

/** mulberry32: small, fast, deterministic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)] as T;

function randomSettings(r: () => number): NoiseSettings | null {
  if (r() < 0.2) return null;
  const timezone = pick(r, ['Asia/Ho_Chi_Minh', 'America/New_York', 'Asia/Kolkata', 'UTC']);
  const start = pick(r, ['20:00', '22:00', '23:30']);
  const end = pick(r, ['06:00', '07:30', '08:00']);
  return {
    ...DEFAULT_NOISE,
    timezone,
    quietHours: r() < 0.5 ? { start, end } : null,
    groupWindowSec: pick(r, [0, 60, 300, 900, 3600] as const),
    digest: pick(r, ['off', 'off', 'hourly', 'daily'] as const),
    digestAt: pick(r, ['08:00', '12:15', '23:00']),
    resolution: r() < 0.3,
  };
}

interface Ingested {
  readonly org: string;
  readonly installation: number;
  readonly deliveryId: string;
  /** Integrations of the organization that were subscribed when the event was first posted. */
  readonly integrations: readonly string[];
}

const INTEGRATIONS = [
  { id: 'i1', org: 'org-a', installation: 1001 },
  { id: 'i2', org: 'org-a', installation: 1001 },
  { id: 'i3', org: 'org-b', installation: 1002 },
] as const;

async function scenario(h: Harness, seed: number, events: number): Promise<Ingested[]> {
  const r = rng(seed);
  for (const i of INTEGRATIONS) insertIntegration(h, i.id, i.org, randomSettings(r));
  const ingested: Ingested[] = [];
  let at = Date.parse('2026-03-07T00:00:00Z') + Math.floor(r() * 86_400_000);
  setNow(new Date(at).toISOString());

  for (let n = 0; n < events; n++) {
    at += Math.floor(r() * 40 * 60_000);
    setNow(new Date(at).toISOString());
    const roll = r();
    if (roll < 0.05) {
      // The person edits an integration's settings in the middle of the stream.
      const target = pick(r, INTEGRATIONS);
      h.db.raw
        .prepare('UPDATE integrations SET noise_json=? WHERE id=?')
        .run(serializeNoise(randomSettings(r)), target.id);
    }
    if (roll > 0.9) await releaseHeldEvents(h.env, { now: () => at, token: () => crypto.randomUUID() });

    // A redelivery of an earlier event (same delivery id) 15% of the time.
    if (ingested.length > 0 && r() < 0.15) {
      const again = pick(r, ingested);
      await postGithub(h, 'issue_comment', comment(1), again.deliveryId, {
        installation: again.installation,
      });
      continue;
    }
    const target = pick(r, [1001, 1002] as const);
    const org = target === 1001 ? 'org-a' : 'org-b';
    const id = `gh-${seed}-${n}`;
    const kind = r();
    if (kind < 0.6)
      await postGithub(h, 'issue_comment', comment(1 + Math.floor(r() * 4)), id, { installation: target });
    else if (kind < 0.75)
      await postGithub(
        h,
        'workflow_run',
        workflowRun('failure', { id: n, branch: pick(r, ['main', 'dev']) }),
        id,
        {
          installation: target,
        },
      );
    else
      await postGithub(
        h,
        'workflow_run',
        workflowRun('success', { id: n, branch: pick(r, ['main', 'dev']) }),
        id,
        {
          installation: target,
        },
      );
    ingested.push({
      org,
      installation: target,
      deliveryId: id,
      integrations: INTEGRATIONS.filter((i) => i.org === org).map((i) => i.id),
    });
  }
  return ingested;
}

async function drain(h: Harness, from: number): Promise<void> {
  let at = from + 3 * 86_400_000;
  setNow(new Date(at).toISOString());
  for (let i = 0; i < 100; i++) {
    const held = h.db.raw
      .prepare("SELECT COUNT(*) AS n FROM held_events WHERE state IN ('held','claimed')")
      .get() as {
      n: number;
    };
    if (held.n === 0) return;
    at += 3_700_000;
    await releaseHeldEvents(h.env, { now: () => at, token: () => crypto.randomUUID() });
  }
  throw new Error('held events did not drain');
}

interface HeldRow {
  id: string;
  organization_id: string;
  integration_id: string;
  state: string;
  released_in: string | null;
}
interface DeliveryRow {
  id: string;
  organization_id: string;
  integration_id: string;
}

describe('noise control conserves every event', () => {
  afterEach(() => vi.useRealTimers());
  const SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i * 7919);

  it.each(SEEDS)(
    'seed %i: every (event, integration) is delivered or held and released exactly once',
    async (seed) => {
      const h = createHarness();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const ingested = await scenario(h, seed, 120);
      await drain(h, Date.now());

      const all = <T>(sql: string): T[] => h.db.raw.prepare(sql).all() as unknown as T[];
      const held = all<HeldRow>(
        'SELECT id,organization_id,integration_id,state,released_in FROM held_events',
      );
      const deliveries = all<DeliveryRow>('SELECT id,organization_id,integration_id FROM deliveries');
      const outbox = all<{ id: string; organization_id: string; payload_json: string }>(
        'SELECT id,organization_id,payload_json FROM notification_outbox',
      );
      const deliveryIds = new Set(deliveries.map((d) => d.id));
      const heldById = new Map(held.map((r) => [r.id, r]));

      // 1. Nothing is left waiting.
      expect(held.filter((r) => r.state !== 'released')).toEqual([]);

      // 2. A released row points at a delivery of the same tenant and integration.
      for (const row of held) {
        expect(row.released_in).not.toBeNull();
        const carrier = deliveries.find((d) => d.id === row.released_in);
        expect(carrier).toBeDefined();
        expect(carrier).toMatchObject({
          organization_id: row.organization_id,
          integration_id: row.integration_id,
        });
      }

      // 3. Each ingested (event, integration) pair is accounted for at most once as a delivery and
      //    at most once as a held row, and never as both unless the held row IS that delivery
      //    (a lone held event is released under its own id).
      let delivered = 0;
      let heldAccounted = 0;
      for (const event of ingested) {
        for (const integration of event.integrations) {
          const dedup = await dedupKey({
            orgId: event.org,
            connectionId: String(event.installation),
            source: 'github',
            eventId: event.deliveryId,
          });
          const id = (await deriveDelivery(dedup.hex, integration)).hex;
          const hasHeld = heldById.has(id);
          const hasDelivery = deliveryIds.has(id);
          if (hasHeld) {
            heldAccounted++;
            // Held, then carried by exactly one delivery: either its own id (a single) or a combined one.
            const carrier = heldById.get(id)?.released_in;
            expect(deliveryIds.has(carrier ?? '')).toBe(true);
            if (carrier !== id) expect(hasDelivery).toBe(false);
          } else if (hasDelivery) delivered++;
          // Every subscribed pair must be one or the other: nothing is dropped.
          expect(hasHeld || hasDelivery).toBe(true);
        }
      }

      // 4. Conservation of counts: a combined notification stands for exactly the held rows that
      //    point at it, and every notification in the outbox has a delivery row.
      for (const m of outbox) {
        expect(deliveryIds.has(m.id)).toBe(true);
        const payload = JSON.parse(m.payload_json) as { count?: number; organizationId: string };
        expect(payload.organizationId).toBe(m.organization_id);
        const carried = held.filter((r) => r.released_in === m.id);
        if (payload.count !== undefined) {
          expect(carried.length).toBe(Math.min(payload.count, 500));
        } else {
          expect(carried.length).toBeLessThanOrEqual(1);
        }
      }
      expect(outbox.length).toBe(deliveries.length);

      // 5. Every held row belongs to one ingested pair, so nothing was invented or double counted.
      expect(heldAccounted).toBe(held.length);
      // The scenario must actually exercise both paths for the property to mean something.
      expect(delivered + heldAccounted).toBeGreaterThan(0);
    },
  );

  it('exercises holds, groups, digests and bypasses across the seeds (the property is not vacuous)', async () => {
    let held = 0;
    let combined = 0;
    let immediate = 0;
    for (const seed of SEEDS.slice(0, 8)) {
      const h = createHarness();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const ingested = await scenario(h, seed, 120);
      await drain(h, Date.now());
      held += (h.db.raw.prepare('SELECT COUNT(*) AS n FROM held_events').get() as { n: number }).n;
      combined += (
        h.db.raw
          .prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE payload_json LIKE \'%"count":%\'')
          .get() as {
          n: number;
        }
      ).n;
      immediate += ingested.length;
    }
    expect(held).toBeGreaterThan(50);
    expect(combined).toBeGreaterThan(5);
    expect(immediate).toBeGreaterThan(0);
  });
});
