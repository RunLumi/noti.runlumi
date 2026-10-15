import { ApiError, api, isDestinationKind, type DestinationKind } from '../lib/api';

/** Delivery log client (docs/API.md "Deliveries"). The server never returns payloads or URLs. */

export const DELIVERY_STATES = [
  'pending',
  'claimed',
  'sent',
  'accepted',
  'retrying',
  'dead_lettered',
  'suppressed',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export interface DeliveryError {
  readonly code: string;
  /** Message id chosen by the server (F220); `null` when the code has no user copy. */
  readonly messageKey: string | null;
  readonly retryable: boolean;
  readonly userActionable: boolean;
}

export type IntegrationStatus = 'available' | 'missing' | 'disabled' | 'quarantined' | 'revoked';

export function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  return (
    value === 'available' ||
    value === 'missing' ||
    value === 'disabled' ||
    value === 'quarantined' ||
    value === 'revoked'
  );
}

export interface DeliveryItem {
  readonly id: string;
  readonly integration: {
    readonly id: string;
    readonly name: string;
    readonly repo: string | null;
    readonly destination: DestinationKind | null;
    readonly destinationHost: string | null;
    /** Fingerprint of the integration's CURRENT webhook URL (F39); null when none. */
    readonly credentialFingerprint: string | null;
  };
  readonly integrationExists: boolean;
  /** Why a redelivery would not be delivered, or `available`. */
  readonly integrationStatus: IntegrationStatus;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly error: DeliveryError | null;
  readonly createdAt: string | null;
  readonly updatedAt: string;
  readonly nextAttemptAt: string | null;
  readonly replayOf: string | null;
  /** A user-requested test notification (ADR 0018), not a real event. */
  readonly isTest: boolean;
  readonly latestReplayState: DeliveryState | null;
  readonly canReplay: boolean;
  /** An earlier attempt got no clear answer and the send was retried: the destination MAY have it twice. */
  readonly possibleDuplicate?: boolean;
  /** A detected repeat that was not sent again, and the delivery it repeats. */
  readonly suppression?: {
    readonly reason: 'duplicate' | 'claim_conflict' | 'provider_idempotency';
    readonly duplicateOf: string | null;
    /** State of the delivery this repeats; `dead_lettered` means the original failed. */
    readonly originalState: DeliveryState | null;
  } | null;
  /** Why a waiting delivery has not been sent although nothing failed this time. */
  readonly pausedReason?: 'circuit_open' | 'destination_paced' | null;
}

export interface DeliveryPage {
  readonly deliveries: readonly DeliveryItem[];
  readonly nextCursor: string | null;
}

export interface TimelineEntry {
  readonly kind: 'created' | 'first_attempt' | 'last_attempt' | 'next_attempt' | 'dead_lettered';
  readonly at: string;
}

export const ATTEMPT_OUTCOMES = [
  'delivered',
  'accepted',
  'retry_scheduled',
  'dead_lettered',
  'deferred',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'timeout', 'network', 'none'] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

/** One try (or one wait). Codes and classes only: the server never sends what the destination said. */
export interface AttemptItem {
  readonly attempt: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: AttemptOutcome;
  readonly error: DeliveryError | null;
  /** A code Noti minted (`provider_http_503`, `circuit_open`); null where hidden. */
  readonly detail: string | null;
  readonly statusClass: StatusClass;
  readonly retryAfterSeconds: number | null;
  readonly possibleDuplicate: boolean;
  /** For a wait: further identical waits folded into this row. */
  readonly repeatCount: number;
}

export interface DeliveryDetail {
  readonly delivery: DeliveryItem;
  readonly timeline: readonly TimelineEntry[];
  /** `full` once per-attempt rows exist; `summary` for a delivery from before they were kept. */
  readonly attemptDetail: 'full' | 'summary';
  readonly attempts: readonly AttemptItem[];
  readonly replays: readonly {
    readonly id: string;
    readonly state: DeliveryState;
    readonly createdAt: string | null;
  }[];
}

export type DeliverySummary = Readonly<Record<DeliveryState, number>>;

export interface DeliveryFilters {
  readonly state?: DeliveryState;
  readonly integrationId?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface BulkPlan {
  /** Deliveries a run would send again now: at most `bound`. */
  readonly eligible: number;
  readonly total: number;
  readonly totalCapped: boolean;
  readonly remaining: number;
  readonly bound: number;
  /** Binds the exact set the person saw; the run refuses if it changed. */
  readonly token: string;
  readonly typedConfirmationAbove: number;
}

export interface BulkResult {
  readonly requested: number;
  readonly replayed: number;
  readonly alreadyInFlight: number;
  readonly refused: number;
  readonly remaining: number;
}

export interface BulkScope {
  readonly integrationId?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface ReplayResult {
  readonly deliveryId: string;
  readonly replayOf: string;
  /** False when an earlier redelivery of the same delivery was returned instead. */
  readonly created: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDeliveryState(value: unknown): value is DeliveryState {
  return DELIVERY_STATES.some((s) => s === value);
}

const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
const bad = (what: string) => new ApiError(`Unexpected ${what} shape`, 500);

function parseError(value: unknown): DeliveryError | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.code !== 'string' ||
    !nullableString(value.messageKey) ||
    typeof value.retryable !== 'boolean' ||
    typeof value.userActionable !== 'boolean'
  )
    throw bad('delivery error');
  return {
    code: value.code,
    messageKey: value.messageKey,
    retryable: value.retryable,
    userActionable: value.userActionable,
  };
}

/** Narrow one row. A malformed row is an error, never silently dropped (F225). */
export function parseDelivery(value: unknown): DeliveryItem {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isRecord(value.integration) ||
    typeof value.integration.id !== 'string' ||
    typeof value.integration.name !== 'string' ||
    typeof value.integrationExists !== 'boolean' ||
    !isIntegrationStatus(value.integrationStatus) ||
    !isDeliveryState(value.state) ||
    typeof value.attempts !== 'number' ||
    !nullableString(value.createdAt) ||
    typeof value.updatedAt !== 'string' ||
    !nullableString(value.nextAttemptAt) ||
    !nullableString(value.replayOf) ||
    (value.latestReplayState !== null && !isDeliveryState(value.latestReplayState)) ||
    typeof value.canReplay !== 'boolean'
  )
    throw bad('delivery');
  const integration = value.integration;
  const destination = isDestinationKind(integration.destination) ? integration.destination : null;
  return {
    id: value.id,
    integration: {
      id: String(integration.id),
      name: String(integration.name),
      repo: typeof integration.repo === 'string' ? integration.repo : null,
      destination,
      destinationHost: typeof integration.destinationHost === 'string' ? integration.destinationHost : null,
      credentialFingerprint:
        typeof integration.credentialFingerprint === 'string' ? integration.credentialFingerprint : null,
    },
    integrationExists: value.integrationExists,
    integrationStatus: value.integrationStatus,
    state: value.state,
    attempts: value.attempts,
    error: parseError(value.error ?? null),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextAttemptAt: value.nextAttemptAt,
    replayOf: value.replayOf,
    isTest: value.isTest === true,
    latestReplayState: value.latestReplayState,
    canReplay: value.canReplay,
    possibleDuplicate: value.possibleDuplicate === true,
    suppression: parseSuppression(value.suppression),
    pausedReason:
      value.pausedReason === 'circuit_open' || value.pausedReason === 'destination_paced'
        ? value.pausedReason
        : null,
  };
}

function parseSuppression(value: unknown): DeliveryItem['suppression'] {
  if (!isRecord(value)) return null;
  const reason = value.reason;
  if (reason !== 'duplicate' && reason !== 'claim_conflict' && reason !== 'provider_idempotency') return null;
  return {
    reason,
    duplicateOf: typeof value.duplicateOf === 'string' ? value.duplicateOf : null,
    originalState: isDeliveryState(value.originalState) ? value.originalState : null,
  };
}

/** An attempt we cannot read is dropped from the list rather than failing the whole dialog. */
function parseAttempt(value: unknown): AttemptItem[] {
  if (
    !isRecord(value) ||
    typeof value.attempt !== 'number' ||
    typeof value.startedAt !== 'string' ||
    typeof value.durationMs !== 'number' ||
    !ATTEMPT_OUTCOMES.some((o) => o === value.outcome) ||
    !STATUS_CLASSES.some((c) => c === value.statusClass)
  )
    return [];
  return [
    {
      attempt: value.attempt,
      startedAt: value.startedAt,
      durationMs: value.durationMs,
      outcome: value.outcome as AttemptOutcome,
      error: value.error === null || value.error === undefined ? null : safeError(value.error),
      detail: typeof value.detail === 'string' ? value.detail : null,
      statusClass: value.statusClass as StatusClass,
      retryAfterSeconds: typeof value.retryAfterSeconds === 'number' ? value.retryAfterSeconds : null,
      possibleDuplicate: value.possibleDuplicate === true,
      repeatCount: typeof value.repeatCount === 'number' ? value.repeatCount : 0,
    },
  ];
}

function safeError(value: unknown): DeliveryError | null {
  try {
    return parseError(value);
  } catch {
    return null;
  }
}

function parsePlan(body: unknown): BulkPlan {
  const plan = isRecord(body) ? body.plan : null;
  if (
    !isRecord(plan) ||
    typeof plan.eligible !== 'number' ||
    typeof plan.total !== 'number' ||
    typeof plan.totalCapped !== 'boolean' ||
    typeof plan.remaining !== 'number' ||
    typeof plan.bound !== 'number' ||
    typeof plan.token !== 'string' ||
    typeof plan.typedConfirmationAbove !== 'number'
  )
    throw bad('replay plan');
  return {
    eligible: plan.eligible,
    total: plan.total,
    totalCapped: plan.totalCapped,
    remaining: plan.remaining,
    bound: plan.bound,
    token: plan.token,
    typedConfirmationAbove: plan.typedConfirmationAbove,
  };
}

function parseBulkResult(body: unknown): BulkResult {
  const r = isRecord(body) ? body.result : null;
  if (
    !isRecord(r) ||
    typeof r.requested !== 'number' ||
    typeof r.replayed !== 'number' ||
    typeof r.alreadyInFlight !== 'number' ||
    typeof r.refused !== 'number' ||
    typeof r.remaining !== 'number'
  )
    throw bad('bulk replay result');
  return {
    requested: r.requested,
    replayed: r.replayed,
    alreadyInFlight: r.alreadyInFlight,
    refused: r.refused,
    remaining: r.remaining,
  };
}

function query(orgId: string, filters: DeliveryFilters, cursor: string | null): string {
  const params = new URLSearchParams({ org: orgId });
  if (filters.state) params.set('state', filters.state);
  if (filters.integrationId) params.set('integrationId', filters.integrationId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

const item = (id: string) => `/api/deliveries/${encodeURIComponent(id)}`;
const withOrg = (path: string, orgId: string) => `${path}?org=${encodeURIComponent(orgId)}`;

export const deliveriesApi = {
  list: async (orgId: string, filters: DeliveryFilters, cursor: string | null): Promise<DeliveryPage> => {
    const body = await api<unknown>(`/api/deliveries?${query(orgId, filters, cursor)}`);
    if (!isRecord(body) || !Array.isArray(body.deliveries) || !nullableString(body.nextCursor))
      throw bad('delivery list');
    return { deliveries: body.deliveries.map(parseDelivery), nextCursor: body.nextCursor };
  },
  get: async (orgId: string, id: string): Promise<DeliveryDetail> => {
    const body = await api<unknown>(withOrg(item(id), orgId));
    if (!isRecord(body) || !Array.isArray(body.timeline) || !Array.isArray(body.replays))
      throw bad('delivery detail');
    return {
      delivery: parseDelivery(body.delivery),
      attemptDetail: body.attemptDetail === 'full' ? 'full' : 'summary',
      attempts: Array.isArray(body.attempts) ? body.attempts.flatMap(parseAttempt) : [],
      timeline: body.timeline.flatMap((e: unknown) =>
        isRecord(e) && typeof e.kind === 'string' && typeof e.at === 'string'
          ? [{ kind: e.kind as TimelineEntry['kind'], at: e.at }]
          : [],
      ),
      replays: body.replays.flatMap((r: unknown) =>
        isRecord(r) && typeof r.id === 'string' && isDeliveryState(r.state)
          ? [{ id: r.id, state: r.state, createdAt: typeof r.createdAt === 'string' ? r.createdAt : null }]
          : [],
      ),
    };
  },
  summary: async (orgId: string): Promise<DeliverySummary> => {
    const body = await api<unknown>(withOrg('/api/deliveries/summary', orgId));
    if (!isRecord(body) || !isRecord(body.counts)) throw bad('summary');
    const counts = body.counts;
    const entries = DELIVERY_STATES.map((s) => [s, typeof counts[s] === 'number' ? counts[s] : 0]);
    return Object.fromEntries(entries) as DeliverySummary;
  },
  /** Step 1 of "redeliver all failed": count what would be sent. Writes nothing. */
  replayPlan: async (orgId: string, scope: BulkScope): Promise<BulkPlan> =>
    parsePlan(
      await api<unknown>(withOrg('/api/deliveries/replay-plan', orgId), {
        method: 'POST',
        body: JSON.stringify(scope),
      }),
    ),
  /** Step 2: send the planned set again. The server refuses if it is no longer exactly what was shown. */
  replayBulk: async (
    orgId: string,
    scope: BulkScope,
    plan: Pick<BulkPlan, 'token' | 'eligible'>,
  ): Promise<BulkResult> =>
    parseBulkResult(
      await api<unknown>(withOrg('/api/deliveries/replay', orgId), {
        method: 'POST',
        body: JSON.stringify({ ...scope, token: plan.token, expectedCount: plan.eligible }),
      }),
    ),
  replay: async (orgId: string, id: string): Promise<ReplayResult> => {
    const body = await api<unknown>(withOrg(`${item(id)}/replay`, orgId), { method: 'POST', body: '{}' });
    const replay = isRecord(body) ? body.replay : null;
    if (
      !isRecord(replay) ||
      typeof replay.deliveryId !== 'string' ||
      typeof replay.replayOf !== 'string' ||
      typeof replay.created !== 'boolean'
    )
      throw bad('replay');
    return { deliveryId: replay.deliveryId, replayOf: replay.replayOf, created: replay.created };
  },
};
