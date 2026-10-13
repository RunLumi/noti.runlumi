/**
 * The closed set of GitHub notification types a customer can subscribe to (F61; fixes D16).
 *
 * `classifyGithubEvent` can produce any `kind.action` string GitHub sends. Only names in
 * this catalog may be stored on an integration, and ingress ignores everything else, so
 * the stored and routed vocabulary is bounded and reviewable.
 */
export const GITHUB_EVENT_TYPES = [
  'issues.opened',
  'issues.closed',
  'issues.reopened',
  'issue_comment.created',
  'pull_request.opened',
  'pull_request.reopened',
  'pull_request.ready_for_review',
  'pull_request.merged',
  'pull_request.closed',
  'pull_request_review.submitted',
  'pull_request_review_comment.created',
  'push',
  'release.published',
  'workflow_run.success',
  'workflow_run.failure',
  'workflow_run.cancelled',
  'workflow_run.timed_out',
  'deployment_status.created',
] as const;

export type GithubEventType = (typeof GITHUB_EVENT_TYPES)[number];

const KNOWN: ReadonlySet<string> = new Set(GITHUB_EVENT_TYPES);

export function isGithubEventType(value: unknown): value is GithubEventType {
  return typeof value === 'string' && KNOWN.has(value);
}
