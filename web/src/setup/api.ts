import { ApiError, api } from '../lib/api';

/** `GET /api/setup/progress` (docs/API.md "Setup progress"): derived from real rows, never stored. */

export const STEP_IDS = [
  'source_connected',
  'integration_created',
  'destination_verified',
  'first_event_received',
] as const;
export type SetupStepId = (typeof STEP_IDS)[number];

export const NEXT_ACTIONS = [
  'connect_source',
  'create_integration',
  'send_test',
  'trigger_real_event',
  'none',
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface SetupStep {
  readonly id: SetupStepId;
  readonly done: boolean;
  readonly since: string | null;
  readonly nextAction: NextAction;
}

export interface SetupProgress {
  readonly steps: readonly SetupStep[];
  readonly complete: boolean;
  readonly next: SetupStepId | null;
  readonly verifiedWindowDays: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStepId = (v: unknown): v is SetupStepId => STEP_IDS.some((s) => s === v);
const isAction = (v: unknown): v is NextAction => NEXT_ACTIONS.some((a) => a === v);

function parseStep(value: unknown): SetupStep {
  if (
    !isRecord(value) ||
    !isStepId(value.id) ||
    typeof value.done !== 'boolean' ||
    !(value.since === null || typeof value.since === 'string') ||
    !isAction(value.nextAction)
  )
    throw new ApiError('Unexpected response', 500);
  return { id: value.id, done: value.done, since: value.since, nextAction: value.nextAction };
}

export function parseProgress(body: unknown): SetupProgress {
  if (!isRecord(body) || !Array.isArray(body.steps) || typeof body.complete !== 'boolean')
    throw new ApiError('Unexpected response', 500);
  return {
    steps: body.steps.map(parseStep),
    complete: body.complete,
    next: isStepId(body.next) ? body.next : null,
    verifiedWindowDays: typeof body.verifiedWindowDays === 'number' ? body.verifiedWindowDays : 30,
  };
}

export const setupApi = {
  progress: async (orgId: string): Promise<SetupProgress> =>
    parseProgress(await api<unknown>(`/api/setup/progress?org=${encodeURIComponent(orgId)}`)),
};
