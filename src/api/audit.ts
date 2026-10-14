import { Hono } from 'hono';
import { authorize, isFailure } from '../auth/workspace';
import type { Bindings } from '../env';
import { AUDIT_RETENTION, parseRetentionDays } from '../pipeline/retention';
import { hit } from '../security/rate-limit';
import { buildAuditQuery, parseAuditFilters, toAuditView, type AuditRowRecord } from './audit-view';
import { encodeCursor } from './delivery-view';

/**
 * Audit log (docs/specs/02-identity-tenancy.md F28): `GET /api/audit`, admin only
 * (`audit.read`), scoped to the resolved workspace and paged by (created_at, id), newest first.
 *
 * What a row carries is decided in `audit-view.ts`: allow-listed metadata only, the actor's
 * name only (never an email, never someone outside the workspace), and no IP address or
 * user agent. The route reads; it never changes the log.
 */
const WINDOW_MS = 60_000;
/** An admin paging through history; well above a person, well below a script. */
export const AUDIT_READS_PER_MINUTE = 120;

const audit = new Hono<{ Bindings: Bindings }>();

audit.get('/', async (c) => {
  const who = await authorize(c, 'audit.read');
  if (isFailure(who)) return c.json({ error: who.error }, who.status);
  const limit = await hit(c.env.DB, `audit:read:${who.userId}`, AUDIT_READS_PER_MINUTE, WINDOW_MS);
  if (limit.limited)
    return c.json({ error: 'Too many requests; try again shortly' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    });
  const parsed = parseAuditFilters((name) => c.req.query(name));
  if (!parsed.ok) return c.json({ error: 'Validation failed', fields: parsed.fields }, 422);

  const query = buildAuditQuery(who.orgId, parsed.value);
  const rows = await c.env.DB.prepare(query.sql)
    .bind(...query.values)
    .all<AuditRowRecord>();
  const page = rows.results.slice(0, parsed.value.limit);
  const last = page.at(-1);
  return c.json(
    {
      organizationId: who.orgId,
      events: page.map(toAuditView),
      nextCursor:
        rows.results.length > parsed.value.limit && last ? encodeCursor(last.created_at, last.id) : null,
      retentionDays: parseRetentionDays(c.env.AUDIT_RETENTION_DAYS, AUDIT_RETENTION),
    },
    200,
    { 'cache-control': 'no-store' },
  );
});

export default audit;
