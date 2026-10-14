import { beforeEach, describe, expect, it } from 'vitest';
import { sessionPastAbsoluteLife, SESSION_ABSOLUTE_SECONDS } from '../../src/auth/session-policy';
import { noteAuditFailure, recentAuditFailures } from '../../src/audit/audit';
import { createAuthHarness, PASSWORD, type AuthHarness } from './harness';

/**
 * The 90-day absolute lifetime must hold on Better Auth's OWN routes too, not only on ours and not only after
 * the hourly purge (ADR 0030). A session is aged by rewriting `created_at`, with its idle expiry still ahead,
 * which is exactly the "used every day for 91 days" case.
 */
const DAY = 86_400_000;
let h: AuthHarness;
let cookie: string;
let org: string;

const sessions = (): number =>
  Number((h.db.raw.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n);
const age = (days: number): void => {
  h.db.raw.prepare('UPDATE "session" SET created_at=?').run(Date.now() - days * DAY);
};

beforeEach(async () => {
  h = createAuthHarness();
  cookie = await h.register('me@example.test', { ip: '10.9.0.1' });
  org = (
    await (
      await h.call('/organization/create', { body: { name: 'a', slug: 'a' }, cookie, ip: '10.0.0.1' })
    ).json<{ id: string }>()
  ).id;
});

describe('Better Auth routes honour the absolute lifetime', () => {
  it('a session 89 days old still works on get-session and an organization route', async () => {
    age(89);
    expect((await h.call('/get-session', { cookie })).status).toBe(200);
    const res = await h.call('/organization/invite-member', {
      body: { email: 'x@example.test', role: 'member', organizationId: org },
      cookie,
      ip: '10.0.1.1',
    });
    expect(res.status).toBe(200);
  });

  it('a session 91 days old is refused with 401 on get-session, and its row is deleted', async () => {
    age(91);
    const res = await h.call('/get-session', { cookie });
    expect(res.status).toBe(401);
    expect(sessions()).toBe(0);
  });

  it.each([
    ['/organization/invite-member', { email: 'x@example.test', role: 'member' }],
    ['/organization/update-member-role', { memberId: 'x', role: 'member' }],
    ['/organization/remove-member', { memberIdOrEmail: 'x' }],
    ['/organization/accept-invitation', { invitationId: 'x' }],
    ['/organization/list-members', undefined],
  ])('a session 91 days old gets 401 from %s and changes nothing', async (path, body) => {
    age(91);
    const members = Number((h.db.raw.prepare('SELECT COUNT(*) AS n FROM member').get() as { n: number }).n);
    const res = await h.call(path, {
      ...(body ? { body: { ...body, organizationId: org } } : {}),
      cookie,
      ip: '10.0.2.1',
      method: body ? 'POST' : 'GET',
    });
    expect(res.status).toBe(401);
    expect(sessions()).toBe(0);
    expect(Number((h.db.raw.prepare('SELECT COUNT(*) AS n FROM member').get() as { n: number }).n)).toBe(
      members,
    );
    expect(Number((h.db.raw.prepare('SELECT COUNT(*) AS n FROM invitation').get() as { n: number }).n)).toBe(
      0,
    );
  });

  it('sign-out still works for such a session, so the person can clear the cookie', async () => {
    age(91);
    expect((await h.call('/sign-out', { method: 'POST', body: {}, cookie, ip: '10.0.3.1' })).status).toBe(
      200,
    );
  });

  it('signing in again creates a fresh session that works', async () => {
    age(91);
    await h.call('/get-session', { cookie });
    const again = await h.signIn('me@example.test', { ip: '10.0.4.1' });
    expect(again.res.status).toBe(200);
    expect((await h.call('/get-session', { cookie: again.cookie })).status).toBe(200);
  });
});

describe('sessionPastAbsoluteLife', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const old = now - (SESSION_ABSOLUTE_SECONDS + 1) * 1000;
  const young = now - DAY;

  it('reads a Date, an ISO string and a millisecond number alike, and does not fail closed on a number', () => {
    for (const make of [
      (ms: number) => new Date(ms),
      (ms: number) => new Date(ms).toISOString(),
      (ms: number) => ms,
    ]) {
      expect(sessionPastAbsoluteLife(make(young), now)).toBe(false);
      expect(sessionPastAbsoluteLife(make(old), now)).toBe(true);
    }
  });

  it('treats a garbled time as past, and an absent one as not past', () => {
    expect(sessionPastAbsoluteLife('not a date', now)).toBe(true);
    expect(sessionPastAbsoluteLife({}, now)).toBe(true);
    expect(sessionPastAbsoluteLife(undefined, now)).toBe(false);
    expect(sessionPastAbsoluteLife(null, now)).toBe(false);
  });
});

describe('password change and audit signals', () => {
  it('records the sessions ended when a password change also ends the others', async () => {
    await h.signIn('me@example.test', { ip: '10.0.5.1' });
    await h.signIn('me@example.test', { ip: '10.0.5.2' });
    const res = await h.call('/change-password', {
      body: { currentPassword: PASSWORD, newPassword: PASSWORD + '9', revokeOtherSessions: true },
      cookie,
      ip: '10.0.5.3',
    });
    expect(res.status).toBe(200);
    const row = h.db.raw
      .prepare("SELECT metadata_json, actor_id FROM audit_events WHERE action='session.revoke_others'")
      .get() as { metadata_json: string; actor_id: string };
    expect(JSON.parse(row.metadata_json)).toEqual({ revoked: 2 });
    expect(row.actor_id).toBeTruthy();
  });

  it('records nothing when the other sessions are kept', async () => {
    await h.call('/change-password', {
      body: { currentPassword: PASSWORD, newPassword: PASSWORD + '8' },
      cookie,
      ip: '10.0.6.1',
    });
    expect(
      h.db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='session.revoke_others'").get(),
    ).toEqual({ n: 0 });
  });

  it('counts a failed audit write and reports it for an hour only', async () => {
    expect(await recentAuditFailures(h.db.d1)).toBe(0);
    await noteAuditFailure(h.db.d1);
    await noteAuditFailure(h.db.d1);
    expect(await recentAuditFailures(h.db.d1)).toBe(2);
    expect(await recentAuditFailures(h.db.d1, Date.now() + 61 * 60_000)).toBe(0);
  });

  it('shows the failure in the readiness warnings', async () => {
    await noteAuditFailure(h.db.d1);
    const res = await h.api('/health/ready');
    const body = await res.json<{ warnings?: string[] }>();
    expect(body.warnings).toContain('audit_write_failed_recently');
  });
});

describe('invitation lifetime by role', () => {
  it('an admin invitation lives 48 hours and a member invitation 7 days', async () => {
    for (const [email, role, ip] of [
      ['a@example.test', 'admin', '10.0.7.1'],
      ['m@example.test', 'member', '10.0.7.2'],
    ] as const)
      await h.call('/organization/invite-member', { body: { email, role, organizationId: org }, cookie, ip });
    const left = (email: string): number =>
      (h.db.raw.prepare('SELECT expires_at AS e FROM invitation WHERE email=?').get(email) as { e: number })
        .e - Date.now();
    expect(left('a@example.test')).toBeLessThanOrEqual(2 * DAY);
    expect(left('a@example.test')).toBeGreaterThan(1.9 * DAY);
    expect(left('m@example.test')).toBeGreaterThan(6.9 * DAY);
  });
});
