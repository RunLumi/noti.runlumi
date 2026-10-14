/**
 * The shape of a request id, with no runtime dependency, so the dashboard and the audit read model can
 * validate one without importing the Worker's AsyncLocalStorage (`./correlation.ts` re-exports these).
 */

/** Printable, URL- and log-safe, and short enough that it cannot bloat a log line. */
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/;

/** Returns the value when it is a sane opaque handle (4-64 chars, restricted set), else null. */
export function sanitiseExternalId(value: string | null | undefined): string | null {
  return typeof value === 'string' && EXTERNAL_ID.test(value) ? value : null;
}

/**
 * An id read back from a queue message, a query string or a stored row: our own opaque id or a sane
 * handle, 4-64 characters from a restricted set. Anything else is dropped, never repaired.
 */
export function sanitiseCorrelationId(value: unknown): string | null {
  return typeof value === 'string' ? sanitiseExternalId(value) : null;
}
