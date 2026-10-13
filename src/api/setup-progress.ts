import { Hono } from 'hono';
import type { Bindings } from '../env';
import { gate } from './integrations';
import { sqlTimeToIso } from './delivery-view';
import { hit } from '../security/rate-limit';

/**
 * `GET /api/setup/progress` — an honest "am I done?" checklist (ADR 0018, spec 14 F206–F214).
 *
 * Every step is derived from rows that exist for the resolved workspace; nothing is estimated
 * and nothing is stored. A step is `done` only when the evidence is there, and `since` is the
 * earliest such row, so the dashboard can say when, not just whether.
 *
 *  - `source_connected`: an ACTIVE GitHub App installation, or any generic/GitLab/Stripe source.
 *  - `integration_created`: at least one integration.
 *  - `destination_verified`: at least one delivery in `sent` or `accepted` within the last 30 days,
 *    from a test OR a real event. `accepted` (Teams) counts: it is the strongest signal that
 *    destination can give, and the dashboard says so.
 *  - `first_event_received`: at least one delivery that is NOT a test, in any state. A held or
 *    failed real event still proves the source reached us.
 *
 * `nextAction` is a closed key the dashboard maps to a route and copy; the first step that is
 * not done is the workspace's `next`. Capability: `delivery.read` (every member).
 */

export const VERIFIED_WINDOW_DAYS = 30;
const READS_PER_MINUTE = 120;

export const STEP_IDS = [
  'source_connected',
  'integration_created',
  'destination_verified',
  'first_event_received',
] as const;
export type SetupStepId = (typeof STEP_IDS)[number];

export type NextActionKey =
  'connect_source' | 'create_integration' | 'send_test' | 'trigger_real_event' | 'none';

const NEXT_ACTION: Readonly<Record<SetupStepId, NextActionKey>> = {
  source_connected: 'connect_source',
  integration_created: 'create_integration',
  destination_verified: 'send_test',
  first_event_received: 'trigger_real_event',
};

export interface SetupStep {
  readonly id: SetupStepId;
  readonly done: boolean;
  /** ISO instant of the earliest evidence, or null when not done. */
  readonly since: string | null;
  /** What to do to finish this step; `none` once it is done. */
  readonly nextAction: NextActionKey;
}

export interface SetupProgress {
  readonly steps: readonly SetupStep[];
  readonly complete: boolean;
  /** The first step not done, or null. */
  readonly next: SetupStepId | null;
}

/** Raw evidence: the earliest `YYYY-MM-DD HH:MM:SS` timestamp per step, or null. */
export interface SetupEvidence {
  readonly source: string | null;
  readonly integration: string | null;
  readonly verified: string | null;
  readonly firstEvent: string | null;
}

/** Pure derivation, so the table of cases is testable without a database. */
export function deriveProgress(evidence: SetupEvidence): SetupProgress {
  const at: Record<SetupStepId, string | null> = {
    source_connected: evidence.source,
    integration_created: evidence.integration,
    destination_verified: evidence.verified,
    first_event_received: evidence.firstEvent,
  };
  const steps = STEP_IDS.map((id): SetupStep => {
    const done = at[id] !== null;
    return {
      id,
      done,
      since: done ? (sqlTimeToIso(at[id]) ?? at[id]) : null,
      nextAction: done ? 'none' : NEXT_ACTION[id],
    };
  });
  const next = steps.find((s) => !s.done)?.id ?? null;
  return { steps, complete: next === null, next };
}

/** Stand-in for a row that predates `created_at`: it exists, so the step is done; when is unknown. */
const EPOCH = '1970-01-01 00:00:00';

const EVIDENCE_SQL = `SELECT
  (SELECT MIN(t) FROM (
     SELECT MIN(COALESCE(created_at, ?3)) AS t FROM github_installations WHERE organization_id=?1 AND status='active'
     UNION ALL
     SELECT MIN(COALESCE(created_at, ?3)) FROM sources WHERE organization_id=?1)) AS source,
  (SELECT MIN(COALESCE(created_at, updated_at, ?3)) FROM integrations WHERE organization_id=?1) AS integration,
  (SELECT MIN(COALESCE(created_at, updated_at)) FROM deliveries
     WHERE organization_id=?1 AND state IN ('sent','accepted') AND COALESCE(created_at, updated_at) >= ?2) AS verified,
  (SELECT MIN(COALESCE(created_at, updated_at, ?3)) FROM deliveries
     WHERE organization_id=?1 AND is_test=0) AS firstEvent`;

const setup = new Hono<{ Bindings: Bindings }>();

setup.get('/progress', async (c) => {
  const who = await gate(c, 'delivery.read');
  if (who instanceof Response) return who;
  const limit = await hit(c.env.DB, `setup:read:${who.userId}`, READS_PER_MINUTE, 60_000);
  if (limit.limited)
    return c.json({ error: 'Too many requests; try again shortly' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    });
  const since = new Date(Date.now() - VERIFIED_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const row = await c.env.DB.prepare(EVIDENCE_SQL).bind(who.orgId, since, EPOCH).first<{
    source: string | null;
    integration: string | null;
    verified: string | null;
    firstEvent: string | null;
  }>();
  return c.json({
    organizationId: who.orgId,
    ...deriveProgress({
      source: row?.source ?? null,
      integration: row?.integration ?? null,
      verified: row?.verified ?? null,
      firstEvent: row?.firstEvent ?? null,
    }),
    verifiedWindowDays: VERIFIED_WINDOW_DAYS,
  });
});

export default setup;
