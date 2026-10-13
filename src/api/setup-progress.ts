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

export type StepStatus = 'done' | 'accepted' | 'todo';

export interface SetupStep {
  readonly id: SetupStepId;
  /** True only for `status: 'done'`. */
  readonly done: boolean;
  /**
   * `accepted` is for `destination_verified` only: the destination accepted a message (Teams
   * Workflows, or a Discord 204) but never confirmed it was shown. It is reported as what it is.
   */
  readonly status: StepStatus;
  /** ISO instant of the earliest evidence, or null when there is none. */
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
  /** A `sent` delivery (the destination confirmed it) to a usable integration. */
  readonly verified: string | null;
  /** An `accepted` delivery (accepted, not confirmed) to a usable integration. */
  readonly verifiedAccepted: string | null;
  readonly firstEvent: string | null;
}

/**
 * Pure derivation, so the table of cases is testable without a database. `complete` means no
 * step is still `todo`: an `accepted`-only destination does not keep the card on screen forever
 * (a Teams-only workspace could never do better), but the step is reported as `accepted`.
 */
export function deriveProgress(evidence: SetupEvidence): SetupProgress {
  const iso = (at: string): string => sqlTimeToIso(at) ?? at;
  const steps = STEP_IDS.map((id): SetupStep => {
    const at: Record<SetupStepId, string | null> = {
      source_connected: evidence.source,
      integration_created: evidence.integration,
      destination_verified: evidence.verified,
      first_event_received: evidence.firstEvent,
    };
    const own = at[id];
    if (own !== null) return { id, done: true, status: 'done', since: iso(own), nextAction: 'none' };
    if (id === 'destination_verified' && evidence.verifiedAccepted !== null)
      return {
        id,
        done: false,
        status: 'accepted',
        since: iso(evidence.verifiedAccepted),
        nextAction: NEXT_ACTION[id],
      };
    return { id, done: false, status: 'todo', since: null, nextAction: NEXT_ACTION[id] };
  });
  const next = steps.find((s) => s.status === 'todo')?.id ?? null;
  return { steps, complete: next === null, next };
}

/** Stand-in for a row that predates `created_at`: it exists, so the step is done; when is unknown. */
const EPOCH = '1970-01-01 00:00:00';

/**
 * Each statement reads one index. The delivery queries name `deliveries_org_created` (INDEXED BY)
 * and take the first row in index order, so a missing migration fails loudly instead of scanning
 * a workspace's whole ledger, and cost does not grow with the number of deliveries.
 * ?1 organization · ?2 window start (or the epoch stand-in) · ?3 state.
 */
export const SOURCE_SQL = `SELECT MIN(t) AS t FROM (
  SELECT MIN(COALESCE(created_at, ?2)) AS t FROM github_installations WHERE organization_id=?1 AND status='active'
  UNION ALL
  SELECT MIN(COALESCE(created_at, ?2)) FROM sources WHERE organization_id=?1 AND enabled=1)`;
export const INTEGRATION_SQL = `SELECT MIN(COALESCE(created_at, updated_at, ?2)) AS t FROM integrations WHERE organization_id=?1`;
export const VERIFIED_SQL = `SELECT d.created_at AS t FROM deliveries d INDEXED BY deliveries_org_created
  WHERE d.organization_id=?1 AND d.created_at>=?2 AND d.state=?3
    AND EXISTS (SELECT 1 FROM integrations i
                WHERE i.id=d.integration_id AND i.organization_id=d.organization_id
                  AND i.enabled=1 AND i.credentials_quarantined_at IS NULL)
  ORDER BY d.created_at LIMIT 1`;
export const FIRST_EVENT_SQL = `SELECT COALESCE(d.created_at, ?2) AS t FROM deliveries d INDEXED BY deliveries_org_created
  WHERE d.organization_id=?1 AND d.is_test=0 ORDER BY d.created_at LIMIT 1`;

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
  const read = async (sql: string, ...args: (string | number)[]): Promise<string | null> =>
    (
      await c.env.DB.prepare(sql)
        .bind(...args)
        .first<{ t: string | null }>()
    )?.t ?? null;
  const [source, integration, verified, verifiedAccepted, firstEvent] = await Promise.all([
    read(SOURCE_SQL, who.orgId, EPOCH),
    read(INTEGRATION_SQL, who.orgId, EPOCH),
    read(VERIFIED_SQL, who.orgId, since, 'sent'),
    read(VERIFIED_SQL, who.orgId, since, 'accepted'),
    read(FIRST_EVENT_SQL, who.orgId, EPOCH),
  ]);
  return c.json({
    organizationId: who.orgId,
    ...deriveProgress({ source, integration, verified, verifiedAccepted, firstEvent }),
    verifiedWindowDays: VERIFIED_WINDOW_DAYS,
  });
});

export default setup;
