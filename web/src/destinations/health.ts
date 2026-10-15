import type { Integration } from '../lib/api';

/**
 * One row of the Destinations health page (ADR 0056), derived only from what
 * `GET /api/integrations` already returns: the breaker and pacing state (`health`, ADR 0023),
 * the switch and the credential state. Nothing is computed that the server did not report. When
 * the server sends no `health` object the row says "not reported" (`null` here), never a zero or
 * a guess that the destination is fine.
 */
export type Sending = 'closed' | 'open' | 'half_open';
export type CredentialHealth = 'ok' | 'legacy' | 'quarantined' | 'revoked';

export interface DestinationRow {
  readonly integration: Integration;
  /** The breaker state, or `null` when the server has no health record. */
  readonly sending: Sending | null;
  /** When an open breaker allows the next try (ISO), as reported. */
  readonly retryAt: string | null;
  /** The destination asked Noti to slow down until this instant (ISO), as reported. */
  readonly pacedUntil: string | null;
  /** Failures in a row, or `null` when not reported. */
  readonly consecutiveFailures: number | null;
  /** How often the breaker has opened, or `null` when not reported. */
  readonly timesOpened: number | null;
  readonly credentials: CredentialHealth;
}

export function destinationRow(integration: Integration): DestinationRow {
  const health = integration.health ?? null;
  return {
    integration,
    sending: health?.state ?? null,
    retryAt: health && health.state !== 'closed' ? health.retryAt : null,
    pacedUntil: health?.pacedUntil ?? null,
    consecutiveFailures: health ? health.consecutiveFailures : null,
    timesOpened: health ? health.timesOpened : null,
    // A revoke keeps `credentials` at `quarantined` (F40); the page names the cause the person chose.
    credentials: integration.revoked ? 'revoked' : integration.credentials,
  };
}
