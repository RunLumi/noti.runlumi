import type { MessageId } from '../i18n';
import type { BlockedReason } from './api';

/**
 * Plain words for each reason a step cannot proceed (spec 14 F207 "blocking_reason"). The server
 * sends a closed key; the sentence, and the way out, are ours. `who` says whose move it is, so
 * the person is never told to fix something only a server operator can.
 */
export interface BlockedCopy {
  readonly title: MessageId;
  readonly body: MessageId;
  readonly who: 'operator' | 'you';
}

export const BLOCKED_COPY: Readonly<Record<BlockedReason, BlockedCopy>> = {
  github_app_not_configured: {
    title: 'setup.blocked.githubApp.title',
    body: 'setup.blocked.githubApp.body',
    who: 'operator',
  },
  github_not_connected: {
    title: 'setup.blocked.githubFirst.title',
    body: 'setup.blocked.githubFirst.body',
    who: 'you',
  },
  credentials_quarantined: {
    title: 'setup.blocked.quarantined.title',
    body: 'setup.blocked.quarantined.body',
    who: 'you',
  },
  integration_paused: {
    title: 'setup.blocked.paused.title',
    body: 'setup.blocked.paused.body',
    who: 'you',
  },
};
