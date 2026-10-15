import { Link } from '@tanstack/react-router';
import { IconAlertTriangle, IconShieldLock } from '@tabler/icons-react';
import type { Integration } from '../lib/api';
import { t } from '../i18n';
import { DESTINATIONS } from './destinations';
import { useLocale } from '../i18n/LocaleProvider';

interface CredentialsNoticeProps {
  readonly integration: Integration;
  /** On the settings page the fix is the form below, so no link is needed. */
  readonly showFix?: boolean;
}

/**
 * Explains a non-`ok` credentials state in plain words with the one action that fixes it.
 * Quarantined is a stop (red rail): nothing is delivered. Legacy is advisory (amber rail).
 */
export function CredentialsNotice({ integration, showFix = true }: CredentialsNoticeProps) {
  useLocale();
  if (integration.credentials === 'ok') return null;
  const quarantined = integration.credentials === 'quarantined';
  const destination = t(DESTINATIONS[integration.destination].name);
  // A revoke is the customer's own decision, so it is explained as that, not as a fault of ours.
  const kind = integration.revoked ? 'revoked' : quarantined ? 'quarantined' : 'legacy';
  return (
    <div className={quarantined ? 'cred-notice cred-notice-stop' : 'cred-notice cred-notice-advice'}>
      {quarantined ? (
        <IconAlertTriangle size={20} aria-hidden="true" />
      ) : (
        <IconShieldLock size={20} aria-hidden="true" />
      )}
      <div>
        <p className="cred-notice-title">{t(`credentials.${kind}.title`)}</p>
        <p className="cred-notice-body">{t(`credentials.${kind}.body`, { destination })}</p>
        {showFix && (
          <Link
            to="/integrations/$id"
            params={{ id: integration.id }}
            hash="credentials"
            className="btn btn-outline cred-notice-action"
          >
            {t('credentials.fix')}
          </Link>
        )}
      </div>
    </div>
  );
}
