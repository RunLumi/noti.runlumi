import { IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import { t, type MessageId } from '../i18n';
import { CopyButton } from './CopyButton';
import type { ProviderKind } from './providers';

interface GuideCopy {
  readonly summary: MessageId;
  readonly steps: readonly MessageId[];
  readonly notes: readonly MessageId[];
  readonly docsUrl: string;
  readonly docsLabel: MessageId;
}

/**
 * Provider-specific setup help: what to paste where, and the limits worth knowing before
 * events go quiet. Everything stated here is something Noti does or the provider documents
 * (ADR 0015); nothing claims more.
 */
const GUIDES: Readonly<Record<ProviderKind, GuideCopy>> = {
  gitlab: {
    summary: 'sources.guide.gitlab.summary',
    steps: [
      'sources.guide.gitlab.step1',
      'sources.guide.gitlab.step2',
      'sources.guide.gitlab.step3',
      'sources.guide.gitlab.step4',
      'sources.guide.gitlab.step5',
    ],
    notes: [
      'sources.guide.gitlab.comOnly',
      'sources.guide.gitlab.disable',
      'sources.guide.gitlab.pushLimit',
      'sources.guide.gitlab.ignored',
    ],
    docsUrl: 'https://docs.gitlab.com/user/project/integrations/webhooks/',
    docsLabel: 'sources.guide.gitlab.docs',
  },
  stripe: {
    summary: 'sources.guide.stripe.summary',
    steps: [
      'sources.guide.stripe.step1',
      'sources.guide.stripe.step2',
      'sources.guide.stripe.step3',
      'sources.guide.stripe.step4',
      'sources.guide.stripe.step5',
    ],
    notes: [
      'sources.guide.stripe.modes',
      'sources.guide.stripe.privacy',
      'sources.guide.stripe.retries',
      'sources.guide.stripe.roll',
    ],
    docsUrl: 'https://docs.stripe.com/webhooks',
    docsLabel: 'sources.guide.stripe.docs',
  },
};

export function ProviderGuidance({
  kind,
  endpointUrl,
  weakAuth,
}: {
  readonly kind: ProviderKind;
  readonly endpointUrl: string;
  /** GitLab secret-token mode: shown as a standing security note. */
  readonly weakAuth: boolean;
}) {
  const guide = GUIDES[kind];
  return (
    <details className="source-details">
      <summary>{t(guide.summary)}</summary>
      <div className="source-details-body">
        <ol className="guide-steps">
          {guide.steps.map((step) => (
            <li key={step}>{t(step)}</li>
          ))}
        </ol>
        <CopyButton
          text={endpointUrl}
          label="sources.card.copyUrl"
          copied="sources.secret.copied"
          failed="sources.secret.copyFailed"
        />
        {[...guide.notes, ...(weakAuth ? (['sources.guide.gitlab.weak'] as const) : [])].map((note) => (
          <p key={note} className="guide-caveat">
            <IconAlertCircle size={18} aria-hidden="true" />
            <span>{t(note)}</span>
          </p>
        ))}
        <p className="guide-note">
          <a href={guide.docsUrl} target="_blank" rel="noopener noreferrer" className="text-link">
            {t(guide.docsLabel)}
            <IconExternalLink size={16} aria-hidden="true" />
          </a>
        </p>
      </div>
    </details>
  );
}
