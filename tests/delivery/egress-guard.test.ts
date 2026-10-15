import { beforeEach, describe, expect, it } from 'vitest';
import {
  INVALID_TRIP,
  OPEN_MS,
  REQUESTS_PER_MINUTE,
  guardGate,
  purgeEgressBuckets,
  recordEgress,
} from '../../src/delivery/egress-guard';
import { createFakeD1, type FakeD1 } from '../support/d1';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 30);
let db: FakeD1;

beforeEach(() => {
  db = createFakeD1();
});

async function record(n: number, status: number | null, at = NOW): Promise<void> {
  for (let i = 0; i < n; i += 1) await recordEgress(db.d1, 'discord', at, status);
}

describe('Discord global guard (F108)', () => {
  it('proceeds on an empty table', async () => {
    expect(await guardGate(db.d1, 'discord', NOW)).toEqual({ action: 'proceed' });
  });

  it('counts only 401, 403 and 429 as invalid', async () => {
    await record(3, 200);
    await record(1, 401);
    await record(1, 403);
    await record(1, 429);
    await record(2, 404);
    await record(1, null);
    const row = db.raw.prepare('SELECT requests, invalid FROM egress_guard_buckets').get();
    expect(row).toEqual({ requests: 9, invalid: 3 });
  });

  it('opens at the trip point, for every caller, and stays open for OPEN_MS', async () => {
    await record(INVALID_TRIP - 1, 429);
    expect((await guardGate(db.d1, 'discord', NOW)).action).toBe('proceed');
    await record(1, 403);
    const gate = await guardGate(db.d1, 'discord', NOW);
    expect(gate).toEqual({ action: 'defer', untilMs: NOW + OPEN_MS, reason: 'platform_paused' });
    // Open state is stored: a later caller is held without recomputing, and nothing re-trips it.
    expect((await guardGate(db.d1, 'discord', NOW + 60_000)).action).toBe('defer');
    const state = db.raw.prepare('SELECT opened_count FROM egress_guard_state').get() as {
      opened_count: number;
    };
    expect(state.opened_count).toBe(1);
  });

  it('closes after OPEN_MS because the counted responses have aged out of the window', async () => {
    await record(INVALID_TRIP, 429);
    await guardGate(db.d1, 'discord', NOW);
    expect((await guardGate(db.d1, 'discord', NOW + OPEN_MS + 1)).action).toBe('proceed');
  });

  it('trips again when the invalid answers keep coming after it closes', async () => {
    await record(INVALID_TRIP, 429);
    await guardGate(db.d1, 'discord', NOW);
    const later = NOW + OPEN_MS + 1;
    await record(INVALID_TRIP, 401, later);
    expect((await guardGate(db.d1, 'discord', later)).action).toBe('defer');
    const state = db.raw.prepare('SELECT opened_count FROM egress_guard_state').get() as {
      opened_count: number;
    };
    expect(state.opened_count).toBe(2);
  });

  it('does not count invalid answers older than ten minutes', async () => {
    await record(INVALID_TRIP, 429, NOW - 11 * 60_000);
    expect((await guardGate(db.d1, 'discord', NOW)).action).toBe('proceed');
  });

  it('paces total requests per minute and releases at the next minute', async () => {
    await record(REQUESTS_PER_MINUTE, 200);
    const gate = await guardGate(db.d1, 'discord', NOW);
    expect(gate).toEqual({
      action: 'defer',
      untilMs: Math.floor(NOW / 60_000) * 60_000 + 60_000,
      reason: 'platform_paused',
    });
    expect((await guardGate(db.d1, 'discord', NOW + 60_000)).action).toBe('proceed');
  });

  it('fails open when D1 cannot be read', async () => {
    const broken = {
      prepare: () => {
        throw new Error('d1 down');
      },
    } as unknown as D1Database;
    expect(await guardGate(broken, 'discord', NOW)).toEqual({ action: 'proceed' });
  });

  it('a recording fault never throws', async () => {
    const broken = {
      prepare: () => {
        throw new Error('d1 down');
      },
    } as unknown as D1Database;
    await expect(recordEgress(broken, 'discord', NOW, 429)).resolves.toBeUndefined();
  });

  it('is platform-wide and carries no tenant data: its tables have no tenant, host or url columns', () => {
    for (const table of ['egress_guard_buckets', 'egress_guard_state']) {
      const cols = (db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols.filter((c) => /org|integration|host|url|tenant|workspace/i.test(c))).toEqual([]);
    }
  });

  it('purges buckets past retention', async () => {
    await record(1, 200, NOW - 3 * 3_600_000);
    await record(1, 200, NOW);
    expect(await purgeEgressBuckets(db.d1, NOW)).toBe(1);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM egress_guard_buckets').get()).toEqual({ n: 1 });
  });
});
