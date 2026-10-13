import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { createAuth, type AuthBindings } from './better-auth';

const workspace = new Hono<{ Bindings: AuthBindings }>();

type WorkspaceContext = Context<{ Bindings: AuthBindings }>;

export type Membership = { orgId: string; role: string; orgName: string };

type Resolved = {
  userId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  orgId: string;
  role: string;
  orgName: string;
};

type Failure = { status: 401 | 403 | 404; error: string };

async function current(c: WorkspaceContext) {
  // Constructed per request on purpose. Better Auth caches async init promises on
  // the instance, and better-auth#10315 (open) shows a client disconnecting before
  // the first request settles can poison those promises for every later request on
  // the same isolate. Module-scope caching would widen that blast radius. With the
  // Drizzle adapter the schema check is local, so this is not an expensive rebuild.
  const auth = createAuth(c.env, c.executionCtx);
  const s = await auth.api.getSession({ headers: c.req.raw.headers });
  return s?.user.emailVerified ? s : null;
}

export type Selection =
  | { kind: 'ok'; membership: Membership }
  | { kind: 'not-a-member' }
  | { kind: 'none' }
  | { kind: 'ambiguous' };

/**
 * Pure membership-selection rule, extracted so it can be tested without D1.
 *
 * This is the function that decides which tenant a request reads. With multi-organization
 * support, "take the first membership" is ambiguous and previously leaked another
 * organization's member list through /team.
 *
 * - A requested organization the caller does not belong to is `not-a-member`, surfaced as
 *   404 rather than 403, because a 403 confirms the organization exists.
 * - With no explicit request, the active organization wins.
 * - Falling back to "their only organization" is safe because a single membership is
 *   unambiguous. With several and no active organization, we refuse rather than guess.
 */
export function selectMembership(
  memberships: readonly Membership[],
  options: { requested?: string | undefined; activeId?: string | null | undefined },
): Selection {
  const { requested, activeId } = options;

  if (requested) {
    const found = memberships.find((m) => m.orgId === requested);
    return found ? { kind: 'ok', membership: found } : { kind: 'not-a-member' };
  }

  if (activeId) {
    const active = memberships.find((m) => m.orgId === activeId);
    if (active) return { kind: 'ok', membership: active };
  }

  if (memberships.length === 0) return { kind: 'none' };
  if (memberships.length === 1) {
    const only = memberships.at(0);
    if (only) return { kind: 'ok', membership: only };
  }
  return { kind: 'ambiguous' };
}

/**
 * Resolve the caller's workspace, or fail.
 *
 * See `selectMembership` for the selection rule; this function only supplies the data.
 */
async function resolveWorkspace(c: WorkspaceContext): Promise<Resolved | Failure> {
  const s = await current(c);
  if (!s) return { status: 401, error: 'Unauthorized' };

  const db = drizzle(c.env.DB, { schema });
  const memberships = (await db
    .select({
      orgId: schema.member.organizationId,
      role: schema.member.role,
      orgName: schema.organization.name,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, s.user.id))) as Membership[];

  const base = {
    userId: s.user.id,
    email: s.user.email,
    emailVerified: s.user.emailVerified,
    name: s.user.name,
  };

  const selection = selectMembership(memberships, {
    requested: c.req.query('org'),
    activeId: s.session.activeOrganizationId,
  });

  switch (selection.kind) {
    case 'ok':
      return { ...base, ...selection.membership };
    case 'not-a-member':
      // 404, not 403: a 403 confirms the organization exists.
      return { status: 404, error: 'Not found' };
    case 'none':
      return { status: 403, error: 'Create or join an organization first' };
    case 'ambiguous':
      return { status: 403, error: 'Select a workspace' };
  }
}

function isFailure(value: Resolved | Failure): value is Failure {
  return 'status' in value;
}

workspace.get('/me', async (c) => {
  const resolved = await resolveWorkspace(c);
  if (isFailure(resolved)) return c.json({ error: resolved.error }, resolved.status);

  const db = drizzle(c.env.DB, { schema });
  const organizations = await db
    .select({
      orgId: schema.member.organizationId,
      role: schema.member.role,
      name: schema.organization.name,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, resolved.userId));

  return c.json({
    user: {
      id: resolved.userId,
      name: resolved.name,
      email: resolved.email,
      emailVerified: resolved.emailVerified,
      org_id: resolved.orgId,
      org_name: resolved.orgName,
      role: resolved.role,
      // Every workspace the caller belongs to, so a client can offer a switcher.
      // Scoped to this user by definition; the caller cannot see anyone else's.
      organizations,
    },
  });
});

workspace.get('/team', async (c) => {
  const resolved = await resolveWorkspace(c);
  if (isFailure(resolved)) return c.json({ error: resolved.error }, resolved.status);

  const db = drizzle(c.env.DB, { schema });
  // Scoped to the RESOLVED organization, not "whatever membership came first".
  const members = await db
    .select({
      id: schema.member.id,
      userId: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.member.role,
      createdAt: schema.member.createdAt,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(eq(schema.member.organizationId, resolved.orgId));

  return c.json({ organizationId: resolved.orgId, members });
});

/**
 * Minimal capability check for workspace routes.
 *
 * The capability set in permissions.ts covers Better Auth's own resources only;
 * domain capabilities (`integration.*`, `destination.*`, `replay`, `audit`) are not
 * defined yet (docs/specs/02 F24). Until they are, this helper is the single place
 * to add them, so a missing check is one edit rather than a hunt.
 */
export async function authorize(c: WorkspaceContext, capability: string): Promise<Resolved | Failure> {
  const resolved = await resolveWorkspace(c);
  if (isFailure(resolved)) return resolved;

  // Only owner/admin may mutate membership; everyone may read.
  if (capability === 'member.write' && resolved.role !== 'admin') {
    return { status: 403, error: 'Forbidden' };
  }
  return resolved;
}

// `selectMembership`, `Selection` and `Membership` are already exported at their
// declarations. Re-exporting them here would conflict.
export { resolveWorkspace, isFailure };
export type { Resolved, Failure };

export default workspace;
