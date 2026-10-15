import { Hono, type Context } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { auditStatement, recordDenial, requestOrigin } from '../audit/audit';
import { authorize, isFailure } from '../auth/workspace';
import * as schema from '../db/schema';
import type { Bindings } from '../env';
import { hit } from '../security/rate-limit';

/**
 * Pending invitations of one workspace (docs/specs/02 F21, F28; ADR 0045).
 *
 *  - `GET  /api/workspace/invitations?org=`            the pending invitations, admin only (`invitation.read`).
 *  - `POST /api/workspace/invitations/:id/cancel?org=` cancel one, admin only (`invitation.cancel`).
 *
 * Both go through `authorize`, which resolves the workspace named by `?org=` against the caller's own
 * membership and checks the capability for that person's role there. A workspace the caller is not in
 * answers 404, exactly as one that does not exist. Every query carries the resolved organization id,
 * so an invitation of another workspace is never read, never changed and never shown.
 *
 * The cancel changes one row and writes its audit row (`member.invite.cancel`) in ONE batch: the row
 * exists if and only if the status changed. This is the write Better Auth would otherwise make through
 * its `after` hook, which is not atomic with the change (ADR 0030); cancelling here closes that gap for
 * this one action. Acceptance is refused by Better Auth for any status other than `pending`, so a
 * cancelled link stops working at once.
 */

/** A workspace with more pending invitations than this is shown the first page and says so. */
export const PENDING_LIST_LIMIT = 100;
/** Admin cancels, generous for a person clicking; a script is not an admin workflow. */
export const CANCELS_PER_MINUTE = 30;

const invitations = new Hono<{ Bindings: Bindings }>();

invitations.get('/', async (c) => {
  const who = await authorize(c, 'invitation.read');
  if (isFailure(who)) return c.json({ error: who.error }, who.status);

  const db = drizzle(c.env.DB, { schema });
  // Pending only: accepted, rejected and cancelled invitations are finished. An expired one is still
  // pending in the table and is shown as expired, so an admin can see it and cancel it.
  const rows = await db
    .select({
      id: schema.invitation.id,
      email: schema.invitation.email,
      role: schema.invitation.role,
      createdAt: schema.invitation.createdAt,
      expiresAt: schema.invitation.expiresAt,
    })
    .from(schema.invitation)
    .where(and(eq(schema.invitation.organizationId, who.orgId), eq(schema.invitation.status, 'pending')))
    .orderBy(desc(schema.invitation.createdAt), schema.invitation.id)
    .limit(PENDING_LIST_LIMIT + 1);

  const now = Date.now();
  return c.json(
    {
      organizationId: who.orgId,
      invitations: rows.slice(0, PENDING_LIST_LIMIT).map((r) => ({
        id: r.id,
        email: r.email,
        // Only the two roles the product has; anything else is shown as no recorded role.
        role: r.role === 'admin' || r.role === 'member' ? r.role : null,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        expired: r.expiresAt.getTime() <= now,
      })),
      truncated: rows.length > PENDING_LIST_LIMIT,
    },
    200,
    { 'cache-control': 'no-store' },
  );
});

/** CSRF defence (F23), repeated here as in `sessions.ts`: a cross-site page cannot cancel an invitation. */
function originRejected(c: Context<{ Bindings: Bindings }>): Response | null {
  const origin = c.req.header('origin');
  return !origin || origin !== new URL(c.env.APP_ORIGIN).origin ? c.json({ error: 'Forbidden' }, 403) : null;
}

invitations.post('/:id/cancel', async (c) => {
  const refused = originRejected(c);
  if (refused) return refused;
  const who = await authorize(c, 'invitation.cancel');
  if (isFailure(who)) return c.json({ error: who.error }, who.status);

  const limit = await hit(c.env.DB, `invitation-cancel:${who.userId}`, CANCELS_PER_MINUTE, 60_000);
  if (limit.limited)
    return c.json({ error: 'Too many requests; try again shortly' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    });

  const invitationId = c.req.param('id');
  const db = c.env.DB;
  const origin = requestOrigin(c.req.raw.headers);
  // Scoped to the resolved workspace. An id that belongs to another workspace, and one that does not
  // exist, look the same here: the answer is the same 404 and nothing of the other workspace is read.
  const found = await db
    .prepare('SELECT role FROM invitation WHERE id=?1 AND organization_id=?2')
    .bind(invitationId, who.orgId)
    .first<{ role: string | null }>();
  if (!found) {
    // The refusal is written into THIS workspace's log only, with no id: an admin here can see that a
    // request named an invitation this workspace does not hold, and nothing about where it is.
    await recordDenial(db, {
      organizationId: who.orgId,
      actorId: who.userId,
      action: 'access.denied',
      subjectType: 'invitation',
      subjectId: null,
      outcome: 'denied',
      metadata: { reason: 'not_in_workspace' },
      ...origin,
    });
    return c.json({ error: 'Not found' }, 404);
  }

  const role = found.role === 'admin' || found.role === 'member' ? found.role : undefined;
  // The status guard makes a second cancel, or a cancel of an accepted invitation, change nothing.
  const update = db
    .prepare(
      "UPDATE invitation SET status='canceled' WHERE id=?1 AND organization_id=?2 AND status='pending'",
    )
    .bind(invitationId, who.orgId);
  // The audit row is written only if the update above changed a row (`changes()` in the same batch).
  const audit = auditStatement(
    db,
    {
      organizationId: who.orgId,
      actorId: who.userId,
      action: 'member.invite.cancel',
      subjectType: 'invitation',
      subjectId: invitationId,
      outcome: 'success',
      metadata: role ? { role } : {},
      ...origin,
    },
    undefined,
    { onlyIfPreviousStatementChangedRows: true },
  );
  const [changed] = await db.batch([update, audit]);
  if (!changed || changed.meta.changes !== 1) return c.json({ error: 'Not found' }, 404);

  return c.json({ cancelled: true, id: invitationId }, 200, { 'cache-control': 'no-store' });
});

export default invitations;
