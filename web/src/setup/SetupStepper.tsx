import { Link } from '@tanstack/react-router';
import { IconAlertTriangle, IconCheck, IconPlayerSkipForward } from '@tabler/icons-react';
import { t, type MessageId } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import type { SetupProgress, SetupStep, StepState } from './api';
import { SETUP_PAGES, SETUP_SLUGS, STEP_TITLE, type SetupSlug } from './model';

const STATE_WORD: Readonly<Record<StepState, MessageId>> = {
  todo: 'setup.state.todo',
  doing: 'setup.state.doing',
  done: 'setup.state.done',
  blocked: 'setup.state.blocked',
  skipped: 'setup.state.skipped',
};

function StateMark({ state, index }: { state: StepState; index: number }) {
  useLocale();
  return (
    <span className="stepper-index" aria-hidden="true">
      {state === 'done' ? (
        <IconCheck size={16} />
      ) : state === 'blocked' ? (
        <IconAlertTriangle size={16} />
      ) : state === 'skipped' ? (
        <IconPlayerSkipForward size={16} />
      ) : (
        index + 1
      )}
    </span>
  );
}

function slugOf(step: SetupStep): SetupSlug | null {
  return SETUP_SLUGS.find((slug) => SETUP_PAGES[slug].step === step.id) ?? null;
}

interface SetupStepperProps {
  readonly progress: SetupProgress;
  /** The page being shown; marked `aria-current="step"`. */
  readonly current: SetupSlug;
}

/**
 * All seven steps with the state the server derived for each: an ordered list, the page being
 * shown marked `aria-current="step"`, every state spelled in words as well as shown by a mark
 * (F216, F221). Each step with a page is a link, so a person can go back to a finished step.
 * Hidden below 900px, where the page's own "Step n of 6" heading says where they are.
 */
export function SetupStepper({ progress, current }: SetupStepperProps) {
  useLocale();
  return (
    <nav aria-label={t('setup.flow.progress')} className="stepper setup-nav">
      <ol className="stepper-list">
        {progress.steps.map((step, index) => {
          const slug = slugOf(step);
          const here = slug === current;
          const label = (
            <>
              <StateMark state={step.state} index={index} />
              <span className="stepper-title">
                {t(STEP_TITLE[step.id])}
                <span className="setup-state-word">
                  {step.optional && step.state !== 'done' ? ` · ${t('setup.optional')}` : ''}
                  {` · ${t(STATE_WORD[step.state])}`}
                </span>
              </span>
            </>
          );
          return (
            <li
              key={step.id}
              className={`stepper-item stepper-${here ? 'current' : step.state === 'done' ? 'done' : 'todo'}`}
              aria-current={here ? 'step' : undefined}
            >
              {slug ? (
                <Link to="/setup/$step" params={{ step: slug }} className="stepper-link">
                  {label}
                </Link>
              ) : (
                label
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
