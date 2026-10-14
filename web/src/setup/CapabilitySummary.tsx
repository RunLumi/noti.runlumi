import { IconCheck, IconMinus } from '@tabler/icons-react';
import type { DestinationKind } from '../lib/api';
import { DESTINATIONS } from '../integrations/destinations';
import { t, type MessageId } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { ABILITIES } from './abilities';

interface Row {
  readonly yes: boolean;
  readonly text: MessageId;
}

function Ability({ yes, text, name }: Row & { name: string }) {
  useLocale();
  return (
    <li className={yes ? 'ability ability-yes' : 'ability ability-no'}>
      <span className="ability-mark" aria-hidden="true">
        {yes ? <IconCheck size={16} /> : <IconMinus size={16} />}
      </span>
      <span>
        <span className="visually-hidden">{t(yes ? 'ability.included' : 'ability.limit')}: </span>
        {t(text, { destination: name })}
      </span>
    </li>
  );
}

/**
 * What the chosen destination can show, before anything is saved (spec 14 F211). Every line is
 * one the adapter does today (`abilities.ts`, checked against the capability matrix); a limit
 * is listed as a limit, with a minus and the word "Limitation", never left out to look better.
 */
export function CapabilitySummary({ kind }: { kind: DestinationKind }) {
  useLocale();
  const a = ABILITIES[kind];
  const name = t(DESTINATIONS[kind].name);
  // Only what is true is listed as included; what is not is listed as a limit, in its own words.
  const rows: readonly Row[] = [
    { yes: true, text: a.layout === 'card' ? 'ability.card' : 'ability.json' },
    ...(a.links ? [{ yes: true, text: 'ability.links' } as const] : []),
    ...(a.plainFallback ? [{ yes: true, text: 'ability.plain' } as const] : []),
    a.confirmation === 'delivered'
      ? { yes: true, text: 'ability.confirmed' }
      : { yes: false, text: 'ability.accepted' },
    ...(a.signed ? [{ yes: true, text: 'ability.signed' } as const] : []),
    ...(a.mentions ? [] : [{ yes: false, text: 'ability.noMentions' } as const]),
    ...(a.redactsContactDetails ? [{ yes: false, text: 'ability.redacts' } as const] : []),
  ];
  return (
    <section className="ability-summary" aria-labelledby={`abilities-${kind}`}>
      <h3 id={`abilities-${kind}`}>{t('ability.title', { destination: name })}</h3>
      <ul className="ability-list">
        {rows.map((row) => (
          <Ability key={row.text} {...row} name={name} />
        ))}
      </ul>
    </section>
  );
}
