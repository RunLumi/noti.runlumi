import { t, tp } from '../i18n';
import { EVENT_LABEL, isGithubEventType, sortEvents } from './events';
import { useLocale } from '../i18n/LocaleProvider';

interface EventListProps {
  readonly eventTypes: readonly string[];
  /** Show at most this many; the rest are summarised as "+N more". */
  readonly limit?: number;
}

/** Subscribed updates in plain language. Unknown legacy values are shown, never hidden. */
export function EventList({ eventTypes, limit }: EventListProps) {
  useLocale();
  const sorted = sortEvents(eventTypes);
  const shown = limit === undefined ? sorted : sorted.slice(0, limit);
  const hidden = sorted.length - shown.length;
  return (
    <ul className="event-chips">
      {shown.map((type) => (
        <li key={type} className={isGithubEventType(type) ? 'event-chip' : 'event-chip event-chip-unknown'}>
          {isGithubEventType(type) ? t(EVENT_LABEL[type]) : t('integration.events.unknown', { type })}
        </li>
      ))}
      {hidden > 0 && <li className="event-chip event-chip-more">{tp('integration.events.more', hidden)}</li>}
    </ul>
  );
}
