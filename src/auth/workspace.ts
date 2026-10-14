import { Hono, type Context } from 'hono';
import { APIError } from 'better-auth/api';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { recordDenial, requestOrigin } from '../audit/audit';
import { log } from '../platform/log';
import { hit } from '../security/rate-limit';
import { createAuth, type AuthBindings } from './better-auth';
import { can, type Capability } from './permissions';
import { sessionPastAbsoluteLife } from './session-policy';

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

type Failure = { status: 400 | 401 | 403 | 404; error: string };

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function current(c: WorkspaceContext) {
  // Constructed per request on purpose. Better Auth caches async init promises on
  // the instance, and better-auth#10315 (open) shows a client disconnecting before
  // the first request settles can poison those promises for every later request on
  // the same isolate. Module-scope caching would widen that blast radius. With the
  // Drizzle adapter the schema check is local, so this is not an expensive rebuild.
  const auth = createAuth(c.env, c.executionCtx);
  // The absolute-lifetime hook throws 401 for a session past its end; that is "not signed in", not a fault.
  const s = await auth.api.getSession({ headers: c.req.raw.headers }).catch((error: unknown) => {
    if (error instanceof APIError && error.statusCode === 401) return null;
    throw error;
  });
  if (!s?.user.emailVerified) return null;
  // The absolute lifetime (ADR 0030): daily use extends a session's idle expiry, never this bound.
  return sessionPastAbsoluteLife(s.session.createdAt) ? null : s;
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

  // A person in several workspaces must NAME the workspace on every write. Without this a tab
  // left open on workspace A would write into B after another tab switched the session's active
  // workspace. One membership is unambiguous, so it needs no parameter. Enforced here, the one
  // place every domain route resolves its tenant.
  if (MUTATING_METHODS.has(c.req.method) && memberships.length > 1 && !c.req.query('org'))
    return { status: 400, error: 'org is required' };

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
    case 'ambiguous': {
      // Several memberships and no valid active workspace (e.g. the active one was purged).
      // Settle on the earliest membership the caller actually holds and remember it as the
      // session's active workspace, so the choice is explicit state rather than a guess.
      const earliest = await db
        .select({
          orgId: schema.member.organizationId,
          role: schema.member.role,
          orgName: schema.organization.name,
        })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
        .where(eq(schema.member.userId, s.user.id))
        .orderBy(schema.member.createdAt, schema.member.organizationId)
        .limit(1);
      const chosen = earliest[0];
      if (!chosen) return { status: 403, error: 'Select a workspace' };
      if (typeof s.session.id === 'string')
        await db
          .update(schema.session)
          .set({ activeOrganizationId: chosen.orgId })
          .where(eq(schema.session.id, s.session.id));
      return { ...base, ...(chosen as Membership) };
    }
  }
}

function isFailure(value: Resolved | Failure): value is Failure {
  return 'status' in value;
}

workspace.get('/me', async (c) => {
  const resolved = await resolveWorkspace(c);
  if (isFailure(resolved)) {
    // A signed-in user with no workspace yet is a normal state (they are about to create
    // one), not an error: answering 403 here bounced new users to /signin forever.
    if (resolved.status === 403 && resolved.error === 'Create or join an organization first') {
      const session = await current(c);
      if (session) {
        return c.json({
          user: {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
            emailVerified: session.user.emailVerified,
            org_id: null,
            org_name: null,
            role: null,
            activeOrgId: null,
            organizations: [],
          },
        });
      }
    }
    return c.json({ error: resolved.error }, resolved.status);
  }

  const db = drizzle(c.env.DB, { schema });
  const organizations = await db
    .select({
      orgId: schema.member.organizationId,
      role: schema.member.role,
      name: schema.organization.name,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, resolved.userId))
    .orderBy(schema.member.createdAt, schema.member.organizationId);

  return c.json({
    user: {
      id: resolved.userId,
      name: resolved.name,
      email: resolved.email,
      emailVerified: resolved.emailVerified,
      org_id: resolved.orgId,
      org_name: resolved.orgName,
      role: resolved.role,
      // The workspace this response describes: the session's active one, as settled above.
      activeOrgId: resolved.orgId,
      // Every workspace the caller belongs to, so a client can offer a switcher.
      // Scoped to this user by definition; the caller cannot see anyone else's.
      organizations,
    },
  });
});

/** Switching is a write to the caller's own session only; a generous ceiling for a person clicking. */
const SWITCHES_PER_MINUTE = 30;

/**
 * `POST /api/workspace/active` `{ organizationId }`: make a workspace the session's active one.
 *
 * Membership is checked here, from the database, for exactly this user: the id in the body is
 * never trusted. A workspace the caller is not in and one that does not exist answer
 * identically (404, same body), so the endpoint cannot be used to learn which ids exist. Only
 * `session.active_organization_id` of the caller's own session changes. CSRF (Origin) is
 * enforced for every `/api/*` mutation by `requireSameOrigin` (and repeated below).
 */
workspace.post('/active', async (c) => {
  // Repeats the central Origin check (`requireSameOrigin`) so this file stands on its own.
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.env.APP_ORIGIN).origin) return c.json({ error: 'Forbidden' }, 403);
  const s = await current(c);
  if (!s) return c.json({ error: 'Unauthorized' }, 401);
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return c.json({ error: 'Expected application/json' }, 415);
  const body: unknown = await c.req.json().catch(() => null);
  const requested =
    typeof body === 'object' && body !== null && 'organizationId' in body ? body.organizationId : null;
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 64)
    return c.json(
      { error: 'Validation failed', fields: [{ field: 'organizationId', message: 'Required.' }] },
      422,
    );

  const limit = await hit(c.env.DB, `workspace-active:${s.user.id}`, SWITCHES_PER_MINUTE, 60_000);
  if (limit.limited)
    return c.json({ error: 'Too many requests; try again shortly' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    });

  const db = drizzle(c.env.DB, { schema });
  const found = await db
    .select({
      orgId: schema.member.organizationId,
      role: schema.member.role,
      orgName: schema.organization.name,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(and(eq(schema.member.userId, s.user.id), eq(schema.member.organizationId, requested)))
    .limit(1);
  const membership = found[0];
  if (!membership) {
    await recordProbe(c, requested, 'workspace.switch');
    return c.json({ error: 'Not found' }, 404);
  }

  // Scoped to the caller's own session row, so another user's session can never be touched.
  if (typeof s.session.id === 'string')
    await db
      .update(schema.session)
      .set({ activeOrganizationId: membership.orgId })
      .where(and(eq(schema.session.id, s.session.id), eq(schema.session.userId, s.user.id)));
  c.header('Cache-Control', 'no-store');
  return c.json({ activeOrgId: membership.orgId, orgName: membership.orgName, role: membership.role });
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
 * Probes recorded per person per minute; a scan of organization ids must not fill the log.
 *
 * Decision (ADR 0028, REMAINING 1.23): NOT every cross-tenant probe is recorded, and the cap is what
 * keeps this log usable. Past it the response is unchanged and the loss is not silent: the FIRST
 * suppressed probe in a window writes one `probe_audit_capped` row (no workspace, so an operator reads
 * it from D1, never a tenant) and a warning goes to the log, each once per person per minute.
 */
export const PROBES_RECORDED_PER_MINUTE = 20;

/**
 * Record a request for a workspace the caller is not a member of. It is written against that
 * workspace when it exists, so its admins can see probes, and never reveals which case it was.
 * Organization ids are short; anything longer is not one and is not stored verbatim. A person
 * is limited to a few recorded probes a minute (the response is unaffected), so scanning ids
 * cannot be used to flood another workspace's audit log or the orphan (no-workspace) rows.
 */
async function recordProbe(c: WorkspaceContext, raw: string | null, capability: string): Promise<void> {
  const requested = raw && raw.length <= 64 ? raw : raw ? '(invalid)' : null;
  const s = await current(c);
  if (s) {
    const limit = await hit(c.env.DB, `probe-audit:${s.user.id}`, PROBES_RECORDED_PER_MINUTE, 60_000).catch(
      () => null,
    );
    if (limit?.limited) {
      // Exactly the first hit over the cap: one marker per person per window, never one per probe.
      if (limit.count === PROBES_RECORDED_PER_MINUTE + 1) {
        log('warn', 'probe_audit_capped', { limit: PROBES_RECORDED_PER_MINUTE });
        await recordDenial(c.env.DB, {
          organizationId: null,
          actorId: s.user.id,
          action: 'access.denied',
          subjectType: 'organization',
          subjectId: null,
          outcome: 'denied',
          ...requestOrigin(c.req.raw.headers),
          metadata: { capability, reason: 'probe_audit_capped' },
        });
      }
      return;
    }
  }
  const exists =
    requested && requested !== '(invalid)'
      ? await c.env.DB.prepare('SELECT 1 AS x FROM organization WHERE id=?').bind(requested).first()
      : null;
  await recordDenial(c.env.DB, {
    organizationId: exists ? requested : null,
    actorId: s?.user.id ?? null,
    action: 'access.denied',
    subjectType: 'organization',
    subjectId: requested,
    outcome: 'denied',
    ...requestOrigin(c.req.raw.headers),
    metadata: { capability, reason: 'not_a_member' },
  });
}

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
    if (resolved.status === 404) await recordProbe(c, c.req.query('org') ?? null, capability);
    return resolved;
  }

  if (!can(resolved.role, capability)) {
    await recordDenial(c.env.DB, {
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
export { resolveWorkspace, isFailure, current as currentSession };
export type { Resolved, Failure };

export default workspace;
