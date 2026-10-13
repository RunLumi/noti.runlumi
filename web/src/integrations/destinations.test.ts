import { describe, expect, it } from 'vitest';
import { DESTINATION_KINDS } from '../../../src/connectors/destinations/types';
import { en } from '../i18n/messages.en';
import { isDestinationKind } from '../lib/api';
import { DESTINATIONS, DESTINATION_ORDER } from './destinations';

describe('destination catalogue', () => {
  it('lists every kind the server can store, once, and each has all of its copy', () => {
    expect([...DESTINATION_ORDER].sort()).toEqual([...DESTINATION_KINDS].sort());
    for (const kind of DESTINATION_KINDS) {
      expect(isDestinationKind(kind)).toBe(true);
      const info = DESTINATIONS[kind];
      expect(info.kind).toBe(kind);
      const ids = [
        info.name,
        info.where,
        info.what,
        info.urlHint,
        info.wrongHost,
        info.docsLabel,
        ...info.steps,
        ...(info.notes ?? []),
      ];
      for (const id of ids) expect(en[id], `${kind}: ${id}`).toBeTruthy();
      expect(info.docsUrl.startsWith('https://')).toBe(true);
    }
  });

  it('only the custom webhook issues a signing secret, and only Lark accepts one', () => {
    expect(DESTINATION_ORDER.filter((k) => DESTINATIONS[k].issuesSigningSecret)).toEqual(['generic_webhook']);
    expect(DESTINATION_ORDER.filter((k) => DESTINATIONS[k].supportsSigningSecret)).toEqual(['lark']);
  });

  it('tells the person what Noti cannot promise for each new destination', () => {
    expect(en['destination.generic_webhook.noteChecked']).toMatch(/cannot re-check/);
    expect(en['destination.generic_webhook.noteEvidence']).toMatch(/only evidence/);
    expect(en['destination.discord.noteDeleted']).toMatch(/pauses/);
  });

  it('does not accept a kind the server cannot store', () => {
    expect(isDestinationKind('telegram')).toBe(false);
    expect(isDestinationKind(undefined)).toBe(false);
  });
});
