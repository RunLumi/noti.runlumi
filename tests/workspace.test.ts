import { describe, it, expect } from 'vitest';
import { selectMembership, type Membership } from '../src/auth/workspace';

/**
 * The membership-selection rule decides which tenant a request reads. With
 * multi-organization support, "take the first membership" is ambiguous and would
 * leak another organization's data through /team.
 */
const orgA: Membership = { orgId: 'org-a', role: 'admin', orgName: 'Acme' };
const orgB: Membership = { orgId: 'org-b', role: 'member', orgName: 'Beta' };
const orgC: Membership = { orgId: 'org-c', role: 'member', orgName: 'Gamma' };

describe('workspace membership selection', () => {
  it('returns none when the user belongs to no organization', () => {
    expect(selectMembership([], {})).toEqual({ kind: 'none' });
  });

  it('uses the only membership when there is exactly one', () => {
    expect(selectMembership([orgA], {})).toEqual({ kind: 'ok', membership: orgA });
  });

  it('prefers the active organization', () => {
    expect(selectMembership([orgA, orgB], { activeId: 'org-b' })).toEqual({
      kind: 'ok',
      membership: orgB,
    });
  });

  it('honours an explicit request even when it differs from the active organization', () => {
    expect(selectMembership([orgA, orgB], { activeId: 'org-a', requested: 'org-b' })).toEqual({
      kind: 'ok',
      membership: orgB,
    });
  });

  it('refuses to guess between several organizations with no active one', () => {
    // The regression this guards: `.limit(1)` returned an arbitrary tenant.
    expect(selectMembership([orgA, orgB], {})).toEqual({ kind: 'ambiguous' });
  });

  it('refuses when the active organization is no longer a membership', () => {
    // A stale activeOrganizationId must not silently fall back to another tenant.
    expect(selectMembership([orgA, orgB], { activeId: 'org-removed' })).toEqual({ kind: 'ambiguous' });
  });

  it('falls back to the only membership when the active id is unknown', () => {
    expect(selectMembership([orgA], { activeId: 'stale' })).toEqual({ kind: 'ok', membership: orgA });
  });

  it('refuses an explicit organization the caller does not belong to', () => {
    expect(selectMembership([orgA, orgB], { requested: 'org-c' })).toEqual({ kind: 'not-a-member' });
  });

  it('refuses an explicit organization even when another membership exists', () => {
    expect(selectMembership([orgA], { requested: 'org-c' })).toEqual({ kind: 'not-a-member' });
  });

  it('does not match an organization id by prefix', () => {
    expect(selectMembership([orgA], { requested: 'org' })).toEqual({ kind: 'not-a-member' });
  });

  it('selects exactly one membership for every single-organization caller', () => {
    for (const m of [orgA, orgB, orgC]) {
      expect(selectMembership([m], {}).kind).toBe('ok');
    }
  });
});
