import { classifyGithubEvent } from '../../src/connectors/sources/github/events';
import { isGithubEventType } from '../../src/connectors/sources/github/catalog';
import { buildCanonical } from '../../src/connectors/sources/build';
import { parseGenericEvent } from '../../src/connectors/sources/generic/event';
import { connectorFor } from '../../src/connectors/sources/registry';
import {
  prepareDelivery,
  validateDestinationConfig,
  type DestinationKind,
} from '../../src/connectors/destinations';
import type { CanonicalEvent } from '../../src/events/canonical';
import type { SourceId } from '../../src/events/catalog';
import type { DeliveryMessage } from '../../src/env';
import { toNotification } from '../../src/pipeline/consumer';
import { DISCORD_URL, LARK_URL, SLACK_URL, TEAMS_URL } from '../destinations/fixtures';

/** The id every pure mapping in the suites uses, so goldens do not depend on random delivery ids. */
export const FIXED_ID = 'fixture-delivery-id';

/**
 * What the route's mapper step produces for a verified payload, called the same way the route
 * calls it. `null` when the route would not deliver (outside the catalogue, ignored, rejected).
 */
export function normalize(
  provider: SourceId,
  headers: Readonly<Record<string, string>>,
  json: Record<string, unknown>,
  id: string = FIXED_ID,
): CanonicalEvent | null {
  if (provider === 'github') {
    const kind = headers['x-github-event'] ?? '';
    const eventType = classifyGithubEvent(kind, json);
    return isGithubEventType(eventType)
      ? buildCanonical({ provider, kind, event: json, eventType, id })
      : null;
  }
  if (provider === 'generic') {
    const parsed = parseGenericEvent(json);
    return parsed.ok ? buildCanonical({ provider, event: parsed.event, id }) : null;
  }
  const mapped = connectorFor(provider).map({
    headers: new Headers(headers),
    body: json,
    source: { livemode: provider === 'stripe' ? false : null },
  });
  if (mapped.outcome !== 'deliver') return null;
  return buildCanonical({ provider, display: mapped.display, id: mapped.eventId ?? id });
}

const URLS: Partial<Record<DestinationKind, string>> = {
  slack: SLACK_URL,
  lark: LARK_URL,
  teams: TEAMS_URL,
  discord: DISCORD_URL,
};
export const RENDER_KINDS = ['slack', 'lark', 'teams', 'discord'] as const;

/** The payload each destination would send for a queued message (render only, no network). */
export async function renderAll(message: DeliveryMessage): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const kind of RENDER_KINDS) {
    const checked = validateDestinationConfig({ kind, webhookUrl: URLS[kind] });
    if (!checked.ok) throw new Error(`destination config ${kind}`);
    const prepared = await prepareDelivery(checked.config, toNotification(message), {
      now: Date.parse('2026-10-14T00:00:00Z'),
    });
    out[kind] = prepared.ok
      ? { format: prepared.message.format, payload: prepared.message.payload }
      : { failed: prepared.reason };
  }
  return out;
}
