import { asRecord } from '../lib/json';
import { descriptorFor, isCatalogSource, type EventStatus, type Severity, type SourceId } from './catalog';
import {
  CANONICAL_BUDGET_BYTES,
  CANONICAL_LIMITS as L,
  CANONICAL_SPECVERSION,
  CANONICAL_TYPE_PREFIX,
  type ActorKind,
  type CanonicalActor,
  type CanonicalData,
  type CanonicalEvent,
  type CanonicalFacts,
} from './canonical';
import { hasUnsafeText } from './text';

/**
 * Runtime validation of a canonical event (spec 04 F41, F45). Hand-written and bounded: it reads
 * a fixed set of keys, never recurses into unknown structure, and rejects rather than repairs. A
 * mapper that produces an invalid event has a bug; the route answers `schema_invalid` before any
 * database write, so an invalid event can never reach a renderer.
 *
 * Errors name the field and a fixed reason, never the offending value (it is untrusted text).
 */
export type ValidationReason =
  | 'required'
  | 'unknown_field'
  | 'wrong_type'
  | 'too_long'
  | 'unsafe_text'
  | 'bad_value'
  | 'not_in_catalog'
  | 'payload_too_large';

export interface ValidationIssue {
  readonly field: string;
  readonly reason: ValidationReason;
}

export type ValidationResult =
  | { readonly ok: true; readonly event: CanonicalEvent }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

const PROVIDERS: readonly SourceId[] = ['github', 'gitlab', 'stripe', 'generic'];
const STATUSES: readonly EventStatus[] = ['success', 'failure', 'warning', 'info'];
const SEVERITIES: readonly Severity[] = ['info', 'warning', 'error', 'critical'];
const ACTOR_KINDS: readonly ActorKind[] = ['user', 'bot', 'ghost', 'unknown'];

const TOP_KEYS = new Set([
  'specversion',
  'id',
  'source',
  'type',
  'subject',
  'time',
  'dataschema',
  'provider',
  'adapterversion',
  'data',
]);
const DATA_KEYS = new Set(['title', 'summary', 'url', 'repo', 'actor', 'status', 'severity', 'facts']);
const ACTOR_KEYS = new Set(['login', 'type', 'isBot', 'isGhost']);
const FACT_KEYS = new Set(['branch', 'baseBranch', 'draft', 'labels']);

/** A CloudEvents extension attribute name: lower-case letters and digits only. */
const ATTRIBUTE_NAME = /^[a-z0-9]+$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Generic event types are sender-chosen labels; this is the shape ADR 0012 allows. */
const GENERIC_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ADAPTER_VERSION = /^\d+\.\d+\.\d+$/;

class Collector {
  readonly errors: ValidationIssue[] = [];
  add(field: string, reason: ValidationReason): void {
    this.errors.push({ field, reason });
  }
}

function checkKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  c: Collector,
) {
  for (const key of Object.keys(record)) if (!allowed.has(key)) c.add(`${prefix}${key}`, 'unknown_field');
}

/** A required or optional bounded text field. A JSON `null` is "unset" (F41). */
function text(
  record: Record<string, unknown>,
  key: string,
  field: string,
  max: number,
  required: boolean,
  c: Collector,
  allowNewlines = false,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    if (required) c.add(field, 'required');
    return undefined;
  }
  if (typeof value !== 'string') {
    c.add(field, 'wrong_type');
    return undefined;
  }
  if (value.length === 0) {
    if (required) c.add(field, 'required');
    else c.add(field, 'bad_value');
    return undefined;
  }
  if (value.length > max) {
    c.add(field, 'too_long');
    return undefined;
  }
  if (hasUnsafeText(value, allowNewlines)) {
    c.add(field, 'unsafe_text');
    return undefined;
  }
  return value;
}

function isRfc3339(value: string): boolean {
  const m = RFC3339.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (y === undefined || mo === undefined || d === undefined || h === undefined) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || (mi ?? 0) > 59 || (s ?? 0) > 60) return false;
  return !Number.isNaN(Date.parse(value));
}

/** An absolute `https:` URI without credentials. */
function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname !== '';
  } catch {
    return false;
  }
}

function isUriReference(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    // A scheme-qualified URI (https:, urn:) is required for `source`: a bare relative path is
    // valid CloudEvents but identifies nothing across tenants.
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateActor(value: unknown, c: Collector): CanonicalActor | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (!record) {
    c.add('data.actor', 'wrong_type');
    return undefined;
  }
  checkKeys(record, ACTOR_KEYS, 'data.actor.', c);
  const login = text(record, 'login', 'data.actor.login', L.actor, true, c);
  const type = record.type;
  if (typeof type !== 'string' || !ACTOR_KINDS.includes(type as ActorKind))
    c.add('data.actor.type', 'bad_value');
  const isBot = record.isBot;
  if (isBot !== null && typeof isBot !== 'boolean') c.add('data.actor.isBot', 'wrong_type');
  const isGhost = record.isGhost;
  if (typeof isGhost !== 'boolean') c.add('data.actor.isGhost', 'wrong_type');
  if (login === undefined || typeof type !== 'string') return undefined;
  return {
    login,
    type: type as ActorKind,
    isBot: typeof isBot === 'boolean' ? isBot : null,
    isGhost: isGhost === true,
  };
}

function nullableText(
  record: Record<string, unknown>,
  key: string,
  field: string,
  max: number,
  c: Collector,
): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  return text(record, key, field, max, false, c) ?? null;
}

function validateFacts(value: unknown, c: Collector): CanonicalFacts {
  const record = asRecord(value);
  if (!record) {
    c.add('data.facts', value === undefined ? 'required' : 'wrong_type');
    return { branch: null, baseBranch: null, draft: null, labels: null };
  }
  checkKeys(record, FACT_KEYS, 'data.facts.', c);
  const draft = record.draft;
  if (draft !== null && draft !== undefined && typeof draft !== 'boolean')
    c.add('data.facts.draft', 'wrong_type');
  let labels: string[] | null = null;
  const rawLabels = record.labels;
  if (rawLabels !== null && rawLabels !== undefined) {
    if (!Array.isArray(rawLabels)) c.add('data.facts.labels', 'wrong_type');
    else if (rawLabels.length > L.labelCount) c.add('data.facts.labels', 'too_long');
    else {
      labels = [];
      for (const label of rawLabels) {
        if (typeof label !== 'string' || label.length === 0) c.add('data.facts.labels', 'wrong_type');
        else if (label.length > L.label) c.add('data.facts.labels', 'too_long');
        else if (hasUnsafeText(label)) c.add('data.facts.labels', 'unsafe_text');
        else labels.push(label);
      }
    }
  }
  return {
    branch: nullableText(record, 'branch', 'data.facts.branch', L.branch, c),
    baseBranch: nullableText(record, 'baseBranch', 'data.facts.baseBranch', L.branch, c),
    draft: typeof draft === 'boolean' ? draft : null,
    labels,
  };
}

function validateData(value: unknown, c: Collector): CanonicalData | undefined {
  const record = asRecord(value);
  if (!record) {
    c.add('data', value === undefined ? 'required' : 'wrong_type');
    return undefined;
  }
  checkKeys(record, DATA_KEYS, 'data.', c);
  const title = text(record, 'title', 'data.title', L.title, true, c);
  // A summary may span lines (generic events list their fields on a second line).
  const summary = text(record, 'summary', 'data.summary', L.summary, false, c, true);
  const url = text(record, 'url', 'data.url', L.url, false, c);
  if (url !== undefined && !isHttpsUrl(url)) c.add('data.url', 'bad_value');
  const repo = text(record, 'repo', 'data.repo', L.repo, false, c);
  const actor = validateActor(record.actor, c);
  const status = record.status;
  if (typeof status !== 'string' || !STATUSES.includes(status as EventStatus))
    c.add('data.status', 'bad_value');
  const severity = record.severity;
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity as Severity))
    c.add('data.severity', 'bad_value');
  const facts = validateFacts(record.facts, c);
  if (title === undefined || typeof status !== 'string' || typeof severity !== 'string') return undefined;
  return {
    title,
    status: status as EventStatus,
    severity: severity as Severity,
    facts,
    ...(summary !== undefined ? { summary } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(actor ? { actor } : {}),
  };
}

function validateType(type: string | undefined, provider: unknown, c: Collector): void {
  if (type === undefined) return;
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as SourceId)) {
    c.add('provider', 'bad_value');
    return;
  }
  const prefix = `${CANONICAL_TYPE_PREFIX}${provider}.`;
  if (!type.startsWith(prefix)) {
    c.add('type', 'bad_value');
    return;
  }
  const eventType = type.slice(prefix.length);
  if (isCatalogSource(provider)) {
    // Closed catalogue (F42): a catalogued source can only produce its catalogued types.
    if (!descriptorFor(provider, eventType)) c.add('type', 'not_in_catalog');
  } else if (!GENERIC_TYPE.test(eventType)) c.add('type', 'bad_value');
}

/** Serialised size in bytes, for the F45 budget. */
export function canonicalSizeBytes(event: CanonicalEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).length;
}

export function validateCanonicalEvent(input: unknown): ValidationResult {
  const record = asRecord(input);
  if (!record) return { ok: false, errors: [{ field: 'event', reason: 'wrong_type' }] };
  const c = new Collector();
  checkKeys(record, TOP_KEYS, '', c);
  for (const key of Object.keys(record)) if (!ATTRIBUTE_NAME.test(key)) c.add(key, 'bad_value');

  if (record.specversion !== CANONICAL_SPECVERSION) c.add('specversion', 'bad_value');
  const id = text(record, 'id', 'id', L.id, true, c);
  const source = text(record, 'source', 'source', L.source, true, c);
  if (source !== undefined && !isUriReference(source)) c.add('source', 'bad_value');
  const type = text(record, 'type', 'type', L.type, true, c);
  validateType(type, record.provider, c);
  const subject = text(record, 'subject', 'subject', L.subject, false, c);
  const time = text(record, 'time', 'time', 64, false, c);
  if (time !== undefined && !isRfc3339(time)) c.add('time', 'bad_value');
  const dataschema = text(record, 'dataschema', 'dataschema', L.dataschema, true, c);
  if (dataschema !== undefined && !isUriReference(dataschema)) c.add('dataschema', 'bad_value');
  const adapterversion = text(record, 'adapterversion', 'adapterversion', L.adapterversion, true, c);
  if (adapterversion !== undefined && !ADAPTER_VERSION.test(adapterversion))
    c.add('adapterversion', 'bad_value');
  const data = validateData(record.data, c);

  if (
    c.errors.length > 0 ||
    id === undefined ||
    source === undefined ||
    type === undefined ||
    dataschema === undefined ||
    adapterversion === undefined ||
    data === undefined
  )
    return { ok: false, errors: c.errors };

  const event: CanonicalEvent = {
    specversion: CANONICAL_SPECVERSION,
    id,
    source,
    type,
    dataschema,
    provider: record.provider as SourceId,
    adapterversion,
    data,
    ...(subject !== undefined ? { subject } : {}),
    ...(time !== undefined ? { time } : {}),
  };
  if (canonicalSizeBytes(event) > CANONICAL_BUDGET_BYTES)
    return { ok: false, errors: [{ field: 'event', reason: 'payload_too_large' }] };
  return { ok: true, event };
}
