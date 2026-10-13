import { Link } from '@tanstack/react-router';
import { IconSend } from '@tabler/icons-react';
import { Button } from '../../components/ui';
import { failureCopy } from '../../deliveries/copy';
import { t } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { ApiError, type Integration } from '../../lib/api';
import { describeError } from '../errors';
import { DESTINATIONS } from '../destinations';
import { useTestSend, type TestState } from './useTestSend';
import type { TestOutcome } from './poll';
import './test-send.css';

/** Failures the person fixes by replacing the webhook URL; the settings link is offered for these. */
const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  'destination_credentials_invalid',
  'destination_revoked',
  'destination_unauthorized',
  'destination_url_rejected',
]);

interface TestSendProps {
  readonly orgId: string;
  readonly integration: Integration;
  /** `panel` on the settings page and in the wizard; `compact` on a list row. */
  readonly variant?: 'panel' | 'compact';
  /** Called once a result is on screen (the wizard switches "Skip" to "Continue"). */
  readonly onSettled?: () => void;
}

type Blocked = 'paused' | 'quarantined' | null;

function blockedBy(integration: Integration): Blocked {
  if (integration.credentials === 'quarantined') return 'quarantined';
  return integration.enabled ? null : 'paused';
}

function ErrorLine({ error, integration }: { error: unknown; integration: Integration }) {
  useLocale();
  // A 409 here is about THIS integration (paused, quarantined, workspace being deleted); the
  // generic 409 copy talks about quotas, so it is replaced.
  if (error instanceof ApiError && error.status === 409 && error.reason === 'test_in_flight')
    return <p>{t('test.error.inFlight')}</p>;
  if (error instanceof ApiError && error.status === 409) {
    const blocked = blockedBy(integration);
    return (
      <p>
        {t(
          blocked === 'paused'
            ? 'test.blocked.paused'
            : blocked === 'quarantined'
              ? 'test.blocked.quarantined'
              : 'test.error.unavailable',
        )}
      </p>
    );
  }
  if (error instanceof ApiError && error.status === 429 && error.retryAfter !== null)
    return <p>{t('test.error.rateLimited', { seconds: error.retryAfter })}</p>;
  const described = describeError(error);
  return (
    <>
      <p>{described.message}</p>
      {described.reference && <p className="error-reference">{described.reference}</p>}
    </>
  );
}

function OutcomeBody({
  outcome,
  integration,
  variant,
}: {
  outcome: TestOutcome;
  integration: Integration;
  variant: 'panel' | 'compact';
}) {
  useLocale();
  const info = DESTINATIONS[integration.destination];
  const destination = t(info.name);
  const activity = (
    <Link to="/activity" search={{ integration: integration.id }} className="text-link">
      {t('test.viewActivity')}
    </Link>
  );
  if (outcome.kind === 'timeout')
    return (
      <>
        <p className="notice-title">{t('test.timeout.title')}</p>
        <p>{t('test.timeout.body')}</p>
        <p>{activity}</p>
      </>
    );
  const where = (
    <p>
      <b>{t('test.where.title')}: </b>
      {t(`test.where.${integration.destination}`)}
    </p>
  );
  if (outcome.kind === 'sent')
    return (
      <>
        <p className="notice-title">{t('test.sent.title')}</p>
        <p>{t('test.sent.body', { destination })}</p>
        {where}
      </>
    );
  if (outcome.kind === 'accepted')
    return (
      <>
        <p className="notice-title">{t('test.accepted.title')}</p>
        <p>
          {integration.destination === 'teams'
            ? t('test.accepted.teams')
            : t('test.accepted.body', { destination })}
        </p>
        {where}
      </>
    );
  const error = outcome.delivery.error;
  // The "unavailable" sentence says Noti gave up; while it is still retrying that would be false.
  const reason =
    error && !(outcome.kind === 'retrying' && error.code === 'destination_unavailable')
      ? failureCopy(error, integration.destination)
      : null;
  const fixable = error !== null && CREDENTIAL_CODES.has(error.code);
  return (
    <>
      <p className="notice-title">
        {t(outcome.kind === 'retrying' ? 'test.retrying.title' : 'test.failed.title')}
      </p>
      {outcome.kind === 'retrying' ? (
        reason && <p>{reason}</p>
      ) : (
        <p>{reason ?? t('delivery.detail.noMessage')}</p>
      )}
      {outcome.kind === 'retrying' && <p>{t('test.retrying.body')}</p>}
      <p className="test-links">
        {fixable &&
          (variant === 'panel' ? (
            <a href="#credentials" className="text-link">
              {t('test.failed.fix')}
            </a>
          ) : (
            <Link
              to="/integrations/$id"
              params={{ id: integration.id }}
              hash="credentials"
              className="text-link"
            >
              {t('test.failed.fix')}
            </Link>
          ))}
        {error?.userActionable && (
          <a href={info.docsUrl} target="_blank" rel="noopener noreferrer" className="text-link">
            {t(info.docsLabel)}
          </a>
        )}
        {activity}
      </p>
    </>
  );
}

function resultKind(state: TestState): 'success' | 'warning' | 'error' | 'info' {
  if (state.phase === 'error') return 'error';
  if (state.phase !== 'done') return 'info';
  switch (state.outcome.kind) {
    case 'sent':
      return 'success';
    case 'failed':
      return 'error';
    default:
      return 'warning';
  }
}

/**
 * "Send a test notification" for one integration (ADR 0018, spec 07 F98). The button creates a
 * real delivery and the panel polls it, then says in plain language what the destination did:
 * confirmed (sent), accepted without confirmation (Teams), failed with the fix, retrying, or
 * still waiting. The result region is a polite live region that exists before the first click,
 * so the outcome is announced; focus stays on the button, because moving it would announce the
 * same text twice.
 */
export function TestSend({ orgId, integration, variant = 'panel', onSettled }: TestSendProps) {
  useLocale();
  const { state, send } = useTestSend(orgId, integration.id, onSettled);
  const destination = t(DESTINATIONS[integration.destination].name);
  const blocked = blockedBy(integration);
  const busy = state.phase === 'sending' || state.phase === 'waiting';
  const used = state.phase === 'done' || state.phase === 'error';
  const label = variant === 'compact' ? t('test.buttonShort') : t(used ? 'test.buttonAgain' : 'test.button');

  return (
    <div className={variant === 'compact' ? 'test-send test-send-compact' : 'test-send'}>
      {variant === 'panel' && <p className="field-hint">{t('test.hint', { destination })}</p>}
      {blocked && (
        <p className="field-hint">
          {t(blocked === 'paused' ? 'test.blocked.paused' : 'test.blocked.quarantined')}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        aria-disabled={busy || blocked !== null || undefined}
        aria-label={variant === 'compact' ? t('test.buttonFor', { name: integration.name }) : undefined}
        onClick={() => {
          if (!busy && blocked === null) void send();
        }}
      >
        <IconSend size={18} aria-hidden="true" />
        {label}
      </Button>
      <div
        className="test-result"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={t('test.resultLabel')}
      >
        {busy && (
          <p className="test-progress">
            {state.phase === 'sending' ? t('test.sending') : t('test.waiting', { destination })}
          </p>
        )}
        {state.phase === 'error' && (
          <div className="notice notice-error">
            <ErrorLine error={state.error} integration={integration} />
          </div>
        )}
        {state.phase === 'done' && (
          <div className={`notice notice-${resultKind(state)}`}>
            <OutcomeBody outcome={state.outcome} integration={integration} variant={variant} />
          </div>
        )}
      </div>
    </div>
  );
}
