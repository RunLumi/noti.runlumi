import { IconCheck } from '@tabler/icons-react';
import { t, type MessageId } from '../../i18n';

interface StepperProps {
  readonly steps: readonly MessageId[];
  readonly current: number;
}

/**
 * The step indicator is an ordered list with `aria-current="step"`, not a row of coloured
 * circles (F216, F221). Below 900px it is hidden: the step heading already says
 * "Step n of 5: …", and a second copy only pushes the form down.
 */
export function Stepper({ steps, current }: StepperProps) {
  return (
    <nav aria-label={t('wizard.progress')} className="stepper">
      <ol className="stepper-list">
        {steps.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li
              key={step}
              className={`stepper-item stepper-${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="stepper-index" aria-hidden="true">
                {state === 'done' ? <IconCheck size={16} /> : index + 1}
              </span>
              <span className="stepper-title">{t(step)}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
