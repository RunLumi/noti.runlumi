import { Hono } from 'hono';
import { authorize, isFailure } from '../auth/workspace';
import type { Bindings } from '../env';
import { currentCorrelationId } from '../platform/correlation';
import { log } from '../platform/log';
import { AUDIT_RETENTION, parseRetentionDays } from '../pipeline/retention';
import { hit } from '../security/rate-limit';
import {
  AUDIT_TOTAL_CAP,
  buildAuditCountQuery,
  buildAuditQuery,
  parseAuditFilters,
  toAuditView,
  type AuditRowRecord,
} from './audit-view';
import { encodeCursor } from './delivery-view';

/**
 * Audit log (docs/specs/02-identity-tenancy.md F28, F222): `GET /api/audit`, admin only
 * (`audit.read`), scoped to the resolved workspace and paged by (created_at, id), newest first.
 *
 * Filters: action, result, actor (a current member, or `system`), target (id and kind of the thing),
 * request id and a date range. The first page also carries `total` (counted up to a cap), so an admin
 * knows how many events a filter matches before paging.
 *
 * What a row carries is decided in `audit-view.ts`: allow-listed metadata only, the actor's
 * name only (never an email, never someone outside the workspace), and no IP address or
 * user agent. The route reads; it never changes the log.
 *
 * FAIL CLOSED (ADR 0028): this is evidence, so it is either complete and this workspace's or it is an
 * error. A failed query, a failed limiter write or a row that is not this workspace's answers 503 with
 * no events: never an empty list, never a partial page. The dashboard shows that as an error, not as
 * "no events".
 */
const WINDOW_MS = 60_000;
/** An admin paging through history; well above a person, well below a script. */
export const AUDIT_READS_PER_MINUTE = 120;

/** The most the first page waits for the count before answering without it. */
export const AUDIT_COUNT_BUDGET_MS = 1500;

class TenantMismatch extends Error {}

const audit = new Hono<{ Bindings: Bindings }>();

audit.get('/', async (c) => {
  const who = await authorize(c, 'audit.read');
  if (isFailure(who)) return c.json({ error: who.error }, who.status);
  const parsed = parseAuditFilters((name) => c.req.query(name));
  if (!parsed.ok) return c.json({ error: 'Validation failed', fields: parsed.fields }, 422);
  const filters = parsed.value;

  try {
    const limit = await hit(c.env.DB, `audit:read:${who.userId}`, AUDIT_READS_PER_MINUTE, WINDOW_MS);
    if (limit.limited)
      return c.json({ error: 'Too many requests; try again shortly' }, 429, {
        'retry-after': String(limit.retryAfterSeconds),
      });

    const query = buildAuditQuery(who.orgId, filters);
    const rows = await c.env.DB.prepare(query.sql)
      .bind(...query.values)
      .all<AuditRowRecord>();
    // Defence in depth: the query is already scoped, so a row of another workspace here means a
    // query or schema fault. Refuse the whole page rather than show it.
    if (rows.results.some((r) => r.organization_id !== who.orgId)) throw new TenantMismatch();
    const page = rows.results.slice(0, filters.limit);
    const events = page.map(toAuditView);
    const last = page.at(-1);

    // The total belongs to the filter, not the page: counted once, on the first page.
    let total: number | null = null;
    let totalCapped = false;
    let totalSince: string | null = null;
    if (!filters.cursor) {
      // The count is a convenience: the LIST never fails because of it. If it errors or overruns its
      // budget the page still answers, with `total: null` and `totalCapped: true` ("unknown, many").
      const count = buildAuditCountQuery(who.orgId, filters);
      totalSince = count.since;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const row = await Promise.race([
          c.env.DB.prepare(count.sql)
            .bind(...count.values)
            .first<{ n: number }>(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('count over budget')), AUDIT_COUNT_BUDGET_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (!row || typeof row.n !== 'number') throw new Error('count unavailable');
        total = Math.min(row.n, AUDIT_TOTAL_CAP);
        totalCapped = row.n > AUDIT_TOTAL_CAP;
      } catch {
        log('warn', 'audit_total_unavailable', {});
        total = null;
        totalCapped = true;
      }
    }
    return c.json(
      {
        organizationId: who.orgId,
        events,
        nextCursor:
          rows.results.length > filters.limit && last ? encodeCursor(last.created_at, last.id) : null,
        total,
        totalCapped,
        totalSince,
        retentionDays: parseRetentionDays(c.env.AUDIT_RETENTION_DAYS, AUDIT_RETENTION),
      },
      200,
      { 'cache-control': 'no-store' },
    );
  } catch (e) {
    // Category only: never the SQL, a row or a value.
    log('error', 'audit_read_failed', {
      code: e instanceof TenantMismatch ? 'tenant_mismatch' : 'read_failed',
    });
    return c.json(
      {
        error: 'The audit log could not be read. Nothing was changed. Try again shortly.',
        correlation_id: currentCorrelationId(),
      },
      503,
      { 'cache-control': 'no-store', 'retry-after': '5' },
    );
  }
});

export default audit;
