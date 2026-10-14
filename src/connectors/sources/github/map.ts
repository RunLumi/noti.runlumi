import { descriptorFor } from '../../../events/catalog';
import {
  CANONICAL_LIMITS as L,
  CANONICAL_SPECVERSION,
  canonicalType,
  dataschemaOf,
  repoSource,
  type CanonicalActor,
  type CanonicalEvent,
  type CanonicalFacts,
} from '../../../events/canonical';
import { cleanLine, cutAt, hasUnsafeText } from '../../../events/text';
import { asRecord, str } from '../../../lib/json';
import { safeHttpsUrl } from '../text';
import type { GithubEventType } from './catalog';
import { extractGithubFacts, senderFacts } from './facts';

/**
 * GitHub webhook payload to the canonical event (spec 05 F62, spec 04 F41). A pure function of the
 * already verified payload: no clock, no I/O, no state. Only a few scalar fields are read; the
 * payload is never passed on, and neither is a pull request or issue body, a commit message or an
 * email address (privacy beats richness: a chat may have readers the repository does not).
 *
 * Attribution (F60) uses `sender.login` and `sender.type` only. It is a display hint, never an
 * authorization input, and a free-text name is never read.
 *
 * Adapter version history: 1.0.0 = first canonical mapping (slice 4b).
 */
export const GITHUB_ADAPTER_VERSION = '1.0.0';

function scalar(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return str(value);
}

/**
 * One short line from a few scalar fields (number, branch names, conclusion). Deliberately
 * not the PR/issue body, a commit message or the payload.
 */
function summaryOf(event: Record<string, unknown>, subject: Record<string, unknown>): string {
  const number = scalar(subject.number);
  const head = scalar(asRecord(subject.head)?.ref) ?? scalar(subject.head_branch);
  const base = scalar(asRecord(subject.base)?.ref);
  const parts = [
    number ? `#${number}` : undefined,
    head && base ? `${head} → ${base}` : head,
    scalar(subject.conclusion),
    scalar(event.action),
  ].filter((p): p is string => p !== undefined);
  return cleanLine(parts.join(' · '), 280);
}

function actorOf(event: Record<string, unknown>): CanonicalActor | undefined {
  const sender = senderFacts(event);
  const login = cleanLine(sender.login, L.actor);
  if (!login) return undefined;
  const isGhost = sender.isGhost === true;
  return {
    login,
    type: isGhost ? 'ghost' : sender.isBot === true ? 'bot' : sender.isBot === false ? 'user' : 'unknown',
    isBot: sender.isBot,
    isGhost,
  };
}

/** A fact is kept verbatim or not at all: it is compared against filters, so it is never rewritten. */
function fact(value: string | null): string | null {
  if (value === null || value.length === 0 || hasUnsafeText(value)) return null;
  return cutAt(value, L.branch);
}

function factsOf(kind: string, event: Record<string, unknown>): CanonicalFacts {
  const raw = extractGithubFacts(kind, event);
  return {
    branch: fact(raw.branch),
    baseBranch: fact(raw.baseBranch),
    draft: raw.draft,
    labels:
      raw.labels === null ? null : raw.labels.filter((l) => !hasUnsafeText(l)).map((l) => cutAt(l, L.label)),
  };
}

export interface GithubMapInput {
  /** The `X-GitHub-Event` value. */
  readonly kind: string;
  /** The verified, parsed body. */
  readonly event: Record<string, unknown>;
  /** The catalogued type `classifyGithubEvent` produced; the caller has already checked it. */
  readonly eventType: GithubEventType;
  /** `X-GitHub-Delivery`, opaque (F59). Kept on a manual redelivery, so it identifies the event. */
  readonly deliveryId: string;
}

export function mapGithubEvent(input: GithubMapInput): CanonicalEvent {
  const { kind, event, eventType, deliveryId } = input;
  const repository = asRecord(event.repository);
  const repoFullName = cleanLine(repository?.full_name, L.repo);
  const subject =
    asRecord(event.issue) ?? asRecord(event.pull_request) ?? asRecord(event.workflow_run) ?? event;
  const number = scalar(subject.number);
  const summary = summaryOf(event, subject);
  const status = descriptorFor('github', eventType)?.defaultStatus ?? 'info';
  const url = safeHttpsUrl(subject.html_url) || safeHttpsUrl(repository?.html_url);
  const actor = actorOf(event);
  return {
    specversion: CANONICAL_SPECVERSION,
    id: deliveryId,
    source: repoSource('github.com', repoFullName),
    type: canonicalType('github', eventType),
    ...(repoFullName && number ? { subject: `${repoFullName}#${number}` } : {}),
    dataschema: dataschemaOf('github', eventType),
    provider: 'github',
    adapterversion: GITHUB_ADAPTER_VERSION,
    data: {
      title: cleanLine(subject.title, L.title) || cleanLine(subject.name, L.title) || eventType,
      status,
      severity: descriptorFor('github', eventType)?.defaultSeverity ?? 'info',
      facts: factsOf(kind, event),
      ...(url ? { url } : {}),
      ...(repoFullName ? { repo: repoFullName } : {}),
      ...(actor ? { actor } : {}),
      ...(summary ? { summary } : {}),
    },
  };
}
