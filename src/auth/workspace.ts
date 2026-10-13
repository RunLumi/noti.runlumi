import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { recordAudit, requestOrigin } from '../audit/audit';
import { createAuth, type AuthBindings } from './better-auth';
import { can, type Capability } from './permissions';

const workspace = new Hono<{ Bindings: AuthBindings }>();

/**
 * The parts of a request context these helpers use. Structural, so a route whose bindings
 * extend `AuthBindings` (the integrations API) can call them too.
 */
type WorkspaceContext = Pick<Context<{ Bindings: AuthBindings }>, 'env' | 'req' | 'executionCtx'>;

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
 * The single authorization gate for domain routes (F24, F26).
 *
 * Resolves the caller's workspace, then checks the capability against their role. Denials
 * are audited here — not in individual routes — so a cross-tenant probe cannot be
 * forgotten. A missing capability names itself in the 403 so support can diagnose it.
 */
export async function authorize(c: WorkspaceContext, capability: Capability): Promise<Resolved | Failure> {
  const resolved = await resolveWorkspace(c);
  const origin = requestOrigin(c.req.raw.headers);

  if (isFailure(resolved)) {
    if (resolved.status === 404) {
      // A request for a workspace the caller is not a member of. Record it against that
      // workspace when it exists, so its admins can see probes; never reveal which it was.
      const requested = c.req.query('org') ?? null;
      const exists = requested
        ? await c.env.DB.prepare('SELECT 1 AS x FROM organization WHERE id=?').bind(requested).first()
        : null;
      const s = await current(c);
      await recordAudit(c.env.DB, {
        organizationId: exists ? requested : null,
        actorId: s?.user.id ?? null,
        action: 'access.denied',
        subjectType: 'organization',
        subjectId: requested,
        outcome: 'denied',
        ...origin,
        metadata: { capability, reason: 'not_a_member' },
      });
    }
    return resolved;
  }

  if (!can(resolved.role, capability)) {
    await recordAudit(c.env.DB, {
      organizationId: resolved.orgId,
      actorId: resolved.userId,
      action: 'access.denied',
      subjectType: 'capability',
      subjectId: capability,
      outcome: 'denied',
      ...origin,
      metadata: { role: resolved.role },
    });
    return { status: 403, error: `Missing capability: ${capability}` };
  }
  return resolved;
}

// `selectMembership`, `Selection` and `Membership` are already exported at their
// declarations. Re-exporting them here would conflict.
export { resolveWorkspace, isFailure };
export type { Resolved, Failure };

export default workspace;
