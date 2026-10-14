import { Link } from '@tanstack/react-router';
import { IconAlertTriangle, IconCheck, IconCircleDashed, IconPlayerSkipForward } from '@tabler/icons-react';
import { Card } from '../components/ui';
import { absoluteTime } from '../deliveries/Time';
import { useOrgId } from '../integrations/hooks';
import { t, type MessageId } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import type { NextAction, SetupStep, StepState } from './api';
import { BLOCKED_COPY } from './blocked';
import { useSetupProgress } from './hooks';
import { SETUP_PAGES, SETUP_SLUGS, STEP_TITLE, slugForStep } from './model';
import './setup.css';

const ACTION_LABEL: Readonly<Record<Exclude<NextAction, 'none'>, MessageId>> = {
  connect_github: 'setup.action.connect_github',
  pick_repository: 'setup.action.pick_repository',
  choose_destination: 'setup.action.choose_destination',
  refine_events: 'setup.action.refine_events',
  send_test: 'setup.action.send_test',
  repair_integration: 'setup.action.repair_integration',
  resume_integration: 'setup.action.resume_integration',
  trigger_real_event: 'setup.action.trigger_real_event',
};

const BODY: Readonly<Record<SetupStep['id'], MessageId>> = {
  workspace_created: 'setup.step.workspace_created.body',
  github_connected: 'setup.step.github_connected.body',
  repositories_selected: 'setup.step.repositories_selected.body',
  destination_connected: 'setup.step.destination_connected.body',
  events_chosen: 'setup.step.events_chosen.body',
  test_delivered: 'setup.step.test_delivered.body',
  activated: 'setup.step.activated.body',
};

const STATE_WORD: Readonly<Record<StepState, MessageId>> = {
  todo: 'setup.state.todo',
  doing: 'setup.state.doing',
  done: 'setup.state.done',
  blocked: 'setup.state.blocked',
  skipped: 'setup.state.skipped',
};

function StateIcon({ state }: { state: StepState }) {
  useLocale();
  if (state === 'done') return <IconCheck size={18} />;
  if (state === 'blocked') return <IconAlertTriangle size={18} />;
  if (state === 'skipped') return <IconPlayerSkipForward size={18} />;
  return <IconCircleDashed size={18} />;
}

function StepRow({ step, days }: { step: SetupStep; days: number }) {
  useLocale();
  const slug = SETUP_SLUGS.find((s) => SETUP_PAGES[s].step === step.id);
  const title = t(STEP_TITLE[step.id]);
  const body =
    step.id === 'test_delivered' && step.verification === 'accepted'
      ? t('setup.step.test_delivered.accepted')
      : t(BODY[step.id], { days });
  return (
    <li className={`setup-step setup-step-${step.state}`}>
      <span className="setup-mark" aria-hidden="true">
        <StateIcon state={step.state} />
      </span>
      <div className="setup-step-body">
        <p className="setup-step-title">
          {slug ? (
            <Link to="/setup/$step" params={{ step: slug }} className="text-link">
              {title}
            </Link>
          ) : (
            title
          )}
          <span className="setup-status">
            {' '}
            · {step.optional && step.state !== 'done' ? `${t('setup.optional')} · ` : ''}
            {t(STATE_WORD[step.state])}
          </span>
        </p>
        <p className="setup-step-text">
          {body}
          {step.state === 'done' && step.since
            ? ` ${t('setup.since', { when: absoluteTime(step.since) })}`
            : ''}
        </p>
        {step.state === 'blocked' && step.blockedBy && (
          <p className="setup-blocked">
            <b>{t('setup.blocked.because')} </b>
            {t(BLOCKED_COPY[step.blockedBy].body)}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * "Finish setting up" (ADR 0025, spec 14 F206/F207): the server's seven steps with the state each
 * is really in, and one button that opens the next one. It renders nothing while loading or when
 * the request fails (it is guidance; the Overview works without it), and once setup is complete
 * it shrinks to a single honest line until a real event arrives.
 */
export function SetupProgressCard() {
  useLocale();
  const orgId = useOrgId();
  const progress = useSetupProgress(orgId);
  const data = progress.data;
  if (!data || data.next === null) return null;
  const steps = data.steps.filter((s) => s.id !== 'workspace_created');
  const settled = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  if (data.complete)
    return (
      <Card className="panel setup-card setup-card-complete">
        <section aria-labelledby="setup-title">
          <h2 id="setup-title">{t('setup.complete.title')}</h2>
          <p className="setup-summary">{t('setup.complete.body')}</p>
          <Link to="/setup/$step" params={{ step: 'done' }} className="btn btn-outline setup-action">
            {t('setup.complete.view')}
          </Link>
        </section>
      </Card>
    );
  const action = data.nextAction === 'none' ? null : ACTION_LABEL[data.nextAction];
  return (
    <Card className="panel setup-card">
      <section aria-labelledby="setup-title">
        <h2 id="setup-title">{t('setup.title')}</h2>
        <p className="setup-summary">{t('setup.summary', { done: settled, total: steps.length })}</p>
        <ol className="setup-steps" aria-label={t('setup.listLabel')}>
          {steps.map((step) => (
            <StepRow key={step.id} step={step} days={data.verifiedWindowDays} />
          ))}
        </ol>
        {action && (
          <Link
            to="/setup/$step"
            params={{ step: slugForStep(data.next) }}
            className="btn btn-primary setup-action"
          >
            {t(action)}
          </Link>
        )}
        <p className="muted setup-honest">{t('setup.honest')}</p>
      </section>
    </Card>
  );
}
