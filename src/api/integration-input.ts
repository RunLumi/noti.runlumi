import { validateDestinationConfig, type ConfigValidation } from '../connectors/destinations';
import { isGithubEventType, type GithubEventType } from '../connectors/sources/github/catalog';
import { asRecord } from '../lib/json';
import type { DestinationKind } from '../pipeline/allowlist';

/**
 * Validation for integration writes. Everything is checked before anything is sealed or
 * stored (D9, D12, D16). Messages name the field and the rule; they never echo a URL or a
 * secret back, because the response may be logged by a proxy.
 *
 * Destination credentials (URL allowlist, signing-secret shape, Teams trigger authentication)
 * are validated by `validateDestinationConfig` alone (ADR 0006); nothing here re-states them.
 */
export type FieldError = { readonly field: string; readonly message: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export interface CreateIntegrationInput {
  readonly name: string;
  readonly repo: string;
  readonly eventTypes: readonly GithubEventType[];
  readonly destination: DestinationKind;
  readonly webhookUrl: string;
  readonly signingSecret: string | null;
}

export interface UpdateIntegrationInput {
  readonly name?: string;
  readonly repo?: string;
  readonly eventTypes?: readonly GithubEventType[];
  readonly enabled?: boolean;
  /** Present together: rotating credentials re-seals under fresh key material. */
  readonly credentials?: { readonly webhookUrl: string; readonly signingSecret: string | null };
}

const NAME_MAX = 80;
// GitHub owner: 1–39 alphanumerics or single hyphens; repo: 1–100 of [A-Za-z0-9._-].
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;
const URL_MAX = 2048;
// C0/C1 controls and bidi overrides/isolates, which can make a name display as something
// else in the dashboard.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

function parseName(value: unknown, errors: FieldError[]): string | undefined {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > NAME_MAX ||
    CONTROL.test(value)
  ) {
    errors.push({ field: 'name', message: `Use 1–${NAME_MAX} characters.` });
    return undefined;
  }
  return value.trim();
}

function parseRepo(value: unknown, errors: FieldError[]): string | undefined {
  if (typeof value !== 'string' || !REPO.test(value) || value.endsWith('/.') || value.endsWith('/..')) {
    errors.push({ field: 'repo', message: 'Use the form owner/repository.' });
    return undefined;
  }
  return value;
}

function parseEventTypes(value: unknown, errors: FieldError[]): GithubEventType[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ field: 'eventTypes', message: 'Choose at least one event.' });
    return undefined;
  }
  if (!value.every(isGithubEventType)) {
    errors.push({ field: 'eventTypes', message: 'Contains an event type Noti does not support.' });
    return undefined;
  }
  return [...new Set(value)];
}

function parseDestination(value: unknown, errors: FieldError[]): DestinationKind | undefined {
  if (value !== 'lark' && value !== 'slack' && value !== 'teams') {
    errors.push({ field: 'destination', message: 'Choose Lark, Slack or Microsoft Teams.' });
    return undefined;
  }
  return value;
}

const URL_HINTS: Readonly<Record<DestinationKind, string>> = {
  slack: 'Slack incoming webhook URLs start with https://hooks.slack.com/services/.',
  lark: 'Lark custom bot URLs start with https://open.larksuite.com/open-apis/bot/v2/hook/ (or open.feishu.cn).',
  teams: 'Use the HTTP URL of your Teams Workflows trigger; it is on a *.logic.azure.com host.',
};

/** Messages name the field and the rule. They never echo the URL or the secret. */
function configFailure(result: Extract<ConfigValidation, { ok: false }>, kind: DestinationKind): FieldError {
  switch (result.reason) {
    case 'destination_url_rejected':
      return {
        field: 'webhookUrl',
        message: result.rule === 'malformed' ? 'This is not a valid URL.' : URL_HINTS[kind],
      };
    case 'config_unsupported':
      return {
        field: result.field,
        message:
          result.field === 'triggerAuth'
            ? 'Only the "anyone" trigger authentication is supported. Set the Workflows trigger to "Anyone".'
            : 'This option is not supported yet.',
      };
    case 'config_invalid':
      return {
        field: result.field,
        message:
          result.field === 'signingSecret'
            ? 'Paste the signing secret exactly as Lark shows it.'
            : result.field === 'triggerAuth'
              ? 'Use "anyone".'
              : URL_HINTS[kind],
      };
  }
}

interface Credentials {
  readonly webhookUrl: string;
  readonly signingSecret: string | null;
}

/**
 * The one place raw credential input becomes a stored value. It adapts the verdict of
 * `validateDestinationConfig` to the API's field-error shape and rejects options that do not
 * apply to the destination kind at all.
 */
function parseCredentials(
  r: Record<string, unknown>,
  destination: DestinationKind | undefined,
  errors: FieldError[],
): Credentials | undefined {
  const before = errors.length;
  // Trimming is leniency for a pasted value, not a policy rule: the policy sees the result.
  const url = typeof r.webhookUrl === 'string' ? r.webhookUrl.trim() : undefined;
  if (url === undefined || url.length > URL_MAX) {
    errors.push({ field: 'webhookUrl', message: 'Paste the webhook URL from your destination.' });
  }
  const secret = r.signingSecret;
  const hasSecret = secret !== undefined && secret !== null && secret !== '';
  if (hasSecret && destination !== undefined && destination !== 'lark') {
    errors.push({
      field: 'signingSecret',
      message: `${destination === 'slack' ? 'Slack incoming webhooks do' : 'Teams Workflows do'} not use a signing secret.`,
    });
  }
  if (r.triggerAuth !== undefined && destination !== undefined && destination !== 'teams') {
    errors.push({ field: 'triggerAuth', message: 'Trigger authentication applies only to Microsoft Teams.' });
  }
  if (errors.length > before || destination === undefined || url === undefined) return undefined;
  const checked = validateDestinationConfig({
    kind: destination,
    webhookUrl: url,
    ...(hasSecret ? { signingSecret: secret } : {}),
    ...(r.triggerAuth !== undefined ? { triggerAuth: r.triggerAuth } : {}),
  });
  if (!checked.ok) {
    errors.push(configFailure(checked, destination));
    return undefined;
  }
  const { config } = checked;
  return {
    webhookUrl: config.webhookUrl,
    signingSecret: config.kind === 'lark' ? (config.signingSecret ?? null) : null,
  };
}

export function parseCreateIntegration(body: unknown): Parsed<CreateIntegrationInput> {
  const r = asRecord(body);
  if (!r) return { ok: false, errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  const errors: FieldError[] = [];
  const name = parseName(r.name, errors);
  const repo = parseRepo(r.repo, errors);
  const eventTypes = parseEventTypes(r.eventTypes, errors);
  const destination = parseDestination(r.destination, errors);
  const credentials = parseCredentials(r, destination, errors);
  if (errors.length || !name || !repo || !eventTypes || !destination || !credentials)
    return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      repo,
      eventTypes,
      destination,
      webhookUrl: credentials.webhookUrl,
      signingSecret: credentials.signingSecret,
    },
  };
}

/** `destination` is the stored kind: it cannot change, because credentials are bound to it. */
export function parseUpdateIntegration(
  body: unknown,
  destination: DestinationKind,
): Parsed<UpdateIntegrationInput> {
  const r = asRecord(body);
  if (!r) return { ok: false, errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  const allowed = new Set([
    'name',
    'repo',
    'eventTypes',
    'enabled',
    'webhookUrl',
    'signingSecret',
    'triggerAuth',
  ]);
  const unknownField = Object.keys(r).find((k) => !allowed.has(k));
  if (unknownField)
    return { ok: false, errors: [{ field: unknownField, message: 'This field cannot be changed.' }] };

  const errors: FieldError[] = [];
  const out: { -readonly [K in keyof UpdateIntegrationInput]: UpdateIntegrationInput[K] } = {};
  if ('name' in r) out.name = parseName(r.name, errors);
  if ('repo' in r) out.repo = parseRepo(r.repo, errors);
  if ('eventTypes' in r) out.eventTypes = parseEventTypes(r.eventTypes, errors);
  if ('enabled' in r) {
    if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
    else errors.push({ field: 'enabled', message: 'Must be true or false.' });
  }
  if ('webhookUrl' in r) {
    const credentials = parseCredentials(r, destination, errors);
    if (credentials) out.credentials = credentials;
  } else if ('signingSecret' in r || 'triggerAuth' in r) {
    errors.push({
      field: 'signingSecret' in r ? 'signingSecret' : 'triggerAuth',
      message: 'Send the webhook URL together with the new credentials.',
    });
  }
  if (errors.length) return { ok: false, errors };
  if (Object.keys(out).length === 0)
    return { ok: false, errors: [{ field: 'body', message: 'Nothing to change.' }] };
  return { ok: true, value: out };
}
