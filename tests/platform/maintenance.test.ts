import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { createFakeD1 } from '../support/d1';

/** MAINTENANCE_MODE is the write freeze for the 0026 migration window (docs/RUNBOOK.md). */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: { getSession: () => Promise.resolve(null) },
    handler: () => new Response('auth'),
  }),
}));
const { default: worker } = await import('../../src/index');

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;
function envWith(mode: string | undefined): { env: Bindings; touched: () => number } {
  const { d1 } = createFakeD1();
  let touched = 0;
  const DB = new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === 'prepare' || prop === 'batch') touched++;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const env = {
    DB,
    APP_ORIGIN: 'https://noti.test',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789ab',
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENCRYPTION_KEY: '',
    GITHUB_APP_ID: '1',
    GITHUB_WEBHOOK_SECRET: 'x',
    ...(mode === undefined ? {} : { MAINTENANCE_MODE: mode }),
  } as unknown as Bindings;
  return { env, touched: () => touched };
}

describe('maintenance mode', () => {
  it.each([
    ['POST', '/webhooks/github'],
    ['POST', '/webhooks/generic/ep-aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['GET', '/api/integrations'],
    ['POST', '/api/integrations'],
    ['GET', '/api/auth/get-session'],
  ])('answers %s %s with 503 and Retry-After, and never touches the database', async (method, path) => {
    const { env, touched } = envWith('true');
    const res = await worker.fetch(
      new Request(`https://noti.test${path}`, { method, headers: { origin: 'https://noti.test' } }),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(touched()).toBe(0);
  });

  it('keeps /health answering', async () => {
    const { env } = envWith('true');
    const res = await worker.fetch(new Request('https://noti.test/health'), env, ctx);
    expect([200, 503]).toContain(res.status);
    expect(await res.text()).toContain('lumi-noti');
  });

  it.each([undefined, 'false', '', 'TRUE', '1', 'yes'])('does nothing for %j', async (mode) => {
    const { env } = envWith(mode);
    const res = await worker.fetch(new Request('https://noti.test/api/integrations'), env, ctx);
    expect(res.status).toBe(401);
  });

  it('skips every cron job; the only statements are the ops_state maintenance marker (ADR 0024)', async () => {
    const { d1 } = createFakeD1();
    const sql: string[] = [];
    const DB = new Proxy(d1, {
      get(target, prop, receiver) {
        if (prop === 'batch') throw new Error('no batch writes during the freeze');
        if (prop === 'prepare')
          return (text: string) => {
            sql.push(text);
            return target.prepare(text);
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const { env } = envWith('true');
    await worker.scheduled({} as ScheduledEvent, { ...env, DB });
    expect(sql.length).toBeGreaterThan(0);
    for (const text of sql) expect(text).toMatch(/ops_state/);
    expect(sql.filter((t) => /^\s*(INSERT|UPDATE|DELETE)/i.test(t))).toHaveLength(1);
  });

  it('hands queue messages back for later without consuming them', async () => {
    const { env, touched } = envWith('true');
    const retryAll = vi.fn();
    await worker.queue(
      { queue: 'lumi-noti-deliveries', messages: [], retryAll } as unknown as MessageBatch<unknown>,
      env,
    );
    expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(touched()).toBe(0);
  });

  it('never gates the dead-letter consumer: its message is not handed back (max_retries 1 would drop it)', async () => {
    const { env } = envWith('true');
    const retryAll = vi.fn();
    await worker.queue(
      { queue: 'noti-dead-letters', messages: [], retryAll } as unknown as MessageBatch<unknown>,
      env,
    );
    expect(retryAll).not.toHaveBeenCalled();
  });
});

describe('/health/ready warns while migration 0026 originals are kept', () => {
  const ready = async (env: Bindings) =>
    await (
      await worker.fetch(new Request('https://noti.test/health/ready'), env, ctx)
    ).json<{
      warnings?: string[];
    }>();

  it('warns (never fails on it) while a `<table>_old` exists, and not once they are gone', async () => {
    const { env } = envWith(undefined);
    expect((await ready(env)).warnings).toEqual(['migration_0026_old_tables_present']);
    const clean = envWith(undefined);
    const raw = clean.env.DB as unknown as { prepare: (s: string) => { run: () => Promise<unknown> } };
    for (const t of [
      'integrations',
      'deliveries',
      'notification_outbox',
      'held_events',
      'routing_decisions',
      'noise_open_failures',
    ])
      await raw.prepare(`DROP TABLE ${t}_old`).run();
    expect((await ready(clean.env)).warnings).toBeUndefined();
    // A view left by an aborted run blocks every later RENAME: also a warning.
    const gated = envWith(undefined);
    const db = gated.env.DB as unknown as { prepare: (s: string) => { run: () => Promise<unknown> } };
    await db.prepare('CREATE VIEW _gate_0026_poison AS SELECT 1 FROM _gate_0026_ok').run();
    expect((await ready(gated.env)).warnings).toContain('migration_0026_gate_view_present');
  });
});
