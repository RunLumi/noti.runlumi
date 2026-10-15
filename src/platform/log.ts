/**
 * Structured logging (docs/specs/01-platform-runtime.md F11, docs/specs/13-observability.md F194/F195,
 * ADR 0051).
 *
 * - `msg` is a member of the closed catalogue in `./log-events`; an unknown event or an undeclared field
 *   is a compile error.
 * - Every line goes through `redact()` (F12) exactly once, here, before it is emitted, so a field that
 *   happens to carry a URL or token cannot reach the log. This file is the only place in `src/` allowed
 *   to call `console` (ESLint `no-console`; `tests/security/log-redaction-site.test.ts`).
 * - A line is held to `LOG_LINE_BUDGET_BYTES`. An oversized line is never cut mid-JSON: string values
 *   are shortened (never inside a `[redacted]` or other marker), then fields are dropped, and the line
 *   says which happened in `log_truncated`.
 */
import { correlationFields } from './correlation';
import { type LogEvent, type LogEventField } from './log-events';
import { redact, truncateSafely, type Redacted, type RedactedObject } from './redact';

export type LogLevel = 'info' | 'warn' | 'error';

/** Fields that may be passed for every event: an explicit correlation id overrides the request's. */
type CommonField = 'correlation_id';

/** The declared fields of `E`, each optional. */
export type LogFields<E extends LogEvent> = { readonly [K in LogEventField<E> | CommonField]?: unknown };

/** `F` with every key `E` does not declare mapped to `never`, so spreads are checked as well as literals. */
type Declared<E extends LogEvent, F> = F & {
  readonly [K in Exclude<keyof F, LogEventField<E> | CommonField>]: never;
};

/**
 * Bytes per line (UTF-8). Workers keep at most 256 KB of logs, exceptions and metadata per invocation
 * (developers.cloudflare.com/workers/platform/limits/); the delivery consumer handles up to 5 messages
 * per batch with a few lines each, so 4 KiB a line keeps a whole batch well inside that.
 */
export const LOG_LINE_BUDGET_BYTES = 4096;

/** Keys `log()` owns. A field can never overwrite them, and they survive every budget step. */
const RESERVED = ['ts', 'level', 'msg'] as const;
const KEPT_WHEN_DROPPING: ReadonlySet<string> = new Set([
  ...RESERVED,
  'correlation_id',
  'external_request_id',
  'cf_ray',
]);
/** String caps tried in order when a line is over budget. */
const SHRINK_STEPS = [256, 64, 16] as const;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

export function logLine<E extends LogEvent, F extends LogFields<E> = LogFields<E>>(
  level: LogLevel,
  msg: E,
  fields?: Declared<E, F>,
): string {
  const head = { ts: new Date().toISOString(), level, msg };
  const merged: Record<string, unknown> = { ...head, ...correlationFields() };
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!(RESERVED as readonly string[]).includes(key)) merged[key] = value;
  }
  // The one redaction site for log output (F195). Everything below works on its result.
  const redacted = redact(merged);
  if (!isObject(redacted)) return JSON.stringify({ ...head, redaction_failed: true });
  return withinBudget(redacted);
}

export function log<E extends LogEvent, F extends LogFields<E> = LogFields<E>>(
  level: LogLevel,
  msg: E,
  fields?: Declared<E, F>,
): void {
  const line = logLine<E, F>(level, msg, fields);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

function isObject(value: Redacted): value is RedactedObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Serialise, shortening strings and then dropping fields until the line fits. Always valid JSON. */
export function withinBudget(line: RedactedObject, budget: number = LOG_LINE_BUDGET_BYTES): string {
  const whole = JSON.stringify(line);
  if (byteLength(whole) <= budget) return whole;
  for (const cap of SHRINK_STEPS) {
    const shrunk: Record<string, Redacted> = {};
    for (const [key, value] of Object.entries(line))
      shrunk[key] = KEPT_WHEN_DROPPING.has(key) ? value : shrinkStrings(value, cap);
    const text = JSON.stringify({ ...shrunk, log_truncated: 'values' });
    if (byteLength(text) <= budget) return text;
  }
  const kept: Record<string, Redacted> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(line)) {
    if (KEPT_WHEN_DROPPING.has(key)) kept[key] = value;
    else dropped++;
  }
  return JSON.stringify({ ...kept, log_truncated: 'fields_dropped', dropped_fields: dropped });
}

/** Shorten every string (already scrubbed) with the redactor's marker-safe cut. */
function shrinkStrings(value: Redacted, cap: number): Redacted {
  if (typeof value === 'string') return truncateSafely(value, cap);
  if (Array.isArray(value)) return (value as readonly Redacted[]).map((v) => shrinkStrings(v, cap));
  if (isObject(value)) {
    const out: Record<string, Redacted> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrinkStrings(v, cap);
    return out;
  }
  return value;
}
