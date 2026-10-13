import { log } from '../platform/log';
import { readStoredFilters } from './filter-input';
import {
  compileFilters,
  evaluateCompiled,
  prepareFacts,
  type CompiledFilters,
  type FilterId,
  type PreparedFacts,
  type RoutingFacts,
} from './filters';
import type { DecisionReason } from './provenance';

/** One integration's routing verdict, ready to record. */
export interface RouteVerdict {
  readonly pass: boolean;
  /** The filter that held the event back; `config` when the stored filters could not be read. */
  readonly filterId: FilterId | 'config' | null;
  readonly reason: DecisionReason;
  readonly unknown: boolean;
}

type Resolved =
  | { readonly kind: 'none' }
  | { readonly kind: 'compiled'; readonly compiled: CompiledFilters }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'newer' };

/**
 * Per-request routing. Facts are extracted and folded at most once, and each distinct stored
 * document is parsed and compiled at most once however many integrations share it (M4).
 *
 * `null` means the integration has no filters: there is nothing to decide or to record, and
 * the delivery row is itself the record.
 *
 * Policy for a stored document that cannot be used (ADR 0010):
 *   - invalid (corrupt, or no longer valid under current limits): FAIL CLOSED. The event is held
 *     back as `filtered` / `config` / `config_invalid`, because a deny rule may be a privacy
 *     control. The API reports `filtersInvalid` and the dashboard blocks until it is replaced.
 *   - written by a newer release (a rollback): fail open as `config_newer`, because the document
 *     may be fine and holding back every filtered integration until the next deploy is worse.
 *   Both log `routing_filters_invalid` (ids and state only) at error level for alerting.
 */
export function createRouteDecider(
  eventType: string,
  extractFacts: () => RoutingFacts,
): (integrationId: string, filtersJson: string | null) => RouteVerdict | null {
  let prepared: PreparedFacts | undefined;
  const cache = new Map<string, Resolved>();

  const resolve = (json: string): Resolved => {
    const stored = readStoredFilters(json);
    switch (stored.kind) {
      case 'none':
        return { kind: 'none' };
      case 'ok':
        return { kind: 'compiled', compiled: compileFilters(stored.config) };
      case 'invalid':
        return { kind: 'invalid' };
      case 'newer':
        return { kind: 'newer' };
    }
  };

  return (integrationId, filtersJson) => {
    if (filtersJson === null || filtersJson === '') return null;
    let resolved = cache.get(filtersJson);
    if (!resolved) {
      resolved = resolve(filtersJson);
      cache.set(filtersJson, resolved);
    }
    switch (resolved.kind) {
      case 'none':
        return null;
      case 'invalid':
        log('error', 'routing_filters_invalid', { integration_id: integrationId, state: 'invalid' });
        return { pass: false, filterId: 'config', reason: 'config_invalid', unknown: false };
      case 'newer':
        log('error', 'routing_filters_invalid', { integration_id: integrationId, state: 'newer_version' });
        return { pass: true, filterId: null, reason: 'config_newer', unknown: false };
      case 'compiled': {
        prepared ??= prepareFacts(extractFacts());
        return evaluateCompiled(resolved.compiled, eventType, prepared);
      }
    }
  };
}
