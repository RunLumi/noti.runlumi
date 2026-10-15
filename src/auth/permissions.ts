import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

/**
 * Domain capabilities (docs/specs/02-identity-tenancy.md F24) alongside Better Auth's own.
 * One definition serves both Better Auth's organization plugin and our route checks, so a
 * role cannot mean one thing to membership management and another to integrations.
 */
const statements = {
  ...defaultStatements,
  // `create` and `cancel` are Better Auth's own; `read` lets an admin list pending invitations (ADR 0045).
  invitation: ['create', 'cancel', 'read'],
  integration: ['read', 'create', 'update', 'delete', 'revoke'],
  source: ['read', 'create', 'update', 'delete', 'rotate', 'revoke'],
  delivery: ['read', 'replay'],
  audit: ['read'],
  workspace: ['export', 'delete'],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  admin: ac.newRole({
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel', 'read'],
    integration: ['read', 'create', 'update', 'delete', 'revoke'],
    source: ['read', 'create', 'update', 'delete', 'rotate', 'revoke'],
    delivery: ['read', 'replay'],
    audit: ['read'],
    workspace: ['export', 'delete'],
  }),
  member: ac.newRole({
    integration: ['read', 'create', 'update', 'delete'],
    // Members may create, list, rename and pause. Rotating a secret (instant outage for the
    // sender), revoking a credential (the same outage until it is re-entered) and deleting a source
    // (destroys its chats) are admin-only.
    source: ['read', 'create', 'update'],
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

/** The resources this product defines itself (the rest of `statements` is Better Auth's own). */
export const DOMAIN_RESOURCES = ['integration', 'source', 'delivery', 'audit', 'workspace'] as const;

/** Every domain capability, derived from the one definition above so a new one cannot be missed. */
export const DOMAIN_CAPABILITIES: readonly Capability[] = DOMAIN_RESOURCES.flatMap((resource) =>
  statements[resource].map((action) => `${resource}.${action}` as Capability),
);

/**
 * The Better Auth `invitation` capabilities that OUR routes check (ADR 0045: the pending list and cancel).
 * The rest of `invitation` (`create`) is enforced by Better Auth's own invite route and is not a domain resource.
 */
export const ROUTE_CHECKED_INVITATION_CAPABILITIES: readonly Capability[] = [
  'invitation.read',
  'invitation.cancel',
];
