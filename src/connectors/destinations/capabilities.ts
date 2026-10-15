import { DESTINATION_REGISTRY } from './kind-registry';
import type { DestinationCapabilities, DestinationKind } from './types';

/**
 * The verified capability matrix (docs/DESTINATION_API_REFERENCE.md §7, read 2026-10-13). The
 * per-mode values, their provider limits and the citations for them live in the kind registry
 * (`kind-registry.ts`, F105, ADR 0052); this is the accessor every adapter uses.
 */
export function capabilitiesFor(kind: DestinationKind): DestinationCapabilities {
  return DESTINATION_REGISTRY[kind].capabilities;
}
