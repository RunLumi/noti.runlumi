import { isAuditAction, type AuditFilters, type AuditOutcome } from './api';
import type { AuditAction } from '../../../src/audit/actions';

/**
 * Filters live in the URL, as on the activity page, so a link shows what the sender saw. Anything
 * that does not validate is dropped rather than trusted.
 */
export interface AuditSearch {
  readonly action?: AuditAction;
  readonly outcome?: AuditOutcome;
  readonly from?: string;
  readonly to?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DATE.test(value)) return undefined;
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? undefined : value;
}

export function validateAuditSearch(search: Record<string, unknown>): AuditSearch {
  const action = isAuditAction(search.action) ? search.action : undefined;
  const outcome = search.outcome === 'success' || search.outcome === 'denied' ? search.outcome : undefined;
  const from = validDate(search.from);
  const to = validDate(search.to);
  return {
    ...(action ? { action } : {}),
    ...(outcome ? { outcome } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

export function toAuditFilters(search: AuditSearch): AuditFilters {
  return { ...search };
}

export function hasAuditFilters(search: AuditSearch): boolean {
  return Object.keys(search).length > 0;
}
