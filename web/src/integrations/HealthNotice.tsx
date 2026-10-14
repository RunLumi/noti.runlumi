import { Link } from '@tanstack/react-router';
import { IconGauge, IconPlayerPause } from '@tabler/icons-react';
import type { Integration } from '../lib/api';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { absoluteTime } from '../deliveries/Time';
import { DESTINATIONS } from './destinations';

interface HealthNoticeProps {
  readonly integration: Integration;
}

/**
 * The delivery circuit breaker and the destination's own rate-limit hold (ADR 0023). It is shown,
 * never enforced on the person: Noti stops hammering a failing destination and says so, and it
 * never turns the integration off. Shape and words carry the meaning; colour is only a rail.
 */
export function HealthNotice({ integration }: HealthNoticeProps) {
  useLocale();
  const health = integration.health;
  if (!health || !integration.enabled) return null;
  const destination = t(DESTINATIONS[integration.destination].name);
  let title: string | null = null;
  let body: string | null = null;
  if (health.state === 'open') {
    title = t('health.open.title');
    body = t('health.open.body', { time: health.retryAt ? absoluteTime(health.retryAt) : '' });
  } else if (health.state === 'half_open') {
    title = t('health.halfOpen.title');
    body = t('health.halfOpen.body', { destination });
  } else if (health.pacedUntil) {
    title = t('health.paced.title');
    body = t('health.paced.body', { destination, time: absoluteTime(health.pacedUntil) });
  }
  if (!title || !body) return null;
  const Icon = health.state === 'closed' ? IconGauge : IconPlayerPause;
  return (
    <div className="cred-notice cred-notice-advice" role="status">
      <Icon size={20} aria-hidden="true" />
      <div>
        <p className="cred-notice-title">{title}</p>
        <p className="cred-notice-body">{body}</p>
        <Link
          to="/activity"
          search={{ state: 'retrying', integration: integration.id }}
          className="text-link"
        >
          {t('health.waiting')}
        </Link>
      </div>
    </div>
  );
}
