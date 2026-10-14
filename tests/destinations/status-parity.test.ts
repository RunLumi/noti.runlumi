import { describe, expect, it } from 'vitest';
import {
  prepareDelivery,
  validateDestinationConfig,
  type DestinationKind,
} from '../../src/connectors/destinations';
import { canonicalFromDisplay, displayOf } from '../../src/events/canonical';
import { toNotification } from '../../src/pipeline/consumer';
import { DISCORD_URL, LARK_URL, SLACK_URL, TEAMS_URL } from './fixtures';

/**
 * An absent status and an explicit `info` do NOT render alike: `info` carries the status label,
 * absent does not. That is deliberate and old: it only affects queue messages written before
 * slice 5, which have no status. Every message the ingress routes build today carries one, because
 * a canonical event always has a status, so nothing current can hit the unlabelled form. This test
 * pins both halves so neither can change unnoticed.
 */
const URLS: Record<string, string> = {
  slack: SLACK_URL,
  lark: LARK_URL,
  teams: TEAMS_URL,
  discord: DISCORD_URL,
};
const base = {
  id: 'd',
  integrationId: 'i',
  organizationId: 'o',
  title: 'Something happened',
  url: 'https://a.test/x',
  eventType: 'push',
};

describe('status on rendered messages', () => {
  for (const kind of ['slack', 'lark', 'teams', 'discord'] as const satisfies readonly DestinationKind[]) {
    it(`${kind}: an explicit info is labelled, a legacy message with no status is not`, async () => {
      const checked = validateDestinationConfig({ kind, webhookUrl: URLS[kind] });
      if (!checked.ok) throw new Error('config');
      const render = async (extra: object) => {
        const prepared = await prepareDelivery(checked.config, toNotification({ ...base, ...extra }), {
          now: 1,
        });
        if (!prepared.ok) throw new Error('render');
        return JSON.stringify(prepared.message.payload);
      };
      expect(await render({ status: 'info' })).toMatch(/Info/);
      expect(await render({})).not.toMatch(/Info/);
    });
  }

  it('a canonical event always yields an explicit status, so current messages are never unlabelled', () => {
    for (const status of [undefined, 'info', 'failure'] as const) {
      const event = canonicalFromDisplay({
        provider: 'gitlab',
        adapterVersion: '1.0.0',
        id: 'i',
        source: 'https://gitlab.com',
        display: { title: 't', url: '', eventType: 'push', ...(status ? { status } : {}) },
      });
      expect(displayOf(event).status).toBeDefined();
    }
  });
});
