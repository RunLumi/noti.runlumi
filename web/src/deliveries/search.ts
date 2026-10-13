import { isDeliveryState, type DeliveryFilters, type DeliveryState } from './api';

/**
 * Filters live in the URL (docs/specs/14 F213) so a support reply can link to exactly what
 * the user is looking at. Anything that does not validate is dropped rather than trusted.
 */
export interface ActivitySearch {
  readonly state?: DeliveryState;
  readonly integration?: string;
  readonly from?: string;
  readonly to?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DATE.test(value)) return undefined;
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? undefined : value;
}

export function validateActivitySearch(search: Record<string, unknown>): ActivitySearch {
  const state = isDeliveryState(search.state) ? search.state : undefined;
  const integration =
    typeof search.integration === 'string' && search.integration.length > 0 && search.integration.length <= 64
      ? search.integration
      : undefined;
  const from = validDate(search.from);
  const to = validDate(search.to);
  return {
    ...(state ? { state } : {}),
    ...(integration ? { integration } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

export function toFilters(search: ActivitySearch): DeliveryFilters {
  return {
    ...(search.state ? { state: search.state } : {}),
    ...(search.integration ? { integrationId: search.integration } : {}),
    ...(search.from ? { from: search.from } : {}),
    ...(search.to ? { to: search.to } : {}),
  };
}

export function hasFilters(search: ActivitySearch): boolean {
  return Object.keys(toFilters(search)).length > 0;
}
