import { ApiError, api } from '../lib/api';

/**
 * Generic sources (docs/API.md "Sources", ADR 0012). The server returns the signing secret
 * exactly twice: in the create response and in the rotate response. Nothing here stores it;
 * the page keeps it in component state until the person dismisses it.
 */
export interface Source {
  readonly id: string;
  readonly name: string;
  readonly endpointId: string;
  readonly endpointUrl: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastReceivedAt: string | null;
  readonly secretRotatedAt: string | null;
  readonly integrationCount: number;
}

/** A source together with the one-time secret from a create or rotate response. */
export interface SourceWithSecret {
  readonly source: Source;
  readonly secret: string;
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
    typeof value.endpointId !== 'string' ||
    typeof value.endpointUrl !== 'string' ||
    typeof value.enabled !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    !nullableString(value.lastReceivedAt) ||
    !nullableString(value.secretRotatedAt) ||
    typeof value.integrationCount !== 'number'
  )
    throw new ApiError('Unexpected source shape', 500);
  return {
    id: value.id,
    name: value.name,
    endpointId: value.endpointId,
    endpointUrl: value.endpointUrl,
    enabled: value.enabled,
    createdAt: value.createdAt,
    lastReceivedAt: value.lastReceivedAt,
    secretRotatedAt: value.secretRotatedAt,
    integrationCount: value.integrationCount,
  };
}

export function parseSourceWithSecret(body: unknown): SourceWithSecret {
  if (!isRecord(body) || typeof body.secret !== 'string' || !body.secret.startsWith('whsec_'))
    throw new ApiError('Unexpected response', 500);
  return { source: parseSource(body.source), secret: body.secret };
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
  create: async (orgId: string, name: string): Promise<SourceWithSecret> =>
    parseSourceWithSecret(
      await api<unknown>(withOrg(base, orgId), { method: 'POST', body: JSON.stringify({ name }) }),
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
  rotate: async (orgId: string, id: string): Promise<SourceWithSecret> =>
    parseSourceWithSecret(
      await api<unknown>(withOrg(`${item(id)}/rotate`, orgId), { method: 'POST', body: '{}' }),
    ),
  remove: async (orgId: string, id: string): Promise<void> => {
    await api<unknown>(withOrg(item(id), orgId), { method: 'DELETE' });
  },
};

/** SQLite timestamps (`YYYY-MM-DD HH:MM:SS`, UTC) as ISO 8601 for `<time>`. */
export function isoOf(sqlite: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlite) ? `${sqlite.replace(' ', 'T')}Z` : sqlite;
}
