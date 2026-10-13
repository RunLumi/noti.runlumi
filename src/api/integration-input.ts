import { validateDestinationConfig, type ConfigValidation } from '../connectors/destinations';
import { generateSigningSecret } from '../connectors/sources/generic/encoding';
import { isGithubEventType, type GithubEventType } from '../connectors/sources/github/catalog';
import { asRecord } from '../lib/json';
import type { DestinationKind } from '../pipeline/allowlist';
import { coverageIssue, parseFilters } from '../routing/filter-input';
import type { FilterConfig } from '../routing/filters';

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
  /** For a source integration this is empty and the handler substitutes the sentinel repo. */
  readonly repo: string;
  /** Set when the integration routes events from a generic source instead of a repository. */
  readonly sourceId?: string;
  readonly eventTypes: readonly GithubEventType[];
  /**
   * Source integrations only: the provider event types selected (empty means every event the
   * source sends). Shape-checked here; the handler checks membership in the catalogue of the
   * source's kind, which only the source row knows.
   */
  readonly sourceEventTypes?: readonly string[];
  readonly destination: DestinationKind;
  readonly webhookUrl: string;
  readonly signingSecret: string | null;
  /** Normalised routing filters; `{}` means none (ADR 0010). */
  readonly filters: FilterConfig;
}

export interface UpdateIntegrationInput {
  readonly name?: string;
  readonly repo?: string;
  readonly eventTypes?: readonly GithubEventType[];
  /** Source integrations only; see CreateIntegrationInput.sourceEventTypes. */
  readonly sourceEventTypes?: readonly string[];
  readonly enabled?: boolean;
  /** Replaces all filters; `{}` clears them. */
  readonly filters?: FilterConfig;
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
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

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

const SOURCE_EVENT_TYPE = /^[a-z][a-z_.]{0,59}$/;
const MAX_SOURCE_EVENT_TYPES = 30;

/** Shape only. An empty list is valid and means "every event the source sends". */
function parseSourceEventTypes(value: unknown, errors: FieldError[]): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SOURCE_EVENT_TYPES ||
    !value.every((v) => typeof v === 'string' && SOURCE_EVENT_TYPE.test(v))
  ) {
    errors.push({ field: 'eventTypes', message: 'Choose event types from the list for this source.' });
    return undefined;
  }
  return [...new Set(value as string[])];
}

function parseDestination(value: unknown, errors: FieldError[]): DestinationKind | undefined {
  if (
    value !== 'lark' &&
    value !== 'slack' &&
    value !== 'teams' &&
    value !== 'discord' &&
    value !== 'generic_webhook'
  ) {
    errors.push({
      field: 'destination',
      message: 'Choose Lark, Slack, Microsoft Teams, Discord or a custom webhook.',
    });
    return undefined;
  }
  return value;
}

const URL_HINTS: Readonly<Record<DestinationKind, string>> = {
  slack: 'Slack incoming webhook URLs start with https://hooks.slack.com/services/.',
  lark: 'Lark custom bot URLs start with https://open.larksuite.com/open-apis/bot/v2/hook/ (or open.feishu.cn).',
  teams: 'Use the HTTP URL of your Teams Workflows trigger; it is on a *.logic.azure.com host.',
  discord:
    'Discord webhook URLs start with https://discord.com/api/webhooks/. Copy the URL from Server Settings, Integrations, Webhooks.',
  generic_webhook:
    'Use the public https address of your endpoint, for example https://hooks.example.com/noti.',
};

const GENERIC_HINTS: Readonly<Partial<Record<string, string>>> = {
  scheme: 'Use an https:// address. Plain http is not accepted.',
  port: 'Use the standard HTTPS port (443); a custom port is not accepted.',
  userinfo: 'Remove the username and password from the address.',
  fragment: 'Remove the # fragment from the address.',
  ip_literal: 'Use a hostname, not an IP address.',
  internal_host: 'Use a public hostname. Local, internal and private names are not accepted.',
  host: 'Use a valid public hostname, for example hooks.example.com.',
  too_long: 'The address is too long (2048 characters at most).',
};

const NO_SECRET_INPUT: Readonly<Partial<Record<DestinationKind, string>>> = {
  slack: 'Slack incoming webhooks do not use a signing secret.',
  teams: 'Teams Workflows do not use a signing secret.',
  discord: 'Discord webhooks do not use a signing secret.',
  generic_webhook: 'Noti generates the signing secret for a custom webhook; it cannot be supplied.',
};

/** Messages name the field and the rule. They never echo the URL or the secret. */
function configFailure(result: Extract<ConfigValidation, { ok: false }>, kind: DestinationKind): FieldError {
  switch (result.reason) {
    case 'destination_url_rejected':
      return {
        field: 'webhookUrl',
        message:
          result.rule === 'malformed'
            ? 'This is not a valid URL.'
            : ((kind === 'generic_webhook' ? GENERIC_HINTS[result.rule] : undefined) ?? URL_HINTS[kind]),
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
      message: NO_SECRET_INPUT[destination] ?? 'This destination does not use a signing secret.',
    });
  }
  if (r.triggerAuth !== undefined && destination !== undefined && destination !== 'teams') {
    errors.push({ field: 'triggerAuth', message: 'Trigger authentication applies only to Microsoft Teams.' });
  }
  if (errors.length > before || destination === undefined || url === undefined) return undefined;
  const checked = validateDestinationConfig({
    kind: destination,
    webhookUrl: url,
    // A custom webhook is always signed, with a secret we generate (and show once).
    ...(destination === 'generic_webhook'
      ? { signingSecret: generateSigningSecret() }
      : hasSecret
        ? { signingSecret: secret }
        : {}),
    ...(r.triggerAuth !== undefined ? { triggerAuth: r.triggerAuth } : {}),
  });
  if (!checked.ok) {
    errors.push(configFailure(checked, destination));
    return undefined;
  }
  const { config } = checked;
  return {
    webhookUrl: config.webhookUrl,
    signingSecret:
      config.kind === 'lark' || config.kind === 'generic_webhook' ? (config.signingSecret ?? null) : null,
  };
}

/** `filters` absent is "none"; `null` or `{}` clears. Errors carry dotted field paths. */
function parseFilterField(r: Record<string, unknown>, errors: FieldError[]): FilterConfig | undefined {
  if (r.filters === undefined) return undefined;
  const parsed = parseFilters(r.filters);
  if (!parsed.ok) {
    errors.push(...parsed.errors);
    return undefined;
  }
  return parsed.value;
}

const SOURCE_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * A source integration carries no repository and no routing filters (they are GitHub-only). It
 * receives every event its source sends unless `eventTypes` selects some of the source kind's
 * catalogue (GitLab, Stripe); the generic kind has no catalogue, which the handler enforces.
 */
function parseSourceIntegration(r: Record<string, unknown>): Parsed<CreateIntegrationInput> {
  const errors: FieldError[] = [];
  if (typeof r.sourceId !== 'string' || !SOURCE_ID.test(r.sourceId))
    errors.push({ field: 'sourceId', message: 'Choose one of your sources.' });
  for (const field of ['repo', 'filters'])
    if (field in r)
      errors.push({ field, message: 'Not used with a source: it receives every event the source sends.' });
  const sourceEventTypes = 'eventTypes' in r ? parseSourceEventTypes(r.eventTypes, errors) : [];
  const name = parseName(r.name, errors);
  const destination = parseDestination(r.destination, errors);
  const credentials = parseCredentials(r, destination, errors);
  if (errors.length || !name || !destination || !credentials || typeof r.sourceId !== 'string')
    return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      repo: '',
      sourceId: r.sourceId,
      eventTypes: [],
      sourceEventTypes: sourceEventTypes ?? [],
      filters: {},
      destination,
      webhookUrl: credentials.webhookUrl,
      signingSecret: credentials.signingSecret,
    },
  };
}

export function parseCreateIntegration(body: unknown): Parsed<CreateIntegrationInput> {
  const r = asRecord(body);
  if (!r) return { ok: false, errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  if ('sourceId' in r) return parseSourceIntegration(r);
  const errors: FieldError[] = [];
  const name = parseName(r.name, errors);
  const repo = parseRepo(r.repo, errors);
  const eventTypes = parseEventTypes(r.eventTypes, errors);
  const destination = parseDestination(r.destination, errors);
  const credentials = parseCredentials(r, destination, errors);
  const filters = parseFilterField(r, errors) ?? {};
  if (eventTypes && errors.length === 0) {
    const issue = coverageIssue(filters, eventTypes);
    if (issue) errors.push(issue);
  }
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
      filters,
    },
  };
}

/** `destination` is the stored kind: it cannot change, because credentials are bound to it. */
export function parseUpdateIntegration(
  body: unknown,
  destination: DestinationKind,
  isSource = false,
): Parsed<UpdateIntegrationInput> {
  const r = asRecord(body);
  if (!r) return { ok: false, errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  const allowed = new Set([
    'name',
    'repo',
    'eventTypes',
    'enabled',
    'filters',
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
  if ('eventTypes' in r) {
    if (isSource) out.sourceEventTypes = parseSourceEventTypes(r.eventTypes, errors);
    else out.eventTypes = parseEventTypes(r.eventTypes, errors);
  }
  if ('enabled' in r) {
    if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
    else errors.push({ field: 'enabled', message: 'Must be true or false.' });
  }
  if ('filters' in r) out.filters = parseFilterField(r, errors);
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
