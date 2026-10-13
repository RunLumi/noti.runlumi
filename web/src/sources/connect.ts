import type { CreateSourceIntegrationBody, DestinationKind } from '../lib/api';
import { DESTINATIONS } from '../integrations/destinations';
import {
  compact,
  validateName,
  validateSigningSecret,
  validateWebhookUrl,
  type FieldErrors,
} from '../integrations/validation';
import { t } from '../i18n';

/** What the "connect a chat" form collects. In memory only; never in the URL or storage. */
export interface ConnectDraft {
  readonly destination: DestinationKind | null;
  readonly name: string;
  readonly webhookUrl: string;
  readonly signingSecret: string;
  /** GitLab and Stripe sources: chosen catalogue types (empty or absent: every event). */
  readonly eventTypes?: readonly string[];
}

export type ConnectErrors = FieldErrors & { destination?: string };

/** A sensible default name that the person can edit. */
export function defaultChatName(sourceName: string, destination: DestinationKind): string {
  return `${sourceName} → ${t(DESTINATIONS[destination].name)}`.slice(0, 80);
}

/**
 * Mirrors the server (`parseCreateIntegration` with a source): the client is a convenience,
 * the server decides. The URL rule is the Worker's own `checkDestinationUrl`.
 */
export function validateConnect(draft: ConnectDraft): ConnectErrors {
  if (draft.destination === null) return { destination: t('validation.destination') };
  return compact({
    name: validateName(draft.name),
    webhookUrl: validateWebhookUrl(draft.webhookUrl, draft.destination),
    signingSecret: DESTINATIONS[draft.destination].supportsSigningSecret
      ? validateSigningSecret(draft.signingSecret)
      : undefined,
  });
}

export function toConnectBody(sourceId: string, draft: ConnectDraft): CreateSourceIntegrationBody | null {
  if (draft.destination === null) return null;
  return {
    name: draft.name.trim(),
    sourceId,
    destination: draft.destination,
    webhookUrl: draft.webhookUrl.trim(),
    ...(DESTINATIONS[draft.destination].supportsSigningSecret && draft.signingSecret !== ''
      ? { signingSecret: draft.signingSecret }
      : {}),
    ...(draft.eventTypes && draft.eventTypes.length > 0 ? { eventTypes: [...draft.eventTypes] } : {}),
  };
}
