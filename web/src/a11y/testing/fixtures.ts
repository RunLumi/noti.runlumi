import type { GithubInstallation, Integration, Me } from '../../lib/api';
import type { DeliveryItem } from '../../deliveries/api';

/**
 * Representative API payloads for the page-level accessibility tests. They are shaped like the
 * real responses (and pass the same `parse*` functions as production code), but they are
 * fixtures: they prove the screens render and meet the axe rules with realistic data, not
 * that any provider accepted anything.
 */
export const ORG_ID = 'org_test_1';

export const ADMIN: Me = {
  user: {
    id: 'user_1',
    name: 'Linh Nguyen',
    email: 'linh@acme.test',
    emailVerified: true,
    org_id: ORG_ID,
    org_name: 'Acme Studio',
    role: 'admin',
    activeOrgId: ORG_ID,
    organizations: [{ orgId: ORG_ID, role: 'admin', name: 'Acme Studio' }],
  },
};

export const MEMBER: Me = { user: { ...ADMIN.user, id: 'user_2', role: 'member' } };
export const NO_WORKSPACE: Me = {
  user: { ...ADMIN.user, org_id: null, org_name: null, role: null, activeOrgId: null, organizations: [] },
};

/** A second workspace for the same person, where they are only a member (switcher tests). */
export const OTHER_ORG_ID = 'org_test_2';
export const MULTI: Me = {
  user: {
    ...ADMIN.user,
    organizations: [
      { orgId: ORG_ID, role: 'admin', name: 'Acme Studio' },
      { orgId: OTHER_ORG_ID, role: 'member', name: 'Bao Retail' },
    ],
  },
};

const integration = (over: Partial<Integration> & Pick<Integration, 'id' | 'name'>): Integration => ({
  repo: 'acme/website',
  sourceId: null,
  eventTypes: ['workflow_run.failure', 'workflow_run.timed_out'],
  destination: 'slack',
  destinationHost: 'hooks.slack.com',
  enabled: true,
  credentials: 'ok',
  filters: {},
  filtersInvalid: false,
  filtersNewer: false,
  noise: null,
  noiseInvalid: false,
  noiseNewer: false,
  createdAt: '2026-10-01T09:00:00Z',
  updatedAt: '2026-10-02T09:00:00Z',
  ...over,
});

export const INTEGRATIONS: readonly Integration[] = [
  integration({
    id: 'int_1',
    name: 'Website builds',
    // The delivery circuit breaker is open: shown, never enforced (ADR 0023).
    health: {
      state: 'open',
      paused: true,
      consecutiveFailures: 5,
      retryAt: '2026-10-14T09:05:00Z',
      pacedUntil: null,
      timesOpened: 1,
    },
  }),
  integration({
    id: 'int_4',
    name: 'Deploy alerts',
    repo: '',
    sourceId: 'src_1',
    eventTypes: [],
    destination: 'slack',
    destinationHost: 'hooks.slack.com',
  }),
  integration({
    id: 'int_5',
    name: 'Filtered pushes',
    repo: 'acme/web-app',
    eventTypes: ['push', 'pull_request.opened'],
    filters: {
      branch: { allow: ['main', 'release/*'], deny: [] },
      actor: { allow: [], deny: ['dependabot[bot]'], bots: 'exclude' },
      draft: 'exclude',
    },
  }),
  integration({
    id: 'int_6',
    name: 'Night-quiet builds',
    repo: 'acme/platform',
    eventTypes: ['workflow_run.failure', 'workflow_run.success', 'issue_comment.created'],
    noise: {
      timezone: 'Asia/Ho_Chi_Minh',
      quietHours: { start: '22:00', end: '08:00' },
      groupWindowSec: 300,
      digest: 'daily',
      digestAt: '08:00',
      resolution: true,
    },
  }),
  integration({
    id: 'int_2',
    name: 'API releases',
    repo: 'acme/api',
    destination: 'lark',
    destinationHost: 'open.larksuite.com',
    eventTypes: ['pull_request.merged', 'release.published', 'push', 'issues.opened'],
    enabled: false,
  }),
  integration({
    id: 'int_3',
    name: 'Mobile reviews',
    repo: 'acme/mobile',
    destination: 'teams',
    destinationHost: 'prod.logic.azure.com',
    credentials: 'quarantined',
    eventTypes: ['pull_request_review.submitted'],
  }),
];

export const SOURCES = [
  {
    id: 'src_1',
    name: 'CI pipeline',
    kind: 'generic',
    authMode: null,
    livemode: null,
    droppedEvents: 0,
    lastDroppedAt: null,
    endpointId: 'ep_abc123',
    endpointUrl: 'https://noti.example.test/webhooks/ep_abc123',
    enabled: true,
    createdAt: '2026-10-01 09:00:00',
    lastReceivedAt: '2026-10-13 07:30:00',
    secretRotatedAt: null,
    reusedIdRejections: 2,
    integrationCount: 1,
  },
  {
    id: 'src_2',
    name: 'Billing service',
    kind: 'generic',
    authMode: null,
    livemode: null,
    droppedEvents: 0,
    lastDroppedAt: null,
    endpointId: 'ep_def456',
    endpointUrl: 'https://noti.example.test/webhooks/ep_def456',
    enabled: false,
    createdAt: '2026-10-02 09:00:00',
    lastReceivedAt: null,
    secretRotatedAt: '2026-10-05 10:00:00',
    reusedIdRejections: 0,
    integrationCount: 0,
  },
] as const;

export const ROUTING_LOG = [
  {
    id: 'rl_1',
    eventType: 'push',
    outcome: 'filtered',
    filterId: 'branch',
    reason: 'not_in_allow_list',
    unknownFact: false,
    decidedAt: '2026-10-13T08:00:00Z',
  },
  {
    id: 'rl_2',
    eventType: 'pull_request.opened',
    outcome: 'delivered',
    filterId: null,
    reason: 'allowed',
    unknownFact: false,
    decidedAt: '2026-10-13T08:05:00Z',
  },
  {
    id: 'rl_3',
    eventType: 'issue_comment.created',
    outcome: 'delivered',
    filterId: null,
    reason: 'quiet_hours',
    unknownFact: false,
    decidedAt: '2026-10-13T16:10:00Z',
  },
  {
    id: 'rl_4',
    eventType: 'workflow_run.failure',
    outcome: 'delivered',
    filterId: null,
    reason: 'critical_bypass',
    unknownFact: false,
    decidedAt: '2026-10-13T16:20:00Z',
  },
] as const;

/** What `GET /api/integrations/:id/noise-status` returns while updates are waiting. */
export const NOISE_STATUS = { held: { count: 3, nextReleaseAt: '2026-10-14T01:00:00Z' } } as const;

export const INSTALLATIONS: readonly GithubInstallation[] = [
  {
    id: 'inst_1',
    account: 'acme',
    accountType: 'Organization',
    repositorySelection: 'selected',
    status: 'active',
    updatedAt: '2026-10-01T09:00:00Z',
    needsResync: false,
    repositories: ['acme/website', 'acme/api', 'acme/mobile'],
  },
];

const delivery = (over: Partial<DeliveryItem> & Pick<DeliveryItem, 'id' | 'state'>): DeliveryItem => ({
  integration: {
    id: 'int_1',
    name: 'Website builds',
    repo: 'acme/website',
    destination: 'slack',
    destinationHost: 'hooks.slack.com',
  },
  integrationExists: true,
  integrationStatus: 'available',
  attempts: 1,
  error: null,
  createdAt: '2026-10-13T08:00:00Z',
  updatedAt: '2026-10-13T08:01:00Z',
  nextAttemptAt: null,
  replayOf: null,
  isTest: false,
  latestReplayState: null,
  canReplay: false,
  ...over,
});

/** The attempt history `GET /api/deliveries/:id` returns once per-attempt rows exist (F184). */
export const ATTEMPTS = [
  {
    attempt: 1,
    startedAt: '2026-10-13T08:00:00Z',
    durationMs: 412,
    outcome: 'retry_scheduled',
    error: {
      code: 'destination_unavailable',
      messageKey: 'errors.destination_unavailable',
      retryable: true,
      userActionable: false,
    },
    detail: 'provider_http_503',
    statusClass: '5xx',
    retryAfterSeconds: null,
    possibleDuplicate: true,
  },
  {
    attempt: 1,
    startedAt: '2026-10-13T08:00:30Z',
    durationMs: 0,
    outcome: 'deferred',
    error: null,
    detail: 'circuit_open',
    statusClass: 'none',
    retryAfterSeconds: 270,
    possibleDuplicate: false,
  },
  {
    attempt: 2,
    startedAt: '2026-10-13T08:05:00Z',
    durationMs: 188,
    outcome: 'dead_lettered',
    error: {
      code: 'destination_revoked',
      messageKey: 'errors.destination_revoked',
      retryable: false,
      userActionable: true,
    },
    detail: 'provider_http_404',
    statusClass: '4xx',
    retryAfterSeconds: null,
    possibleDuplicate: false,
  },
] as const;

export const DELIVERIES: readonly DeliveryItem[] = [
  delivery({ id: 'del_1', state: 'sent' }),
  delivery({
    id: 'del_2',
    state: 'accepted',
    integration: {
      id: 'int_3',
      name: 'Mobile reviews',
      repo: 'acme/mobile',
      destination: 'teams',
      destinationHost: 'prod.logic.azure.com',
    },
  }),
  delivery({
    id: 'del_3',
    state: 'dead_lettered',
    attempts: 5,
    canReplay: true,
    error: {
      code: 'destination_revoked',
      messageKey: 'errors.destination_revoked',
      retryable: false,
      userActionable: true,
    },
  }),
  delivery({
    id: 'del_4',
    state: 'retrying',
    attempts: 2,
    nextAttemptAt: '2026-10-13T08:30:00Z',
    possibleDuplicate: true,
    pausedReason: 'circuit_open',
  }),
  delivery({
    id: 'del_6',
    state: 'suppressed',
    suppression: { reason: 'duplicate', duplicateOf: 'del_1' },
  }),
  delivery({ id: 'del_5', state: 'sent', isTest: true }),
];

/** What `GET /api/setup/progress` returns for a workspace that has connected and created but not verified. */
export const SETUP_PROGRESS = {
  organizationId: ORG_ID,
  steps: [
    { id: 'source_connected', done: true, status: 'done', since: '2026-10-01T09:00:00Z', nextAction: 'none' },
    {
      id: 'integration_created',
      done: true,
      status: 'done',
      since: '2026-10-01T09:30:00Z',
      nextAction: 'none',
    },
    { id: 'destination_verified', done: false, status: 'todo', since: null, nextAction: 'send_test' },
    {
      id: 'first_event_received',
      done: false,
      status: 'todo',
      since: null,
      nextAction: 'trigger_real_event',
    },
  ],
  complete: false,
  next: 'destination_verified',
  verifiedWindowDays: 30,
} as const;

/** The delivery a test send creates; its state is whatever a scenario needs. */
export const TEST_DELIVERY_ID = 'del_test_1';

export const MEMBERS = [
  {
    id: 'mem_1',
    userId: 'user_1',
    name: 'Linh Nguyen',
    email: 'linh@acme.test',
    role: 'admin',
    createdAt: '2026-09-01T00:00:00Z',
  },
  {
    id: 'mem_2',
    userId: 'user_9',
    name: 'Minh Tran',
    email: 'minh@acme.test',
    role: 'member',
    createdAt: '2026-09-02T00:00:00Z',
  },
] as const;

export const PASSKEYS = [{ id: 'pk_1', name: 'Work laptop', createdAt: '2026-09-10T00:00:00.000Z' }];

/** What `GET /api/audit` returns for an admin: names only, allow-listed details, no addresses. */
export const AUDIT_EVENTS = [
  {
    id: 'au_1',
    createdAt: '2026-10-13T09:30:00Z',
    action: 'integration.create',
    subjectType: 'integration',
    subjectId: 'int_1',
    outcome: 'success',
    actor: { kind: 'member', name: 'Linh Nguyen' },
    summary: [
      { key: 'repo', value: 'acme/website' },
      { key: 'destination', value: 'slack' },
      { key: 'signed', value: false },
      { key: 'eventTypes', value: ['workflow_run.failure', 'workflow_run.timed_out'] },
    ],
  },
  {
    id: 'au_2',
    createdAt: '2026-10-13T08:10:00Z',
    action: 'access.denied',
    subjectType: 'capability',
    subjectId: 'delivery.replay',
    outcome: 'denied',
    actor: { kind: 'member', name: 'Minh Tran' },
    summary: [{ key: 'role', value: 'member' }],
  },
  {
    id: 'au_3',
    createdAt: '2026-10-12T22:00:00Z',
    action: 'integration.auto_pause',
    subjectType: 'integration',
    subjectId: 'int_3',
    outcome: 'success',
    actor: { kind: 'system' },
    summary: [
      { key: 'destination', value: 'discord' },
      { key: 'providerStatus', value: 404 },
    ],
  },
  {
    id: 'au_4',
    createdAt: '2026-10-12T21:00:00Z',
    action: 'access.denied',
    subjectType: 'organization',
    subjectId: 'org_other',
    outcome: 'denied',
    actor: { kind: 'other' },
    summary: [{ key: 'reason', value: 'not_a_member' }],
  },
] as const;
