import { AUDIT_ACTIONS, type AuditAction } from '../../../src/audit/actions';
import { ApiError, api } from '../lib/api';

/** Audit log client (docs/API.md "Audit log"). The server returns allow-listed facts only. */

export { AUDIT_ACTIONS, type AuditAction };
export type AuditOutcome = 'success' | 'denied';

export type AuditActor =
  | { readonly kind: 'member'; readonly name: string }
  | { readonly kind: 'system' }
  | { readonly kind: 'other' };

export type SummaryValue = string | number | boolean | readonly string[];
export interface SummaryItem {
  readonly key: string;
  readonly value: SummaryValue;
}

export interface AuditEvent {
  readonly id: string;
  readonly createdAt: string;
  /** Usually an `AuditAction`; a value from a newer release is kept and shown generically. */
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly outcome: AuditOutcome;
  readonly actor: AuditActor;
  readonly summary: readonly SummaryItem[];
}

export interface AuditPage {
  readonly events: readonly AuditEvent[];
  readonly nextCursor: string | null;
  readonly retentionDays: number;
}

export interface AuditFilters {
  readonly action?: AuditAction;
  readonly outcome?: AuditOutcome;
  readonly from?: string;
  readonly to?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAuditAction(value: unknown): value is AuditAction {
  return AUDIT_ACTIONS.some((a) => a === value);
}

const bad = (what: string) => new ApiError(`Unexpected ${what} shape`, 500);

function parseActor(value: unknown): AuditActor {
  if (isRecord(value) && value.kind === 'member' && typeof value.name === 'string')
    return { kind: 'member', name: value.name };
  if (isRecord(value) && value.kind === 'system') return { kind: 'system' };
  if (isRecord(value) && value.kind === 'other') return { kind: 'other' };
  throw bad('audit actor');
}

function parseSummary(value: unknown): SummaryItem[] {
  if (!Array.isArray(value)) throw bad('audit summary');
  return value.flatMap((item: unknown): SummaryItem[] => {
    if (!isRecord(item) || typeof item.key !== 'string') return [];
    const v = item.value;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      return [{ key: item.key, value: v }];
    if (Array.isArray(v))
      return [{ key: item.key, value: v.filter((x): x is string => typeof x === 'string') }];
    return [];
  });
}

/** Narrow one row. A malformed row is an error, never silently dropped (F225). */
export function parseAuditEvent(value: unknown): AuditEvent {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.action !== 'string' ||
    typeof value.subjectType !== 'string' ||
    (value.subjectId !== null && typeof value.subjectId !== 'string') ||
    (value.outcome !== 'success' && value.outcome !== 'denied')
  )
    throw bad('audit event');
  return {
    id: value.id,
    createdAt: value.createdAt,
    action: value.action,
    subjectType: value.subjectType,
    subjectId: value.subjectId,
    outcome: value.outcome,
    actor: parseActor(value.actor),
    summary: parseSummary(value.summary),
  };
}

function query(orgId: string, filters: AuditFilters, cursor: string | null): string {
  const params = new URLSearchParams({ org: orgId });
  if (filters.action) params.set('action', filters.action);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export const auditApi = {
  list: async (orgId: string, filters: AuditFilters, cursor: string | null): Promise<AuditPage> => {
    const body = await api<unknown>(`/api/audit?${query(orgId, filters, cursor)}`);
    if (
      !isRecord(body) ||
      !Array.isArray(body.events) ||
      (body.nextCursor !== null && typeof body.nextCursor !== 'string') ||
      typeof body.retentionDays !== 'number'
    )
      throw bad('audit list');
    return {
      events: body.events.map(parseAuditEvent),
      nextCursor: body.nextCursor,
      retentionDays: body.retentionDays,
    };
  },
};
