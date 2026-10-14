import { Hono } from 'hono';
import type { Bindings } from '../env';
import { gate } from './integrations';
import { sqlTimeToIso } from './delivery-view';
import { hit } from '../security/rate-limit';
import { githubAppConfig } from '../connectors/sources/github/app-config';

/**
 * `GET /api/setup/progress`, version 2 (ADR 0025, spec 14 F207/F216; supersedes the four-step
 * model of ADR 0018).
 *
 * The seven steps of the spec, each with a state the server derives from rows that exist for the
 * resolved workspace. Nothing is estimated and nothing is stored, so a refresh, a second device
 * or a shared link all show the same thing; the browser keeps no step state.
 *
 * States: `done` (evidence exists), `doing` (the one step to work on now), `todo` (waiting for an
 * earlier step), `blocked` (cannot proceed, with a closed `blockedBy` reason), `skipped` (an
 * optional or inapplicable step that needs nothing).
 *
 *  - `workspace_created`: always done; the request resolved a workspace.
 *  - `github_connected`: an ACTIVE GitHub App installation. `skipped` when there is none but the
 *    workspace has another enabled source; `blocked` when this server has no GitHub App.
 *  - `repositories_selected`, `destination_connected`: an integration exists. An integration is
 *    created in one request, so these two flip together; the destination stays blocked while its
 *    saved credentials are quarantined.
 *  - `events_chosen` (optional): `done` when the integration uses events other than the quiet
 *    default, or has filters or noise settings; `skipped` while the defaults apply.
 *  - `test_delivered`: a `sent` delivery (confirmed) or an `accepted` one (the destination does
 *    not say more, as Teams) in the last 30 days to a usable integration, a test or a real event.
 *    `verification` says which.
 *  - `activated` (optional): at least one real (non-test) event reached the workspace.
 *
 * `complete` means every required step is `done` or `skipped`; `next` is the first step still
 * `todo`, `doing` or `blocked`. `resume` names where a returning person should land. Capability:
 * `delivery.read` (every member).
 */

export const VERIFIED_WINDOW_DAYS = 30;
const READS_PER_MINUTE = 120;
export const PROGRESS_VERSION = 2;

export const STEP_IDS = [
  'workspace_created',
  'github_connected',
  'repositories_selected',
  'destination_connected',
  'events_chosen',
  'test_delivered',
  'activated',
] as const;
export type SetupStepId = (typeof STEP_IDS)[number];

export type StepState = 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';

/** Why a step cannot proceed; the dashboard maps each to a sentence and a way out. */
export type BlockedReason =
  'github_app_not_configured' | 'github_not_connected' | 'credentials_quarantined' | 'integration_paused';

export type NextActionKey =
  | 'connect_github'
  | 'pick_repository'
  | 'choose_destination'
  | 'refine_events'
  | 'send_test'
  | 'repair_integration'
  | 'resume_integration'
  | 'trigger_real_event'
  | 'none';

/** Steps a workspace can finish without; they never keep `complete` false. */
const OPTIONAL: ReadonlySet<SetupStepId> = new Set(['events_chosen', 'activated']);

/** The quiet default of the create wizard (web/src/integrations/events.ts DEFAULT_EVENTS; a test keeps them equal). */
export const DEFAULT_EVENT_TYPES: readonly string[] = ['workflow_run.failure', 'workflow_run.timed_out'];

export interface SetupStep {
  readonly id: SetupStepId;
  readonly state: StepState;
  /** True only for `done`; kept so a simple client can count progress. */
  readonly done: boolean;
  readonly optional: boolean;
  /** `test_delivered` only: whether the destination confirmed the message or only accepted it. */
  readonly verification: 'confirmed' | 'accepted' | null;
  /** ISO instant of the earliest evidence, or null when there is none. */
  readonly since: string | null;
  /** What to do to finish this step; `none` once it is done or skipped. */
  readonly nextAction: NextActionKey;
  readonly blockedBy: BlockedReason | null;
}

export interface SetupResume {
  /** The step to open: the first one still to do, or the last when everything is finished. */
  readonly step: SetupStepId;
  /** The workspace's newest integration, which the test and events steps act on. */
  readonly integrationId: string | null;
  /** Changes whenever the resume point changes, so a client can tell a stale deep link. */
  readonly point: string;
}

export interface SetupProgress {
  readonly version: typeof PROGRESS_VERSION;
  readonly steps: readonly SetupStep[];
  /** Every required step is done or skipped. */
  readonly complete: boolean;
  /** The first step still todo, doing or blocked, or null. */
  readonly next: SetupStepId | null;
  readonly nextAction: NextActionKey;
  readonly resume: SetupResume;
}

export interface IntegrationEvidence {
  readonly id: string;
  readonly enabled: boolean;
  readonly quarantined: boolean;
  /** Events other than the default, filters, noise settings, or a generic source's own choice. */
  readonly customized: boolean;
}

/** Raw evidence: the earliest `YYYY-MM-DD HH:MM:SS` timestamp per step, or null. */
export interface SetupEvidence {
  readonly githubConfigured: boolean;
  readonly installation: string | null;
  readonly otherSource: string | null;
  /** Earliest integration creation, or null when there is none. */
  readonly integration: string | null;
  /** The newest integration, which later steps act on. */
  readonly focus: IntegrationEvidence | null;
  /** A `sent` delivery (the destination confirmed it) to a usable integration. */
  readonly verified: string | null;
  /** An `accepted` delivery (accepted, not confirmed) to a usable integration. */
  readonly verifiedAccepted: string | null;
  readonly firstEvent: string | null;
}

interface Draft {
  state: StepState;
  since: string | null;
  verification?: 'confirmed' | 'accepted';
  blockedBy?: BlockedReason;
}

const ACTION: Readonly<Record<SetupStepId, NextActionKey>> = {
  workspace_created: 'none',
  github_connected: 'connect_github',
  repositories_selected: 'pick_repository',
  destination_connected: 'choose_destination',
  events_chosen: 'refine_events',
  test_delivered: 'send_test',
  activated: 'trigger_real_event',
};

function repairAction(blockedBy: BlockedReason | undefined, fallback: NextActionKey): NextActionKey {
  if (blockedBy === 'credentials_quarantined') return 'repair_integration';
  if (blockedBy === 'integration_paused') return 'resume_integration';
  return fallback;
}

/** Pure derivation, so the table of cases is testable without a database. */
export function deriveProgress(evidence: SetupEvidence): SetupProgress {
  const iso = (at: string | null): string | null => (at === null ? null : (sqlTimeToIso(at) ?? at));
  const focus = evidence.focus;
  const hasIntegration = evidence.integration !== null;
  const draft: Record<SetupStepId, Draft> = {
    workspace_created: { state: 'done', since: null },
    github_connected: evidence.installation
      ? { state: 'done', since: iso(evidence.installation) }
      : evidence.otherSource !== null
        ? { state: 'skipped', since: null }
        : !evidence.githubConfigured
          ? { state: 'blocked', since: null, blockedBy: 'github_app_not_configured' }
          : { state: 'todo', since: null },
    repositories_selected: { state: 'todo', since: null },
    destination_connected: { state: 'todo', since: null },
    events_chosen: { state: 'todo', since: null },
    test_delivered: { state: 'todo', since: null },
    activated: evidence.firstEvent
      ? { state: 'done', since: iso(evidence.firstEvent) }
      : { state: 'todo', since: null },
  };
  if (hasIntegration) {
    const since = iso(evidence.integration);
    draft.repositories_selected = { state: 'done', since };
    draft.destination_connected = focus?.quarantined
      ? { state: 'blocked', since, blockedBy: 'credentials_quarantined' }
      : { state: 'done', since };
    draft.events_chosen = focus?.customized ? { state: 'done', since } : { state: 'skipped', since: null };
    if (evidence.verified !== null)
      draft.test_delivered = { state: 'done', since: iso(evidence.verified), verification: 'confirmed' };
    else if (evidence.verifiedAccepted !== null)
      draft.test_delivered = {
        state: 'done',
        since: iso(evidence.verifiedAccepted),
        verification: 'accepted',
      };
    else if (focus?.quarantined)
      draft.test_delivered = { state: 'blocked', since: null, blockedBy: 'credentials_quarantined' };
    else if (focus && !focus.enabled)
      draft.test_delivered = { state: 'blocked', since: null, blockedBy: 'integration_paused' };
  } else if (draft.github_connected.state === 'blocked') {
    draft.repositories_selected = { state: 'blocked', since: null, blockedBy: 'github_not_connected' };
  }
  const waiting = (id: SetupStepId): boolean => draft[id].state === 'todo' || draft[id].state === 'blocked';
  const next = STEP_IDS.find(waiting) ?? null;
  if (next !== null && draft[next].state === 'todo') draft[next] = { ...draft[next], state: 'doing' };
  const steps = STEP_IDS.map((id): SetupStep => {
    const d = draft[id];
    const finished = d.state === 'done' || d.state === 'skipped';
    return {
      id,
      state: d.state,
      done: d.state === 'done',
      optional: OPTIONAL.has(id),
      verification: d.verification ?? null,
      since: d.since,
      nextAction: finished ? 'none' : repairAction(d.blockedBy, ACTION[id]),
      blockedBy: d.blockedBy ?? null,
    };
  });
  const complete = steps.every((s) => s.optional || s.state === 'done' || s.state === 'skipped');
  const resumeStep: SetupStepId = next ?? 'activated';
  const integrationId = focus?.id ?? null;
  return {
    version: PROGRESS_VERSION,
    steps,
    complete,
    next,
    nextAction: steps.find((s) => s.id === next)?.nextAction ?? 'none',
    resume: {
      step: resumeStep,
      integrationId,
      point: `v${PROGRESS_VERSION}:${resumeStep}:${integrationId ?? '-'}`,
    },
  };
}

/**
 * Delivery evidence reads at most this many index rows, in index order, so a workspace's cost
 * does not grow with its ledger and a miss is as cheap as a hit. The consequence is stated, not
 * hidden: "verified" looks at the newest {EVIDENCE_ROWS} deliveries of the last 30 days, and "a real
 * event arrived" at the oldest {EVIDENCE_ROWS} of all time (it fails only if every one of those is
 * a test). One query answers both `sent` and `accepted`, preferring the confirmed one.
 */
export const EVIDENCE_ROWS = 500;

/** Stand-in for a row that predates `created_at`: it exists, so the step is done; when is unknown. */
const EPOCH = '1970-01-01 00:00:00';

/**
 * Each statement reads one index. The delivery queries name `deliveries_org_created` (INDEXED BY)
 * and take the first row in index order, so a missing migration fails loudly instead of scanning
 * a workspace's whole ledger, and cost does not grow with the number of deliveries.
 * ?1 organization · ?2 window start (or the epoch stand-in) · ?3 integration id (VERIFIED_SQL only).
 * Same-second integrations are ordered by rowid DESC, so the newest insert wins deterministically.
 */
export const INSTALLATION_SQL = `SELECT MIN(COALESCE(created_at, ?2)) AS t FROM github_installations WHERE organization_id=?1 AND status='active'`;
export const SOURCE_SQL = `SELECT MIN(COALESCE(created_at, ?2)) AS t FROM sources WHERE organization_id=?1 AND enabled=1`;
export const INTEGRATION_SQL = `SELECT MIN(COALESCE(created_at, updated_at, ?2)) AS t FROM integrations WHERE organization_id=?1`;
export const FOCUS_SQL = `SELECT id, event_types, filters_json, noise_json, source_id, enabled, credentials_quarantined_at AS quarantined_at
  FROM integrations WHERE organization_id=?1 ORDER BY COALESCE(created_at, updated_at, ?2) DESC, rowid DESC LIMIT 1`;
export const VERIFIED_SQL = `SELECT t, state FROM (
    SELECT d.created_at AS t, d.state AS state, d.integration_id AS integration_id
    FROM deliveries d INDEXED BY deliveries_org_created
    WHERE d.organization_id=?1 AND d.created_at>=?2
    ORDER BY d.created_at DESC LIMIT ${EVIDENCE_ROWS})
  WHERE integration_id=?3 AND state IN ('sent','accepted')
  ORDER BY (state='sent') DESC, t DESC LIMIT 1`;
export const FIRST_EVENT_SQL = `SELECT t FROM (
    SELECT COALESCE(d.created_at, ?2) AS t, d.is_test AS is_test
    FROM deliveries d INDEXED BY deliveries_org_created
    WHERE d.organization_id=?1 ORDER BY d.created_at LIMIT ${EVIDENCE_ROWS})
  WHERE is_test=0 LIMIT 1`;

export interface FocusRow {
  id: string;
  event_types: string;
  filters_json: string | null;
  noise_json: string | null;
  source_id: string | null;
  enabled: number;
  quarantined_at: string | null;
}

/** True when the integration departs from what the create wizard would have chosen on its own. */
export function isCustomized(row: FocusRow): boolean {
  if (row.source_id !== null || row.filters_json !== null || row.noise_json !== null) return true;
  let events: unknown;
  try {
    events = JSON.parse(row.event_types);
  } catch {
    return true;
  }
  if (!Array.isArray(events)) return true;
  const chosen = [...new Set(events.map(String))].sort();
  const quiet = [...DEFAULT_EVENT_TYPES].sort();
  return chosen.length !== quiet.length || chosen.some((e, i) => e !== quiet[i]);
}

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
  const [installation, otherSource, integration, firstEvent, focusRow] = await Promise.all([
    read(INSTALLATION_SQL, who.orgId, EPOCH),
    read(SOURCE_SQL, who.orgId, EPOCH),
    read(INTEGRATION_SQL, who.orgId, EPOCH),
    read(FIRST_EVENT_SQL, who.orgId, EPOCH),
    c.env.DB.prepare(FOCUS_SQL).bind(who.orgId, EPOCH).first<FocusRow>(),
  ]);
  // The test step belongs to the newest integration: an older one that works proves nothing about
  // the one being set up. A paused or quarantined integration cannot have verified anything.
  const usable = focusRow !== null && focusRow.enabled === 1 && focusRow.quarantined_at === null;
  const proof = usable
    ? await c.env.DB.prepare(VERIFIED_SQL)
        .bind(who.orgId, since, focusRow.id)
        .first<{ t: string; state: string }>()
    : null;
  const verified = proof?.state === 'sent' ? proof.t : null;
  const verifiedAccepted = proof?.state === 'accepted' ? proof.t : null;
  const focus: IntegrationEvidence | null = focusRow
    ? {
        id: focusRow.id,
        enabled: focusRow.enabled === 1,
        quarantined: focusRow.quarantined_at !== null,
        customized: isCustomized(focusRow),
      }
    : null;
  return c.json({
    organizationId: who.orgId,
    ...deriveProgress({
      githubConfigured: githubAppConfig(c.env) !== null,
      installation,
      otherSource,
      integration,
      focus,
      verified,
      verifiedAccepted,
      firstEvent,
    }),
    verifiedWindowDays: VERIFIED_WINDOW_DAYS,
  });
});

export default setup;
