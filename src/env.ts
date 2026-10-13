import type { AuthBindings } from './auth/better-auth';

/**
 * A queue message carries identifiers and display text only — never a credential, sealed
 * or not (D5, F173). The consumer re-reads the integration, scoped to `organizationId`,
 * and opens its credentials itself.
 */
export interface DeliveryMessage {
  readonly id: string;
  readonly integrationId: string;
  /** Resolved from the verified installation. The consumer re-checks it against the row. */
  readonly organizationId: string;
  readonly title: string;
  readonly url: string;
  /**
   * Canonical display fields (slice 5). All optional: rows and queue messages written before
   * this slice lack them and still deliver, with defaults. Bounded, display-only text; never
   * the provider payload.
   */
  readonly repo?: string;
  /** The sender's login. */
  readonly actor?: string;
  readonly status?: 'success' | 'failure' | 'warning' | 'info';
  /** Catalog event type, e.g. `workflow_run.failure`. */
  readonly eventType?: string;
  /** At most {@link SUMMARY_MAX_CHARS}; derived from a few scalar fields, not the body. */
  readonly summary?: string;
  /**
   * Set only on a notification that stands for several updates (a group or a digest, noise
   * control). It raises the summary bound to {@link COMBINED_SUMMARY_MAX_CHARS}, because the
   * summary then lists the items. 1..500.
   */
  readonly count?: number;
}

export const SUMMARY_MAX_CHARS = 280;
/** Summary bound for a combined notification; destination adapters still fit it to their caps. */
export const COMBINED_SUMMARY_MAX_CHARS = 1800;
export const COMBINED_COUNT_MAX = 500;

export type Bindings = AuthBindings & {
  /** Static assets of the dashboard build (ADR 0017). Absent only under `vite dev`. */
  ASSETS?: Fetcher;
  DELIVERY_QUEUE: Queue<DeliveryMessage>;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  /** Public App slug (github.com/apps/<slug>). Not a secret. */
  GITHUB_APP_SLUG: string;
  /** OAuth client id of the App, used for the install-verification leg. Not a secret. */
  GITHUB_CLIENT_ID: string;
  /** OAuth client secret of the App. Secret. */
  GITHUB_CLIENT_SECRET: string;
  /** Legacy v0 key. Read-only until the migration job reports zero v0 rows (F37). */
  ENCRYPTION_KEY: string;
  /** Key-encryption keys by version, 64 hex characters each (F34, F37). */
  KEK_V1: string;
  KEK_V2?: string;
  /** Which KEK version wraps new connection keys. */
  KMS_ACTIVE_VERSION: string;
  /** Delivery ledger retention in days (30..365, default 90). See src/pipeline/retention.ts. */
  DELIVERY_RETENTION_DAYS?: string;
  /**
   * `"true"` turns on the custom-webhook destination (create, re-enable and send). Off by
   * default; see ADR 0014 for the criteria that must be met first.
   */
  GENERIC_WEBHOOK_ENABLED?: string;
  /** Audit event retention in days (30..3650, default 365). */
  AUDIT_RETENTION_DAYS?: string;
};
