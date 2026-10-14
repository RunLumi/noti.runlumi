import { asRecord } from '../../../lib/json';
import { child, clean, joinSummary, safeHttpsUrl } from '../text';
import type { Display, MapInput, MapResult } from '../types';
import { GITLAB_COM_HOST, type GitlabEventType } from './catalog';

/**
 * GitLab event to canonical display fields. Payload shapes are the documented examples at
 * docs.gitlab.com/user/project/integrations/webhook_events/ (read 2026-10-13); the tests'
 * fixtures are those examples. Only a few scalar fields are read: never a full payload, and
 * never an email address (`user_email`, commit author emails are personal data).
 *
 * The event is classified by the `X-Gitlab-Event` header; the action, where there is one, comes
 * from the body (`object_attributes.action`), never from the header (spec F83).
 *
 * UNVERIFIED: the complete list of pipeline `status` values (the docs page shows only
 * `success`; `failed` is the documented counterpart for jobs). Only `failed` and `success`
 * notify; every other status is ignored, so an unlisted value cannot produce a wrong message.
 * UNVERIFIED: the exact value GitLab.com puts in `X-Gitlab-Instance` (documented as "the
 * hostname"); a present header that is not `gitlab.com` is refused, an absent one is accepted.
 */

/**
 * Every link in a notification must be on gitlab.com: a payload URL is data from the sender, and
 * a verified secret does not make an arbitrary host safe to link to. A link that fails the check
 * is dropped; the event is still delivered.
 */
const link = (value: unknown): string => safeHttpsUrl(value, ['gitlab.com']);

const ZERO_SHA = /^0{40}$/;

type Mapped = Display & { readonly eventType: GitlabEventType };

const ignore = (reason: string): MapResult => ({ outcome: 'ignore', reason });

function projectPath(body: Record<string, unknown>): string | undefined {
  const path = clean(child(body, 'project')?.path_with_namespace, 200);
  return path || undefined;
}

function actorOf(body: Record<string, unknown>): string | undefined {
  // `user.username` (or, for push events, `user_username`): a handle, never an email.
  const name = clean(child(body, 'user')?.username ?? body.user_username, 100);
  return name || undefined;
}

function branchOf(ref: unknown): string {
  return clean(typeof ref === 'string' ? ref.replace(/^refs\/(heads|tags)\//, '') : '', 120);
}

function push(body: Record<string, unknown>, tag: boolean): Mapped | null {
  const name = branchOf(body.ref);
  if (!name) return null;
  const total = typeof body.total_commits_count === 'number' ? body.total_commits_count : undefined;
  const commits = Array.isArray(body.commits) ? body.commits : [];
  // Commits are listed oldest first in the documented example, so the last entry is the newest.
  const newest = asRecord(commits[commits.length - 1]);
  const created = typeof body.before === 'string' && ZERO_SHA.test(body.before);
  const deleted = typeof body.after === 'string' && ZERO_SHA.test(body.after);
  const subject = tag ? `Tag ${name}` : `Branch ${name}`;
  const title = deleted
    ? `${subject} deleted`
    : tag
      ? `${subject} pushed`
      : created
        ? `${subject} created`
        : `Push to ${name}`;
  const count = total ?? commits.length;
  return {
    eventType: tag ? 'tag_push' : 'push',
    title,
    url: link(newest?.url),
    status: deleted ? 'warning' : 'info',
    ...(projectPath(body) ? { repo: projectPath(body) as string } : {}),
    ...(actorOf(body) ? { actor: actorOf(body) as string } : {}),
    summary: joinSummary([
      !deleted && count > 0 && `${count} commit${count === 1 ? '' : 's'}`,
      !deleted && clean(newest?.title, 120),
    ]),
  };
}

const MR_ACTIONS: Readonly<
  Record<string, { type: GitlabEventType; word: string; status: NonNullable<Display['status']> }>
> = {
  open: { type: 'merge_request.opened', word: 'opened', status: 'info' },
  reopen: { type: 'merge_request.reopened', word: 'reopened', status: 'info' },
  close: { type: 'merge_request.closed', word: 'closed', status: 'warning' },
  merge: { type: 'merge_request.merged', word: 'merged', status: 'success' },
};

function mergeRequest(body: Record<string, unknown>): Mapped | null {
  const attrs = child(body, 'object_attributes');
  const action = MR_ACTIONS[typeof attrs?.action === 'string' ? attrs.action : ''];
  if (!attrs || !action) return null;
  const iid = typeof attrs.iid === 'number' ? `!${attrs.iid}` : 'Merge request';
  const source = clean(attrs.source_branch, 80);
  const target = clean(attrs.target_branch, 80);
  return {
    eventType: action.type,
    title: `${iid} ${action.word}: ${clean(attrs.title, 200) || '(no title)'}`,
    url: link(attrs.url),
    status: action.status,
    ...(projectPath(body) ? { repo: projectPath(body) as string } : {}),
    ...(actorOf(body) ? { actor: actorOf(body) as string } : {}),
    summary: joinSummary([source && target && `${source} → ${target}`, attrs.draft === true && 'Draft']),
  };
}

const ISSUE_ACTIONS: Readonly<
  Record<string, { type: GitlabEventType; word: string; status: NonNullable<Display['status']> }>
> = {
  open: { type: 'issue.opened', word: 'opened', status: 'info' },
  reopen: { type: 'issue.reopened', word: 'reopened', status: 'info' },
  close: { type: 'issue.closed', word: 'closed', status: 'success' },
};

function issue(body: Record<string, unknown>): Mapped | null {
  const attrs = child(body, 'object_attributes');
  const action = ISSUE_ACTIONS[typeof attrs?.action === 'string' ? attrs.action : ''];
  if (!attrs || !action) return null;
  const iid = typeof attrs.iid === 'number' ? `#${attrs.iid}` : 'Issue';
  // A confidential issue's title is not copied into a chat the project did not choose.
  const confidential = attrs.confidential === true;
  const labels = confidential
    ? []
    : Array.isArray(body.labels)
      ? body.labels
          .map((l) => clean(asRecord(l)?.title, 40))
          .filter(Boolean)
          .slice(0, 5)
      : [];
  return {
    eventType: action.type,
    title: confidential
      ? `Confidential issue ${iid} ${action.word}`
      : `Issue ${iid} ${action.word}: ${clean(attrs.title, 200) || '(no title)'}`,
    url: link(attrs.url),
    status: action.status,
    ...(projectPath(body) ? { repo: projectPath(body) as string } : {}),
    ...(actorOf(body) ? { actor: actorOf(body) as string } : {}),
    summary: joinSummary([labels.length > 0 && `Labels: ${labels.join(', ')}`]),
  };
}

function pipeline(body: Record<string, unknown>): Mapped | null {
  const attrs = child(body, 'object_attributes');
  const status = attrs?.status;
  if (!attrs || (status !== 'failed' && status !== 'success')) return null;
  const failed = status === 'failed';
  const ref = clean(attrs.ref, 120);
  const builds = Array.isArray(body.builds) ? body.builds : [];
  const failedJobs = failed
    ? builds
        .map((b) => asRecord(b))
        .filter((b) => b?.status === 'failed')
        .map((b) => clean(b?.name, 40))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const duration = typeof attrs.duration === 'number' ? `${Math.round(attrs.duration)}s` : undefined;
  return {
    eventType: failed ? 'pipeline.failed' : 'pipeline.succeeded',
    title: `Pipeline ${failed ? 'failed' : 'succeeded'}${ref ? ` on ${ref}` : ''}`,
    url: link(attrs.url),
    status: failed ? 'failure' : 'success',
    ...(projectPath(body) ? { repo: projectPath(body) as string } : {}),
    ...(actorOf(body) ? { actor: actorOf(body) as string } : {}),
    summary: joinSummary([
      clean(child(body, 'commit')?.title, 120),
      failedJobs.length > 0 && `Failed: ${failedJobs.join(', ')}`,
      duration,
    ]),
  };
}

const BY_HEADER: Readonly<Record<string, (body: Record<string, unknown>) => Mapped | null>> = {
  'Push Hook': (b) => push(b, false),
  'Tag Push Hook': (b) => push(b, true),
  'Merge Request Hook': mergeRequest,
  'Issue Hook': issue,
  'Pipeline Hook': pipeline,
};

export function mapGitlab(input: MapInput): MapResult {
  const event = input.headers.get('x-gitlab-event');
  if (!event || event.length > 64) return { outcome: 'reject', status: 400, reason: 'missing_event_header' };
  // GitLab.com only (spec F81, open item 8). The header is recorded for diagnostics, not trusted
  // for authorization: authentication already succeeded on the secret.
  const instance = input.headers.get('x-gitlab-instance');
  if (instance !== null && instance.trim().toLowerCase() !== GITLAB_COM_HOST)
    return { outcome: 'reject', status: 401, reason: 'instance_not_supported' };
  const handler = Object.hasOwn(BY_HEADER, event) ? BY_HEADER[event] : undefined;
  if (!handler) return ignore('event_not_supported');
  const body = asRecord(input.body);
  if (!body) return { outcome: 'reject', status: 400, reason: 'invalid_body' };
  const mapped = handler(body);
  return mapped ? { outcome: 'deliver', display: mapped } : ignore('action_not_notified');
}
