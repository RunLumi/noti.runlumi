import { checkDestinationUrl } from '../../../src/connectors/destinations/url-policy';
import { t } from '../i18n';
import type { DestinationKind, FieldError } from '../lib/api';
import { DESTINATIONS } from './destinations';

/**
 * Client-side checks that mirror `src/api/integration-input.ts`, so a person hears about a
 * mistake before a round trip. They are a convenience, not the rule: the server validates
 * every write again and its 422 field errors are what the form finally shows.
 *
 * The URL policy is imported from the Worker (`url-policy.ts`, pure TypeScript), not
 * re-implemented, so the two cannot drift.
 */
export type FormField = 'name' | 'repo' | 'eventTypes' | 'webhookUrl' | 'signingSecret';
export type FieldErrors = Partial<Record<FormField, string>>;

const NAME_MAX = 80;
const SECRET_MAX = 256;
const URL_MAX = 2048;
// Same expression as the server: GitHub owner (1–39, single inner hyphens) / repository.
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;
// C0/C1 controls and bidi overrides/isolates — the server's set, which it rejects in names and
// signing secrets because they can make text display as something else.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const FORM_FIELDS: ReadonlySet<string> = new Set<FormField>([
  'name',
  'repo',
  'eventTypes',
  'webhookUrl',
  'signingSecret',
]);

export function validateName(value: string): string | undefined {
  const ok = value.trim().length > 0 && value.length <= NAME_MAX && !CONTROL.test(value);
  return ok ? undefined : t('validation.name');
}

export function validateRepo(value: string): string | undefined {
  const ok = REPO.test(value) && !value.endsWith('/.') && !value.endsWith('/..');
  return ok ? undefined : t('validation.repo');
}

export function validateEvents(value: readonly string[]): string | undefined {
  return value.length > 0 ? undefined : t('validation.events');
}

export function validateWebhookUrl(value: string, destination: DestinationKind): string | undefined {
  const name = t(DESTINATIONS[destination].name);
  if (value.trim().length === 0) return t('validation.webhookUrl.empty', { destination: name });
  if (value.length > URL_MAX) return t('validation.webhookUrl.invalid');
  const result = checkDestinationUrl(destination, value.trim());
  if (result.ok) return undefined;
  // A string that is not a URL at all gets the generic message; a URL on the wrong host,
  // scheme or path gets the destination-specific hint.
  return result.rule === 'malformed'
    ? t('validation.webhookUrl.invalid')
    : t(DESTINATIONS[destination].wrongHost);
}

export function validateSigningSecret(value: string): string | undefined {
  if (value === '') return undefined;
  const ok = value.length <= SECRET_MAX && !CONTROL.test(value) && !/\s/.test(value);
  return ok ? undefined : t('validation.signingSecret');
}

/** Keep only the defined messages, so `Object.keys(errors).length` means "has errors". */
export function compact(errors: FieldErrors): FieldErrors {
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v !== undefined));
}

/**
 * Turn the server's 422 `fields` into per-field messages. Server messages never echo input
 * (see `integration-input.ts`), so they are safe to show next to the field they name. A
 * field the form does not render (e.g. `body`) is returned separately for a form-level notice.
 */
export function fromServer(fields: readonly FieldError[]): { fields: FieldErrors; other: string[] } {
  const out: FieldErrors = {};
  const other: string[] = [];
  for (const f of fields) {
    if (FORM_FIELDS.has(f.field)) out[f.field as FormField] ??= f.message;
    else other.push(f.message);
  }
  return { fields: out, other };
}
