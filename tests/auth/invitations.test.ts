import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthHarness, type AuthHarness } from './harness';

/**
 * Spec 02 F21 (invitations) and F24 (roles), through the real organization plugin: who may invite,
 * which roles exist, who may accept, when an invitation stops working, and that accepting never creates
 * a second workspace.
 */
let h: AuthHarness;
let admin: string;

const count = (table: string): number =>
  Number((h.db.raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);

async function createWorkspace(cookie: string, slug: string): Promise<string> {
  const res = await h.call('/organization/create', { body: { name: slug, slug }, cookie, ip: '10.0.0.1' });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

async function invite(
  cookie: string,
  organizationId: string,
  email: string,
  role: string,
  ip = '10.0.1.1',
): Promise<Response> {
  return h.call('/organization/invite-member', { body: { email, role, organizationId }, cookie, ip });
}

/** The invitation's id, read from the table (the person may have received other mail since). */
const invitationIdFor = (email: string): string =>
  (h.db.raw.prepare('SELECT id FROM invitation WHERE lower(email)=lower(?)').get(email) as { id: string }).id;

beforeEach(async () => {
  h = createAuthHarness();
  admin = await h.register('boss@example.test', { ip: '10.9.0.1' });
});

describe('role validation', () => {
  it('refuses an invitation for a role that does not exist', async () => {
    const org = await createWorkspace(admin, 'acme');
    for (const role of ['owner', 'superadmin', '', 'admin,member']) {
      const res = await invite(admin, org, 'new@example.test', role);
      expect(res.status, `role ${JSON.stringify(role)}`).toBeGreaterThanOrEqual(400);
    }
    expect(count('invitation')).toBe(0);
    expect(h.mail.filter((m) => m.subject.includes('invited'))).toHaveLength(0);
  });

  it('accepts admin and member, and records the role on the invitation', async () => {
    const org = await createWorkspace(admin, 'acme');
    expect((await invite(admin, org, 'a@example.test', 'admin')).status).toBe(200);
    expect((await invite(admin, org, 'm@example.test', 'member', '10.0.1.2')).status).toBe(200);
    const roles = h.db.raw.prepare('SELECT email, role FROM invitation ORDER BY email').all();
    expect(roles).toEqual([
      { email: 'a@example.test', role: 'admin' },
      { email: 'm@example.test', role: 'member' },
    ]);
  });

  it('refuses to change a member to a role that does not exist', async () => {
    const org = await createWorkspace(admin, 'acme');
    await invite(admin, org, 'p@example.test', 'member');
    const pat = await h.register('p@example.test', { ip: '10.9.0.2' });
    const accepted = await h.call('/organization/accept-invitation', {
      body: { invitationId: invitationIdFor('p@example.test') },
      cookie: pat,
      ip: '10.9.0.2',
    });
    expect(accepted.status).toBe(200);
    const member = h.db.raw.prepare(`SELECT id FROM member WHERE role='member'`).get() as { id: string };
    const res = await h.call('/organization/update-member-role', {
      body: { memberId: member.id, role: 'owner', organizationId: org },
      cookie: admin,
      ip: '10.0.2.1',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(
      (h.db.raw.prepare('SELECT role FROM member WHERE id=?').get(member.id) as { role: string }).role,
    ).toBe('member');
  });
});

describe('who may invite', () => {
  it('a plain member cannot invite anyone', async () => {
    const org = await createWorkspace(admin, 'acme');
    await invite(admin, org, 'mem@example.test', 'member');
    const mem = await h.register('mem@example.test', { ip: '10.9.0.3' });
    await h.call('/organization/accept-invitation', {
      body: { invitationId: invitationIdFor('mem@example.test') },
      cookie: mem,
      ip: '10.9.0.3',
    });
    const before = count('invitation');
    const res = await invite(mem, org, 'third@example.test', 'member', '10.0.3.1');
    expect(res.status).toBe(403);
    expect(count('invitation')).toBe(before);
  });

  it('an outsider cannot invite into a workspace they do not belong to', async () => {
    const org = await createWorkspace(admin, 'acme');
    const outsider = await h.register('out@example.test', { ip: '10.9.0.4' });
    const res = await invite(outsider, org, 'x@example.test', 'member', '10.0.4.1');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(count('invitation')).toBe(0);
  });

  it('a signed-out caller cannot invite', async () => {
    const org = await createWorkspace(admin, 'acme');
    const res = await h.call('/organization/invite-member', {
      body: { email: 'x@example.test', role: 'member', organizationId: org },
      ip: '10.0.5.1',
    });
    expect(res.status).toBe(401);
  });
});

describe('accepting an invitation', () => {
  it('adds a membership and creates no workspace', async () => {
    const org = await createWorkspace(admin, 'acme');
    await invite(admin, org, 'new@example.test', 'member');
    const newbie = await h.register('new@example.test', { ip: '10.9.0.5' });
    const workspaces = count('organization');
    const res = await h.call('/organization/accept-invitation', {
      body: { invitationId: invitationIdFor('new@example.test') },
      cookie: newbie,
      ip: '10.9.0.5',
    });
    expect(res.status).toBe(200);
    expect(count('organization')).toBe(workspaces);
    expect(
      h.db.raw
        .prepare(`SELECT organization_id AS o, role FROM member WHERE organization_id=? AND role='member'`)
        .all(org),
    ).toHaveLength(1);
  });

  it('an existing member of another workspace may join a second one, keeping the first', async () => {
    const acme = await createWorkspace(admin, 'acme');
    const other = await h.register('other@example.test', { ip: '10.9.0.6' });
    const created = await h.call('/organization/create', {
      body: { name: 'globex', slug: 'globex' },
      cookie: other,
      ip: '10.0.6.1',
    });
    const globex = (await created.json<{ id: string }>()).id;
    await invite(admin, acme, 'other@example.test', 'member');
    const res = await h.call('/organization/accept-invitation', {
      body: { invitationId: invitationIdFor('other@example.test') },
      cookie: other,
      ip: '10.9.0.6',
    });
    expect(res.status).toBe(200);
    const orgs = h.db.raw
      .prepare(
        `SELECT organization_id AS o FROM member WHERE user_id=(SELECT id FROM "user" WHERE email='other@example.test') ORDER BY o`,
      )
      .all() as { o: string }[];
    expect(orgs.map((r) => r.o).sort()).toEqual([acme, globex].sort());
  });

  describe('joins the inviting workspace only (F21: no second workspace for the invitee)', () => {
    type MeBody = { user: { activeOrgId: string | null; organizations: { orgId: string; role: string }[] } };
    const me = async (cookie: string): Promise<MeBody> => {
      const res = await h.api('/api/workspace/me', { cookie });
      expect(res.status).toBe(200);
      return res.json<MeBody>();
    };
    const membershipsOf = (email: string): string[] =>
      (
        h.db.raw
          .prepare(
            `SELECT organization_id AS o FROM member WHERE user_id=(SELECT id FROM "user" WHERE email=?) ORDER BY o`,
          )
          .all(email) as { o: string }[]
      ).map((r) => r.o);

    it('a newcomer who signs up from the invitation (invite-only deployment) ends in that workspace and no other', async () => {
      // The deployed configuration: invite-only, with the operator on the allowlist (ADR 0047).
      h = createAuthHarness({ SIGNUP_MODE: 'invite_only', SIGNUP_ALLOWLIST: 'boss@example.test' });
      admin = await h.register('boss@example.test', { ip: '10.9.1.1' });
      const acme = await createWorkspace(admin, 'acme');
      expect((await invite(admin, acme, 'fresh@example.test', 'member')).status).toBe(200);
      const workspaces = count('organization');

      // Sign-up, verification and sign-in create no workspace: the invitee has none until they accept.
      const fresh = await h.register('fresh@example.test', { ip: '10.9.1.2' });
      expect(count('organization')).toBe(workspaces);
      expect(membershipsOf('fresh@example.test')).toEqual([]);
      expect((await me(fresh)).user.organizations).toEqual([]);

      const res = await h.call('/organization/accept-invitation', {
        body: { invitationId: invitationIdFor('fresh@example.test') },
        cookie: fresh,
        ip: '10.9.1.2',
      });
      expect(res.status).toBe(200);
      // The answer names the inviting workspace, which is what the invitation page switches to.
      const joined = await res.json<{
        invitation: { organizationId: string };
        member: { organizationId: string };
      }>();
      expect(joined.member.organizationId).toBe(acme);
      expect(joined.invitation.organizationId).toBe(acme);

      expect(count('organization')).toBe(workspaces);
      expect(membershipsOf('fresh@example.test')).toEqual([acme]);
      const after = (await me(fresh)).user;
      expect(after.organizations.map((o) => [o.orgId, o.role])).toEqual([[acme, 'member']]);
      expect(
        h.db.raw.prepare(`SELECT status FROM invitation WHERE email='fresh@example.test'`).get(),
      ).toEqual({
        status: 'accepted',
      });

      // Accepting again changes nothing: no second membership and no workspace.
      const again = await h.call('/organization/accept-invitation', {
        body: { invitationId: invitationIdFor('fresh@example.test') },
        cookie: fresh,
        ip: '10.9.1.2',
      });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(count('organization')).toBe(workspaces);
      expect(membershipsOf('fresh@example.test')).toEqual([acme]);
    });

    it('a person who already has a workspace gains exactly the inviting one: no third workspace, the first kept', async () => {
      const acme = await createWorkspace(admin, 'acme');
      const owner = await h.register('owner@example.test', { ip: '10.9.1.3' });
      const own = await createWorkspace(owner, 'own-shop');
      await invite(admin, acme, 'owner@example.test', 'admin');
      const workspaces = count('organization');

      const res = await h.call('/organization/accept-invitation', {
        body: { invitationId: invitationIdFor('owner@example.test') },
        cookie: owner,
        ip: '10.9.1.3',
      });
      expect(res.status).toBe(200);
      expect(count('organization')).toBe(workspaces);
      expect(membershipsOf('owner@example.test')).toEqual([acme, own].sort());
      const listed = (await me(owner)).user.organizations.map((o) => [o.orgId, o.role]);
      expect(listed.sort()).toEqual(
        [
          [own, 'admin'],
          [acme, 'admin'],
        ].sort(),
      );
      // The inviting workspace gained exactly one member beside its creator: the invitee.
      expect(
        h.db.raw.prepare('SELECT COUNT(*) AS n FROM member WHERE organization_id=?').get(acme) as {
          n: number;
        },
      ).toEqual({ n: 2 });
    });
  });

  it('only the invited address may accept: another signed-in person is refused and nothing changes', async () => {
    const org = await createWorkspace(admin, 'acme');
    await invite(admin, org, 'meant@example.test', 'admin');
    const id = invitationIdFor('meant@example.test');
    const thief = await h.register('thief@example.test', { ip: '10.9.0.7' });
    const members = count('member');
    const res = await h.call('/organization/accept-invitation', {
      body: { invitationId: id },
      cookie: thief,
      ip: '10.9.0.7',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(count('member')).toBe(members);
    expect(
      (h.db.raw.prepare('SELECT status FROM invitation WHERE id=?').get(id) as { status: string }).status,
    ).toBe('pending');
  });

  it('matches the invited address regardless of letter case', async () => {
    const org = await createWorkspace(admin, 'acme');
    await invite(admin, org, 'Mixed.Case@Example.TEST', 'member');
    const who = await h.register('mixed.case@example.test', { ip: '10.9.0.8' });
    const res = await h.call('/organization/accept-invitation', {
      body: { invitationId: invitationIdFor('mixed.case@example.test') },
      cookie: who,
      ip: '10.9.0.8',
    });
    expect(res.status).toBe(200);
  });

  it('an invitation can be accepted once', async () => {
    const org = await createWorkspace(admin, 'acme');
    await invite(admin, org, 'once@example.test', 'member');
    const id = invitationIdFor('once@example.test');
    const who = await h.register('once@example.test', { ip: '10.9.0.9' });
    const accept = () =>
      h.call('/organization/accept-invitation', { body: { invitationId: id }, cookie: who, ip: '10.9.0.9' });
    expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBeGreaterThanOrEqual(400);
    expect(count('member')).toBe(2);
  });

  it('an invitation can still be accepted on day six and cannot after day seven', async () => {
    const org = await createWorkspace(admin, 'acme');
    await invite(admin, org, 'early@example.test', 'member');
    await invite(admin, org, 'late@example.test', 'member', '10.0.1.2');
    const early = await h.register('early@example.test', { ip: '10.9.0.10' });
    const late = await h.register('late@example.test', { ip: '10.9.0.12' });
    const accept = (email: string, cookie: string, ip: string) =>
      h.call('/organization/accept-invitation', {
        body: { invitationId: invitationIdFor(email) },
        cookie,
        ip,
      });

    vi.setSystemTime(Date.now() + 6 * 86_400_000);
    expect((await accept('early@example.test', early, '10.9.0.10')).status).toBe(200);

    vi.setSystemTime(Date.now() + 1 * 86_400_000 + 60_000);
    const refused = await accept('late@example.test', late, '10.9.0.12');
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(count('member')).toBe(2); // the admin and the early invitee, not the late one
  });

  it('an admin can cancel a pending invitation, after which it cannot be accepted', async () => {
    const org = await createWorkspace(admin, 'acme');
    await invite(admin, org, 'gone@example.test', 'member');
    const id = invitationIdFor('gone@example.test');
    const cancel = await h.call('/organization/cancel-invitation', {
      body: { invitationId: id },
      cookie: admin,
      ip: '10.0.7.1',
    });
    expect(cancel.status).toBe(200);
    const who = await h.register('gone@example.test', { ip: '10.9.0.11' });
    const res = await h.call('/organization/accept-invitation', {
      body: { invitationId: id },
      cookie: who,
      ip: '10.9.0.11',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the last admin', () => {
  it('cannot be removed or demoted, so a workspace never has no admin', async () => {
    const org = await createWorkspace(admin, 'acme');
    const self = h.db.raw.prepare(`SELECT id FROM member WHERE role='admin'`).get() as { id: string };
    const remove = await h.call('/organization/remove-member', {
      body: { memberIdOrEmail: self.id, organizationId: org },
      cookie: admin,
      ip: '10.0.8.1',
    });
    expect(remove.status).toBeGreaterThanOrEqual(400);
    const demote = await h.call('/organization/update-member-role', {
      body: { memberId: self.id, role: 'member', organizationId: org },
      cookie: admin,
      ip: '10.0.8.2',
    });
    expect(demote.status).toBeGreaterThanOrEqual(400);
    expect(count('member')).toBe(1);
    expect(
      (h.db.raw.prepare('SELECT role FROM member WHERE id=?').get(self.id) as { role: string }).role,
    ).toBe('admin');
  });
});
