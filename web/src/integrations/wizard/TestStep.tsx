import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { IconArrowRight } from '@tabler/icons-react';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/ui';
import { t, type MessageId } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import type { Integration } from '../../lib/api';
import { DESTINATIONS } from '../destinations';
import { TestSend } from '../test/TestSend';
import { Stepper } from './Stepper';
import '../integrations.css';

interface TestStepProps {
  readonly orgId: string;
  readonly integration: Integration;
  /** Every step of the wizard, the test step last; all earlier ones are done. */
  readonly steps: readonly MessageId[];
  readonly onDone: () => void;
}

/**
 * The wizard's optional last step (ADR 0018). The integration is already saved, so skipping is
 * always safe and nothing here can lose work: "Skip for now" and "Go to the integration" are
 * the same navigation, worded by whether a test has been tried.
 */
export function TestStep({ orgId, integration, steps, onDone }: TestStepProps) {
  useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => heading.current?.focus(), []);
  const destination = t(DESTINATIONS[integration.destination].name);
  return (
    <>
      <PageHeader
        before={
          <Link to="/integrations" className="text-link back-link">
            {t('settings.back')}
          </Link>
        }
        eyebrow={t('wizard.eyebrow')}
        title={t('wizard.title')}
        description={t('wizard.description')}
      />
      <div className="wizard">
        <Stepper steps={steps} current={steps.length - 1} />
        <section className="wizard-sheet" aria-labelledby="wizard-test-title">
          <h2 id="wizard-test-title" ref={heading} className="wizard-step-title" tabIndex={-1}>
            {t('wizard.stepOf', {
              current: steps.length,
              total: steps.length,
              title: t('wizard.step.test'),
            })}
          </h2>
          <p>
            <b>{t('wizard.test.title', { name: integration.name })}</b>
          </p>
          <p>{t('wizard.test.intro', { destination })}</p>
          <TestSend orgId={orgId} integration={integration} onSettled={() => setTried(true)} />
          <div className="wizard-actions">
            <span />
            <Button type="button" variant={tried ? 'primary' : 'outline'} onClick={onDone}>
              {t(tried ? 'wizard.test.done' : 'wizard.test.skip')}
              <IconArrowRight size={18} aria-hidden="true" />
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}
