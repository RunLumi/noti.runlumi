import { ApiError, api } from '../lib/api';

/** Workspace export and two-phase deletion (docs/API.md "Workspace export and deletion"). */

export type DeletionStatus =
  | { readonly scheduled: false }
  | {
      readonly scheduled: true;
      readonly requestedAt: string;
      readonly purgeAfter: string;
      readonly purgeStarted: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDeletion(body: unknown): DeletionStatus {
  if (!isRecord(body) || typeof body.scheduled !== 'boolean') throw new ApiError('Unexpected response', 500);
  if (!body.scheduled) return { scheduled: false };
  if (
    typeof body.requestedAt !== 'string' ||
    typeof body.purgeAfter !== 'string' ||
    typeof body.purgeStarted !== 'boolean'
  )
    throw new ApiError('Unexpected response', 500);
  return {
    scheduled: true,
    requestedAt: body.requestedAt,
    purgeAfter: body.purgeAfter,
    purgeStarted: body.purgeStarted,
  };
}

const withOrg = (path: string, orgId: string) => `${path}?org=${encodeURIComponent(orgId)}`;

export interface ExportResult {
  readonly file: string;
  /** True when older deliveries or audit events were left out of the file. */
  readonly truncated: boolean;
}

/** A filename the server chose, reduced to characters that are safe in a download name. */
export function safeFileName(header: string | null): string {
  const match = header ? /filename="([^"]+)"/.exec(header) : null;
  const cleaned = match?.[1]?.replace(/[^\w.-]/g, '_');
  return cleaned && cleaned.length <= 100 ? cleaned : 'lumi-noti-export.json';
}

function truncatedIn(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    const flags = isRecord(parsed) && isRecord(parsed.truncated) ? Object.values(parsed.truncated) : [];
    return flags.some((flag) => flag === true);
  } catch {
    return false;
  }
}

/** Fetches the export and hands it to the browser as a file; nothing is kept in memory after. */
export async function downloadExport(orgId: string): Promise<ExportResult> {
  let res: Response;
  try {
    res = await fetch(withOrg('/api/workspace/export', orgId), { credentials: 'same-origin' });
  } catch {
    throw new ApiError('Network request failed', 0);
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new ApiError(
      isRecord(body) && typeof body.error === 'string' ? body.error : 'Request failed',
      res.status,
    );
  }
  const text = await res.text();
  const file = safeFileName(res.headers.get('content-disposition'));
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { file, truncated: truncatedIn(text) };
}

export const workspaceApi = {
  deletion: async (orgId: string): Promise<DeletionStatus> =>
    parseDeletion(await api<unknown>(withOrg('/api/workspace/deletion', orgId))),
  requestDeletion: async (orgId: string, confirm: string): Promise<DeletionStatus> =>
    parseDeletion(
      await api<unknown>(withOrg('/api/workspace/deletion', orgId), {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      }),
    ),
  cancelDeletion: async (orgId: string): Promise<void> => {
    await api<unknown>(withOrg('/api/workspace/deletion', orgId), { method: 'DELETE' });
  },
};
