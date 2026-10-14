/**
 * The event-type catalog registry (spec 04 F42): ONE table of every notification type a
 * closed-catalog source can produce, with per-type metadata. `GITHUB_EVENT_TYPES`,
 * `GITLAB_EVENT_TYPES` and `STRIPE_EVENT_TYPES` are derived from it, and the canonical
 * validator checks a type against it, so the stored, routed and displayed vocabularies cannot
 * drift apart.
 *
 * This module has no runtime imports: the dashboard imports the per-source catalogues, so it
 * must never pull in Worker environment types.
 *
 * The generic source has no catalog: its `type` is a sender-chosen label that cannot be
 * subscribed to or filtered on (ADR 0012), so it is not listed here.
 */
export const CATALOG_SOURCES = ['github', 'gitlab', 'stripe'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

/** Every provider that can produce a canonical event, catalogued or not. */
export type SourceId = CatalogSource | 'generic';

export type EventStatus = 'success' | 'failure' | 'warning' | 'info';
export type Severity = 'info' | 'warning' | 'error' | 'critical';

export interface EventTypeDescriptor<S extends CatalogSource = CatalogSource, T extends string = string> {
  /** `kind.action` as stored on an integration and shown in the routing log. */
  readonly type: T;
  readonly source: S;
  /** i18n message id of the human label (the dashboard owns the wording). */
  readonly labelKey: string;
  /**
   * What the type means when the payload says nothing more. A mapper may refine it from the
   * payload (a lost dispute is a failure, a won one a success); it never contradicts it.
   */
  readonly defaultStatus: EventStatus;
  readonly defaultSeverity: Severity;
}

/** failure -> error, warning -> warning, otherwise info. The single status/severity rule. */
export function severityOfStatus(status: EventStatus): Severity {
  if (status === 'failure') return 'error';
  return status === 'warning' ? 'warning' : 'info';
}

type Row<T extends string> = readonly [type: T, status?: EventStatus];

function table<const S extends CatalogSource, const R extends readonly Row<string>[]>(
  source: S,
  labelPrefix: string,
  rows: R,
): { [K in keyof R]: EventTypeDescriptor<S, R[K][0]> } {
  return rows.map(([type, status = 'info']) => ({
    type,
    source,
    labelKey: `${labelPrefix}${type}`,
    defaultStatus: status,
    defaultSeverity: severityOfStatus(status),
  })) as unknown as { [K in keyof R]: EventTypeDescriptor<S, R[K][0]> };
}

/** The `workflow_run.*` conclusions are the documented values of `workflow_run.conclusion`. */
export const GITHUB_DESCRIPTORS = table('github', 'event.', [
  ['issues.opened'],
  ['issues.closed'],
  ['issues.reopened'],
  ['issue_comment.created'],
  ['pull_request.opened'],
  ['pull_request.reopened'],
  ['pull_request.ready_for_review'],
  ['pull_request.merged', 'success'],
  ['pull_request.closed'],
  ['pull_request_review.submitted'],
  ['pull_request_review_comment.created'],
  ['push'],
  ['release.published'],
  ['workflow_run.success', 'success'],
  ['workflow_run.failure', 'failure'],
  ['workflow_run.cancelled'],
  ['workflow_run.timed_out', 'failure'],
  ['deployment_status.created'],
] as const);

export const GITLAB_DESCRIPTORS = table('gitlab', 'sources.event.', [
  ['push'],
  ['tag_push'],
  ['merge_request.opened'],
  ['merge_request.merged', 'success'],
  ['merge_request.closed', 'warning'],
  ['merge_request.reopened'],
  ['issue.opened'],
  ['issue.closed', 'success'],
  ['issue.reopened'],
  ['pipeline.failed', 'failure'],
  ['pipeline.succeeded', 'success'],
] as const);

export const STRIPE_DESCRIPTORS = table('stripe', 'sources.event.', [
  ['invoice.payment_failed', 'failure'],
  ['payment_intent.payment_failed', 'failure'],
  ['charge.dispute.created', 'failure'],
  ['charge.dispute.closed'],
  ['customer.subscription.created'],
  ['customer.subscription.updated'],
  ['customer.subscription.deleted', 'warning'],
] as const);

export const EVENT_CATALOG: Readonly<Record<CatalogSource, readonly EventTypeDescriptor[]>> = {
  github: GITHUB_DESCRIPTORS,
  gitlab: GITLAB_DESCRIPTORS,
  stripe: STRIPE_DESCRIPTORS,
};

const INDEX: Readonly<Record<CatalogSource, ReadonlyMap<string, EventTypeDescriptor>>> = {
  github: new Map(GITHUB_DESCRIPTORS.map((d) => [d.type, d])),
  gitlab: new Map(GITLAB_DESCRIPTORS.map((d) => [d.type, d])),
  stripe: new Map(STRIPE_DESCRIPTORS.map((d) => [d.type, d])),
};

export function isCatalogSource(value: unknown): value is CatalogSource {
  return typeof value === 'string' && (CATALOG_SOURCES as readonly string[]).includes(value);
}

export function descriptorFor(source: CatalogSource, type: string): EventTypeDescriptor | undefined {
  return INDEX[source].get(type);
}
