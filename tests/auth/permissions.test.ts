import { describe, expect, it } from 'vitest';
import { can, type Capability } from '../../src/auth/permissions';

const table: [Capability, admin: boolean, member: boolean][] = [
  ['integration.read', true, true],
  ['integration.create', true, true],
  ['integration.update', true, true],
  ['integration.delete', true, true],
  ['delivery.read', true, true],
  ['delivery.replay', true, false],
  ['audit.read', true, false],
  ['member.create', true, false],
  ['invitation.create', true, false],
  ['organization.update', true, false],
  ['organization.delete', false, false],
];

describe('domain authorization (F24)', () => {
  it.each(table)('%s → admin %s, member %s', (capability, admin, member) => {
    expect(can('admin', capability)).toBe(admin);
    expect(can('member', capability)).toBe(member);
  });

  it('grants nothing to an unknown or missing role', () => {
    for (const [capability] of table) {
      expect(can('owner', capability)).toBe(false);
      expect(can(undefined, capability)).toBe(false);
    }
  });
});
