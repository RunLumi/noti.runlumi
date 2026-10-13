import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { createAuth, type AuthBindings } from './better-auth';

const workspace = new Hono<{ Bindings: AuthBindings }>();

type WorkspaceContext = Context<{ Bindings: AuthBindings }>;

async function current(c: WorkspaceContext) {
  const auth = createAuth(c.env, c.executionCtx);
  const s = await auth.api.getSession({ headers: c.req.raw.headers });
  return s?.user.emailVerified ? s : null;
}

workspace.get('/me', async (c) => {
  const s = await current(c);
  if (!s) return c.json({ error: 'Unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const [membership] = await db
    .select({
      orgId: schema.member.organizationId,
      role: schema.member.role,
      orgName: schema.organization.name,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, s.user.id))
    .limit(1);
  return c.json({
    user: {
      id: s.user.id,
      name: s.user.name,
      email: s.user.email,
      emailVerified: s.user.emailVerified,
      org_id: membership?.orgId ?? null,
      org_name: membership?.orgName ?? null,
      role: membership?.role ?? null,
    },
  });
});

workspace.get('/team', async (c) => {
  const s = await current(c);
  if (!s) return c.json({ error: 'Unauthorized' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const [membership] = await db
    .select({ orgId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, s.user.id))
    .limit(1);
  if (!membership) return c.json({ error: 'Create or join an organization first' }, 403);
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
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, membership.orgId));
  return c.json({ members });
});

export default workspace;
