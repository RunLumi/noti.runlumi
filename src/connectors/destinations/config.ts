import { checkDestinationUrl, larkDomainOf, type LarkDomain, type UrlRejectionRule } from './url-policy';
import { DESTINATION_KINDS, type DestinationKind } from './types';

/**
 * Write-time validation of a customer-supplied destination (F96). The result is the only
 * way to obtain a `ValidatedDestinationConfig`, so a renderer or sender can never be handed
 * an unchecked URL.
 */

declare const validated: unique symbol;
interface Validated {
  readonly [validated]: true;
}

/**
 * Teams Workflows trigger authentication (`triggerAuthenticationType`). Only `anyone` is
 * supported: the other two require an Entra token header we do not yet obtain, and sending
 * no token to such a trigger fails every delivery (F104).
 */
export const TEAMS_TRIGGER_AUTH = ['anyone', 'tenant_users', 'specific_users'] as const;
export type TeamsTriggerAuth = (typeof TEAMS_TRIGGER_AUTH)[number];

export interface SlackDestinationConfig extends Validated {
  readonly kind: 'slack';
  readonly mode: 'incoming_webhook';
  readonly webhookUrl: string;
}

export interface TeamsDestinationConfig extends Validated {
  readonly kind: 'teams';
  readonly mode: 'workflows_webhook';
  readonly webhookUrl: string;
  readonly triggerAuth: 'anyone';
}

export interface LarkDestinationConfig extends Validated {
  readonly kind: 'lark';
  readonly mode: 'custom_bot';
  readonly webhookUrl: string;
  readonly domain: LarkDomain;
  readonly signingSecret?: string;
}

export type ValidatedDestinationConfig =
  SlackDestinationConfig | TeamsDestinationConfig | LarkDestinationConfig;

export type ConfigField = 'kind' | 'webhookUrl' | 'signingSecret' | 'triggerAuth';

export type ConfigValidation =
  | { readonly ok: true; readonly config: ValidatedDestinationConfig }
  | { readonly ok: false; readonly reason: 'destination_url_rejected'; readonly rule: UrlRejectionRule }
  | { readonly ok: false; readonly reason: 'config_invalid'; readonly field: ConfigField }
  | { readonly ok: false; readonly reason: 'config_unsupported'; readonly field: ConfigField };

const MAX_SECRET_LENGTH = 256;

type Raw = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isKind(v: unknown): v is DestinationKind {
  return typeof v === 'string' && (DESTINATION_KINDS as readonly string[]).includes(v);
}

function invalid(field: ConfigField): ConfigValidation {
  return { ok: false, reason: 'config_invalid', field };
}

/** The brand is a compile-time marker only; this is the single place it is asserted. */
function seal<T>(config: T): T & Validated {
  return config as T & Validated;
}

function validateTeams(raw: Raw, webhookUrl: string): ConfigValidation {
  const auth = raw.triggerAuth ?? 'anyone';
  if (typeof auth !== 'string' || !(TEAMS_TRIGGER_AUTH as readonly string[]).includes(auth)) {
    return invalid('triggerAuth');
  }
  if (auth !== 'anyone') return { ok: false, reason: 'config_unsupported', field: 'triggerAuth' };
  return {
    ok: true,
    config: seal({ kind: 'teams', mode: 'workflows_webhook', webhookUrl, triggerAuth: 'anyone' } as const),
  };
}

function validateLark(raw: Raw, url: URL, webhookUrl: string): ConfigValidation {
  const domain = larkDomainOf(url);
  if (!domain) return invalid('webhookUrl');
  const secret = raw.signingSecret;
  if (secret !== undefined && (typeof secret !== 'string' || !secret || secret.length > MAX_SECRET_LENGTH)) {
    return invalid('signingSecret');
  }
  const base = { kind: 'lark', mode: 'custom_bot', webhookUrl, domain } as const;
  return { ok: true, config: seal(secret === undefined ? base : { ...base, signingSecret: secret }) };
}

/** As `validateDestinationConfig`, but only accepts input of the given kind. */
export function validateConfigFor(kind: DestinationKind, raw: unknown): ConfigValidation {
  if (!isRecord(raw) || raw.kind !== kind) return invalid('kind');
  return validateDestinationConfig(raw);
}

/** Validate untrusted configuration input. Rejections never echo the submitted URL. */
export function validateDestinationConfig(raw: unknown): ConfigValidation {
  if (!isRecord(raw) || !isKind(raw.kind)) return invalid('kind');
  if (typeof raw.webhookUrl !== 'string') return invalid('webhookUrl');
  const checked = checkDestinationUrl(raw.kind, raw.webhookUrl);
  if (!checked.ok) return checked;
  const webhookUrl = checked.url.href;
  switch (raw.kind) {
    case 'slack':
      return { ok: true, config: seal({ kind: 'slack', mode: 'incoming_webhook', webhookUrl } as const) };
    case 'teams':
      return validateTeams(raw, webhookUrl);
    case 'lark':
      return validateLark(raw, checked.url, webhookUrl);
  }
}
