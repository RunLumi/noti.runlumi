import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, type AuditAction } from '../../../src/audit/actions';
import { ApiError, api } from '../lib/api';

/** Audit log client (docs/API.md "Audit log"). The server returns allow-listed facts only. */

export { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, type AuditAction };
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];
export type AuditOutcome = 'success' | 'denied';

export type AuditActor =
  | { readonly kind: 'member'; readonly name: string }
  | { readonly kind: 'system' }
  | { readonly kind: 'former' }
  | { readonly kind: 'other' };

export type SummaryValue = string | number | boolean | readonly string[];
export interface SummaryItem {
  readonly key: string;
  readonly value: SummaryValue;
}

/** Before and after of a field an update changed (only a few non-secret fields have one). */
export type FieldChange =
  | {
      readonly field: 'enabled' | 'repo';
      readonly kind: 'value';
      readonly before: string | boolean;
      readonly after: string | boolean;
    }
  | {
      readonly field: 'eventTypes';
      readonly kind: 'list';
      readonly added: readonly string[];
      readonly removed: readonly string[];
    };

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
  /** The request this change was made in; null for older rows and for background jobs. */
  readonly correlationId: string | null;
  readonly changes: readonly FieldChange[];
}

export interface AuditPage {
  readonly events: readonly AuditEvent[];
  readonly nextCursor: string | null;
  readonly retentionDays: number;
  /** How many events match the filters (first page only), counted up to a cap. */
  readonly total: number | null;
  readonly totalCapped: boolean;
}

export interface AuditFilters {
  readonly action?: AuditAction;
  readonly outcome?: AuditOutcome;
  /** A member's user id, or `system`. */
  readonly actor?: string;
  readonly target?: string;
  readonly targetType?: AuditSubjectType;
  readonly correlationId?: string;
  readonly from?: string;
  readonly to?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAuditSubjectType(value: unknown): value is AuditSubjectType {
  return AUDIT_SUBJECT_TYPES.some((t) => t === value);
}

export function isAuditAction(value: unknown): value is AuditAction {
  return AUDIT_ACTIONS.some((a) => a === value);
}

const bad = (what: string) => new ApiError(`Unexpected ${what} shape`, 500);

function parseActor(value: unknown): AuditActor {
  if (isRecord(value) && value.kind === 'member' && typeof value.name === 'string')
    return { kind: 'member', name: value.name };
  if (isRecord(value) && value.kind === 'system') return { kind: 'system' };
  if (isRecord(value) && value.kind === 'former') return { kind: 'former' };
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

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** A malformed change is dropped: it only decorates a row the log already shows. */
function parseChanges(value: unknown): FieldChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): FieldChange[] => {
    if (!isRecord(item)) return [];
    if (
      item.kind === 'value' &&
      (item.field === 'enabled' || item.field === 'repo') &&
      (typeof item.before === 'string' || typeof item.before === 'boolean') &&
      (typeof item.after === 'string' || typeof item.after === 'boolean')
    )
      return [{ field: item.field, kind: 'value', before: item.before, after: item.after }];
    if (item.kind === 'list' && item.field === 'eventTypes')
      return [
        { field: 'eventTypes', kind: 'list', added: strings(item.added), removed: strings(item.removed) },
      ];
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
    correlationId: typeof value.correlationId === 'string' ? value.correlationId : null,
    changes: parseChanges(value.changes),
  };
}

function query(orgId: string, filters: AuditFilters, cursor: string | null): string {
  const params = new URLSearchParams({ org: orgId });
  if (filters.action) params.set('action', filters.action);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.target) params.set('target', filters.target);
  if (filters.targetType) params.set('targetType', filters.targetType);
  if (filters.correlationId) params.set('correlationId', filters.correlationId);
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
      typeof body.retentionDays !== 'number' ||
      (body.total !== null && body.total !== undefined && typeof body.total !== 'number')
    )
      throw bad('audit list');
    return {
      events: body.events.map(parseAuditEvent),
      nextCursor: body.nextCursor,
      retentionDays: body.retentionDays,
      total: typeof body.total === 'number' ? body.total : null,
      totalCapped: body.totalCapped === true,
    };
  },
};
