import { GITHUB_DESCRIPTORS } from '../../../events/catalog';

/**
 * The closed set of GitHub notification types a customer can subscribe to (F61; fixes D16).
 *
 * `classifyGithubEvent` can produce any `kind.action` string GitHub sends. Only names in
 * this catalog may be stored on an integration, and ingress ignores everything else, so
 * the stored and routed vocabulary is bounded and reviewable.
 *
 * The list is derived from the event-type registry (src/events/catalog.ts), which also
 * carries each type's label key and default status: there is one table, not two.
 */
export type GithubEventType = (typeof GITHUB_DESCRIPTORS)[number]['type'];

export const GITHUB_EVENT_TYPES: readonly GithubEventType[] = GITHUB_DESCRIPTORS.map((d) => d.type);

const KNOWN: ReadonlySet<string> = new Set(GITHUB_EVENT_TYPES);

export function isGithubEventType(value: unknown): value is GithubEventType {
  return typeof value === 'string' && KNOWN.has(value);
}
