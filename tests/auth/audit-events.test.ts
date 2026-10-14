import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthHarness, PASSWORD, type AuthHarness } from './harness';

/**
 * Spec 02 F28, REMAINING 2.3: membership, invitation, role and session changes made through Better Auth's
 * organization routes leave an audit row, written by the actor's own request. The rows are read back from
 * `audit_events` and through the admin API (`GET /api/audit`), so what an admin sees is what is asserted.
 */
let h: AuthHarness;
let admin: string;
let adminId: string;
let org: string;

interface Row {
  action: string;
  actor_id: string | null;
  organization_id: string | null;
  subject_type: string;
  subject_id: string | null;
  outcome: string;
  metadata_json: string;
  ip: string | null;
}
const rows = (...actions: string[]): Row[] =>
  h.db.raw
    .prepare(
      `SELECT action, actor_id, organization_id, subject_type, subject_id, outcome, metadata_json, ip
       FROM audit_events WHERE action IN (${actions.map(() => '?').join(',')}) ORDER BY created_at, rowid`,
    )
    .all(...actions) as unknown as Row[];
const meta = (r: Row | undefined): unknown => JSON.parse(r?.metadata_json ?? '{}');
const userId = (email: string): string =>
  (h.db.raw.prepare('SELECT id FROM "user" WHERE email=?').get(email) as { id: string }).id;
const invitationId = (email: string): string =>
  (h.db.raw.prepare('SELECT id FROM invitation WHERE email=?').get(email) as { id: string }).id;

async function join(email: string, role: 'admin' | 'member', ip: string): Promise<string> {
  const res = await h.call('/organization/invite-member', {
    body: { email, role, organizationId: org },
    cookie: admin,
    ip: '10.1.0.' + ip,
  });
  expect(res.status).toBe(200);
  const cookie = await h.register(email, { ip: '10.2.0.' + ip });
  const ok = await h.call('/organization/accept-invitation', {
    body: { invitationId: invitationId(email) },
    cookie,
    ip: '10.2.0.' + ip,
  });
  expect(ok.status).toBe(200);
  return cookie;
}

beforeEach(async () => {
  h = createAuthHarness();
  admin = await h.register('boss@example.test', { ip: '10.9.0.1' });
  adminId = userId('boss@example.test');
  const res = await h.call('/organization/create', {
    body: { name: 'acme', slug: 'acme' },
    cookie: admin,
    ip: '10.0.0.1',
  });
  org = (await res.json<{ id: string }>()).id;
});

describe('invitations', () => {
  it('records the invitation, who sent it and the role, but never the invitee address', async () => {
    await h.call('/organization/invite-member', {
      body: { email: 'new@example.test', role: 'member', organizationId: org },
      cookie: admin,
      ip: '10.1.0.1',
    });
    const [row, ...rest] = rows('member.invite');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      actor_id: adminId,
      organization_id: org,
      subject_type: 'invitation',
      subject_id: invitationId('new@example.test'),
      outcome: 'success',
      ip: '10.1.0.1',
    });
    expect(meta(row)).toEqual({ role: 'member' });
    expect(JSON.stringify(rows('member.invite'))).not.toContain('new@example.test');
  });

  it('records acceptance by the person who accepted', async () => {
    await join('bob@example.test', 'member', '1');
    const [row] = rows('member.invite.accept');
    expect(row).toMatchObject({
      actor_id: userId('bob@example.test'),
      organization_id: org,
      subject_type: 'invitation',
      outcome: 'success',
    });
    expect(meta(row)).toEqual({ role: 'member' });
  });

  it('records cancellation by the admin who cancelled, and rejection by the invitee', async () => {
    await h.call('/organization/invite-member', {
      body: { email: 'gone@example.test', role: 'member', organizationId: org },
      cookie: admin,
      ip: '10.1.0.2',
    });
    const cancel = await h.call('/organization/cancel-invitation', {
      body: { invitationId: invitationId('gone@example.test') },
      cookie: admin,
      ip: '10.1.0.3',
    });
    expect(cancel.status).toBe(200);
    expect(rows('member.invite.cancel')[0]).toMatchObject({ actor_id: adminId, organization_id: org });

    await h.call('/organization/invite-member', {
      body: { email: 'nope@example.test', role: 'admin', organizationId: org },
      cookie: admin,
      ip: '10.1.0.4',
    });
    const nope = await h.register('nope@example.test', { ip: '10.2.0.9' });
    const reject = await h.call('/organization/reject-invitation', {
      body: { invitationId: invitationId('nope@example.test') },
      cookie: nope,
      ip: '10.2.0.9',
    });
    expect(reject.status).toBe(200);
    expect(rows('member.invite.reject')[0]).toMatchObject({
      actor_id: userId('nope@example.test'),
      organization_id: org,
    });
  });

  it('records nothing for an invitation that was refused', async () => {
    const before = rows('member.invite').length;
    await h.call('/organization/invite-member', {
      body: { email: 'x@example.test', role: 'owner', organizationId: org },
      cookie: admin,
      ip: '10.1.0.5',
    });
    expect(rows('member.invite')).toHaveLength(before);
  });
});

describe('roles and removal', () => {
  it('records a role change with the old and new role, and who made it', async () => {
    await join('bob@example.test', 'member', '2');
    const member = h.db.raw
      .prepare(`SELECT id FROM member WHERE user_id=?`)
      .get(userId('bob@example.test')) as { id: string };
    const res = await h.call('/organization/update-member-role', {
      body: { memberId: member.id, role: 'admin', organizationId: org },
      cookie: admin,
      ip: '10.1.0.6',
    });
    expect(res.status).toBe(200);
    const [row] = rows('member.role.change');
    expect(row).toMatchObject({
      actor_id: adminId,
      organization_id: org,
      subject_type: 'member',
      subject_id: userId('bob@example.test'),
      outcome: 'success',
    });
    expect(meta(row)).toEqual({ role: 'admin', previousRole: 'member' });
  });

  it('records the removal of a member by an admin', async () => {
    await join('bob@example.test', 'member', '3');
    const member = h.db.raw
      .prepare(`SELECT id FROM member WHERE user_id=?`)
      .get(userId('bob@example.test')) as { id: string };
    const res = await h.call('/organization/remove-member', {
      body: { memberIdOrEmail: member.id, organizationId: org },
      cookie: admin,
      ip: '10.1.0.7',
    });
    expect(res.status).toBe(200);
    const [row] = rows('member.remove');
    expect(row).toMatchObject({
      actor_id: adminId,
      organization_id: org,
      subject_id: userId('bob@example.test'),
    });
    expect(meta(row)).toEqual({ role: 'member', self: false });
  });

  it('records a member leaving on their own as such', async () => {
    const bob = await join('bob@example.test', 'member', '4');
    const res = await h.call('/organization/leave', {
      body: { organizationId: org },
      cookie: bob,
      ip: '10.2.0.40',
    });
    expect(res.status).toBe(200);
    const [row] = rows('member.remove');
    expect(row).toMatchObject({ actor_id: userId('bob@example.test'), organization_id: org });
    expect(meta(row)).toEqual({ role: 'member', self: true });
  });

  it('records a refused attempt by a plain member to change a role as a denial, and changes nothing', async () => {
    const bob = await join('bob@example.test', 'member', '5');
    const adminMember = h.db.raw.prepare(`SELECT id FROM member WHERE user_id=?`).get(adminId) as {
      id: string;
    };
    const res = await h.call('/organization/update-member-role', {
      body: { memberId: adminMember.id, role: 'member', organizationId: org },
      cookie: bob,
      ip: '10.2.0.50',
    });
    expect(res.status).toBe(403);
    expect(rows('member.role.change')).toHaveLength(0);
    const [denied] = rows('access.denied');
    expect(denied).toMatchObject({
      actor_id: userId('bob@example.test'),
      organization_id: org,
      outcome: 'denied',
    });
    expect(
      (h.db.raw.prepare('SELECT role FROM member WHERE id=?').get(adminMember.id) as { role: string }).role,
    ).toBe('admin');
  });
});

describe('sessions ended by a password reset', () => {
  it('records that every session of the person was ended, and how many', async () => {
    await h.register('reset@example.test', { ip: '10.3.0.1' });
    await h.signIn('reset@example.test', { ip: '10.3.0.2' });
    await h.call('/request-password-reset', {
      body: { email: 'reset@example.test', redirectTo: '/reset' },
      ip: '10.3.0.3',
    });
    const mail = [...h.mail].reverse().find((m) => m.to === 'reset@example.test');
    const token = new URL(/https?:\/\/\S+/.exec(mail?.text ?? '')?.[0] ?? '').pathname.split('/').pop();
    const res = await h.call('/reset-password', {
      body: { newPassword: PASSWORD + '!', token },
      ip: '10.3.0.3',
    });
    expect(res.status).toBe(200);
    const [row] = rows('session.revoke_all');
    expect(row).toMatchObject({
      actor_id: userId('reset@example.test'),
      organization_id: null,
      outcome: 'success',
    });
    expect(meta(row)).toEqual({ revoked: 2, reason: 'password_reset' });
  });

  it('records nothing when the reset fails', async () => {
    await h.call('/reset-password', {
      body: { newPassword: PASSWORD + '!', token: 'garbage' },
      ip: '10.3.0.4',
    });
    expect(rows('session.revoke_all')).toHaveLength(0);
  });
});

describe('what an admin sees', () => {
  it('shows these events in the workspace audit log, and member events only to that workspace', async () => {
    await join('bob@example.test', 'member', '6');
    const res = await h.api('/api/audit?limit=50', { cookie: admin });
    expect(res.status).toBe(200);
    const { events } = await res.json<{
      events: { action: string; summary: { key: string; value: unknown }[] }[];
    }>();
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['member.invite', 'member.invite.accept']));
    expect(events.find((e) => e.action === 'member.invite')?.summary).toEqual([
      { key: 'role', value: 'member' },
    ]);

    const outsider = await h.register('out@example.test', { ip: '10.9.0.7' });
    expect((await h.api('/api/audit', { cookie: outsider })).status).toBeGreaterThanOrEqual(400);
  });
});
