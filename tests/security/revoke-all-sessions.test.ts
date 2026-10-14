import { describe, expect, it } from 'vitest';
import { createAuthHarness, type AuthHarness } from '../auth/harness';

/**
 * Spec 15 F234 mitigation 6: a restore can resurrect a session row the person had ended, because Better
 * Auth keeps the token as is (AR-1). `scripts/revoke-all-sessions.mjs` is the step that ends that risk.
 * The first test shows the risk is real before showing the remedy, so the remedy is not vacuous.
 */
// The script is plain ESM so an operator can run it without a build step; it has no type declarations.
interface Script {
  REASONS: string[];
  planRevokeAll: (
    executor: { query(sql: string): Promise<Record<string, unknown>[]>; run(s: string[]): Promise<void> },
    options: { reason: string },
  ) => Promise<{ sessions: number; verifications: number; statements: string[] }>;
}
const scriptPath = '../../scripts/revoke-all-sessions.mjs';
const script = (await import(/* @vite-ignore */ scriptPath)) as Script;

function executorFor(h: AuthHarness) {
  return {
    query: (sql: string) => Promise.resolve(h.db.raw.prepare(sql).all() as Record<string, unknown>[]),
    run: (statements: string[]) => {
      for (const s of statements) h.db.raw.exec(s);
      return Promise.resolve();
    },
  };
}

const alive = async (h: AuthHarness, cookie: string): Promise<boolean> =>
  (await h.api('/api/workspace/me/sessions', { cookie })).status === 200;

describe('after a restore, every session is ended (F234, AR-1)', () => {
  it('a restored row works again; the script ends it, and records that it did', async () => {
    const h = createAuthHarness();
    const cookie = await h.register('me@example.test', { ip: '203.0.113.1' });
    const other = (await h.signIn('me@example.test', { ip: '203.0.113.2' })).cookie;
    const backup = h.db.raw
      .prepare('SELECT * FROM "session" WHERE user_agent IS NOT NULL ORDER BY created_at')
      .all();
    expect(backup).toHaveLength(2);

    // The person ends the other session...
    const listed = await (
      await h.api('/api/workspace/me/sessions', { cookie })
    ).json<{
      sessions: { id: string; current: boolean }[];
    }>();
    const target = listed.sessions.find((s) => !s.current);
    await h.api(`/api/workspace/me/sessions/${target?.id}/revoke`, { method: 'POST', cookie });
    expect(await alive(h, other)).toBe(false);

    // ...and a restore from before that brings the row back.
    for (const row of backup as Record<string, string | number | null>[]) {
      h.db.raw
        .prepare(
          'INSERT OR IGNORE INTO "session"(id,expires_at,token,created_at,updated_at,ip_address,user_agent,user_id,active_organization_id) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          row.id ?? null,
          row.expires_at ?? null,
          row.token ?? null,
          row.created_at ?? null,
          row.updated_at ?? null,
          row.ip_address ?? null,
          row.user_agent ?? null,
          row.user_id ?? null,
          row.active_organization_id ?? null,
        );
    }
    expect(await alive(h, other)).toBe(true); // the risk, demonstrated

    const plan = await script.planRevokeAll(executorFor(h), { reason: 'restore' });
    expect(plan.sessions).toBe(2);
    await executorFor(h).run(plan.statements);

    expect(await alive(h, cookie)).toBe(false);
    expect(await alive(h, other)).toBe(false);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 0 });
    const event = h.db.raw
      .prepare(
        "SELECT organization_id, actor_id, subject_type, outcome, metadata_json FROM audit_events WHERE action='session.revoke_all'",
      )
      .get() as Record<string, string | null>;
    expect(event).toMatchObject({
      organization_id: null,
      actor_id: null,
      subject_type: 'session',
      outcome: 'success',
    });
    expect(JSON.parse(event.metadata_json ?? '{}')).toEqual({ revoked: 2, reason: 'restore' });
  });

  it('also clears one-time records, so a restored, already-used reset link cannot work again', async () => {
    const h = createAuthHarness();
    await h.register('me@example.test');
    h.db.raw
      .prepare(
        'INSERT INTO verification(id,identifier,value,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run('v1', 'reset-password:abc', 'user', Date.now() + 3_600_000, Date.now(), Date.now());
    const plan = await script.planRevokeAll(executorFor(h), { reason: 'incident' });
    expect(plan.verifications).toBeGreaterThanOrEqual(1);
    await executorFor(h).run(plan.statements);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM verification').get()).toEqual({ n: 0 });
  });

  it('a plan changes nothing', async () => {
    const h = createAuthHarness();
    await h.register('me@example.test');
    await script.planRevokeAll(executorFor(h), { reason: 'restore' });
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 1 });
    expect(
      h.db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='session.revoke_all'").get(),
    ).toEqual({ n: 0 });
  });

  it('accepts only the closed reasons, so nothing typed can reach the SQL', async () => {
    const h = createAuthHarness();
    expect(script.REASONS).toEqual(['restore', 'incident']);
    for (const reason of ['', 'because', "restore'); DROP TABLE audit_events;--"])
      await expect(script.planRevokeAll(executorFor(h), { reason })).rejects.toThrow(/reason must be/);
  });

  it('an empty session table is a valid run and records zero', async () => {
    const h = createAuthHarness();
    const plan = await script.planRevokeAll(executorFor(h), { reason: 'restore' });
    await executorFor(h).run(plan.statements);
    const event = h.db.raw
      .prepare("SELECT metadata_json FROM audit_events WHERE action='session.revoke_all'")
      .get() as { metadata_json: string };
    expect(JSON.parse(event.metadata_json)).toEqual({ revoked: 0, reason: 'restore' });
  });
});
