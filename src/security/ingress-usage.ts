/**
 * Ingress usage accounting (docs/specs/02-identity-tenancy.md F29, ADR 0028).
 *
 * How many inbound events a workspace sent us, per UTC day and per source kind: accepted,
 * duplicate, and answered with the flood limit. It is accounting and is kept APART from the abuse
 * limiter: `api_rate_limits` (src/security/rate-limit.ts) is pruned hourly, keyed by installation
 * or source, and its counts say nothing about usage (F29, F231). Nothing here reads or writes it
 * (`tests/security/ingress-usage.test.ts` pins that).
 *
 * Best effort, and honest about it. The write happens AFTER the event is durably accepted (or
 * refused), outside that transaction, so a failed write can only under-count and can never lose,
 * delay or change the answer to an event. A failure is logged as a counter name, nothing else.
 * It is not a billing meter and nothing may describe it as one.
 *
 * Tenant isolation: the workspace comes from the verified source row or installation, never from
 * the payload, and the row is keyed by it. Counts only: no payload, no event id, no actor.
 */
import { log } from '../platform/log';

export const INGRESS_USAGE_SOURCES = ['github', 'generic', 'gitlab', 'stripe'] as const;
export type IngressUsageSource = (typeof INGRESS_USAGE_SOURCES)[number];

/** Daily rows are kept this long (the retention job drops older ones). One year covers a yearly review. */
export const INGRESS_USAGE_RETENTION_DAYS = 400;

export interface IngressUsageDelta {
  readonly accepted?: number;
  readonly duplicate?: number;
  readonly rateLimited?: number;
}

type Db = Pick<D1Database, 'prepare'>;

/** The UTC day a time falls in, `YYYY-MM-DD`. */
export function usageDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** One UPSERT. Exported so a test can assert the statement shape and its tenant key. */
export const INGRESS_USAGE_SQL = `INSERT INTO ingress_usage(organization_id,day,source,events_accepted,events_duplicate,events_rate_limited,updated_at)
  VALUES(?1,?2,?3,?4,?5,?6,?7)
  ON CONFLICT(organization_id,day,source) DO UPDATE SET
    events_accepted=events_accepted+excluded.events_accepted,
    events_duplicate=events_duplicate+excluded.events_duplicate,
    events_rate_limited=events_rate_limited+excluded.events_rate_limited,
    updated_at=excluded.updated_at`;

/** Add to today's counters for this workspace and source. Never throws. */
export async function recordIngressUsage(
  db: Db,
  organizationId: string,
  source: IngressUsageSource,
  delta: IngressUsageDelta,
  nowMs: number = Date.now(),
): Promise<void> {
  const accepted = delta.accepted ?? 0;
  const duplicate = delta.duplicate ?? 0;
  const rateLimited = delta.rateLimited ?? 0;
  if (accepted + duplicate + rateLimited <= 0) return;
  try {
    await db
      .prepare(INGRESS_USAGE_SQL)
      .bind(organizationId, usageDay(nowMs), source, accepted, duplicate, rateLimited, nowMs)
      .run();
  } catch {
    log('warn', 'ingress_usage_write_failed', { source });
  }
}
