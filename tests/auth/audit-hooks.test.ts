import { describe, expect, it } from 'vitest';
import { AUDITED_PATHS, entryFor, isAuditedPath } from '../../src/auth/audit-hooks';
import { AUDIT_ACTIONS } from '../../src/audit/actions';

/**
 * `entryFor` turns what Better Auth returned into an audit row, or into nothing. It is pure, so every
 * shape (and every malformed one) is checked here without a server; `audit-events.test.ts` runs the same
 * mapping end to end.
 */
describe('which Better Auth routes are audited', () => {
  it('maps every audited path to an action the audit log knows', () => {
    for (const action of Object.values(AUDITED_PATHS)) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('recognises exactly those paths, and nothing inherited from Object.prototype', () => {
    expect(isAuditedPath('/organization/invite-member')).toBe(true);
    expect(isAuditedPath('/sign-in/email')).toBe(false);
    expect(isAuditedPath('toString')).toBe(false);
    expect(isAuditedPath('__proto__')).toBe(false);
    expect(isAuditedPath(undefined)).toBe(false);
  });
});

describe('entryFor', () => {
  const invitation = { id: 'inv1', organizationId: 'org1', role: 'member', email: 'secret@example.test' };

  it('never lets the invitee address into a row', () => {
    const entry = entryFor({ path: '/organization/invite-member', returned: invitation, actorId: 'u1' });
    expect(entry).toMatchObject({ action: 'member.invite', subjectId: 'inv1', organizationId: 'org1' });
    expect(JSON.stringify(entry)).not.toContain('secret@example.test');
  });

  it('drops a role that is not one of ours instead of storing text a caller could influence', () => {
    const entry = entryFor({
      path: '/organization/invite-member',
      returned: { ...invitation, role: '<script>' },
      actorId: 'u1',
    });
    expect(entry?.metadata).toEqual({});
  });

  it('records nothing when the response lacks what a row needs', () => {
    for (const returned of [null, undefined, 'ok', 42, {}, { id: 'x' }, { organizationId: 'o' }, []])
      expect(entryFor({ path: '/organization/invite-member', returned, actorId: 'u1' })).toBeNull();
    expect(
      entryFor({ path: '/organization/update-member-role', returned: { userId: 'u' }, actorId: 'a' }),
    ).toBeNull();
    expect(
      entryFor({ path: '/organization/remove-member', returned: { member: {} }, actorId: 'a' }),
    ).toBeNull();
    expect(
      entryFor({ path: '/organization/accept-invitation', returned: { invitation: {} }, actorId: 'a' }),
    ).toBeNull();
  });

  it('marks removal of oneself as leaving, and of someone else as removal', () => {
    const member = { userId: 'u2', organizationId: 'org1', role: 'member' };
    expect(
      entryFor({ path: '/organization/remove-member', returned: { member }, actorId: 'u1' })?.metadata,
    ).toEqual({
      role: 'member',
      self: false,
    });
    expect(entryFor({ path: '/organization/leave', returned: member, actorId: 'u2' })?.metadata).toEqual({
      role: 'member',
      self: true,
    });
  });

  it('a role change keeps the old role only when it is one of ours', () => {
    const returned = { userId: 'u2', organizationId: 'org1', role: 'admin' };
    expect(
      entryFor({ path: '/organization/update-member-role', returned, actorId: 'u1', previousRole: 'member' })
        ?.metadata,
    ).toEqual({ role: 'admin', previousRole: 'member' });
    expect(
      entryFor({ path: '/organization/update-member-role', returned, actorId: 'u1', previousRole: 'owner' })
        ?.metadata,
    ).toEqual({ role: 'admin' });
  });

  it('a password reset needs the person it was for and a success, and has no workspace', () => {
    const ok = { status: true };
    expect(entryFor({ path: '/reset-password', returned: ok, actorId: null })).toBeNull();
    expect(
      entryFor({ path: '/reset-password', returned: { status: false }, actorId: null, resetUserId: 'u1' }),
    ).toBeNull();
    expect(
      entryFor({
        path: '/reset-password',
        returned: ok,
        actorId: null,
        resetUserId: 'u1',
        revokedSessions: 3,
      }),
    ).toEqual({
      organizationId: null,
      actorId: 'u1',
      action: 'session.revoke_all',
      subjectType: 'session',
      subjectId: null,
      outcome: 'success',
      metadata: { revoked: 3, reason: 'password_reset' },
    });
  });
});
