/**
 * Narrow an untrusted value to a plain object. Provider payloads are `unknown` until
 * proven otherwise — this is the boundary that stops an attacker-chosen field from
 * reaching a query. See docs/specs/00-current-state.md D3.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a non-empty string field, or undefined. Never coerces; coercion hides bugs. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
