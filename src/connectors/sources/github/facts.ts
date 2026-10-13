import { asRecord, str } from '../../../lib/json';
import { LABEL_MAX } from '../../../routing/filter-input';
import type { RoutingFacts } from '../../../routing/filters';

/**
 * The minimal normalised facts routing filters may read, extracted from a payload whose
 * signature and installation are already verified (docs/specs/04-event-model.md F41, F62).
 * Only these scalars survive; the payload is never passed on or stored.
 *
 * A field the payload does not carry is `null`, never a guess (F43): `isBot` is only known
 * when GitHub sent `sender.type`, and `labels` is `[]` only when GitHub sent an empty list.
 */
const MAX_LABELS = 100;
const HEADS_PREFIX = 'refs/heads/';

const SHA = /^[0-9a-f]{7,40}$/i;
const TAGS_PREFIX = 'refs/tags/';

/**
 * A ref from a deployment or release, kept only when it looks like a branch name. GitHub puts a
 * branch, a tag or a commit SHA there and does not say which, so a SHA or a `refs/tags/` ref is
 * "no branch" (unknown), never a guess. A tag name that is not a SHA is indistinguishable from a
 * branch name and is accepted as one.
 */
function branchLikeRef(value: unknown): string | null {
  const ref = str(value);
  if (!ref || SHA.test(ref) || ref.startsWith(TAGS_PREFIX)) return null;
  return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
}

function branchOf(kind: string, event: Record<string, unknown>): string | null {
  if (kind === 'push') {
    const ref = str(event.ref);
    return ref?.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : null;
  }
  if (kind === 'workflow_run') return str(asRecord(event.workflow_run)?.head_branch) ?? null;
  if (kind === 'deployment_status') return branchLikeRef(asRecord(event.deployment)?.ref);
  if (kind === 'release') return branchLikeRef(asRecord(event.release)?.target_commitish);
  return str(asRecord(asRecord(event.pull_request)?.head)?.ref) ?? null;
}

function labelsOf(event: Record<string, unknown>): string[] | null {
  const raw = asRecord(event.pull_request)?.labels ?? asRecord(event.issue)?.labels;
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const label of raw.slice(0, MAX_LABELS)) {
    const name = str(asRecord(label)?.name);
    if (name) names.push(name.slice(0, LABEL_MAX));
  }
  return names;
}

export function extractGithubFacts(kind: string, event: Record<string, unknown>): RoutingFacts {
  const sender = asRecord(event.sender);
  const login = str(sender?.login) ?? null;
  const type = str(sender?.type);
  const draft = asRecord(event.pull_request)?.draft;
  return {
    branch: branchOf(kind, event),
    baseBranch: str(asRecord(asRecord(event.pull_request)?.base)?.ref) ?? null,
    actorLogin: login,
    actorIsBot: type === undefined ? null : type === 'Bot',
    // GitHub's placeholder for a deleted account is the login "ghost" (F60/F138).
    actorIsGhost: login === null ? null : login.toLowerCase() === 'ghost',
    draft: typeof draft === 'boolean' ? draft : null,
    labels: labelsOf(event),
  };
}
