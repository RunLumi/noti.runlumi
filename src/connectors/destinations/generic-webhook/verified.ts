/**
 * Proof that a custom webhook's host passed the workspace allowlist and the resolution check
 * (host-control.ts) for THIS send. `sendRequest` refuses a `generic_webhook` request without one, so a new
 * caller of the send path cannot reach a customer host by forgetting the check (ADR 0029, review M3).
 * The type is branded: only {@link mintHostVerification} makes one, and tests/security/egress.test.ts pins
 * that it is called from host-control.ts alone.
 */
declare const verified: unique symbol;

export interface HostVerification {
  readonly [verified]: true;
  /** The lower-case hostname that was verified; `sendRequest` compares it with the request URL's host. */
  readonly host: string;
}

export function mintHostVerification(host: string): HostVerification {
  return { host: host.toLowerCase() } as HostVerification;
}
