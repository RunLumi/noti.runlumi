import { afterEach, describe, expect, it, vi } from 'vitest';
import { dedupKey, deliveryId as deriveDelivery } from '../../src/delivery/ids';
import type { Bindings } from '../../src/env';
import { MAX_ATTEMPTS, releaseHeldEvents } from '../../src/pipeline/noise-release';
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
 * state"): whatever the settings, the clock, redeliveries, settings changes, paused or deleted
 * integrations and injected D1 failures, every (event, integration) pair ingested is accounted for
 * EXACTLY ONCE: delivered at once, or held and then released inside exactly one delivery (or, only
 * after repeated release failures, visibly dead-lettered), with counts that match. A seeded RNG
 * makes a failure reproducible: the seed is in the test name.
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
  readonly critical: boolean;
  /** Integrations that existed AND were enabled when the event was first posted. */
  readonly integrations: Set<string>;
}

const INTEGRATIONS = [
  { id: 'i1', org: 'org-a', installation: 1001 },
  { id: 'i2', org: 'org-a', installation: 1001 },
  { id: 'i3', org: 'org-b', installation: 1002 },
] as const;

const expectedId = async (event: Ingested, integration: string): Promise<string> => {
  const dedup = await dedupKey({
    orgId: event.org,
    connectionId: String(event.installation),
    source: 'github',
    eventId: event.deliveryId,
  });
  return (await deriveDelivery(dedup.hex, integration)).hex;
};

/**
 * A D1 binding whose RELEASE batches fail at random (and, in "crash" mode, whose failure
 * bookkeeping fails too, so the claim is only recovered by the lease). Ingress and every other
 * statement go through untouched: a failed ingress write is the provider's retry, not our subject.
 */
function injecting(env: Bindings, r: () => number, probability: number): Bindings {
  const db = env.DB;
  return {
    ...env,
    DB: {
      prepare: db.prepare.bind(db),
      exec: db.exec.bind(db),
      batch: (statements: D1PreparedStatement[]) => {
        const sqls = (statements as unknown as { sql: string }[]).map((s) => s.sql);
        const releasing = sqls.some((s) =>
          s.includes('FROM held_events WHERE organization_id=? AND claim_token=?'),
        );
        const marking = sqls.some((s) => s.includes("last_error_class='batch_failed'"));
        if ((releasing || marking) && r() < (marking ? probability / 2 : probability))
          return Promise.reject(new Error('D1 unavailable'));
        return db.batch(statements);
      },
    } as unknown as D1Database,
  };
}

interface Run {
  readonly ingested: Ingested[];
  readonly deleted: ReadonlySet<string>;
  /** Largest clock value the scenario used. */
  readonly endedAt: number;
}

async function scenario(h: Harness, seed: number, events: number, faults: boolean): Promise<Run> {
  const r = rng(seed);
  for (const i of INTEGRATIONS) insertIntegration(h, i.id, i.org, randomSettings(r));
  const ingested: Ingested[] = [];
  const enabled = new Map<string, boolean>(INTEGRATIONS.map((i) => [i.id, true]));
  const deleted = new Set<string>();
  const flaky = injecting(h.env, r, faults ? 0.25 : 0);
  const deleteAt = seed % 3 === 0 ? Math.floor(events * 0.7) : -1;
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
    } else if (roll < 0.09) {
      // Pause or resume one integration: events meanwhile are not for it; what it holds waits.
      const flip = pick(r, ['i1', 'i2'] as const);
      const next = !enabled.get(flip);
      enabled.set(flip, next);
      h.db.raw.prepare('UPDATE integrations SET enabled=? WHERE id=?').run(next ? 1 : 0, flip);
    } else if (roll > 0.9) {
      const release = (): Promise<unknown> =>
        releaseHeldEvents(flaky, { now: () => at, token: () => crypto.randomUUID() }).catch(() => undefined);
      // Sometimes two overlapping runs, to exercise the claim.
      await (r() < 0.3 ? Promise.all([release(), release()]) : release());
    }
    if (n === deleteAt && !deleted.has('i3')) {
      // Deleting an integration deletes what it was holding (as the API does).
      h.db.raw.prepare("DELETE FROM held_events WHERE integration_id='i3'").run();
      h.db.raw.prepare("DELETE FROM integrations WHERE id='i3'").run();
      deleted.add('i3');
    }

    // A redelivery of an earlier event (same delivery id) 15% of the time.
    if (ingested.length > 0 && r() < 0.15) {
      const again = pick(r, ingested);
      await postGithub(h, 'issue_comment', comment(1), again.deliveryId, {
        installation: again.installation,
      });
      // An integration enabled since the first attempt receives it now: a new pair, like any other.
      for (const i of INTEGRATIONS)
        if (i.org === again.org && enabled.get(i.id) && !deleted.has(i.id)) again.integrations.add(i.id);
      continue;
    }
    const target = pick(r, [1001, 1002] as const);
    const org = target === 1001 ? 'org-a' : 'org-b';
    const id = `gh-${seed}-${n}`;
    const kind = r();
    const critical = kind >= 0.6 && kind < 0.75;
    const live = INTEGRATIONS.filter((i) => i.org === org && enabled.get(i.id) && !deleted.has(i.id)).map(
      (i) => i.id,
    );
    if (kind < 0.6)
      await postGithub(h, 'issue_comment', comment(1 + Math.floor(r() * 4)), id, { installation: target });
    else if (critical)
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
    const event: Ingested = {
      org,
      installation: target,
      deliveryId: id,
      critical,
      integrations: new Set(live),
    };
    ingested.push(event);

    if (critical) {
      // (a) A failure is delivered AT INGEST, to every integration that received it: it can never
      //     be swallowed into a held row or a later digest.
      for (const integration of live) {
        const row = h.db.raw
          .prepare('SELECT 1 AS present FROM deliveries WHERE id=?')
          .get(await expectedId(event, integration));
        expect(row, `failure ${id} to ${integration} was not delivered at ingest`).toBeTruthy();
      }
    }
  }
  return { ingested, deleted, endedAt: at };
}

async function drain(h: Harness, from: number, deleted: ReadonlySet<string>): Promise<void> {
  // Everything paused is resumed: held updates of a paused integration waited, and now release.
  for (const i of INTEGRATIONS)
    if (!deleted.has(i.id)) h.db.raw.prepare('UPDATE integrations SET enabled=1 WHERE id=?').run(i.id);
  let at = from + 3 * 86_400_000;
  setNow(new Date(at).toISOString());
  for (let i = 0; i < 400; i++) {
    const waiting = h.db.raw
      .prepare("SELECT COUNT(*) AS n FROM held_events WHERE state IN ('held','claimed')")
      .get() as { n: number };
    if (waiting.n === 0) return;
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
  release_at: number;
  released_at: number | null;
  attempts: number;
  event_type: string;
}
interface DeliveryRow {
  id: string;
  organization_id: string;
  integration_id: string;
}

/** Items a digest message lists plus items it says are not shown, parsed from its own text. */
function digestAccounting(summary: string): { listed: number; notShown: number } {
  let listed = 0;
  let notShown = 0;
  for (const line of summary.split('\n')) {
    if (/^[✗!•✓] /.test(line)) listed += Number(/\(×(\d+)\)$/.exec(line)?.[1] ?? 1);
    const more = /^…and (\d+) more items? not shown\./.exec(line);
    if (more) notShown += Number(more[1]);
  }
  return { listed, notShown };
}

async function checkConservation(h: Harness, run: Run, faults: boolean): Promise<void> {
  const all = <T>(sql: string): T[] => h.db.raw.prepare(sql).all() as unknown as T[];
  const held = all<HeldRow>(
    'SELECT id,organization_id,integration_id,state,released_in,release_at,released_at,attempts,event_type FROM held_events',
  );
  const deliveries = all<DeliveryRow>('SELECT id,organization_id,integration_id FROM deliveries');
  const outbox = all<{ id: string; organization_id: string; payload_json: string }>(
    'SELECT id,organization_id,payload_json FROM notification_outbox',
  );
  const deliveryIds = new Set(deliveries.map((d) => d.id));
  const heldById = new Map(held.map((r) => [r.id, r]));

  // 1. Nothing is left waiting; the only other end state is a visible, dead-lettered row.
  expect(held.filter((r) => r.state !== 'released' && r.state !== 'failed')).toEqual([]);
  const failed = held.filter((r) => r.state === 'failed');
  for (const row of failed) expect(row.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
  if (!faults) expect(failed).toEqual([]);

  // 2. A released row points at a delivery of the same tenant and integration, and is never
  //    released before it was due.
  for (const row of held.filter((r) => r.state === 'released')) {
    const carrier = deliveries.find((d) => d.id === row.released_in);
    expect(carrier).toBeDefined();
    expect(carrier).toMatchObject({
      organization_id: row.organization_id,
      integration_id: row.integration_id,
    });
    // (b) never before its release time
    expect(row.released_at ?? 0).toBeGreaterThanOrEqual(row.release_at);
  }

  // 3. A failure is never held (it bypasses), so no held row carries a failure event type.
  expect(held.filter((r) => /failure|timed_out/.test(r.event_type))).toEqual([]);

  // 4. Every (event, integration) pair is a delivery, a held-and-released row, or a visible
  //    failed row; never two of them, never none. Deleted integrations are exempt: deleting one
  //    deletes what it was holding, deliberately.
  let accounted = 0;
  for (const event of run.ingested) {
    for (const integration of event.integrations) {
      if (run.deleted.has(integration)) continue;
      const id = await expectedId(event, integration);
      const row = heldById.get(id);
      const delivered = deliveryIds.has(id);
      expect(row !== undefined || delivered, `event ${event.deliveryId} to ${integration} was lost`).toBe(
        true,
      );
      if (row?.state === 'released' && row.released_in !== id)
        expect(delivered, 'delivered both on its own and inside a digest').toBe(false);
      accounted++;
    }
  }
  expect(accounted).toBeGreaterThan(0);

  // 5. Counts conserve: a combined notification stands for exactly the rows pointing at it, and
  //    every outbox message has a delivery row.
  for (const m of outbox) {
    expect(deliveryIds.has(m.id)).toBe(true);
    const payload = JSON.parse(m.payload_json) as {
      count?: number;
      organizationId: string;
      integrationId: string;
      eventType?: string;
      summary?: string;
    };
    expect(payload.organizationId).toBe(m.organization_id);
    // A deleted integration took its held rows with it; its notifications remain.
    if (run.deleted.has(payload.integrationId)) continue;
    const carried = held.filter((r) => r.released_in === m.id);
    if (payload.count !== undefined) expect(carried.length).toBe(Math.min(payload.count, 500));
    else expect(carried.length).toBeLessThanOrEqual(1);
    if (payload.eventType === 'noti.digest') {
      // (e) A digest's own text accounts for every row it stands for: listed + not shown == rows.
      const { listed, notShown } = digestAccounting(payload.summary ?? '');
      expect(listed + notShown).toBe(carried.length);
    }
  }
  expect(outbox.length).toBe(deliveries.length);

  // 6. Every held row belongs to one ingested pair (nothing invented), and released rows keep no text.
  const known = new Set<string>();
  for (const event of run.ingested)
    for (const integration of event.integrations) known.add(await expectedId(event, integration));
  for (const row of held) expect(known.has(row.id)).toBe(true);
  const text = all<{ title: string; summary: string; url: string; actor: string; repo: string }>(
    "SELECT title,summary,url,actor,repo FROM held_events WHERE state='released'",
  );
  for (const row of text) expect(row).toEqual({ title: '', summary: '', url: '', actor: '', repo: '' });
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
      const run = await scenario(h, seed, 120, false);
      await drain(h, run.endedAt, run.deleted);
      await checkConservation(h, run, false);
    },
  );

  it.each(SEEDS)(
    'seed %i with injected D1 failures, lost leases, overlapping runs, pauses and deletion',
    async (seed) => {
      const h = createHarness();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const run = await scenario(h, seed ^ 0x5eed, 120, true);
      // Leases lapse and backoffs pass while the scenario's clock is far behind the drain's.
      await drain(h, run.endedAt, run.deleted);
      await checkConservation(h, run, true);
    },
  );

  it('exercises holds, groups, digests, bypasses, failures and deletions (the property is not vacuous)', async () => {
    let held = 0;
    let combined = 0;
    let digests = 0;
    let deletions = 0;
    let retried = 0;
    for (const seed of SEEDS.slice(0, 12)) {
      const h = createHarness();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const run = await scenario(h, seed ^ 0x5eed, 120, true);
      await drain(h, run.endedAt, run.deleted);
      const one = (sql: string): number => (h.db.raw.prepare(sql).get() as { n: number }).n;
      held += one('SELECT COUNT(*) AS n FROM held_events');
      combined += one('SELECT COUNT(*) AS n FROM notification_outbox WHERE payload_json LIKE \'%"count":%\'');
      digests += one("SELECT COUNT(*) AS n FROM notification_outbox WHERE payload_json LIKE '%noti.digest%'");
      retried += one('SELECT COUNT(*) AS n FROM held_events WHERE attempts > 0');
      deletions += run.deleted.size;
    }
    expect(held).toBeGreaterThan(50);
    expect(combined).toBeGreaterThan(5);
    expect(digests).toBeGreaterThan(0);
    expect(deletions).toBeGreaterThan(0);
    // Injected failures really did hit some release (attempts recorded), and conservation held.
    expect(retried).toBeGreaterThan(0);
  });
});
