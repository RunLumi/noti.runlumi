import { GITLAB_EVENT_TYPES } from '../../../src/connectors/sources/gitlab/catalog';
import { STRIPE_EVENT_TYPES } from '../../../src/connectors/sources/stripe/catalog';
import { t, type MessageId } from '../i18n';

/**
 * What the dashboard knows about each source kind (ADR 0015): which credential a person
 * pastes, how the pasted value is checked before it is sent, which events a chat can pick, and
 * which guidance applies. Server rules are the authority; these checks only save a round trip,
 * and `providers.test.ts` asserts they agree with the Worker's own parsers.
 */
export type SourceKind = 'generic' | 'gitlab' | 'stripe';
export type ProviderKind = 'gitlab' | 'stripe';
export type AuthMode = 'signing_token' | 'secret_token';

export const KIND_ORDER: readonly SourceKind[] = ['generic', 'gitlab', 'stripe'];

export const KIND_LABEL: Readonly<Record<SourceKind, { name: MessageId; where: MessageId }>> = {
  generic: { name: 'sources.kind.generic.name', where: 'sources.kind.generic.where' },
  gitlab: { name: 'sources.kind.gitlab.name', where: 'sources.kind.gitlab.where' },
  stripe: { name: 'sources.kind.stripe.name', where: 'sources.kind.stripe.where' },
};

export const isProviderKind = (kind: SourceKind): kind is ProviderKind => kind !== 'generic';

/** The closed event catalogue of a kind: the Worker's own list, so the two cannot drift. */
export function eventCatalog(kind: SourceKind): readonly string[] {
  return kind === 'gitlab' ? GITLAB_EVENT_TYPES : kind === 'stripe' ? STRIPE_EVENT_TYPES : [];
}

export const eventLabelId = (type: string): MessageId => `sources.event.${type}` as MessageId;

export interface CreateDraft {
  readonly name: string;
  readonly kind: SourceKind;
  readonly authMode: AuthMode | null;
  readonly livemode: boolean | null;
  readonly secret: string;
}

export const EMPTY_DRAFT: CreateDraft = {
  name: '',
  kind: 'generic',
  authMode: null,
  livemode: null,
  secret: '',
};

export type CreateErrors = Partial<Record<'name' | 'authMode' | 'livemode' | 'secret', string>>;

const SIGNING_TOKEN_MAX = 512;
const SECRET_TOKEN = /^[!-~]{8,255}$/;
const STRIPE_SECRET = /^whsec_[A-Za-z0-9_+/=-]{16,200}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The pasted credential, checked the way the Worker checks it. Returns an error message or undefined. */
export function validateSecret(
  kind: ProviderKind,
  authMode: AuthMode | null,
  secret: string,
): string | undefined {
  if (kind === 'stripe') return STRIPE_SECRET.test(secret) ? undefined : t('sources.validation.stripeSecret');
  if (authMode === 'signing_token') {
    const body = secret.startsWith('whsec_') ? secret.slice(6) : '';
    return secret.length <= SIGNING_TOKEN_MAX && body.length % 4 === 0 && BASE64.test(body)
      ? undefined
      : t('sources.validation.gitlabSigning');
  }
  return authMode === 'secret_token' && SECRET_TOKEN.test(secret)
    ? undefined
    : authMode === null
      ? undefined
      : t('sources.validation.gitlabSecret');
}

export function validateCreate(draft: CreateDraft, nameError: string | undefined): CreateErrors {
  const errors: { -readonly [K in keyof CreateErrors]: CreateErrors[K] } = {};
  if (nameError) errors.name = nameError;
  if (!isProviderKind(draft.kind)) return errors;
  if (draft.kind === 'gitlab' && draft.authMode === null) errors.authMode = t('sources.validation.authMode');
  if (draft.kind === 'stripe' && draft.livemode === null) errors.livemode = t('sources.validation.livemode');
  if (draft.kind === 'stripe' || draft.authMode !== null) {
    const problem = validateSecret(draft.kind, draft.authMode, draft.secret);
    if (problem) errors.secret = problem;
  }
  return errors;
}

/** The request body. The pasted secret is sent exactly as typed (never trimmed or logged). */
export function toCreateBody(draft: CreateDraft): Record<string, unknown> {
  if (draft.kind === 'generic') return { name: draft.name.trim() };
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    secret: draft.secret,
    ...(draft.kind === 'gitlab' ? { authMode: draft.authMode } : { livemode: draft.livemode }),
  };
}

/** Server field names to the draft's error slots (the server may name `kind`, shown on the picker). */
export const SERVER_FIELDS = ['name', 'authMode', 'livemode', 'secret'] as const;
