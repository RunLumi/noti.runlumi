import type { DestinationAdapter } from './adapter';
import type { ValidatedDestinationConfig } from './config';
import { discordAdapter } from './discord/adapter';
import { genericWebhookAdapter } from './generic-webhook/adapter';
import type { DestinationKind } from './kind-registry';
import { larkAdapter } from './lark/adapter';
import { slackAdapter } from './slack/adapter';
import { teamsAdapter } from './teams/adapter';

/** The validated configuration of one kind. */
export type ConfigOf<K extends DestinationKind> = Extract<ValidatedDestinationConfig, { kind: K }>;

/**
 * F105: the adapter bound to each registered kind (ADR 0052). A mapped type over
 * `DESTINATION_KINDS`, so a kind without an adapter, or an adapter bound to the wrong kind's
 * config, does not compile; `tests/destinations/kind-registry.test.ts` also checks that every
 * `*\/adapter.ts` module is bound here and that each entry's `kind` is its key.
 */
export const ADAPTERS: { readonly [K in DestinationKind]: DestinationAdapter<ConfigOf<K>> } = {
  lark: larkAdapter,
  slack: slackAdapter,
  teams: teamsAdapter,
  discord: discordAdapter,
  generic_webhook: genericWebhookAdapter,
};

/**
 * The adapter for a validated config. The return type is widened to the config union (adapter
 * methods are bivariant in their parameter), because TypeScript cannot correlate
 * `ADAPTERS[config.kind]` with `config`; the mapped type above is what guarantees each key holds
 * its own kind's adapter, so the config passed back in is always that adapter's kind.
 */
export function adapterFor(
  config: ValidatedDestinationConfig,
): DestinationAdapter<ValidatedDestinationConfig> {
  return ADAPTERS[config.kind];
}

/** The adapter for a stored kind, for the parts of the contract that need no config. */
export function adapterOfKind(kind: DestinationKind): DestinationAdapter<ValidatedDestinationConfig> {
  return ADAPTERS[kind];
}
