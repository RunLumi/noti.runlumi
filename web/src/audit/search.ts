import {
  AUDIT_SUBJECT_TYPES,
  isAuditAction,
  type AuditFilters,
  type AuditOutcome,
  type AuditSubjectType,
} from './api';
import type { AuditAction } from '../../../src/audit/actions';

/**
 * Filters live in the URL, as on the activity page, so a link shows what the sender saw. Anything
 * that does not validate is dropped rather than trusted.
 */
export interface AuditSearch {
  readonly action?: AuditAction;
  readonly outcome?: AuditOutcome;
  readonly actor?: string;
  readonly target?: string;
  readonly targetType?: AuditSubjectType;
  readonly correlationId?: string;
  readonly from?: string;
  readonly to?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The same shapes the server accepts (src/api/audit-view.ts); anything else is dropped here, not sent.
const ACTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Printable text, 1 to 200 characters: the same rule as the server (`validTarget`, src/api/audit-view.ts). */
const validTargetText = (value: string): boolean =>
  value.length >= 1 &&
  value.length <= 200 &&
  Array.from(value).every((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/;

export const isValidTarget = validTargetText;
export const isValidRequestId = (value: string): boolean => REQUEST_ID.test(value);

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DATE.test(value)) return undefined;
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? undefined : value;
}

export function validateAuditSearch(search: Record<string, unknown>): AuditSearch {
  const action = isAuditAction(search.action) ? search.action : undefined;
  const outcome = search.outcome === 'success' || search.outcome === 'denied' ? search.outcome : undefined;
  const from = validDate(search.from);
  const to = validDate(search.to);
  const actor = search.actor === '~system' ? '~system' : matching(search.actor, ACTOR_ID);
  const target =
    typeof search.target === 'string' && validTargetText(search.target) ? search.target : undefined;
  const targetType = AUDIT_SUBJECT_TYPES.find((t) => t === search.targetType);
  const correlationId = matching(search.correlationId, REQUEST_ID);
  return {
    ...(action ? { action } : {}),
    ...(outcome ? { outcome } : {}),
    ...(actor ? { actor } : {}),
    ...(target ? { target } : {}),
    ...(targetType ? { targetType } : {}),
    ...(correlationId ? { correlationId } : {}),
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
