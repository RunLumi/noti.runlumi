import type { DestinationKind } from '../lib/api';
import type { MessageId } from '../i18n';

/**
 * What the dashboard says about each destination it can actually connect today. Only Lark
 * and Slack are listed because only they pass the server's write-time allowlist (F206: a
 * destination we cannot connect is absent, not greyed out).
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
  },
};

export const DESTINATION_ORDER: readonly DestinationKind[] = ['lark', 'slack'];
