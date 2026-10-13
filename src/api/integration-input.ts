import { isGithubEventType, type GithubEventType } from '../connectors/sources/github/catalog';
import { asRecord } from '../lib/json';
import { destinationAllowed, type DestinationKind } from '../pipeline/allowlist';

/**
 * Validation for integration writes. Everything is checked before anything is sealed or
 * stored (D9, D12, D16). Messages name the field and the rule; they never echo a URL or a
 * secret back, because the response may be logged by a proxy.
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
const SECRET_MAX = 256;
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

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
  if (value !== 'lark' && value !== 'slack') {
    errors.push({ field: 'destination', message: 'Choose Lark or Slack.' });
    return undefined;
  }
  return value;
}

function parseWebhookUrl(value: unknown, destination: DestinationKind | undefined, errors: FieldError[]) {
  if (typeof value !== 'string' || value.length > URL_MAX) {
    errors.push({ field: 'webhookUrl', message: 'Paste the webhook URL from your destination.' });
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    errors.push({ field: 'webhookUrl', message: 'This is not a valid URL.' });
    return undefined;
  }
  if (destination && !destinationAllowed(url, destination)) {
    const hint =
      destination === 'slack'
        ? 'Slack incoming webhook URLs start with https://hooks.slack.com/services/.'
        : 'Lark custom bot URLs start with https://open.larksuite.com/open-apis/bot/v2/hook/ (or open.feishu.cn).';
    errors.push({ field: 'webhookUrl', message: hint });
    return undefined;
  }
  return url.toString();
}

function parseSigningSecret(value: unknown, destination: DestinationKind | undefined, errors: FieldError[]) {
  if (value === undefined || value === null || value === '') return null;
  if (destination === 'slack') {
    errors.push({ field: 'signingSecret', message: 'Slack incoming webhooks do not use a signing secret.' });
    return undefined;
  }
  if (typeof value !== 'string' || value.length > SECRET_MAX || CONTROL.test(value) || /\s/.test(value)) {
    errors.push({ field: 'signingSecret', message: 'Paste the signing secret exactly as Lark shows it.' });
    return undefined;
  }
  return value;
}

export function parseCreateIntegration(body: unknown): Parsed<CreateIntegrationInput> {
  const r = asRecord(body);
  if (!r) return { ok: false, errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  const errors: FieldError[] = [];
  const name = parseName(r.name, errors);
  const repo = parseRepo(r.repo, errors);
  const eventTypes = parseEventTypes(r.eventTypes, errors);
  const destination = parseDestination(r.destination, errors);
  const webhookUrl = parseWebhookUrl(r.webhookUrl, destination, errors);
  const signingSecret = parseSigningSecret(r.signingSecret, destination, errors);
  if (
    errors.length ||
    !name ||
    !repo ||
    !eventTypes ||
    !destination ||
    !webhookUrl ||
    signingSecret === undefined
  )
    return { ok: false, errors };
  return { ok: true, value: { name, repo, eventTypes, destination, webhookUrl, signingSecret } };
}

/** `destination` is the stored kind: it cannot change, because credentials are bound to it. */
export function parseUpdateIntegration(
  body: unknown,
  destination: DestinationKind,
): Parsed<UpdateIntegrationInput> {
  const r = asRecord(body);
  if (!r) return { ok: false, errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  const allowed = new Set(['name', 'repo', 'eventTypes', 'enabled', 'webhookUrl', 'signingSecret']);
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
    const webhookUrl = parseWebhookUrl(r.webhookUrl, destination, errors);
    const signingSecret = parseSigningSecret(r.signingSecret, destination, errors);
    if (webhookUrl && signingSecret !== undefined) out.credentials = { webhookUrl, signingSecret };
  } else if ('signingSecret' in r) {
    errors.push({
      field: 'signingSecret',
      message: 'Send the webhook URL together with a new signing secret.',
    });
  }
  if (errors.length) return { ok: false, errors };
  if (Object.keys(out).length === 0)
    return { ok: false, errors: [{ field: 'body', message: 'Nothing to change.' }] };
  return { ok: true, value: out };
}
