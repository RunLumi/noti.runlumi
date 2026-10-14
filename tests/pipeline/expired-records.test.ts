import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_RATE_LIMIT_MAX_AGE_MS,
  AUTH_STATE_GRACE_MS,
  EXPIRED_BATCH,
  EXPIRED_INTERVAL_MS,
  EXPIRED_STATE_KEY,
  purgeExpiredAuthRecords,
} from '../../src/pipeline/expired-records';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

const NOW = Date.parse('2026-10-14T12:00:00Z');
let db: FakeD1;

const n = (table: string): number =>
  Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

function session(id: string, expiresAt: number): void {
  db.raw
    .prepare('INSERT INTO "session"(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'u', `t-${id}`, expiresAt, 1, 1);
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
      verifications: 1,
      authStates: 1,
      authRateLimits: 1,
      more: false,
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
    for (let i = 0; i < EXPIRED_BATCH * 5 + 10; i++)
      insert.run(`s${String(i)}`, 'u', `t${String(i)}`, NOW - 1, 1, 1);
    db.raw.exec('COMMIT');

    const first = await purgeExpiredAuthRecords(db.d1, NOW);
    expect(first).toMatchObject({ sessions: EXPIRED_BATCH * 5, more: true });
    expect(n('"session"')).toBe(10);
    expect(db.raw.prepare('SELECT 1 FROM ops_state WHERE key=?').get(EXPIRED_STATE_KEY)).toBeUndefined();

    const second = await purgeExpiredAuthRecords(db.d1, NOW + 1000);
    expect(second).toMatchObject({ sessions: 10, more: false });
    expect(n('"session"')).toBe(0);
  });
});
