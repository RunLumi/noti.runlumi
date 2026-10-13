import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

/**
 * Domain capabilities (docs/specs/02-identity-tenancy.md F24) alongside Better Auth's own.
 * One definition serves both Better Auth's organization plugin and our route checks, so a
 * role cannot mean one thing to membership management and another to integrations.
 */
const statements = {
  ...defaultStatements,
  integration: ['read', 'create', 'update', 'delete'],
  source: ['read', 'create', 'update', 'delete'],
  delivery: ['read', 'replay'],
  audit: ['read'],
  workspace: ['export', 'delete'],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  admin: ac.newRole({
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    integration: ['read', 'create', 'update', 'delete'],
    source: ['read', 'create', 'update', 'delete'],
    delivery: ['read', 'replay'],
    audit: ['read'],
    workspace: ['export', 'delete'],
  }),
  member: ac.newRole({
    integration: ['read', 'create', 'update', 'delete'],
    source: ['read', 'create', 'update', 'delete'],
    delivery: ['read'],
  }),
} as const;

export type OrgRole = keyof typeof roles;

export function isOrgRole(value: unknown): value is OrgRole {
  return value === 'admin' || value === 'member';
}

type Statements = typeof statements;
export type Capability = {
  [R in keyof Statements]: `${R & string}.${Statements[R][number]}`;
}[keyof Statements];

/** Pure check: may `role` perform `capability`? Unknown roles may do nothing. */
export function can(role: unknown, capability: Capability): boolean {
  if (!isOrgRole(role)) return false;
  const [resource, action] = capability.split('.') as [keyof Statements, string];
  return roles[role].authorize({ [resource]: [action] }).success;
}
