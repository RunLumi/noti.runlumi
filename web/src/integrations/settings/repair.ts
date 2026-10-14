import type { DeliveryItem } from '../../deliveries/api';
import type { Integration } from '../../lib/api';

/**
 * What needs repairing on an integration, from facts the server reported (spec 14 F217 "repair
 * panel"). Each kind names one next action and where it is on the settings page. Nothing here
 * is guessed: a kind appears only when the saved integration or its latest delivery says so, and
 * disappears when the next delivery succeeds or the setting is fixed.
 */
export type RepairKind =
  'quarantined' | 'destination_rejected' | 'breaker_open' | 'filters_unreadable' | 'noise_unreadable';

export interface Repair {
  readonly kind: RepairKind;
  /** The section that holds the fix, as an in-page anchor. */
  readonly target: 'credentials' | 'destination' | 'filters' | 'noise';
}

/** The destination answered that the saved address is no longer accepted: only a new address helps. */
const REJECTED_CODES: ReadonlySet<string> = new Set([
  'destination_revoked',
  'destination_credentials_invalid',
  'destination_unauthorized',
  'destination_url_rejected',
]);

/**
 * `recent` is the integration's deliveries, newest first. Only the newest one speaks for the
 * present: an old failure that a later delivery has since cleared is history, not a repair.
 */
export function repairsFor(integration: Integration, recent: readonly DeliveryItem[]): readonly Repair[] {
  const out: Repair[] = [];
  const latest = recent[0];
  if (integration.credentials === 'quarantined') out.push({ kind: 'quarantined', target: 'credentials' });
  else if (
    latest !== undefined &&
    latest.state === 'dead_lettered' &&
    latest.error !== null &&
    REJECTED_CODES.has(latest.error.code)
  )
    out.push({ kind: 'destination_rejected', target: 'credentials' });
  if (integration.enabled && integration.health?.state === 'open')
    out.push({ kind: 'breaker_open', target: 'destination' });
  if (integration.filtersInvalid) out.push({ kind: 'filters_unreadable', target: 'filters' });
  if (integration.noiseInvalid) out.push({ kind: 'noise_unreadable', target: 'noise' });
  return out;
}

export interface HealthSummary {
  readonly lastDelivered: DeliveryItem | null;
  readonly lastFailed: DeliveryItem | null;
  readonly considered: number;
}

/** Last success and last failure within the deliveries given; honest about how many it looked at. */
export function summariseHealth(recent: readonly DeliveryItem[]): HealthSummary {
  return {
    lastDelivered: recent.find((d) => d.state === 'sent' || d.state === 'accepted') ?? null,
    lastFailed: recent.find((d) => d.state === 'dead_lettered') ?? null,
    considered: recent.length,
  };
}
