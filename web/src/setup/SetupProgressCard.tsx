import { Link } from '@tanstack/react-router';
import { IconCheck, IconCircleDashed } from '@tabler/icons-react';
import { Card } from '../components/ui';
import { absoluteTime } from '../deliveries/Time';
import { useOrgId } from '../integrations/hooks';
import { t, type MessageId } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import type { NextAction, SetupStep } from './api';
import { useSetupProgress } from './hooks';
import './setup.css';

/** Where each next action goes: existing routes only. */
const ACTION_TARGET: Readonly<
  Record<Exclude<NextAction, 'none'>, '/integrations/new' | '/integrations' | '/activity'>
> = {
  connect_source: '/integrations/new',
  create_integration: '/integrations/new',
  send_test: '/integrations',
  trigger_real_event: '/activity',
};

function StepRow({ step, isNext, days }: { step: SetupStep; isNext: boolean; days: number }) {
  useLocale();
  const title = `setup.step.${step.id}` as MessageId;
  return (
    <li className={step.done ? 'setup-step setup-step-done' : 'setup-step'}>
      <span className="setup-mark" aria-hidden="true">
        {step.done ? <IconCheck size={18} /> : <IconCircleDashed size={18} />}
      </span>
      <div className="setup-step-body">
        <p className="setup-step-title">
          {t(title)}
          <span className="setup-status">
            {' '}
            ·{' '}
            {t(
              step.done
                ? 'setup.done'
                : step.status === 'accepted'
                  ? 'setup.accepted'
                  : isNext
                    ? 'setup.next'
                    : 'setup.todo',
            )}
          </span>
        </p>
        <p className="setup-step-text">
          {t((step.status === 'accepted' ? `${title}.accepted` : `${title}.body`) as MessageId, { days })}
          {step.status !== 'todo' && step.since
            ? ` ${t('setup.since', { when: absoluteTime(step.since) })}`
            : ''}
        </p>
        {(isNext || step.status === 'accepted') && step.nextAction !== 'none' && (
          <Link to={ACTION_TARGET[step.nextAction]} className="btn btn-primary setup-action">
            {t(`setup.action.${step.nextAction}` as MessageId)}
          </Link>
        )}
      </div>
    </li>
  );
}

/**
 * "Finish setting up" (ADR 0018, spec 14 F206–F214): the four steps that decide whether a
 * workspace actually works, derived by the server from real rows. It disappears when every step
 * is done, and renders nothing while loading or if the request fails: it is guidance, so it
 * never blocks the Overview or shows an error for a screen that works without it.
 */
export function SetupProgressCard() {
  useLocale();
  const orgId = useOrgId();
  const progress = useSetupProgress(orgId);
  const data = progress.data;
  if (!data || data.complete) return null;
  const done = data.steps.filter((s) => s.done).length;
  return (
    <Card className="panel setup-card">
      <section aria-labelledby="setup-title">
        <h2 id="setup-title">{t('setup.title')}</h2>
        <p className="setup-summary">{t('setup.summary', { done, total: data.steps.length })}</p>
        <ol className="setup-steps" aria-label={t('setup.listLabel')}>
          {data.steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              isNext={data.next === step.id}
              days={data.verifiedWindowDays}
            />
          ))}
        </ol>
        <p className="muted setup-honest">{t('setup.honest')}</p>
      </section>
    </Card>
  );
}
