import { ApiError, api } from '../lib/api';

/**
 * `GET /api/setup/progress`, version 2 (docs/API.md "Setup progress", ADR 0025): seven steps with
 * a state each, derived from real rows and never stored. The browser keeps no step state; it asks
 * this endpoint on every page of `/setup` and after every action that could change the answer.
 */

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

export const STEP_STATES = ['todo', 'doing', 'done', 'blocked', 'skipped'] as const;
export type StepState = (typeof STEP_STATES)[number];

export const BLOCKED_REASONS = [
  'github_app_not_configured',
  'github_not_connected',
  'credentials_quarantined',
  'integration_paused',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const NEXT_ACTIONS = [
  'connect_github',
  'pick_repository',
  'choose_destination',
  'refine_events',
  'send_test',
  'repair_integration',
  'resume_integration',
  'trigger_real_event',
  'none',
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface SetupStep {
  readonly id: SetupStepId;
  readonly state: StepState;
  readonly done: boolean;
  readonly optional: boolean;
  /** `test_delivered` only: the destination confirmed the message, or only accepted it. */
  readonly verification: 'confirmed' | 'accepted' | null;
  readonly since: string | null;
  readonly nextAction: NextAction;
  readonly blockedBy: BlockedReason | null;
}

export interface SetupResume {
  readonly step: SetupStepId;
  readonly integrationId: string | null;
  readonly point: string;
}

export interface SetupProgress {
  readonly steps: readonly SetupStep[];
  /** Every required step is done or skipped. */
  readonly complete: boolean;
  readonly next: SetupStepId | null;
  readonly nextAction: NextAction;
  readonly resume: SetupResume;
  readonly verifiedWindowDays: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): v is T =>
    list.some((x) => x === v);
const isStepId = oneOf(STEP_IDS);
const isState = oneOf(STEP_STATES);
const isReason = oneOf(BLOCKED_REASONS);
const isAction = oneOf(NEXT_ACTIONS);
const unexpected = () => new ApiError('Unexpected response', 500);

function parseStep(value: unknown): SetupStep {
  if (
    !isRecord(value) ||
    !isStepId(value.id) ||
    !isState(value.state) ||
    typeof value.done !== 'boolean' ||
    typeof value.optional !== 'boolean' ||
    !(value.since === null || typeof value.since === 'string') ||
    !isAction(value.nextAction)
  )
    throw unexpected();
  return {
    id: value.id,
    state: value.state,
    done: value.done,
    optional: value.optional,
    verification:
      value.verification === 'confirmed' || value.verification === 'accepted' ? value.verification : null,
    since: value.since,
    nextAction: value.nextAction,
    blockedBy: isReason(value.blockedBy) ? value.blockedBy : null,
  };
}

export function parseProgress(body: unknown): SetupProgress {
  if (
    !isRecord(body) ||
    body.version !== 2 ||
    !Array.isArray(body.steps) ||
    typeof body.complete !== 'boolean' ||
    !isRecord(body.resume) ||
    !isStepId(body.resume.step) ||
    typeof body.resume.point !== 'string'
  )
    throw unexpected();
  return {
    steps: body.steps.map(parseStep),
    complete: body.complete,
    next: isStepId(body.next) ? body.next : null,
    nextAction: isAction(body.nextAction) ? body.nextAction : 'none',
    resume: {
      step: body.resume.step,
      integrationId: typeof body.resume.integrationId === 'string' ? body.resume.integrationId : null,
      point: body.resume.point,
    },
    verifiedWindowDays: typeof body.verifiedWindowDays === 'number' ? body.verifiedWindowDays : 30,
  };
}

export const stepOf = (progress: SetupProgress, id: SetupStepId): SetupStep | undefined =>
  progress.steps.find((s) => s.id === id);

export const setupApi = {
  progress: async (orgId: string): Promise<SetupProgress> =>
    parseProgress(await api<unknown>(`/api/setup/progress?org=${encodeURIComponent(orgId)}`)),
};
