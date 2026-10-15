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

/**
 * F143 and F144 gaps: the noise summaries read correctly through the two adapters people look at
 * most. Slack's top-level `text` is what a screen reader and the notification preview read (so it
 * must carry the summary, not just the title); Discord's single embed must carry the collapsed
 * counts and elision line, and a digest embed must not carry a URL that Discord would dedupe.
 */
const held = (over: Partial<HeldItem>): HeldItem => ({
  id: 'x',
  holdReason: 'grouped',
  groupKey: 'g-default',
  heldAt: 1,
  eventType: 'issue_comment.created',
  title: 'Comment on #7',
  url: 'https://github.com/acme/web/issues/7#issuecomment-1',
  repo: 'acme/web',
  actor: 'alice',
  status: 'info',
  summary: '',
  resolved: false,
  ...over,
});

function parsed(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

describe('noise summaries through the Slack and Discord renderers', () => {
  it('Slack: the top-level text carries the count, the newest-first list and the failure marker', async () => {
    const group = renderGroup([
      held({ id: 'a', heldAt: 1, title: 'Comment on #7' }),
      held({ id: 'b', heldAt: 2, title: 'Comment on #7 again' }),
      held({
        id: 'c',
        heldAt: 3,
        title: 'Fix build',
        status: 'failure',
        url: 'https://github.com/acme/web/actions/runs/9',
      }),
    ]);
    const prepared = await prepare('slack', asMessage({ ...group }));
    const payload = parsed(prepared.request.body);
    const text = String(payload.text);
    expect(text).toContain('3 updates combined, newest first:');
    expect(text).toContain('✗ acme/web: Fix build');
    expect(text).toContain('• acme/web: Comment on #7 again');
    // The block header carries the title with the count; the section carries the summary as plain text.
    const blocks = payload.blocks as { type: string; text?: { text?: string } }[];
    expect(blocks[0]?.text?.text).toContain('· 3 updates');
    expect(prepared.message.truncatedFields).not.toContain('summary');
  });

  it('Slack: a digest collapses one key into a counted line, and the top-level text says so', async () => {
    const items: HeldItem[] = [
      ...Array.from({ length: 12 }, (_, i) =>
        held({ id: `r${i}`, heldAt: i + 1, holdReason: 'digest', groupKey: 'same', title: `Comment ${i}` }),
      ),
      held({
        id: 'f',
        heldAt: 100,
        holdReason: 'digest',
        groupKey: 'other',
        status: 'failure',
        title: 'Deploy failed',
      }),
    ];
    const [part] = renderDigestParts(items, 'digest');
    if (!part) throw new Error('no digest part');
    const prepared = await prepare('slack', asMessage({ ...part }));
    const text = String(parsed(prepared.request.body).text);
    expect(text).toContain('13 updates since the last summary:');
    expect(text).toContain('(×12)');
    // Failures first: the failure line is above the collapsed comments.
    expect(text.indexOf('✗ acme/web: Deploy failed')).toBeLessThan(text.indexOf('(×12)'));
    expect(text).not.toContain('not shown');
  });

  it('Slack: a split digest says which part it is and that it continues, and the last part states what it left out', async () => {
    const items = Array.from({ length: 80 }, (_, i) =>
      held({
        id: `d${i}`,
        heldAt: i + 1,
        holdReason: 'digest',
        groupKey: String(i).padStart(32, '0'),
        title: `Build ${i} ${'x'.repeat(70)}`,
        url: `https://github.com/acme/web/actions/runs/${i}`,
        status: 'warning',
      }),
    );
    const parts = renderDigestParts(items, 'digest');
    expect(parts.length).toBeGreaterThan(1);
    const first = await prepare('slack', asMessage({ ...parts[0] }));
    expect(String(parsed(first.request.body).text)).toContain(`(part 1 of ${parts.length})`);
    expect(String(parsed(first.request.body).text)).toContain('Continued in the next message.');
    const last = parts.at(-1);
    if (!last) throw new Error('no parts');
    const lastPrepared = await prepare('slack', asMessage({ ...last }));
    const lastText = String(parsed(lastPrepared.request.body).text);
    expect(lastText).toContain(`(part ${parts.length} of ${parts.length})`);
    if (last.notShown > 0)
      expect(lastText).toMatch(/and \d+ more items not shown\. Their details are not kept\./);
  });

  it('Discord: the group embed carries the count and the list, with one URL that is the newest update', async () => {
    const group = renderGroup([
      held({ id: 'a', heldAt: 1, title: 'Comment on #7', url: 'https://github.com/acme/web/issues/7#1' }),
      held({
        id: 'b',
        heldAt: 2,
        title: 'Comment on #7 again',
        url: 'https://github.com/acme/web/issues/7#2',
      }),
    ]);
    const prepared = await prepare('discord', asMessage({ ...group }));
    const payload = parsed(prepared.request.body) as {
      content?: string;
      embeds: { title: string; url?: string; description?: string }[];
    };
    expect(payload.embeds).toHaveLength(1);
    const [embed] = payload.embeds;
    expect(embed?.title).toContain('· 2 updates');
    expect(embed?.description).toContain('2 updates combined, newest first:');
    expect(embed?.description).toContain('• acme/web: Comment on #7 again');
    expect(embed?.url).toBe('https://github.com/acme/web/issues/7#2');
    expect(payload.content ?? '').toContain('2 updates');
  });

  it('Discord: a digest has no embed URL (so none can be deduplicated) and states its collapsed counts', async () => {
    const items: HeldItem[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        held({ id: `r${i}`, heldAt: i + 1, holdReason: 'digest', groupKey: 'same', title: `Comment ${i}` }),
      ),
      held({
        id: 'f',
        heldAt: 50,
        holdReason: 'digest',
        groupKey: 'other',
        status: 'failure',
        title: 'Deploy failed',
      }),
    ];
    const [part] = renderDigestParts(items, 'digest');
    if (!part) throw new Error('no digest part');
    const prepared = await prepare('discord', asMessage({ ...part }));
    const payload = parsed(prepared.request.body) as { embeds: { url?: string; description?: string }[] };
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0]?.url).toBeUndefined();
    expect(payload.embeds[0]?.description).toContain('(×5)');
    expect(payload.embeds[0]?.description).toContain('✗ acme/web: Deploy failed');
  });
});
