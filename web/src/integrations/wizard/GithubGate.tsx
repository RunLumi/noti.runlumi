import type { UseQueryResult } from '@tanstack/react-query';
import { IconBrandGithub } from '@tabler/icons-react';
import { Notice } from '../../components/ui';
import type { GithubConnection } from '../../lib/api';
import { t } from '../../i18n';
import { describeError } from '../errors';
import { ConnectGithubButton } from '../github/ConnectGithubButton';
import { useLocale } from '../../i18n/LocaleProvider';

interface GithubGateProps {
  readonly orgId: string;
  readonly connection: UseQueryResult<GithubConnection>;
}

/**
 * The wizard's first step while the workspace has no active GitHub installation. Connecting
 * is a full-page trip to GitHub; nothing has been typed yet, so nothing is lost.
 */
export function GithubGate({ orgId, connection }: GithubGateProps) {
  useLocale();
  if (connection.isPending)
    return (
      <p className="field-hint" aria-busy="true">
        {t('github.loading')}
      </p>
    );
  if (connection.isError)
    return (
      <Notice kind="error">
        <p>{t('github.error')}</p>
        <p>{describeError(connection.error).message}</p>
      </Notice>
    );
  if (!connection.data.configured)
    return (
      <Notice kind="warning">
        <p className="notice-title">{t('github.notConfigured.title')}</p>
        <p>{t('github.notConfigured.body')}</p>
      </Notice>
    );
  return (
    <div className="github-gate">
      <div className="empty-icon">
        <IconBrandGithub size={24} aria-hidden="true" />
      </div>
      <h3>{t('repo.none.title')}</h3>
      <p>{t('repo.none.body')}</p>
      <ConnectGithubButton orgId={orgId} />
      <p className="field-hint">{t('github.samlHint')}</p>
    </div>
  );
}
