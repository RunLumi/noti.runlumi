import { describe, expect, it } from 'vitest';
import { can, DOMAIN_CAPABILITIES, type Capability } from '../../src/auth/permissions';

const table: [Capability, admin: boolean, member: boolean][] = [
  ['integration.read', true, true],
  ['integration.create', true, true],
  ['integration.update', true, true],
  ['integration.delete', true, true],
  ['integration.revoke', true, false],
  ['source.read', true, true],
  ['source.create', true, true],
  ['source.update', true, true],
  ['source.delete', true, false],
  ['source.rotate', true, false],
  ['source.revoke', true, false],
  ['delivery.read', true, true],
  ['delivery.replay', true, false],
  ['audit.read', true, false],
  ['member.create', true, false],
  ['invitation.create', true, false],
  ['organization.update', true, false],
  ['organization.delete', false, false],
  ['workspace.export', true, false],
  ['workspace.delete', true, false],
];

describe('domain authorization (F24)', () => {
  it.each(table)('%s → admin %s, member %s', (capability, admin, member) => {
    expect(can('admin', capability)).toBe(admin);
    expect(can('member', capability)).toBe(member);
  });

  it('covers every defined domain capability, so a new one cannot ship untested', () => {
    const covered = new Set(table.map(([capability]) => capability));
    expect(DOMAIN_CAPABILITIES.filter((capability) => !covered.has(capability))).toEqual([]);
  });

  it('grants nothing to an unknown or missing role', () => {
    for (const [capability] of table) {
      expect(can('owner', capability)).toBe(false);
      expect(can(undefined, capability)).toBe(false);
    }
  });
});
