import { asRecord, str } from '../../../lib/json';

/**
 * The few normalised facts noise control reads from a verified GitHub payload (ADR 0016). Like
 * routing facts they are scalars only and are never stored: the subject feeds a hashed group
 * key, and the workflow and branch feed a hashed open-failure key.
 *
 * `subject` is what the update is ABOUT, so two updates about different things can never be
 * combined (F141): a pull request or issue number, a workflow run id, a pushed branch, a
 * deployment or a release tag. An update with no usable subject has the empty subject and is
 * grouped only with other updates of the same type in the same repository.
 */
export interface GithubNoiseFacts {
  readonly subject: string;
  /** Workflow name and branch, for failure -> success resolution. Null when not a workflow run. */
  readonly workflow: string | null;
  readonly branch: string | null;
}

function numberOf(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
}

function subjectOf(kind: string, event: Record<string, unknown>): string {
  switch (kind) {
    case 'issues':
    case 'issue_comment': {
      const n = numberOf(asRecord(event.issue)?.number);
      return n ? `#${n}` : '';
    }
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment': {
      const n = numberOf(asRecord(event.pull_request)?.number);
      return n ? `#${n}` : '';
    }
    case 'push': {
      const ref = str(event.ref);
      return ref ? `branch:${ref}` : '';
    }
    case 'workflow_run': {
      const id = numberOf(asRecord(event.workflow_run)?.id);
      return id ? `run:${id}` : '';
    }
    case 'deployment_status': {
      const id = numberOf(asRecord(event.deployment)?.id);
      return id ? `deployment:${id}` : '';
    }
    case 'release': {
      const tag = str(asRecord(event.release)?.tag_name);
      return tag ? `release:${tag}`.slice(0, 200) : '';
    }
    default:
      return '';
  }
}

export function githubNoiseFacts(kind: string, event: Record<string, unknown>): GithubNoiseFacts {
  const run = kind === 'workflow_run' ? asRecord(event.workflow_run) : null;
  return {
    subject: subjectOf(kind, event),
    workflow: str(run?.name) ?? null,
    branch: str(run?.head_branch) ?? null,
  };
}

/** The two workflow conclusions that open a failure; a cancelled run neither opens nor closes. */
export function isWorkflowFailure(eventType: string): boolean {
  return eventType === 'workflow_run.failure' || eventType === 'workflow_run.timed_out';
}
