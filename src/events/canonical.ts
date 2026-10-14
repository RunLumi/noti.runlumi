import type { RoutingFacts } from '../routing/filters';
import { severityOfStatus, type EventStatus, type Severity, type SourceId } from './catalog';

/**
 * The canonical event (spec 04 F41, ADR 0020): what every source normalises into BEFORE routing,
 * noise control and rendering. CloudEvents-aligned context attributes plus a small, closed `data`
 * object. A pragmatic subset of F41:
 *
 *  - structured only, no `ce-` binary binding, and no `orgid`/`connectionid` extensions: tenancy
 *    stays on the queue message and the database rows, so an event never carries it;
 *  - `id` is the PROVIDER's delivery or event id (opaque), not a ULID. `source` + `id` is then
 *    unique, which is exactly the CloudEvents duplicate rule; the tenant-bound idempotency key is
 *    derived separately from it (src/delivery/ids.ts, F170);
 *  - no payload bodies: every field is a bounded scalar chosen by a mapper, never a pass-through.
 *
 * A mapper is a PURE function of (verified payload, headers): no clock, no randomness, no I/O. A
 * `time` is therefore only set when the provider's payload carries a trustworthy one.
 *
 * Versioning (F46): `type` changes only for a breaking change to `data`; `dataschema` carries the
 * version and changes with every change. See docs/adr/0020-canonical-event.md.
 */
export const CANONICAL_SPECVERSION = '1.0';
export const CANONICAL_TYPE_PREFIX = 'io.lumi.noti.';
/** The version of the canonical `data` shape. Part of every `dataschema`. */
export const CANONICAL_SCHEMA_VERSION = 'v1';

/** Field bounds (F45). The mappers cut to these; the validator rejects what exceeds them. */
export const CANONICAL_LIMITS = {
  id: 512,
  source: 512,
  type: 200,
  subject: 300,
  dataschema: 300,
  adapterversion: 32,
  title: 300,
  summary: 1000,
  url: 2048,
  repo: 200,
  actor: 100,
  branch: 255,
  labelCount: 100,
  label: 100,
} as const;

/**
 * Hard ceiling on a serialised canonical event: the CloudEvents "consumers SHOULD accept 64 KByte"
 * threshold (F45). Exceeding it is `payload_too_large`, never a silent truncation. The field
 * bounds above keep every real event far below it (a test asserts the worst case).
 */
export const CANONICAL_BUDGET_BYTES = 64 * 1024;

export type ActorKind = 'user' | 'bot' | 'ghost' | 'unknown';

export interface CanonicalActor {
  /** A login or handle. Plain text, never a display name and never used for authorization (F60). */
  readonly login: string;
  readonly type: ActorKind;
  /** `null` when the provider does not say. Never `false` as a guess (F43). */
  readonly isBot: boolean | null;
  /** GitHub's placeholder for a deleted account. Never presented as a person (F60). */
  readonly isGhost: boolean;
}

/** What routing filters may read besides the actor. `null` means the payload did not say (F43). */
export interface CanonicalFacts {
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly draft: boolean | null;
  readonly labels: readonly string[] | null;
}

export interface CanonicalData {
  readonly title: string;
  readonly summary?: string;
  /** An absolute `https:` link without credentials. */
  readonly url?: string;
  readonly repo?: string;
  readonly actor?: CanonicalActor;
  readonly status: EventStatus;
  readonly severity: Severity;
  readonly facts: CanonicalFacts;
}

export interface CanonicalEvent {
  readonly specversion: typeof CANONICAL_SPECVERSION;
  readonly id: string;
  readonly source: string;
  /** `io.lumi.noti.<provider>.<event type>`. */
  readonly type: string;
  readonly subject?: string;
  /** RFC 3339. Only when the payload carries one: a mapper has no clock. */
  readonly time?: string;
  readonly dataschema: string;
  /** Extension attributes: lower-case a-z0-9 names only (CloudEvents core). */
  readonly provider: SourceId;
  readonly adapterversion: string;
  readonly data: CanonicalData;
}

export const NO_FACTS: CanonicalFacts = { branch: null, baseBranch: null, draft: null, labels: null };

export const canonicalType = (provider: SourceId, eventType: string): string =>
  `${CANONICAL_TYPE_PREFIX}${provider}.${eventType}`;

export const dataschemaOf = (provider: SourceId, eventType: string): string =>
  `urn:lumi:noti:schema:${provider}:${eventType}:${CANONICAL_SCHEMA_VERSION}`;

/** The provider's own event type (`workflow_run.failure`), recovered from a canonical `type`. */
export function eventTypeOf(event: Pick<CanonicalEvent, 'type' | 'provider'>): string {
  return event.type.slice(`${CANONICAL_TYPE_PREFIX}${event.provider}.`.length);
}

/**
 * The display fields the delivery path carries (`DeliveryMessage`, src/env.ts): bounded text,
 * never the provider payload.
 */
export interface DisplayFields {
  readonly title: string;
  readonly url: string;
  readonly repo?: string;
  readonly actor?: string;
  readonly status?: EventStatus;
  readonly eventType?: string;
  readonly summary?: string;
}

/**
 * Derive the display fields from a canonical event. Attribution follows F60: a ghost sender is
 * never shown as a person, so a ghost has no `actor` here; a bot is shown by its own login.
 */
export function displayOf(event: CanonicalEvent): DisplayFields {
  const { data } = event;
  const showActor = data.actor !== undefined && !data.actor.isGhost;
  return {
    title: data.title,
    url: data.url ?? '',
    status: data.status,
    eventType: eventTypeOf(event),
    ...(data.repo ? { repo: data.repo } : {}),
    ...(showActor && data.actor ? { actor: data.actor.login } : {}),
    ...(data.summary ? { summary: data.summary } : {}),
  };
}

/** The routing facts of an event, in the shape the filter engine reads (src/routing/filters.ts). */
export function routingFactsOf(event: CanonicalEvent): RoutingFacts {
  const { actor, facts } = event.data;
  return {
    branch: facts.branch,
    baseBranch: facts.baseBranch,
    actorLogin: actor?.login ?? null,
    actorIsBot: actor ? actor.isBot : null,
    actorIsGhost: actor ? actor.isGhost : null,
    draft: facts.draft,
    labels: facts.labels,
  };
}

/** What a mapper whose provider has no actor typing builds an actor from. */
export function plainActor(login: string): CanonicalActor {
  return { login, type: 'unknown', isBot: null, isGhost: false };
}

/**
 * Wrap display-shaped provider output (GitLab, Stripe) as a canonical event. Those connectors
 * have no routing facts and no actor typing, so `facts` are all unknown and the actor is a plain
 * handle. `displayOf(canonicalFromDisplay(d))` returns `d` (a test asserts it for every fixture).
 */
export function canonicalFromDisplay(input: {
  readonly provider: SourceId;
  readonly adapterVersion: string;
  readonly id: string;
  readonly source: string;
  readonly display: DisplayFields;
}): CanonicalEvent {
  const { display } = input;
  const eventType = display.eventType ?? 'notification';
  const status = display.status ?? 'info';
  return {
    specversion: CANONICAL_SPECVERSION,
    id: input.id,
    source: input.source,
    type: canonicalType(input.provider, eventType),
    dataschema: dataschemaOf(input.provider, eventType),
    provider: input.provider,
    adapterversion: input.adapterVersion,
    data: {
      title: display.title,
      status,
      severity: severityOfStatus(status),
      facts: NO_FACTS,
      ...(display.url ? { url: display.url } : {}),
      ...(display.repo ? { repo: display.repo } : {}),
      ...(display.actor ? { actor: plainActor(display.actor) } : {}),
      ...(display.summary ? { summary: display.summary } : {}),
    },
  };
}

/** The URI-reference of a repository-scoped source, or the bare host when the path is unusable. */
export function repoSource(host: string, path: string | undefined): string {
  return path && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(path)
    ? `https://${host}/${path}`
    : `https://${host}`;
}
