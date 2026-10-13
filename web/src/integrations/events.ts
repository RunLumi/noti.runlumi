import {
  GITHUB_EVENT_TYPES,
  isGithubEventType,
  type GithubEventType,
} from '../../../src/connectors/sources/github/catalog';
import type { MessageId } from '../i18n';

/**
 * The one label map for subscribable GitHub events. It is keyed by the server's closed
 * catalog, so adding an event type there without a label here fails the web type check.
 */
export { GITHUB_EVENT_TYPES, isGithubEventType, type GithubEventType };

export const EVENT_LABEL: Readonly<Record<GithubEventType, MessageId>> = {
  'workflow_run.failure': 'event.workflow_run.failure',
  'workflow_run.timed_out': 'event.workflow_run.timed_out',
  'workflow_run.cancelled': 'event.workflow_run.cancelled',
  'workflow_run.success': 'event.workflow_run.success',
  'pull_request.opened': 'event.pull_request.opened',
  'pull_request.ready_for_review': 'event.pull_request.ready_for_review',
  'pull_request.reopened': 'event.pull_request.reopened',
  'pull_request.merged': 'event.pull_request.merged',
  'pull_request.closed': 'event.pull_request.closed',
  'pull_request_review.submitted': 'event.pull_request_review.submitted',
  'pull_request_review_comment.created': 'event.pull_request_review_comment.created',
  'issues.opened': 'event.issues.opened',
  'issues.closed': 'event.issues.closed',
  'issues.reopened': 'event.issues.reopened',
  'issue_comment.created': 'event.issue_comment.created',
  push: 'event.push',
  'release.published': 'event.release.published',
  'deployment_status.created': 'event.deployment_status.created',
};

export interface EventGroup {
  readonly id: string;
  readonly label: MessageId;
  readonly hint?: MessageId;
  readonly events: readonly GithubEventType[];
}

/** Display grouping, ordered by how often a team usually wants each kind of update. */
export const EVENT_GROUPS: readonly EventGroup[] = [
  {
    id: 'builds',
    label: 'eventGroup.builds',
    hint: 'eventGroup.builds.hint',
    events: [
      'workflow_run.failure',
      'workflow_run.timed_out',
      'workflow_run.cancelled',
      'workflow_run.success',
    ],
  },
  {
    id: 'pull-requests',
    label: 'eventGroup.pullRequests',
    events: [
      'pull_request.opened',
      'pull_request.ready_for_review',
      'pull_request.reopened',
      'pull_request.merged',
      'pull_request.closed',
    ],
  },
  {
    id: 'reviews',
    label: 'eventGroup.reviews',
    events: ['pull_request_review.submitted', 'pull_request_review_comment.created'],
  },
  {
    id: 'issues',
    label: 'eventGroup.issues',
    events: ['issues.opened', 'issues.closed', 'issues.reopened', 'issue_comment.created'],
  },
  { id: 'code', label: 'eventGroup.code', events: ['push'] },
  {
    id: 'releases',
    label: 'eventGroup.releases',
    events: ['release.published', 'deployment_status.created'],
  },
];

/** F210: the quietest useful starting point. The user can change it on the same screen. */
export const DEFAULT_EVENTS: readonly GithubEventType[] = ['workflow_run.failure', 'workflow_run.timed_out'];

/** Catalog order, so the list, the review step and the request body read the same way. */
const ORDER: ReadonlyMap<string, number> = new Map(
  EVENT_GROUPS.flatMap((g) => g.events).map((e, i) => [e, i]),
);

export function sortEvents<T extends string>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => (ORDER.get(a) ?? Infinity) - (ORDER.get(b) ?? Infinity));
}
