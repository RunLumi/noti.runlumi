import type { SourceId } from '../../events/catalog';
import type { SourceConnector } from './connector';
import { genericContract } from './generic/contract';
import { githubConnector } from './github';
import { connectorFor } from './registry';
import { PROVIDER_KINDS, type SourceContract } from './types';

/**
 * Every source Noti accepts events from, as its contract (spec 05 F71, ADR 0057). The shared
 * conformance suite (tests/conformance) runs once per entry against the real route, so a source is
 * not "supported" until it is listed here and passes.
 *
 * Worker-only: the GitHub connector touches D1. The dashboard reads the endpoint registry instead.
 */
export const SOURCE_CONNECTORS: readonly SourceConnector[] = [
  githubConnector,
  ...PROVIDER_KINDS.map(connectorFor),
];

export const SOURCE_CONTRACTS: readonly SourceContract<SourceId>[] = [
  githubConnector,
  genericContract,
  ...PROVIDER_KINDS.map(connectorFor),
];
