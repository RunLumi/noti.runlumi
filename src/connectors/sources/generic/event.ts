import { SUMMARY_MAX_CHARS, type DeliveryMessage } from '../../../env';
import { canonicalFromDisplay, type CanonicalEvent } from '../../../events/canonical';
import { cutAt } from '../../../events/text';
import { asRecord } from '../../../lib/json';

/**
 * The documented generic event envelope (ADR 0012, docs/API.md). Hand-validated, strict:
 * unknown keys are rejected so a typo surfaces instead of silently dropping data. Nothing
 * here is fetched or executed; `url` is only ever rendered as a link.
 *
 *   { "type": "deploy.failed", "title": "...", "summary": "...", "url": "https://...",
 *     "severity": "info|warning|error|critical", "actor": "...", "fields": { "k": "v" } }
 */
export const SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const LIMITS = {
  type: 100,
  title: 300,
  summary: 1000,
  url: 2048,
  actor: 100,
  fieldCount: 10,
  fieldKey: 40,
  fieldValue: 200,
} as const;

export interface GenericEvent {
  readonly type: string;
  readonly title: string;
  readonly summary?: string;
  readonly url?: string;
  readonly severity: Severity;
  readonly actor?: string;
  readonly fields: readonly (readonly [string, string])[];
}

export type FieldError = { readonly field: string; readonly message: string };
export type ParsedEvent = { ok: true; event: GenericEvent } | { ok: false; errors: FieldError[] };

const ALLOWED_KEYS = new Set(['type', 'title', 'summary', 'url', 'severity', 'actor', 'fields']);
const TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FIELD_KEY = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
/* eslint-disable no-control-regex -- matching control characters is the point. */
// C0/C1 controls, line/paragraph separators and bidi overrides/isolates: all can make text
// display as something it is not. Single-line fields reject them outright.
const LINE_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
// The summary may span lines: tab and newline are allowed, every other control is not.
const TEXT_UNSAFE =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/* eslint-enable no-control-regex */

function line(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
  errors: FieldError[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max ||
    LINE_UNSAFE.test(value)
  ) {
    errors.push({ field, message: `Use 1–${max} characters on a single line.` });
    return undefined;
  }
  return value.trim();
}

function parseUrl(value: unknown, errors: FieldError[]): string | undefined {
  if (value === undefined) return undefined;
  const bad = (): undefined => {
    errors.push({ field: 'url', message: 'Use an absolute https:// URL without credentials.' });
    return undefined;
  };
  if (typeof value !== 'string' || value.length > LIMITS.url || LINE_UNSAFE.test(value)) return bad();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return bad();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return bad();
  return parsed.href;
}

function parseFields(value: unknown, errors: FieldError[]): [string, string][] {
  if (value === undefined) return [];
  const record = asRecord(value);
  if (!record) {
    errors.push({ field: 'fields', message: 'Must be an object of simple values.' });
    return [];
  }
  const entries = Object.entries(record);
  if (entries.length > LIMITS.fieldCount) {
    errors.push({ field: 'fields', message: `At most ${LIMITS.fieldCount} fields.` });
    return [];
  }
  const out: [string, string][] = [];
  for (const [key, raw] of entries) {
    const text =
      typeof raw === 'number' && Number.isFinite(raw)
        ? String(raw)
        : typeof raw === 'boolean'
          ? String(raw)
          : raw;
    if (
      key.length > LIMITS.fieldKey ||
      !FIELD_KEY.test(key) ||
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > LIMITS.fieldValue ||
      LINE_UNSAFE.test(text)
    ) {
      errors.push({
        field: 'fields',
        message: `Keys: letters, digits, space, _ . - up to ${LIMITS.fieldKey}. Values: text, number or true/false, up to ${LIMITS.fieldValue} characters.`,
      });
      return [];
    }
    out.push([key, text]);
  }
  return out;
}

export function parseGenericEvent(body: unknown): ParsedEvent {
  const r = asRecord(body);
  if (!r) return { ok: false, errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  const errors: FieldError[] = [];
  for (const key of Object.keys(r)) {
    if (!ALLOWED_KEYS.has(key)) errors.push({ field: key, message: 'Unknown field.' });
  }
  const type = line(r.type, 'type', LIMITS.type, true, errors);
  if (type !== undefined && !TYPE.test(type))
    errors.push({ field: 'type', message: 'Use letters, digits and . _ : - (for example deploy.failed).' });
  // `test` and `noti.*` belong to Noti: the sender chooses this string, so it must never be able
  // to name an event as one of ours (ADR 0018).
  if (type !== undefined && (type === 'test' || type.toLowerCase().startsWith('noti.')))
    errors.push({
      field: 'type',
      message: 'This event type is reserved. Choose another (for example deploy.failed).',
    });
  const title = line(r.title, 'title', LIMITS.title, true, errors);
  const actor = line(r.actor, 'actor', LIMITS.actor, false, errors);
  let summary: string | undefined;
  if (r.summary !== undefined) {
    if (typeof r.summary !== 'string' || r.summary.length > LIMITS.summary || TEXT_UNSAFE.test(r.summary))
      errors.push({ field: 'summary', message: `Use up to ${LIMITS.summary} characters of plain text.` });
    else summary = r.summary.trim() || undefined;
  }
  let severity: Severity = 'info';
  if (r.severity !== undefined) {
    if ((SEVERITIES as readonly unknown[]).includes(r.severity)) severity = r.severity as Severity;
    else errors.push({ field: 'severity', message: `Use one of: ${SEVERITIES.join(', ')}.` });
  }
  const url = parseUrl(r.url, errors);
  const fields = parseFields(r.fields, errors);
  if (errors.length > 0 || type === undefined || title === undefined) return { ok: false, errors };
  return {
    ok: true,
    event: {
      type,
      title,
      severity,
      fields,
      ...(summary ? { summary } : {}),
      ...(url ? { url } : {}),
      ...(actor ? { actor } : {}),
    },
  };
}

type Display = Pick<DeliveryMessage, 'title' | 'url' | 'actor' | 'status' | 'eventType' | 'summary'>;

/** info → info, warning → warning, error and critical → failure. */
export function statusOfSeverity(severity: Severity): NonNullable<DeliveryMessage['status']> {
  if (severity === 'warning') return 'warning';
  return severity === 'info' ? 'info' : 'failure';
}

/**
 * The canonical display fields the delivery path already carries (DeliveryMessage). The
 * summary is the sender's summary followed by one `key: value · key: value` line, cut to the
 * shared SUMMARY_MAX_CHARS budget; an ellipsis marks a cut, so truncation is never silent.
 */
export function toDisplayFields(event: GenericEvent): Display {
  const fieldsLine = event.fields.map(([k, v]) => `${k}: ${v}`).join(' · ');
  const joined = [event.summary, fieldsLine].filter((p): p is string => !!p).join('\n');
  const summary =
    joined.length > SUMMARY_MAX_CHARS ? `${cutAt(joined, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : joined;
  return {
    title: event.title,
    url: event.url ?? '',
    status: statusOfSeverity(event.severity),
    eventType: event.type,
    ...(event.actor ? { actor: event.actor } : {}),
    ...(summary ? { summary } : {}),
  };
}

/** Version of the generic mapping; recorded on every canonical event (spec 04 F54). */
export const GENERIC_ADAPTER_VERSION = '1.0.0';

/**
 * The generic event as a canonical event. `id` is the signed `webhook-id`; the severity the sender
 * chose is kept as is (it can be `critical`, which has no status of its own). The `source` is the
 * product, not the sender: a generic endpoint has no public identity beyond its secret URL.
 */
export function toCanonicalEvent(event: GenericEvent, id: string): CanonicalEvent {
  const canonical = canonicalFromDisplay({
    provider: 'generic',
    adapterVersion: GENERIC_ADAPTER_VERSION,
    id,
    source: 'urn:lumi:noti:generic',
    display: toDisplayFields(event),
  });
  return { ...canonical, data: { ...canonical.data, severity: event.severity } };
}
