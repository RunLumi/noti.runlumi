import { ApiError, api } from '../lib/api';

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

export interface DeliveryItem {
  readonly id: string;
  readonly integration: {
    readonly id: string;
    readonly name: string;
    readonly repo: string | null;
    readonly destination: 'lark' | 'slack' | null;
    readonly destinationHost: string | null;
  };
  readonly integrationExists: boolean;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly error: DeliveryError | null;
  readonly createdAt: string | null;
  readonly updatedAt: string;
  readonly nextAttemptAt: string | null;
  readonly replayOf: string | null;
  readonly latestReplayState: DeliveryState | null;
  readonly canReplay: boolean;
}

export interface DeliveryPage {
  readonly deliveries: readonly DeliveryItem[];
  readonly nextCursor: string | null;
}

export interface TimelineEntry {
  readonly kind: 'created' | 'first_attempt' | 'last_attempt' | 'next_attempt' | 'dead_lettered';
  readonly at: string;
}

export interface DeliveryDetail {
  readonly delivery: DeliveryItem;
  readonly timeline: readonly TimelineEntry[];
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
  const destination =
    integration.destination === 'lark' || integration.destination === 'slack'
      ? integration.destination
      : null;
  return {
    id: value.id,
    integration: {
      id: String(integration.id),
      name: String(integration.name),
      repo: typeof integration.repo === 'string' ? integration.repo : null,
      destination,
      destinationHost: typeof integration.destinationHost === 'string' ? integration.destinationHost : null,
    },
    integrationExists: value.integrationExists,
    state: value.state,
    attempts: value.attempts,
    error: parseError(value.error ?? null),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextAttemptAt: value.nextAttemptAt,
    replayOf: value.replayOf,
    latestReplayState: value.latestReplayState,
    canReplay: value.canReplay,
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
