import { cleanLine, cutAt } from '../../events/text';
import { asRecord } from '../../lib/json';

/**
 * Helpers shared by the provider mappers. Every string that reaches a notification came from
 * a third party, so it is treated as untrusted display text: controls, line separators and
 * bidirectional overrides are removed, length is bounded, and a URL is kept only if it is an
 * absolute `https:` link without credentials. Nothing here parses markup or follows a link.
 */

/**
 * The shared summary budget. It equals `SUMMARY_MAX_CHARS` in src/env.ts (a test asserts it);
 * it is repeated here so the dashboard, which imports the connector catalogues, never has to
 * load the Worker's environment types.
 */
export const SUMMARY_BUDGET = 280;

/** One line of display text: unsafe characters become spaces, whitespace collapses, cut with an ellipsis. */
export function clean(value: unknown, max: number): string {
  return cleanLine(value, max);
}

/** An `https:` URL without credentials, or '' (no link). Optionally restricted to host suffixes. */
export function safeHttpsUrl(value: unknown, hostSuffixes?: readonly string[]): string {
  if (typeof value !== 'string' || value.length > 2048) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return '';
  if (hostSuffixes) {
    const host = url.hostname.toLowerCase();
    if (!hostSuffixes.some((s) => host === s || host.endsWith(`.${s}`))) return '';
  }
  return url.href;
}

/** Join non-empty parts with a middle dot and cut to the shared summary budget. */
export function joinSummary(parts: readonly (string | undefined | false)[]): string {
  const joined = parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' · ');
  return joined.length > SUMMARY_BUDGET ? `${cutAt(joined, SUMMARY_BUDGET - 1).trimEnd()}…` : joined;
}

/** A property of a record when it is itself a record. */
export function child(parent: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return parent ? asRecord(parent[key]) : null;
}
