import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { runCronJobs } from '../../src/observability/cron';
import { sqliteTimestamp } from '../../src/delivery/claim';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

vi.mock('../../src/auth/better-auth', () => ({ createAuth: () => ({ handler: () => new Response(null) }) }));
const { default: worker } = await import('../../src/index');

let db: FakeD1;
afterEach(() => vi.restoreAllMocks());

describe('runCronJobs', () => {
  it('runs every job even when an earlier one throws, then rejects naming the failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ran: string[] = [];
    const job = (name: string, fail = false) => ({
      name,
      run: () => {
        ran.push(name);
        return fail ? Promise.reject(new Error('boom token=abc123')) : Promise.resolve();
      },
    });
    await expect(runCronJobs([job('a', true), job('b'), job('c', true), job('d')])).rejects.toThrow(
      'cron jobs failed: a, c',
    );
    expect(ran).toEqual(['a', 'b', 'c', 'd']);
  });

  it('logs one redacted error line per failed job', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      runCronJobs([{ name: 'x', run: () => Promise.reject(new Error('bad token=abc123')) }]),
    ).rejects.toThrow();
    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0]?.[0]);
    expect(line).toContain('cron_job_failed');
    expect(line).toContain('"job":"x"');
    expect(line).not.toContain('abc123');
  });

  it('resolves when nothing fails', async () => {
    await expect(runCronJobs([{ name: 'ok', run: () => Promise.resolve() }])).resolves.toBeUndefined();
  });
});

describe('scheduled()', () => {
  beforeEach(() => {
    db = createFakeD1();
    seedOrganization(db.raw, 'org-a');
  });

  // No KEK configured: credential maintenance throws, which used to skip everything after it.
  const env = (): Bindings => ({ DB: db.d1 }) as unknown as Bindings;
  const tick = (): Promise<void> => Promise.resolve(worker.scheduled({} as ScheduledEvent, env()));

  function oldDelivery(): void {
    db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at,updated_at) VALUES('old','i','org-a','sent',?,?)",
      )
      .run(sqliteTimestamp(Date.now() - 400 * 86_400_000), sqliteTimestamp(Date.now() - 400 * 86_400_000));
  }

  it('still runs stall detection and retention after an earlier job throws, and still fails the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    oldDelivery();
    db.raw
      .prepare(
        "INSERT INTO notification_outbox(id,payload_json,state,organization_id,created_at) VALUES('s','{}','pending','org-a',?)",
      )
      .run(sqliteTimestamp(Date.now() - 3_600_000));
    await expect(tick()).rejects.toThrow(/credential_maintenance/);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 0 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('delivery_stall'))).toBe(true);
  });

  it('survives a missing ops_state table: retention still runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    db.raw.exec('DROP TABLE ops_state');
    oldDelivery();
    await expect(tick()).rejects.toThrow(/heartbeat/);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 0 });
  });

  it('writes a heartbeat row every tick', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(tick()).rejects.toThrow();
    const first = db.raw
      .prepare("SELECT value, updated_at FROM ops_state WHERE key='cron_heartbeat'")
      .get() as {
      value: string;
      updated_at: number;
    };
    expect(Number(first.value)).toBeGreaterThan(0);
    expect(first.updated_at).toBe(Number(first.value));
    // The suite pins Date (tests/setup/pin-clock.ts); move it forward explicitly.
    vi.setSystemTime(Date.now() + 1_000);
    await expect(tick()).rejects.toThrow();
    const second = db.raw.prepare("SELECT value FROM ops_state WHERE key='cron_heartbeat'").get() as {
      value: string;
    };
    expect(Number(second.value)).toBeGreaterThan(Number(first.value));
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ops_state WHERE key='cron_heartbeat'").get()).toEqual({
      n: 1,
    });
  });
});
