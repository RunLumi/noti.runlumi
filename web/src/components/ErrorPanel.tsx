import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { ApiError } from '../lib/api';
import { errorKind, type ErrorKind } from '../integrations/errors';
import { t, type MessageId } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { Button } from './ui';
import './state.css';

/**
 * Plain-language errors in four parts (spec 14 F220, F225): what happened, why, what to do, and
 * how to get help. The words come from our catalogue and are chosen by the kind of failure;
 * server text and exception messages never reach the screen. The only machine detail is the
 * HTTP status, shown as a reference to quote.
 */
const WHY: Readonly<Record<ErrorKind, MessageId>> = {
  network: 'errorpanel.why.network',
  session: 'errorpanel.why.session',
  forbidden: 'errorpanel.why.forbidden',
  blocked: 'errorpanel.why.blocked',
  notFound: 'errorpanel.why.notFound',
  quota: 'errorpanel.why.quota',
  rateLimited: 'errorpanel.why.rateLimited',
  tooLarge: 'errorpanel.why.tooLarge',
  validation: 'errorpanel.why.validation',
  server: 'errorpanel.why.server',
};

const TODO: Readonly<Record<ErrorKind, MessageId>> = {
  network: 'errorpanel.do.network',
  session: 'errorpanel.do.session',
  forbidden: 'errorpanel.do.forbidden',
  blocked: 'errorpanel.do.blocked',
  notFound: 'errorpanel.do.notFound',
  quota: 'errorpanel.do.quota',
  rateLimited: 'errorpanel.do.rateLimited',
  tooLarge: 'errorpanel.do.tooLarge',
  validation: 'errorpanel.do.validation',
  server: 'errorpanel.do.server',
};

/** Failures that retrying can fix; the others need the person to change something first. */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set(['network', 'rateLimited', 'server']);

export const ERROR_KINDS = Object.keys(WHY) as ErrorKind[];
export const ERROR_PANEL_MESSAGE_IDS: readonly MessageId[] = [
  ...Object.values(WHY),
  ...Object.values(TODO),
  'errorpanel.what.generic',
  'errorpanel.help',
  'errorpanel.reference',
  'errorpanel.reference.none',
];

interface ErrorPanelProps {
  readonly error: unknown;
  /** What happened, in the screen's own words ("We couldn’t load your integrations."). */
  readonly what?: MessageId;
  /** Offered only when trying again can help. */
  readonly onRetry?: () => void;
}

export function ErrorPanel({ error, what = 'errorpanel.what.generic', onRetry }: ErrorPanelProps) {
  useLocale();
  const kind = errorKind(error);
  const status = error instanceof ApiError && error.status > 0 ? String(error.status) : null;
  const seconds = error instanceof ApiError ? error.retryAfter : null;
  return (
    <div className="error-panel" role="alert">
      <IconAlertTriangle size={20} aria-hidden="true" className="error-panel-icon" />
      <div className="error-panel-body">
        <p className="error-panel-what">{t(what)}</p>
        <p className="error-panel-why">{t(WHY[kind])}</p>
        <p className="error-panel-do">
          {kind === 'rateLimited' && seconds !== null
            ? t('errorpanel.do.rateLimitedFor', { seconds })
            : t(TODO[kind])}
        </p>
        <p className="error-panel-help">
          {t('errorpanel.help')}{' '}
          <span className="error-reference">
            {status ? t('errorpanel.reference', { status }) : t('errorpanel.reference.none')}
          </span>
        </p>
        {onRetry && RETRYABLE.has(kind) && (
          <Button variant="outline" type="button" onClick={onRetry}>
            <IconRefresh size={18} aria-hidden="true" />
            {t('integrations.retry')}
          </Button>
        )}
      </div>
    </div>
  );
}
