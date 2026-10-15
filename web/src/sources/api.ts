import { ApiError, api, type RevokeReason } from '../lib/api';
import type { AuthMode, SourceKind } from './providers';

/**
 * Generic sources (docs/API.md "Sources", ADR 0012). The server returns the signing secret
 * exactly twice: in the create response and in the rotate response. Nothing here stores it;
 * the page keeps it in component state until the person dismisses it.
 */
export interface Source {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceKind;
  /** GitLab only: which credential the source verifies. Never the credential. */
  readonly authMode: AuthMode | null;
  /** Stripe only: true for live, false for test. */
  readonly livemode: boolean | null;
  /** Events dropped because the source exceeded its rate limit. */
  readonly droppedEvents: number;
  readonly lastDroppedAt: string | null;
  readonly endpointId: string;
  readonly endpointUrl: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastReceivedAt: string | null;
  readonly secretRotatedAt: string | null;
  /** Events refused because their webhook-id was already used with a different body. */
  readonly reusedIdRejections: number;
  readonly integrationCount: number;
  /**
   * Keyed, tenant-scoped code computed from the stored secret (F39), 8 characters: never the secret. Null when the
   * secret was sealed before fingerprints existed or the deployment has no fingerprint key. Kept after a revoke.
   */
  readonly credentialFingerprint: string | null;
  /** The credential was revoked (F40): the source stays off until a new secret is entered (rotate). */
  readonly revoked: boolean;
  /** Revoked and its wrapped key destroyed (F40): nobody can open the sealed secret any more. */
  readonly keyDestroyed: boolean;
}

/**
 * A source from a create or rotate response. `secret` is present only for a generic source,
 * whose secret Noti generates and shows once; GitLab and Stripe credentials are pasted by the
 * person and are never returned.
 */
export interface SourceWithSecret {
  readonly source: Source;
  readonly secret: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** Narrow one API row. A malformed row is an error, never silently dropped. */
export function parseSource(value: unknown): Source {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    (value.kind !== 'generic' && value.kind !== 'gitlab' && value.kind !== 'stripe') ||
    (value.authMode !== null && value.authMode !== 'signing_token' && value.authMode !== 'secret_token') ||
    (value.livemode !== null && typeof value.livemode !== 'boolean') ||
    typeof value.endpointId !== 'string' ||
    typeof value.endpointUrl !== 'string' ||
    typeof value.enabled !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    !nullableString(value.lastReceivedAt) ||
    !nullableString(value.secretRotatedAt) ||
    typeof value.reusedIdRejections !== 'number' ||
    typeof value.droppedEvents !== 'number' ||
    !nullableString(value.lastDroppedAt) ||
    typeof value.integrationCount !== 'number' ||
    !nullableString(value.credentialFingerprint) ||
    typeof value.revoked !== 'boolean' ||
    typeof value.keyDestroyed !== 'boolean'
  )
    throw new ApiError('Unexpected source shape', 500);
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    authMode: value.authMode,
    livemode: value.livemode,
    endpointId: value.endpointId,
    endpointUrl: value.endpointUrl,
    enabled: value.enabled,
    createdAt: value.createdAt,
    lastReceivedAt: value.lastReceivedAt,
    secretRotatedAt: value.secretRotatedAt,
    reusedIdRejections: value.reusedIdRejections,
    droppedEvents: value.droppedEvents,
    lastDroppedAt: value.lastDroppedAt,
    integrationCount: value.integrationCount,
    credentialFingerprint: value.credentialFingerprint,
    revoked: value.revoked,
    // A key can only be destroyed after a revoke; anything else is not shown as destroyed.
    keyDestroyed: value.revoked && value.keyDestroyed,
  };
}

export function parseSourceWithSecret(body: unknown): SourceWithSecret {
  if (!isRecord(body)) throw new ApiError('Unexpected response', 500);
  const source = parseSource(body.source);
  // A generic source must come with its one-time secret; a provider source must not.
  if (source.kind === 'generic') {
    if (typeof body.secret !== 'string' || !body.secret.startsWith('whsec_'))
      throw new ApiError('Unexpected response', 500);
    return { source, secret: body.secret };
  }
  if ('secret' in body) throw new ApiError('Unexpected response', 500);
  return { source, secret: null };
}

const withOrg = (path: string, orgId: string) => `${path}?org=${encodeURIComponent(orgId)}`;
const base = '/api/sources';
const item = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const sourcesApi = {
  list: async (orgId: string): Promise<readonly Source[]> => {
    const body = await api<unknown>(withOrg(base, orgId));
    if (!isRecord(body) || !Array.isArray(body.sources)) throw new ApiError('Unexpected response', 500);
    return body.sources.map(parseSource);
  },
  create: async (orgId: string, body: Record<string, unknown>): Promise<SourceWithSecret> =>
    parseSourceWithSecret(
      await api<unknown>(withOrg(base, orgId), { method: 'POST', body: JSON.stringify(body) }),
    ),
  update: async (
    orgId: string,
    id: string,
    patch: { readonly name?: string; readonly enabled?: boolean },
  ): Promise<Source> => {
    const body = await api<unknown>(withOrg(item(id), orgId), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!isRecord(body)) throw new ApiError('Unexpected response', 500);
    return parseSource(body.source);
  },
  /** Generic: no body (Noti generates the secret). GitLab and Stripe: the new pasted credential. */
  rotate: async (orgId: string, id: string, body: Record<string, unknown> = {}): Promise<SourceWithSecret> =>
    parseSourceWithSecret(
      await api<unknown>(withOrg(`${item(id)}/rotate`, orgId), {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ),
  /** Revoke the credential (F40): the source is switched off at once and its encrypted copy destroyed. */
  revokeCredentials: async (orgId: string, id: string, reason: RevokeReason): Promise<Source> => {
    const body = await api<unknown>(withOrg(`${item(id)}/revoke-credentials`, orgId), {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    if (!isRecord(body)) throw new ApiError('Unexpected response', 500);
    return parseSource(body.source);
  },
  /** `cascade` must be true when chats are connected: they are deleted with the source. */
  remove: async (orgId: string, id: string, cascade: boolean): Promise<void> => {
    const path = withOrg(item(id), orgId);
    await api<unknown>(cascade ? `${path}&cascade=true` : path, { method: 'DELETE' });
  },
};

/** SQLite timestamps (`YYYY-MM-DD HH:MM:SS`, UTC) as ISO 8601 for `<time>`. */
export function isoOf(sqlite: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlite) ? `${sqlite.replace(' ', 'T')}Z` : sqlite;
}
