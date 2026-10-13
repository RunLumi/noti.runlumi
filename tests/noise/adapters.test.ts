import { describe, expect, it } from 'vitest';
import {
  capabilitiesFor,
  prepareDelivery,
  validateDestinationConfig,
  type DestinationKind,
} from '../../src/connectors/destinations';
import { generateSigningSecret } from '../../src/connectors/sources/generic/encoding';
import type { DeliveryMessage } from '../../src/env';
import { toNotification } from '../../src/pipeline/consumer';
import { parseDeliveryMessage } from '../../src/pipeline/outbox';
import { renderDigestParts, renderGroup, type HeldItem } from '../../src/routing/noise-render';
import { DISCORD_URL, GENERIC_URL, LARK_URL, SLACK_URL, TEAMS_URL } from '../destinations/fixtures';

/**
 * A released group or digest, at the largest sizes the renderer can produce, through every
 * destination adapter: the closing "not shown" line must survive the adapter's own fitting (a
 * review finding), Discord's single-embed and 2000-character `content` rules must hold (F143), and
 * the custom webhook's body cap must hold.
 */
const URLS: Record<DestinationKind, string> = {
  slack: SLACK_URL,
  lark: LARK_URL,
  teams: TEAMS_URL,
  discord: DISCORD_URL,
  generic_webhook: GENERIC_URL,
};
const KINDS = ['slack', 'lark', 'teams', 'discord', 'generic_webhook'] as const;

/** Worst-case items: maximal fields, markup characters and non-ASCII text in the title. */
const widest = (n: number): HeldItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${String(i).padStart(4, '0')}`,
    holdReason: 'digest' as const,
    groupKey: String(i).padStart(32, '0'),
    heldAt: 1000 + i,
    eventType: 'issues.opened',
    title: `T${'é<>&*_`'.repeat(60)}`,
    url: `https://example.test/${'1'.repeat(100)}`,
    repo: 'r'.repeat(200),
    actor: 'a'.repeat(100),
    status: 'failure' as const,
    summary: 's'.repeat(280),
    resolved: false,
  }));

async function prepare(kind: DestinationKind, message: DeliveryMessage) {
  const checked = validateDestinationConfig({
    kind,
    webhookUrl: URLS[kind],
    ...(kind === 'generic_webhook' ? { signingSecret: generateSigningSecret() } : {}),
  });
  if (!checked.ok) throw new Error('fixture config rejected');
  const prepared = await prepareDelivery(checked.config, toNotification(message), {
    now: Date.now(),
    meta: { deliveryId: 'delivery-fixture-1', organizationId: 'org-fixture-1' },
  });
  if (!prepared.ok) throw new Error(`render failed: ${prepared.reason}`);
  return prepared;
}

const asMessage = (fields: object): DeliveryMessage =>
  parseDeliveryMessage({
    id: 'a',
    integrationId: 'b',
    organizationId: 'c',
    url: '',
    ...fields,
  }) as DeliveryMessage;

describe('combined notifications through every adapter', () => {
  it.each(KINDS)('the last digest part keeps its closing line intact for %s', async (kind) => {
    const last = renderDigestParts(widest(500), 'digest').at(-1);
    if (!last) throw new Error('no parts');
    const prepared = await prepare(kind, asMessage({ ...last }));
    // Nothing the ladder cut may be the summary: the closing line would go with it.
    expect(prepared.message.truncatedFields).not.toContain('summary');
    expect(prepared.request.body).toContain('Their details are not kept.');
    expect(new TextEncoder().encode(prepared.request.body).length).toBeLessThanOrEqual(
      capabilitiesFor(kind).maxBodyBytes,
    );
  });

  it.each(KINDS)('a combined group keeps its "and N more" line intact for %s', async (kind) => {
    const prepared = await prepare(kind, asMessage({ ...renderGroup(widest(12)) }));
    expect(prepared.message.truncatedFields).not.toContain('summary');
    expect(prepared.request.body).toMatch(/and \d+ more not shown\./);
  });

  it('Discord: at most one embed, no repeated embed URL, content within 2000, mentions inert', async () => {
    for (const fields of [renderGroup(widest(12)), renderDigestParts(widest(40), 'digest')[0]]) {
      const prepared = await prepare('discord', asMessage({ ...fields }));
      const payload = JSON.parse(prepared.request.body) as {
        content?: string;
        embeds?: { url?: string }[];
        allowed_mentions: { parse: string[] };
      };
      expect(payload.embeds?.length ?? 1).toBeLessThanOrEqual(1);
      const embedUrls = (payload.embeds ?? []).map((e) => e.url).filter(Boolean);
      expect(new Set(embedUrls).size).toBe(embedUrls.length);
      expect((payload.content ?? '').length).toBeLessThanOrEqual(2000);
      expect(payload.allowed_mentions).toEqual({ parse: [] });
    }
  });
});
