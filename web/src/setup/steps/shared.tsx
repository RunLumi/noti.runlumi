import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { IconArrowLeft, IconArrowRight } from '@tabler/icons-react';
import { Notice } from '../../components/ui';
import type { Draft, WizardErrors } from '../../integrations/wizard/draft';
import type { GithubInstallation } from '../../lib/api';
import { t, type MessageId } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import type { BlockedReason, SetupProgress, SetupStep } from '../api';
import { BLOCKED_COPY } from '../blocked';
import type { SetupSlug } from '../model';

/** What every page of the setup flow is given. The draft lives in memory only, never in the URL. */
export interface SetupPageProps {
  readonly orgId: string;
  readonly stale: boolean;
  readonly progress: SetupProgress;
  readonly draft: Draft;
  readonly errors: WizardErrors;
  readonly installations: readonly GithubInstallation[];
  readonly update: <K extends keyof Draft>(field: K, value: Draft[K]) => void;
  readonly setErrors: (errors: WizardErrors) => void;
  readonly clearDraft: () => void;
  /** Move to another page; resolves once the server's view of setup is fresh. */
  readonly goTo: (slug: SetupSlug) => void;
}

/** The server's step for a page, or throws away the type's `undefined` with a clear failure. */
export function stepState(progress: SetupProgress, id: SetupStep['id']): SetupStep {
  const found = progress.steps.find((s) => s.id === id);
  if (!found) throw new Error(`setup progress is missing step ${id}`);
  return found;
}

export function BlockedNotice({ reason, children }: { reason: BlockedReason; children?: ReactNode }) {
  useLocale();
  const copy = BLOCKED_COPY[reason];
  return (
    <Notice kind="warning">
      <p className="notice-title">{t(copy.title)}</p>
      <p>{t(copy.body)}</p>
      {children}
    </Notice>
  );
}

const GO: Readonly<Record<SetupSlug, MessageId>> = {
  github: 'setup.flow.prereq.go.github',
  repository: 'setup.flow.prereq.go.repository',
  destination: 'setup.flow.prereq.go.destination',
  events: 'setup.flow.prereq.go.events',
  test: 'setup.flow.prereq.go.test',
  done: 'setup.flow.prereq.go.done',
};

interface PrerequisiteProps {
  readonly slug: SetupSlug;
  readonly children?: ReactNode;
}

/**
 * Reached a step before the one it depends on (a bookmark, a shared link, the back button after
 * a refresh): say so and offer the earlier step, never a form that cannot work (F216).
 */
export function Prerequisite({ slug, children }: PrerequisiteProps) {
  useLocale();
  return (
    <Notice>
      <p className="notice-title">{t('setup.flow.prereq.title')}</p>
      <p>{children ?? t('setup.flow.prereq.body')}</p>
      <p>
        <Link to="/setup/$step" params={{ step: slug }} className="text-link">
          {t(GO[slug])}
        </Link>
      </p>
    </Notice>
  );
}

interface NavProps {
  readonly back?: SetupSlug;
  readonly children?: ReactNode;
}

/** Back on the left, the page's actions on the right; "Finish later" is always in the header. */
export function StepActions({ back, children }: NavProps) {
  useLocale();
  return (
    <div className="wizard-actions setup-actions">
      {back ? (
        <Link to="/setup/$step" params={{ step: back }} className="btn btn-outline">
          <IconArrowLeft size={18} aria-hidden="true" />
          {t('wizard.back')}
        </Link>
      ) : (
        <span />
      )}
      <div className="setup-actions-main">{children}</div>
    </div>
  );
}

export function ContinueLink({
  to,
  label,
}: {
  to: SetupSlug;
  label?: 'setup.flow.continue' | 'setup.flow.skip';
}) {
  useLocale();
  return (
    <Link to="/setup/$step" params={{ step: to }} className="btn btn-primary">
      {t(label ?? 'setup.flow.continue')}
      <IconArrowRight size={18} aria-hidden="true" />
    </Link>
  );
}
