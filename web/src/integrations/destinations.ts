import type { DestinationKind } from '../lib/api';
import type { MessageId } from '../i18n';

/**
 * What the dashboard says about each destination it can actually connect today. Only the
 * kinds that pass the server's write-time allowlist are listed (F206: a destination we
 * cannot connect is absent, not greyed out).
 */
export interface DestinationInfo {
  readonly kind: DestinationKind;
  readonly name: MessageId;
  readonly where: MessageId;
  readonly what: MessageId;
  readonly urlHint: MessageId;
  readonly wrongHost: MessageId;
  readonly steps: readonly MessageId[];
  readonly docsLabel: MessageId;
  /** Official provider documentation, the fallback when a provider screen changes (F212). */
  readonly docsUrl: string;
  readonly supportsSigningSecret: boolean;
  /**
   * Noti generates this destination's signing secret and shows it once (custom webhook). Never
   * chosen by the person, so there is no input for it; the one-time reveal follows a save.
   */
  readonly issuesSigningSecret: boolean;
  /** Extra provider-specific caveats shown under the steps (Teams: trigger access, orphaned flows, accepted ≠ delivered). */
  readonly notes?: readonly MessageId[];
}

export const DESTINATIONS: Readonly<Record<DestinationKind, DestinationInfo>> = {
  lark: {
    kind: 'lark',
    name: 'destination.lark',
    where: 'destination.lark.where',
    what: 'destination.lark.what',
    urlHint: 'destination.lark.urlHint',
    wrongHost: 'validation.webhookUrl.wrongHost.lark',
    steps: [
      'destination.lark.step1',
      'destination.lark.step2',
      'destination.lark.step3',
      'destination.lark.step4',
      'destination.lark.step5',
    ],
    docsLabel: 'destination.lark.docs',
    docsUrl: 'https://open.larksuite.com/document/client-docs/bot-v3/add-custom-bot',
    supportsSigningSecret: true,
    issuesSigningSecret: false,
  },
  slack: {
    kind: 'slack',
    name: 'destination.slack',
    where: 'destination.slack.where',
    what: 'destination.slack.what',
    urlHint: 'destination.slack.urlHint',
    wrongHost: 'validation.webhookUrl.wrongHost.slack',
    steps: [
      'destination.slack.step1',
      'destination.slack.step2',
      'destination.slack.step3',
      'destination.slack.step4',
    ],
    docsLabel: 'destination.slack.docs',
    docsUrl: 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks',
    supportsSigningSecret: false,
    issuesSigningSecret: false,
  },
  teams: {
    kind: 'teams',
    name: 'destination.teams',
    where: 'destination.teams.where',
    what: 'destination.teams.what',
    urlHint: 'destination.teams.urlHint',
    wrongHost: 'validation.webhookUrl.wrongHost.teams',
    steps: [
      'destination.teams.step1',
      'destination.teams.step2',
      'destination.teams.step3',
      'destination.teams.step4',
      'destination.teams.step5',
    ],
    docsLabel: 'destination.teams.docs',
    docsUrl:
      'https://support.microsoft.com/en-us/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498',
    supportsSigningSecret: false,
    issuesSigningSecret: false,
    notes: ['destination.teams.noteOwner', 'destination.teams.noteAccepted'],
  },
  discord: {
    kind: 'discord',
    name: 'destination.discord',
    where: 'destination.discord.where',
    what: 'destination.discord.what',
    urlHint: 'destination.discord.urlHint',
    wrongHost: 'validation.webhookUrl.wrongHost.discord',
    steps: [
      'destination.discord.step1',
      'destination.discord.step2',
      'destination.discord.step3',
      'destination.discord.step4',
    ],
    docsLabel: 'destination.discord.docs',
    docsUrl: 'https://discord.com/developers/docs/resources/webhook',
    supportsSigningSecret: false,
    issuesSigningSecret: false,
    notes: ['destination.discord.noteMentions', 'destination.discord.noteDeleted'],
  },
  generic_webhook: {
    kind: 'generic_webhook',
    name: 'destination.generic_webhook',
    where: 'destination.generic_webhook.where',
    what: 'destination.generic_webhook.what',
    urlHint: 'destination.generic_webhook.urlHint',
    wrongHost: 'validation.webhookUrl.wrongHost.generic_webhook',
    steps: [
      'destination.generic_webhook.step1',
      'destination.generic_webhook.step2',
      'destination.generic_webhook.step3',
      'destination.generic_webhook.step4',
      'destination.generic_webhook.step5',
    ],
    docsLabel: 'destination.generic_webhook.docs',
    docsUrl: 'https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md',
    supportsSigningSecret: false,
    issuesSigningSecret: true,
    notes: ['destination.generic_webhook.noteChecked', 'destination.generic_webhook.noteEvidence'],
  },
};

export const DESTINATION_ORDER: readonly DestinationKind[] = [
  'lark',
  'slack',
  'teams',
  'discord',
  'generic_webhook',
];
