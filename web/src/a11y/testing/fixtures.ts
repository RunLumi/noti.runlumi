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
  },
};

export const MEMBER: Me = { user: { ...ADMIN.user, id: 'user_2', role: 'member' } };
export const NO_WORKSPACE: Me = { user: { ...ADMIN.user, org_id: null, org_name: null, role: null } };

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
  createdAt: '2026-10-01T09:00:00Z',
  updatedAt: '2026-10-02T09:00:00Z',
  ...over,
});

export const INTEGRATIONS: readonly Integration[] = [
  integration({ id: 'int_1', name: 'Website builds' }),
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
] as const;

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
  latestReplayState: null,
  canReplay: false,
  ...over,
});

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
  delivery({ id: 'del_4', state: 'retrying', attempts: 2, nextAttemptAt: '2026-10-13T08:30:00Z' }),
];

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
