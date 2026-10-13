/**
 * The destination kinds an integration may use. The outbound URL allowlist lives in exactly
 * one place, `connectors/destinations/url-policy.ts`, applied by `validateDestinationConfig`
 * at write time and again before every send (ADR 0006); this module does not duplicate it.
 */
export type { DestinationKind } from '../connectors/destinations/types';
