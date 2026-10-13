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
}

export type Bindings = AuthBindings & {
  DELIVERY_QUEUE: Queue<DeliveryMessage>;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  /** Legacy v0 key. Read-only until the migration job reports zero v0 rows (F37). */
  ENCRYPTION_KEY: string;
  /** Key-encryption keys by version, 64 hex characters each (F34, F37). */
  KEK_V1: string;
  KEK_V2?: string;
  /** Which KEK version wraps new connection keys. */
  KMS_ACTIVE_VERSION: string;
};
