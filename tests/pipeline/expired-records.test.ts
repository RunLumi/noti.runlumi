import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { SESSION_ABSOLUTE_SECONDS } from '../../src/auth/session-policy';
import {
  AUTH_RATE_LIMIT_MAX_AGE_MS,
  AUTH_STATE_GRACE_MS,
  EXPIRED_BATCH,
  EXPIRED_INTERVAL_MS,
  EXPIRED_STATE_KEY,
  MAJORITY_FLOOR,
  UNIT_CANARY_MS,
  purgeExpiredAuthRecords,
} from '../../src/pipeline/expired-records';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

const NOW = Date.parse('2026-10-14T12:00:00Z');
let db: FakeD1;

const n = (table: string): number =>
  Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

function session(id: string, expiresAt: number, createdAt: number = NOW - 60_000): void {
  db.raw
    .prepare('INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'u', `t-${id}`, expiresAt, createdAt, createdAt);
}

beforeEach(() => {
  db = createFakeD1();
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('u', 'U', 'u@example.test', 1, 1, 1);
  seedOrganization(db.raw, 'org');
});

describe('purgeExpiredAuthRecords', () => {
  it('deletes only rows that can no longer be used', async () => {
    session('old', NOW - 1);
    session('live', NOW + 60_000);
    const verification = db.raw.prepare(
      'INSERT INTO verification(id,identifier,value,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    );
    verification.run('v-old', 'i', 'v', NOW - 1, 1, 1);
    verification.run('v-live', 'i', 'v', NOW + 1000, 1, 1);
    const state = db.raw.prepare(
      "INSERT INTO github_auth_states(state_hash,purpose,organization_id,user_id,expires_at) VALUES(?,'install','org','u',?)",
    );
    state.run('s-expired-long-ago', NOW - AUTH_STATE_GRACE_MS - 1);
    state.run('s-expired-recently', NOW - 1000);
    state.run('s-live', NOW + 1000);
    const limit = db.raw.prepare('INSERT INTO rate_limit(id,key,count,last_request) VALUES(?,?,?,?)');
    limit.run('r-old', 'k-old', 1, NOW - AUTH_RATE_LIMIT_MAX_AGE_MS - 1);
    limit.run('r-new', 'k-new', 1, NOW - 1000);

    const report = await purgeExpiredAuthRecords(db.d1, NOW);
    expect(report).toEqual({
      skipped: false,
      sessions: 1,
      overAgeSessions: 0,
      verifications: 1,
      authStates: 1,
      authRateLimits: 1,
      more: false,
      aborted: false,
    });
    expect(
      (db.raw.prepare('SELECT id FROM "session"').all() as Array<{ id: string }>).map((r) => r.id),
    ).toEqual(['live']);
    expect(
      (
        db.raw.prepare('SELECT state_hash FROM github_auth_states ORDER BY 1').all() as Array<{
          state_hash: string;
        }>
      ).map((r) => r.state_hash),
    ).toEqual(['s-expired-recently', 's-live']);
    expect(n('verification')).toBe(1);
    expect(n('rate_limit')).toBe(1);
  });

  it('runs at most hourly, and only advances the throttle after a complete pass', async () => {
    session('a', NOW - 1);
    await purgeExpiredAuthRecords(db.d1, NOW);
    session('b', NOW - 1);
    expect((await purgeExpiredAuthRecords(db.d1, NOW + 60_000)).skipped).toBe(true);
    expect(n('"session"')).toBe(1);
    const later = await purgeExpiredAuthRecords(db.d1, NOW + EXPIRED_INTERVAL_MS);
    expect(later).toMatchObject({ skipped: false, sessions: 1 });
    expect(n('"session"')).toBe(0);
  });

  it('is bounded per tick and keeps going on the next one without marking itself complete', async () => {
    db.raw.exec('BEGIN');
    const insert = db.raw.prepare(
      'INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    );
    const expired = EXPIRED_BATCH * 5 + 10;
    for (let i = 0; i < expired; i++)
      insert.run(`s${String(i)}`, 'u', `t${String(i)}`, NOW - 1, NOW - 60_000, NOW - 60_000);
    // Mostly live rows, so the majority guard does not apply to this backlog.
    for (let i = 0; i < expired * 2; i++)
      insert.run(`l${String(i)}`, 'u', `lt${String(i)}`, NOW + 1e9, NOW - 60_000, NOW - 60_000);
    db.raw.exec('COMMIT');

    const first = await purgeExpiredAuthRecords(db.d1, NOW);
    expect(first).toMatchObject({ sessions: EXPIRED_BATCH * 5, more: true });
    expect(n('"session"')).toBe(10 + 2 * (EXPIRED_BATCH * 5 + 10));
    expect(db.raw.prepare('SELECT 1 FROM ops_state WHERE key=?').get(EXPIRED_STATE_KEY)).toBeUndefined();

    const second = await purgeExpiredAuthRecords(db.d1, NOW + 1000);
    expect(second).toMatchObject({ sessions: 10, more: false });
    expect(n('"session"')).toBe(2 * (EXPIRED_BATCH * 5 + 10));
  });

  describe('the absolute session lifetime (ADR 0030)', () => {
    const DAY = 86_400_000;
    const absoluteMs = SESSION_ABSOLUTE_SECONDS * 1000;

    it('removes a session in daily use once it is older than the absolute lifetime, and keeps a younger one', async () => {
      // Both are valid by their idle expiry; only their age differs.
      session('over', NOW + 20 * DAY, NOW - absoluteMs - 1);
      session('exactly', NOW + 20 * DAY, NOW - absoluteMs);
      session('young', NOW + 20 * DAY, NOW - absoluteMs + DAY);
      const report = await purgeExpiredAuthRecords(db.d1, NOW);
      expect(report).toMatchObject({ sessions: 0, overAgeSessions: 1, aborted: false });
      expect(
        (db.raw.prepare('SELECT id FROM "session" ORDER BY id').all() as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      ).toEqual(['exactly', 'young']);
    });

    it('is bounded per tick like the other deletes, and reports that more remain', async () => {
      db.raw.exec('BEGIN');
      for (let i = 0; i < EXPIRED_BATCH * 5 + 3; i++)
        session(`o${String(i)}`, NOW + DAY, NOW - absoluteMs - 1000);
      // Mostly young rows, so the majority guard does not apply to this backlog.
      for (let i = 0; i < EXPIRED_BATCH * 12; i++) session(`y${String(i)}`, NOW + DAY);
      db.raw.exec('COMMIT');
      expect(await purgeExpiredAuthRecords(db.d1, NOW)).toMatchObject({
        overAgeSessions: EXPIRED_BATCH * 5,
        more: true,
      });
    });

    it('a whole cohort reaching its absolute end together is purged, not mistaken for a unit error', async () => {
      db.raw.exec('BEGIN');
      for (let i = 0; i < MAJORITY_FLOOR + 51; i++) session(`c${String(i)}`, NOW + DAY, NOW - 100 * DAY);
      db.raw.exec('COMMIT');
      const report = await purgeExpiredAuthRecords(db.d1, NOW);
      expect(report).toMatchObject({ aborted: false, overAgeSessions: MAJORITY_FLOOR + 51 });
      expect(n('"session"')).toBe(0);
    });

    it('aborts instead of deleting when created_at looks like seconds, not milliseconds', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      session('seconds-created', NOW + DAY, Math.floor(NOW / 1000));
      const report = await purgeExpiredAuthRecords(db.d1, NOW);
      expect(report.aborted).toBe(true);
      expect(n('"session"')).toBe(1);
      error.mockRestore();
    });
  });

  describe('real-shaped rows and the sanity guard (M3)', () => {
    async function liveSessionViaDrizzle(id: string, expiresAt: Date): Promise<void> {
      await drizzle(db.d1, { schema })
        .insert(schema.session)
        .values({
          id,
          token: `tok-${id}`,
          userId: 'u',
          expiresAt,
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
        });
    }

    it('keeps a session written the way Better Auth writes it (thirty days ahead, in milliseconds)', async () => {
      await liveSessionViaDrizzle('live', new Date(NOW + 30 * 86_400_000));
      await liveSessionViaDrizzle('dead', new Date(NOW - 1000));
      const stored = db.raw.prepare('SELECT id, expires_at FROM "session" ORDER BY id').all() as Array<{
        id: string;
        expires_at: number;
      }>;
      // Canary: if the column ever holds seconds, this fails before the purge can be wrong.
      for (const row of stored) expect(row.expires_at).toBeGreaterThan(1e12);

      const report = await purgeExpiredAuthRecords(db.d1, NOW);
      expect(report).toMatchObject({ aborted: false, sessions: 1 });
      expect(
        (db.raw.prepare('SELECT id FROM "session"').all() as Array<{ id: string }>).map((r) => r.id),
      ).toEqual(['live']);
    });

    it('aborts, deletes nothing and logs when an expiry is not in milliseconds', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      session('seconds', Math.floor((NOW + 30 * 86_400_000) / 1000));
      session('dead', NOW - 1);
      expect(Math.floor((NOW + 1) / 1000)).toBeLessThan(UNIT_CANARY_MS);

      const report = await purgeExpiredAuthRecords(db.d1, NOW);
      expect(report.aborted).toBe(true);
      expect(n('"session"')).toBe(2);
      expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('expired_purge_aborted');
      // The throttle did not advance, so the pass is retried.
      expect(db.raw.prepare('SELECT 1 FROM ops_state WHERE key=?').get(EXPIRED_STATE_KEY)).toBeUndefined();
      error.mockRestore();
    });

    it('aborts when a table of real size would lose more than half its sessions, but not a small one', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (let i = 0; i < 10; i++) session(`small${String(i)}`, NOW - 1);
      expect((await purgeExpiredAuthRecords(db.d1, NOW)).aborted).toBe(false);
      expect(n('"session"')).toBe(0);

      db.raw.exec('BEGIN');
      for (let i = 0; i < MAJORITY_FLOOR; i++) session(`big${String(i)}`, NOW - 1);
      db.raw.exec('COMMIT');
      const report = await purgeExpiredAuthRecords(db.d1, NOW + EXPIRED_INTERVAL_MS);
      expect(report.aborted).toBe(true);
      expect(n('"session"')).toBe(MAJORITY_FLOOR);
      error.mockRestore();
    });
  });
});
